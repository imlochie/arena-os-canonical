import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isEffectivelyMuted,
  resolveActiveMixerState,
  type MixerValues,
} from "./useStemTransport";

test("active stem state ignores solo controls left behind by a removed bank", () => {
  const previousMix: Record<string, MixerValues> = {
    "old-vocals": { volume: 0.4, pan: -0.2, muted: false, solo: true },
    "old-drums": { volume: 0.8, pan: 0.1, muted: false, solo: false },
  };

  const state = resolveActiveMixerState(
    ["new-vocals", "new-drums", "new-bass", "new-other"],
    previousMix,
  );

  assert.equal(state.anySolo, false);
  assert.deepEqual(Object.keys(state.controls), [
    "new-vocals",
    "new-drums",
    "new-bass",
    "new-other",
  ]);
  assert.deepEqual(state.controls["new-vocals"], {
    volume: 1,
    pan: 0,
    muted: false,
    solo: false,
  });
  assert.equal(isEffectivelyMuted(state.controls["new-vocals"], state.anySolo), false);
});

test("solo on a current stem silences only the other active channels", () => {
  const state = resolveActiveMixerState(
    ["vocals", "drums", "bass", "other"],
    {
      "removed-vocals": { volume: 1, pan: 0, muted: false, solo: true },
      vocals: { volume: 0.6, pan: 0, muted: false, solo: true },
    },
  );

  assert.equal(state.anySolo, true);
  assert.equal(isEffectivelyMuted(state.controls.vocals, state.anySolo), false);
  assert.equal(isEffectivelyMuted(state.controls.drums, state.anySolo), true);
  assert.equal(isEffectivelyMuted(state.controls.bass, state.anySolo), true);
  assert.equal(isEffectivelyMuted(state.controls.other, state.anySolo), true);
});
