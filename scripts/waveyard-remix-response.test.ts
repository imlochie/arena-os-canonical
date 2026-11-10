import assert from "node:assert/strict";
import test from "node:test";
import { remixFromResponse, type PersistedRemixResponse } from "../artifacts/arenaforge/src/components/waveyard/studio/remix-response";
import { remixState } from "../artifacts/arenaforge/src/components/waveyard/studio/types";

test("persisted donor metadata reaches Studio previews without becoming arrangement state", () => {
  const previewAsset = {
    id: "donor-a",
    durationSeconds: 245,
    sampleRate: 44_100,
    channels: 2,
    fileSizeBytes: 8_500_000,
  };
  const response = {
    remix: {
      id: "remix-a",
      name: "Arrangement",
      masterVolume: 1,
      loopStartMs: 0,
      loopEndMs: null,
      tempoBpm: 120,
      timeSignatureNumerator: 4,
      timeSignatureDenominator: 4,
      gridDivision: "beat",
      snapEnabled: true,
      targetKey: null,
    },
    tracks: [],
    automation: [],
    stems: [previewAsset],
  } satisfies PersistedRemixResponse;

  const remix = remixFromResponse(response);
  assert.deepEqual(remix.previewAssets, [previewAsset]);
  assert.equal("previewAssets" in remixState(remix), false);
});

test("keeps empty automation lanes when hydrating a completed automatic remix", () => {
  const stemTypes = ["bass", "drums", "other", "vocals"];
  const response: PersistedRemixResponse = {
    remix: {
      id: "automatic-remix",
      name: "Automatic original",
      masterVolume: 1,
      loopStartMs: 0,
      loopEndMs: null,
      tempoBpm: 120,
      timeSignatureNumerator: 4,
      timeSignatureDenominator: 4,
      gridDivision: "beat",
      snapEnabled: true,
      targetKey: "F# minor",
    },
    tracks: stemTypes.map((stemType, trackIndex) => ({
      id: `track-${stemType}`,
      stemAssetId: `stem-${stemType}`,
      name: `fixture.wav — ${stemType}`,
      sortOrder: trackIndex,
      volume: 1,
      pan: 0,
      muted: false,
      solo: false,
      clips: [0, 1, 2].map((windowIndex) => ({
        id: `${stemType}-clip-${windowIndex}`,
        stemAssetId: `stem-${stemType}`,
        timelineStartMs: windowIndex * 6_000,
        sourceOffsetMs: windowIndex * 6_000,
        durationMs: windowIndex === 2 ? 8_000 : 6_000,
        gain: 1,
        fadeInMs: 0,
        fadeOutMs: 0,
        tempoSyncEnabled: false,
        keySyncEnabled: false,
        beatSnapEnabled: false,
      })),
    })),
    automation: [],
  };

  const remix = remixFromResponse(response);
  assert.equal(remix.tracks.length, 4);
  assert.equal(remix.tracks.every((track) => track.clips), true);
  assert.equal(remix.tracks.flatMap((track) => track.clips).length, 12);
  assert.deepEqual(remix.automation, []);
  assert.doesNotThrow(() => remix.automation.find((lane) => lane.parameter === "volume"));
});
