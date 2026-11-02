import assert from "node:assert/strict";
import test from "node:test";
import type { RemixTrackInput } from "./remix";
import { selectArrangementPreviewTracks } from "./arrangement-preview-selection";

function track(id: string, stemAssetId: string, muted = false, solo = false) {
  return {
    id,
    muted,
    solo,
    clips: [{ stemAssetId }],
  } as unknown as RemixTrackInput;
}

test("arrangement preview decodes only unmuted tracks and keeps their distinct clip donors", () => {
  const result = selectArrangementPreviewTracks([
    track("drums", "clip-drums"),
    track("vocals", "clip-vocals", true),
    track("bass", "clip-bass"),
  ]);

  assert.deepEqual(result.audibleTracks.map(({ id }) => id), ["drums", "bass"]);
  assert.deepEqual(result.assetIds, ["clip-drums", "clip-bass"]);
});

test("solo preview excludes other lanes before decoding their clip donors", () => {
  const result = selectArrangementPreviewTracks([
    track("drums", "muted-drums", false, false),
    track("vocals", "solo-vocals", false, true),
    track("bass", "muted-bass", false, false),
    track("other", "explicitly-muted", true, false),
  ]);

  assert.deepEqual(result.audibleTracks.map(({ id }) => id), ["vocals"]);
  assert.deepEqual(result.assetIds, ["solo-vocals"]);
});
