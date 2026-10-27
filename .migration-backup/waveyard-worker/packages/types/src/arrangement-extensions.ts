export const ARRANGEMENT_EXTENSION_INTENTS = ["extend-intro", "extend-outro", "repeat-section", "instrumental-break"] as const;
export type ArrangementExtensionIntent = (typeof ARRANGEMENT_EXTENSION_INTENTS)[number];

export type ArrangementExtensionAnchor = {
  clipId: string;
  remixTrackId: string;
  stemAssetId: string;
  stemType: string;
  timelineStartMs: number;
  durationMs: number;
  sourceOffsetMs: number;
  gain: number;
  fadeInMs: number;
  fadeOutMs: number;
  tempoSyncEnabled: boolean;
  keySyncEnabled: boolean;
  beatSnapEnabled: boolean;
  barCount: number | null;
};

export type ArrangementExtensionProposal = {
  id: string;
  intent: ArrangementExtensionIntent;
  anchorClipId: string;
  insertionTimelineMs: number;
  shiftFollowingByMs: number;
  sourceOffsetMs: number;
  durationMs: number;
  barCount: number | null;
  tempoSyncEnabled: boolean;
  keySyncEnabled: boolean;
  beatSnapEnabled: boolean;
  reasons: string[];
};

function validAnchor(anchor: ArrangementExtensionAnchor) {
  return Number.isSafeInteger(anchor.timelineStartMs) && anchor.timelineStartMs >= 0
    && Number.isSafeInteger(anchor.durationMs) && anchor.durationMs > 0;
}

/**
 * Derives an explicit extension of a user-selected existing clip. It neither
 * selects new sources nor rewrites the backbone: acceptance only inserts a
 * normal clip and, when requested, shifts later ordinary clips together.
 */
export function proposeArrangementExtension(input: {
  anchor: ArrangementExtensionAnchor;
  intent: ArrangementExtensionIntent;
  arrangementEndMs: number;
}): ArrangementExtensionProposal | null {
  const { anchor, intent } = input;
  if (!validAnchor(anchor) || !Number.isSafeInteger(input.arrangementEndMs) || input.arrangementEndMs < 0) return null;
  const anchorEnd = anchor.timelineStartMs + anchor.durationMs;
  const insertionTimelineMs = intent === "extend-intro" ? 0
    : intent === "extend-outro" ? Math.max(anchorEnd, input.arrangementEndMs)
      : anchorEnd;
  const shiftFollowingByMs = intent === "extend-outro" ? 0 : anchor.durationMs;
  const unit = anchor.barCount && [4, 8, 16].includes(anchor.barCount)
    ? `${anchor.barCount}-bar source unit`
    : "selected source window";
  const reasons = [
    `preserves the selected ${unit}`,
    intent === "extend-intro" ? "shifts the existing arrangement together after the new intro material"
      : intent === "extend-outro" ? "appends after the current arrangement ending"
        : "inserts after the selected region and keeps later material in order",
  ];
  if (intent === "instrumental-break") reasons.push("uses only the user-selected track; no other sources are added");
  return {
    id: `extension:${intent}:${anchor.clipId}:${insertionTimelineMs}:${anchor.durationMs}`,
    intent,
    anchorClipId: anchor.clipId,
    insertionTimelineMs,
    shiftFollowingByMs,
    sourceOffsetMs: anchor.sourceOffsetMs,
    durationMs: anchor.durationMs,
    barCount: anchor.barCount,
    tempoSyncEnabled: anchor.tempoSyncEnabled,
    keySyncEnabled: anchor.keySyncEnabled,
    beatSnapEnabled: anchor.beatSnapEnabled,
    reasons,
  };
}
