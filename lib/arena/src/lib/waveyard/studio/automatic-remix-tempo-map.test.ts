import assert from "node:assert/strict";
import test from "node:test";

import {
  automaticRemixTempoMap,
  type AutomaticRemixTempoMapInput,
} from "./automatic-remix-tempo-map";
import { clipTempoMapMatches } from "./local-tempo-map";

const ids = {
  clip: "11111111-1111-4111-8111-111111111111",
  track: "22222222-2222-4222-8222-222222222222",
  stem: "33333333-3333-4333-8333-333333333333",
  source: "44444444-4444-4444-8444-444444444444",
};

function fixture(overrides: Partial<AutomaticRemixTempoMapInput> = {}): AutomaticRemixTempoMapInput {
  return {
    clip: {
      id: ids.clip,
      remixTrackId: ids.track,
      stemAssetId: ids.stem,
      sourceOffsetMs: 1_000,
      timelineStartMs: 5_000,
      durationMs: 5_000,
      tempoSyncEnabled: true,
    },
    stem: {
      id: ids.stem,
      sourceAssetId: ids.source,
      checksumSha256: "b".repeat(64),
      durationSeconds: 8,
      channels: 2,
      format: "wav",
    },
    source: { id: ids.source, checksumSha256: "a".repeat(64) },
    analysis: {
      status: "complete",
      analysisEngine: "arena-js-dsp",
      analysisEngineVersion: "1.4.0",
      sourceChecksumSha256: "a".repeat(64),
      bpm: 120,
      bpmConfidence: 0.9,
    },
    sessionTempoBpm: 100,
    ...overrides,
  };
}

test("automatic tempo sync persists the source-to-output transform for the saved clip", () => {
  const result = automaticRemixTempoMap(fixture());
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.map.clipId, ids.clip);
  assert.equal(result.map.remixTrackId, ids.track);
  assert.equal(result.map.stemAssetId, ids.stem);
  assert.equal(result.map.sessionTempoBpm, 100);
  assert.equal(result.map.baseStretchRatio, 1.2);
  assert.equal(result.map.timelineStartMs, 5_000);
  assert.equal(result.map.durationMs, 5_000);
  assert.equal(result.map.points.length, 3);
  assert.equal(result.map.points.at(-1)?.outputMs, 5_000);
  assert.ok(Math.abs(result.map.points.at(-1)!.sourceMs - (5_000 / 1.2)) < 0.01);
  assert.equal(clipTempoMapMatches(result.map, {
    clipId: ids.clip,
    remixTrackId: ids.track,
    stemAssetId: ids.stem,
    sourceAssetId: ids.source,
    sourceChecksumSha256: "a".repeat(64),
    stemChecksumSha256: "b".repeat(64),
    sourceOffsetMs: 1_000,
    timelineStartMs: 5_000,
    durationMs: 5_000,
    sessionTempoBpm: 100,
    stemDurationMs: 8_000,
  }), true);
});

test("persisted tempo map uses a stable current beat grid when raw BPM confidence is weak", () => {
  const beatGridMs = Array.from({ length: 41 }, (_, index) => Math.round(index * 60_000 / 110));
  const result = automaticRemixTempoMap(fixture({
    stem: { ...fixture().stem, durationSeconds: 10 },
    analysis: {
      status: "complete",
      analysisEngine: "arena-js-dsp",
      analysisEngineVersion: "1.4.0",
      sourceChecksumSha256: "a".repeat(64),
      bpm: 109.957,
      bpmConfidence: 0.426,
      beatConfidence: 0.642,
      beatGridMs,
      durationMs: 22_000,
    },
  }));
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.ok(Math.abs(result.map.baseStretchRatio - 1.1) < 0.002);
  assert.ok(Math.abs(result.map.points.at(-1)!.sourceMs - (5_000 / 1.1)) < 10);
  assert.equal(result.map.sessionTempoBpm, 100);
});

test("automatic tempo sync refuses stale or mismatched source evidence", () => {
  const stale = fixture({
    analysis: {
      status: "complete",
      analysisEngine: "arena-js-dsp",
      analysisEngineVersion: "1.4.0",
      sourceChecksumSha256: "c".repeat(64),
      bpm: 120,
      bpmConfidence: 0.9,
    },
  });
  const staleResult = automaticRemixTempoMap(stale);
  assert.equal(staleResult.ok, false);
  if (!staleResult.ok) assert.match(staleResult.reason, /BPM evidence/);

  const crossSource = fixture({
    stem: { ...fixture().stem, sourceAssetId: "55555555-5555-4555-8555-555555555555" },
  });
  const crossSourceResult = automaticRemixTempoMap(crossSource);
  assert.equal(crossSourceResult.ok, false);
  if (!crossSourceResult.ok) assert.match(crossSourceResult.reason, /identities/);
});

test("automatic tempo sync refuses unsupported audio and source spans beyond the stem", () => {
  const mono = fixture({ stem: { ...fixture().stem, channels: 1 } });
  const monoResult = automaticRemixTempoMap(mono);
  assert.equal(monoResult.ok, false);
  if (!monoResult.ok) assert.match(monoResult.reason, /stereo WAV/);

  const tooLong = fixture({
    clip: { ...fixture().clip, sourceOffsetMs: 0, durationMs: 10_000 },
  });
  const tooLongResult = automaticRemixTempoMap(tooLong);
  assert.equal(tooLongResult.ok, false);
  if (!tooLongResult.ok) assert.match(tooLongResult.reason, /does not contain/);
});
