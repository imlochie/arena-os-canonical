/**
 * Render helper tests — the exported FFmpeg filter construction must match
 * the worker's output shape (ports of tempo.ts / key.ts / automation.ts),
 * plus the desktop's explicit unnormalized mix strategy.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  atempoFilterChain,
  automatedTrackBusFilters,
  ffmpegAutomationExpression,
  ffmpegFadeFilters,
  mixSumFilters,
  padToTimeline,
  pitchFilterChain,
  requiredSourceDurationMs,
  resolveKeySync,
  sourceDurationFits,
  tempoRatio,
  timelineSampleCount,
} from "@/lib/waveyard/worker-local/render-helpers";

test("atempoFilterChain chains stages within ffmpeg's 0.5–2 range", () => {
  assert.equal(atempoFilterChain(1.5), "atempo=1.50000000");
  assert.equal(atempoFilterChain(4), "atempo=2.00000000,atempo=2.00000000");
  assert.equal(atempoFilterChain(0.25), "atempo=0.50000000,atempo=0.50000000");
  assert.throws(() => atempoFilterChain(0));
});

test("tempoRatio and required duration math match the worker", () => {
  assert.equal(tempoRatio(120, 120), 1);
  assert.equal(tempoRatio(160, 80), 2);
  assert.equal(requiredSourceDurationMs(1000, 2), 2000);
  assert.equal(sourceDurationFits(0, 1000, 2, 2000), true);
  assert.equal(sourceDurationFits(100, 1000, 2, 2000), false);
  assert.throws(() => tempoRatio(120, 10));
});

test("pitchFilterChain shifts rate and restores duration", () => {
  const chain = pitchFilterChain(2, 44100);
  // 2 semitones up: asetrate ~49587 then aresample back, atempo ~0.891
  assert.ok(chain.startsWith("asetrate=49501,aresample=44100,atempo=0.89089"), chain);
  assert.throws(() => pitchFilterChain(12, 44100));
  assert.throws(() => pitchFilterChain(1, 0));
});

test("resolveKeySync distinguishes missing analysis from unusable keys", () => {
  assert.deepEqual(resolveKeySync("processing", "C major", "D major"), { errorCode: "key_sync_analysis_missing" });
  assert.deepEqual(resolveKeySync("complete", null, "D major"), { errorCode: "key_sync_key_unavailable" });
  const ok = resolveKeySync("complete", "C major", "D major");
  assert.deepEqual(ok, { semitones: 2 });
});

test("automation expression interpolates linear segments by time", () => {
  const points = [
    { id: "a", timelineMs: 0, value: 0.5 },
    { id: "b", timelineMs: 1000, value: 1.5 },
  ];
  const expression = ffmpegAutomationExpression(points, 1);
  assert.ok(expression.includes("if(lt(t\\,"), expression);
  assert.ok(expression.includes("*(t-0)/"), expression);
  // Empty lane falls back to the static default.
  assert.equal(ffmpegAutomationExpression([], 0.75), "0.75");
});

test("automatedTrackBusFilters builds the asplit/pan/join bus", () => {
  const filters = automatedTrackBusFilters(["[clip0]", "[clip1]"], "track0", [], [], 1, 0);
  assert.equal(filters.length, 5); // mixSum(1) + asplit + 2 pan-volume + join
  assert.ok(filters[0].startsWith("[clip0][clip1]amerge=inputs=2"));
  assert.ok(filters[1].includes("asplit=2"));
  assert.ok(filters[2].includes("pan=mono|c0=c0"));
  assert.ok(filters[4].includes("join=inputs=2:channel_layout=stereo"));
});

test("mixSumFilters chunks large label sets and sums unnormalized", () => {
  const labels = Array.from({ length: 40 }, (_, i) => `[c${i}]`);
  const filters = mixSumFilters(labels, "mix");
  // 40 labels → stage 0: chunks of 32 and 8; stage 1: their 2 sums → [mix]
  assert.equal(filters.length, 3);
  assert.ok(filters[0].includes("amerge=inputs=32"));
  assert.ok(filters[0].includes("c0=c0+c2+c4+c6"));
  assert.ok(filters[1].includes("amerge=inputs=8"));
  assert.ok(filters[2].includes("amerge=inputs=2"));
  assert.ok(filters[2].endsWith("[mix]"));
  // single stream passes through untouched
  assert.deepEqual(mixSumFilters(["[solo]"], "mix"), ["[solo]anull[mix]"]);
  assert.throws(() => mixSumFilters([], "mix"));
});

test("padToTimeline + timelineSampleCount compute exact render length", () => {
  const clips = [
    { timelineStartMs: 0, durationMs: 1000 },
    { timelineStartMs: 2000, durationMs: 1000 },
  ];
  assert.equal(timelineSampleCount(clips, 44100), 132300); // 3 s
  assert.equal(padToTimeline(44100, 132300, 1000), "apad=pad_len=88200"); // clip A pads 2 s
  assert.equal(padToTimeline(44100, 132300, 3000), "apad=pad_len=0"); // clip B ends at the timeline end
});

test("ffmpegFadeFilters: linear clips produce the historical byte-identical filters", () => {
  assert.equal(
    ffmpegFadeFilters({ fadeInMs: 250, fadeOutMs: 250, durationMs: 1000, fadeShape: "linear" }),
    "afade=t=in:st=0:d=0.250,afade=t=out:st=0.750:d=0.250",
  );
  // Missing shape = linear (historical snapshots).
  assert.equal(
    ffmpegFadeFilters({ fadeInMs: 250, fadeOutMs: 250, durationMs: 1000 }),
    "afade=t=in:st=0:d=0.250,afade=t=out:st=0.750:d=0.250",
  );
});

test("ffmpegFadeFilters: shaped fades append the exact afade curve", () => {
  // qsin = sin(t·π/2) is EXACTLY our equal-power curve; hsin = (1−cos(tπ))/2
  // is exactly our s-curve — preview and export agree by construction.
  assert.equal(
    ffmpegFadeFilters({ fadeInMs: 100, fadeOutMs: 0, durationMs: 1000, fadeShape: "equal-power" }),
    "afade=t=in:st=0:d=0.100:curve=qsin",
  );
  assert.equal(
    ffmpegFadeFilters({ fadeInMs: 0, fadeOutMs: 300, durationMs: 900, fadeShape: "s-curve" }),
    "afade=t=out:st=0.600:d=0.300:curve=hsin",
  );
  assert.equal(ffmpegFadeFilters({ fadeInMs: 0, fadeOutMs: 0, durationMs: 1000, fadeShape: "equal-power" }), "");
});
