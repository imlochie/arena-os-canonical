import test from "node:test";
import assert from "node:assert/strict";

import {
  clipTempoMapMatches,
  createPersistedClipTempoMap,
  makeLocalTempoMapWindow,
  parsePersistedClipTempoMap,
  renderLocalTempoMapRange,
  renderLocalTempoMapWhole,
  type LocalTempoMap,
} from "./local-tempo-map";

const map: LocalTempoMap = {
  points: [
    { sourceMs: 0, outputMs: 0 },
    { sourceMs: 1_000, outputMs: 1_005 },
    { sourceMs: 2_000, outputMs: 2_020 },
    { sourceMs: 3_000, outputMs: 3_025 },
    { sourceMs: 4_000, outputMs: 4_040 },
  ],
  baselineFit: { matchedBeats: 12, comparedBeats: 16, meanErrorMs: 46 },
  correctedFit: { matchedBeats: 15, comparedBeats: 16, meanErrorMs: 12 },
  maximumRateDeviationPercent: 1.5,
  entryShiftMs: 0,
};

function persistedMap() {
  return createPersistedClipTempoMap({
    clipId: "11111111-1111-4111-8111-111111111111",
    remixTrackId: "22222222-2222-4222-8222-222222222222",
    stemAssetId: "33333333-3333-4333-8333-333333333333",
    sourceAssetId: "44444444-4444-4444-8444-444444444444",
    sourceChecksumSha256: "a".repeat(64),
    stemChecksumSha256: "b".repeat(64),
    sourceOffsetMs: 2_000,
    timelineStartMs: 500,
    durationMs: 4_040,
    sessionTempoBpm: 120,
    baseStretchRatio: 1,
    map,
  });
}

test("local WSOLA map is strictly bounded and source/clip-bound", () => {
  const saved = persistedMap();
  assert.ok(saved);
  assert.deepEqual(parsePersistedClipTempoMap(JSON.parse(JSON.stringify(saved))), saved);
  const identity = {
    clipId: saved.clipId,
    remixTrackId: saved.remixTrackId,
    stemAssetId: saved.stemAssetId,
    sourceAssetId: saved.sourceAssetId,
    sourceChecksumSha256: saved.sourceChecksumSha256,
    stemChecksumSha256: saved.stemChecksumSha256,
    sourceOffsetMs: saved.sourceOffsetMs,
    timelineStartMs: saved.timelineStartMs,
    durationMs: saved.durationMs,
    sessionTempoBpm: saved.sessionTempoBpm,
    stemDurationMs: 10_000,
  };
  assert.equal(clipTempoMapMatches(saved, identity), true);
  assert.equal(clipTempoMapMatches(saved, { ...identity, sourceChecksumSha256: "c".repeat(64) }), false);
  assert.equal(clipTempoMapMatches(saved, { ...identity, timelineStartMs: 501 }), false);
  assert.equal(clipTempoMapMatches(saved, { ...identity, stemDurationMs: 5_998 }), false);

  assert.equal(parsePersistedClipTempoMap({
    ...saved,
    points: [...saved.points.slice(0, 2), { sourceMs: 1_000, outputMs: 900 }, ...saved.points.slice(3)],
  }), null, "non-monotonic points must be rejected");
  assert.equal(parsePersistedClipTempoMap({ ...saved, baseStretchRatio: 0.5 }), null,
    "rates outside the measured ±1.5% envelope must be rejected");
  assert.equal(parsePersistedClipTempoMap({ ...saved, stemChecksumSha256: "not-a-checksum" }), null);
});

function pulseSource(sampleRate: number) {
  const frames = 4 * sampleRate;
  const samples = new Float32Array(frames * 2);
  for (const milliseconds of [500, 1_500, 2_500, 3_500]) {
    const frame = Math.round(milliseconds * sampleRate / 1_000);
    for (let offset = 0; offset < 2; offset += 1) {
      samples[(frame + offset) * 2] = 0.9;
      samples[(frame + offset) * 2 + 1] = 0.9;
    }
  }
  return samples;
}

