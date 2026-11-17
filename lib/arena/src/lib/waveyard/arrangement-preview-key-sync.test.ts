import assert from "node:assert/strict";
import test from "node:test";
import { withArrangementPreviewKeySync } from "./arrangement-preview-key-sync";

const clip = {
  id: "clip",
  stemAssetId: "stem",
  timelineStartMs: 0,
  durationMs: 1_000,
  sourceOffsetMs: 0,
  gain: 1,
  fadeInMs: 0,
  fadeOutMs: 0,
  tempoSyncEnabled: false,
  keySyncEnabled: true,
  beatSnapEnabled: false,
};

const state = {
  targetKey: "D major",
  tracks: [{ id: "track", stemAssetId: "stem", name: "Vocals", sortOrder: 0, volume: 1, pan: 0, muted: false, solo: false, clips: [clip] }],
};

test("preview resolves enabled key sync from trusted source keys without changing persisted clips", () => {
  const preview = withArrangementPreviewKeySync(state, new Map([["stem", "C major"]]));
  assert.equal(preview.tracks[0]?.clips[0]?.previewKeyShiftSemitones, 2);
  assert.equal(state.tracks[0]?.clips[0]?.keySyncEnabled, true);
  assert.equal("previewKeyShiftSemitones" in state.tracks[0]!.clips[0]!, false);
});

test("preview leaves key-sync clips unavailable when source or target evidence is missing", () => {
  assert.equal(
    withArrangementPreviewKeySync(state, new Map()).tracks[0]?.clips[0]?.previewKeyShiftSemitones,
    null,
  );
  assert.equal(
    withArrangementPreviewKeySync({ ...state, targetKey: null }, new Map([["stem", "C major"]]))
      .tracks[0]?.clips[0]?.previewKeyShiftSemitones,
    null,
  );
});

test("preview does not add pitch instructions to clips with key sync disabled", () => {
  const disabled = { ...state, tracks: [{ ...state.tracks[0]!, clips: [{ ...clip, keySyncEnabled: false }] }] };
  const preview = withArrangementPreviewKeySync(disabled, new Map([["stem", "C major"]]));
  assert.equal("previewKeyShiftSemitones" in preview.tracks[0]!.clips[0]!, false);
});
