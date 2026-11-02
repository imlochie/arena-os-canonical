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
