import { describe, it } from "node:test";
import { expect } from "../../test-shim";
import { proposeArrangementExtension, type ArrangementExtensionAnchor } from "../index";

const anchor: ArrangementExtensionAnchor = {
  clipId: "clip-a", remixTrackId: "track-a", stemAssetId: "stem-a", stemType: "other",
  timelineStartMs: 8_000, durationMs: 16_000, sourceOffsetMs: 32_000, gain: 0.82, fadeInMs: 0, fadeOutMs: 0,
  tempoSyncEnabled: true, keySyncEnabled: true, beatSnapEnabled: true, barCount: 8,
};

describe("Extended Arrangement Intelligence", () => {
  it("keeps the selected source window as an eight-bar repeat", () => {
    const proposal = proposeArrangementExtension({ anchor, intent: "repeat-section", arrangementEndMs: 48_000 });
    expect(proposal).toMatchObject({ insertionTimelineMs: 24_000, shiftFollowingByMs: 16_000, sourceOffsetMs: 32_000, durationMs: 16_000, barCount: 8, tempoSyncEnabled: true, keySyncEnabled: true, beatSnapEnabled: true });
    expect(proposal?.reasons[0]).toContain("8-bar");
  });

  it("extends intro by inserting before the backbone and outro by appending", () => {
    expect(proposeArrangementExtension({ anchor, intent: "extend-intro", arrangementEndMs: 48_000 })).toMatchObject({ insertionTimelineMs: 0, shiftFollowingByMs: 16_000 });
    expect(proposeArrangementExtension({ anchor, intent: "extend-outro", arrangementEndMs: 48_000 })).toMatchObject({ insertionTimelineMs: 48_000, shiftFollowingByMs: 0 });
  });

  it("keeps an instrumental break scoped to the user-selected track", () => {
    const proposal = proposeArrangementExtension({ anchor, intent: "instrumental-break", arrangementEndMs: 48_000 });
    expect(proposal?.reasons).toContain("uses only the user-selected track; no other sources are added");
  });

  it("is repeatable and refuses invalid anchors instead of inventing a window", () => {
    expect(proposeArrangementExtension({ anchor, intent: "repeat-section", arrangementEndMs: 48_000 })).toEqual(proposeArrangementExtension({ anchor, intent: "repeat-section", arrangementEndMs: 48_000 }));
    expect(proposeArrangementExtension({ anchor: { ...anchor, durationMs: 0 }, intent: "repeat-section", arrangementEndMs: 48_000 })).toBeNull();
  });
});
