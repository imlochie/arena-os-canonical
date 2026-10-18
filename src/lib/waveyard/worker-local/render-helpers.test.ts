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
  assert.equal(padToTimeline(44100, 132300, 1000), "apad=pad_len=88200,aformat=channel_layouts=stereo"); // clip A pads 2 s
  assert.equal(padToTimeline(44100, 132300, 3000), "apad=pad_len=0,aformat=channel_layouts=stereo"); // clip B ends at the timeline end
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

test("bundled FFmpeg renders two delayed stereo clips without losing channel-layout negotiation", async () => {
  const { execTool } = await import("@/lib/waveyard/ffmpeg");
  const { mkdtemp, readFile, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "arena-stereo-render-"));
  try {
    for (const [index, hz] of [220, 440].entries()) {
      const frames = 44100, wav = Buffer.alloc(44 + frames * 4);
      wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
      wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22);
      wav.writeUInt32LE(44100, 24); wav.writeUInt32LE(176400, 28); wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34);
      wav.write("data", 36); wav.writeUInt32LE(frames * 4, 40);
      for (let n = 0; n < frames; n++) for (let channel = 0; channel < 2; channel++) wav.writeInt16LE(Math.round(8192 * Math.sin(2 * Math.PI * hz * n / 44100)), 44 + n * 4 + channel * 2);
      await writeFile(join(root, `${index}.wav`), wav);
    }
    const filters = [0, 1].map((index) => `[${index}:a]atrim=start=0:duration=1,asetpts=PTS-STARTPTS,aformat=sample_rates=44100:channel_layouts=stereo,pan=stereo|c0=0.707107*c0|c1=0.707107*c1,volume=1,adelay=${index * 1000}|${index * 1000},${padToTimeline(44100, 88200, (index + 1) * 1000)}[clip${index}]`);
    filters.push(...mixSumFilters(["[clip0]", "[clip1]"], "premaster"), "[premaster]volume=0.4,aresample=out_sample_fmt=s16:dither_method=triangular_hp[mix]");
    const output = join(root, "render.wav");
    await execTool("ffmpeg", ["-v", "error", "-i", join(root, "0.wav"), "-i", join(root, "1.wav"), "-filter_complex", filters.join(";"), "-map", "[mix]", "-c:a", "pcm_s16le", "-y", output]);
    const pcm = join(root, "render.pcm");
    await execTool("ffmpeg", ["-v", "error", "-i", output, "-ac", "1", "-f", "s16le", "-y", pcm]);
    const bytes = await readFile(pcm);
    assert.equal(bytes.length, 88200 * 2, "full sequential timeline exported");
    for (const [second, hz] of [220, 440].entries()) {
      let real = 0, imaginary = 0;
      for (let n = 0; n < 22050; n++) {
        const sample = bytes.readInt16LE((second * 44100 + n) * 2) / 32768;
        real += sample * Math.cos(2 * Math.PI * hz * n / 44100);
        imaginary += sample * Math.sin(2 * Math.PI * hz * n / 44100);
      }
      const magnitude = 2 * Math.hypot(real, imaginary) / 22050;
      assert.ok(Math.abs(magnitude - 0.07071) < 0.001, `expected source ${hz}Hz at saved master gain, got ${magnitude}`);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
