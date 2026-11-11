import assert from "node:assert/strict";
import test from "node:test";

import { arrangementPreviewGainCurve, hasArrangementVolumeAutomation } from "./arrangement-preview-gain";

test("arrangement preview applies saved absolute track-volume automation to clip gain", () => {
  const automation = [{
    remixTrackId: "donor-drums",
    parameter: "volume" as const,
    points: [
      { timelineMs: 0, value: 0.6 },
      { timelineMs: 1_000, value: 0.432 },
      { timelineMs: 2_000, value: 0.6 },
    ],
  }];
  const curve = arrangementPreviewGainCurve({
    trackId: "donor-drums",
    trackVolume: 0.6,
    automation,
    clip: { gain: 0.5, durationMs: 2_000, fadeInMs: 0, fadeOutMs: 0 },
    clipElapsedMs: 0,
    timelineStartMs: 0,
    durationMs: 2_000,
    samples: 5,
  });

  assert.deepEqual([...curve].map((value) => Number(value.toFixed(3))), [0.3, 0.258, 0.216, 0.258, 0.3]);
  assert.equal(hasArrangementVolumeAutomation(automation, "donor-drums"), true);
  assert.equal(hasArrangementVolumeAutomation(automation, "lead-vocals"), false);
});

test("arrangement preview combines saved volume automation with clip fades and seek offsets", () => {
  const curve = arrangementPreviewGainCurve({
    trackId: "donor",
    trackVolume: 0.6,
    automation: [{
      remixTrackId: "donor",
      parameter: "volume",
      points: [{ timelineMs: 0, value: 0.3 }, { timelineMs: 2_000, value: 0.5 }],
    }],
    clip: { gain: 0.8, durationMs: 4_000, fadeInMs: 1_000, fadeOutMs: 1_000 },
    clipElapsedMs: 500,
    timelineStartMs: 1_000,
    durationMs: 1_000,
    samples: 3,
  });

  assert.deepEqual([...curve].map((value) => Number(value.toFixed(3))), [0.16, 0.36, 0.4]);
});