function renderWindow(
  source: Float32Array,
  sampleRate: number,
  startMs: number,
  durationMs: number,
) {
  const window = makeLocalTempoMapWindow(map, sampleRate, startMs, durationMs, 100);
  assert.ok(window);
  const input = source.subarray(window.inputStartFrame * 2, window.inputEndFrame * 2);
  const rendered = renderLocalTempoMapRange(input, sampleRate, window);
  assert.ok(rendered);
  return rendered;
}

function localOutputMsForSource(sourceMs: number) {
  for (let index = 1; index < map.points.length; index += 1) {
    const left = map.points[index - 1]!;
    const right = map.points[index]!;
    if (sourceMs > right.sourceMs) continue;
    const fraction = (sourceMs - left.sourceMs) / (right.sourceMs - left.sourceMs);
    return left.outputMs + fraction * (right.outputMs - left.outputMs);
  }
  return map.points.at(-1)!.outputMs;
}

function peakNear(samples: Float32Array, sampleRate: number, expectedMs: number) {
  const center = Math.round(expectedMs * sampleRate / 1_000);
  const radius = Math.round(sampleRate * 0.035);
  let peakFrame = center;
  let peak = -1;
  for (let frame = Math.max(0, center - radius); frame < Math.min(samples.length / 2, center + radius); frame += 1) {
    const magnitude = Math.max(Math.abs(samples[frame * 2]!), Math.abs(samples[frame * 2 + 1]!));
    if (magnitude > peak) {
      peak = magnitude;
      peakFrame = frame;
    }
  }
  return peakFrame * 1_000 / sampleRate;
}

test("bounded Studio preview windows preserve mapped transient timing from the full-clip WSOLA render", () => {
  const sampleRate = 8_000;
  const source = pulseSource(sampleRate);
  const full = renderLocalTempoMapWhole(source, sampleRate, map);
  assert.ok(full);
  const splitAtMs = 2_020;
  const left = renderWindow(source, sampleRate, 0, splitAtMs);
  const right = renderWindow(source, sampleRate, splitAtMs, 4_040 - splitAtMs);
  const windowed = new Float32Array(left.length + right.length);
  windowed.set(left);
  windowed.set(right, left.length);
  assert.equal(windowed.length, full.length);

  let maximumWholeTimingErrorMs = 0;
  let maximumChunkDifferenceMs = 0;
  for (const sourceMs of [500, 1_500, 2_500, 3_500]) {
    const expectedMs = localOutputMsForSource(sourceMs);
    const wholeMs = peakNear(full, sampleRate, expectedMs);
    const chunkedMs = peakNear(windowed, sampleRate, expectedMs);
    maximumWholeTimingErrorMs = Math.max(maximumWholeTimingErrorMs, Math.abs(wholeMs - expectedMs));
    maximumChunkDifferenceMs = Math.max(maximumChunkDifferenceMs, Math.abs(chunkedMs - wholeMs));
    assert.ok(Math.abs(wholeMs - expectedMs) <= 25,
      `full WSOLA transient at ${wholeMs.toFixed(1)} ms should follow map target ${expectedMs.toFixed(1)} ms`);
    assert.ok(Math.abs(chunkedMs - wholeMs) <= 15,
      `chunked preview at ${chunkedMs.toFixed(1)} ms should agree with full render at ${wholeMs.toFixed(1)} ms`);
  }
  console.info(JSON.stringify({
    waveyardLocalTempoMapTiming: {
      pulseCount: 4,
      maxFullRenderTimingErrorMs: Number(maximumWholeTimingErrorMs.toFixed(1)),
      maxChunkVsFullDifferenceMs: Number(maximumChunkDifferenceMs.toFixed(1)),
      chunkBoundaryMs: splitAtMs,
    },
  }));
});
