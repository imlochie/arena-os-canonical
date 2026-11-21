import { normaliseMusicalKey, semitoneShift, type MusicalKey } from "./musical-key";
import { tempoRatioForBpm, usableBeatGrid } from "./beat-grid";
import type { VocalActivityInterval } from "./vocal-analysis";

export const MUSICAL_MEETING_POINT_ENGINE = "waveyard-musical-meeting-points";
export const MUSICAL_MEETING_POINT_ENGINE_VERSION = "1";
export const MUSICAL_MEETING_POINT_STATES = ["ready", "possible", "experimental"] as const;
export type MusicalMeetingPointState = (typeof MUSICAL_MEETING_POINT_STATES)[number];

export type MeetingPointAnalysis = {
  status: string;
  sourceChecksumSha256: string;
  bpm: number | null;
  musicalKey: string | null;
  beatGridMs: unknown;
};

export type VocalSlotEvidence =
  | { status: "measured"; overlapRatio: number }
  | { status: "no-existing-vocal-clip"; overlapRatio: null }
  | { status: "unavailable"; overlapRatio: null };

/**
 * Projects checksum-current isolated-vocal activity through the same source
 * window and tempo transform as its saved arrangement clip. A null result is
 * unavailable evidence; an empty list is a measured clip with no detected
 * vocal activity.
 */
export function projectVocalActivityToTimeline(input: {
  timelineStartMs: number;
  durationMs: number;
  sourceOffsetMs: number;
  sourceDurationMs: number;
  tempoRatio: number;
  intervals: readonly VocalActivityInterval[] | null;
}): VocalActivityInterval[] | null {
  const { timelineStartMs, durationMs, sourceOffsetMs, sourceDurationMs, tempoRatio, intervals } = input;
  if (intervals === null
    || ![timelineStartMs, durationMs, sourceOffsetMs, sourceDurationMs, tempoRatio].every(Number.isFinite)
    || ![timelineStartMs, durationMs, sourceOffsetMs].every(Number.isSafeInteger)
    || timelineStartMs < 0 || durationMs <= 0 || sourceOffsetMs < 0 || sourceDurationMs <= 0 || tempoRatio <= 0)
    return null;
  if (!Number.isSafeInteger(timelineStartMs + durationMs)
    || !Number.isFinite(sourceOffsetMs + durationMs * tempoRatio)) return null;
  const sourceEndMs = Math.min(sourceDurationMs, sourceOffsetMs + durationMs * tempoRatio);
  if (sourceEndMs <= sourceOffsetMs) return null;
  const result: VocalActivityInterval[] = [];
  for (const interval of intervals) {
    if (![interval.startMs, interval.endMs, interval.confidence].every(Number.isFinite)
      || !Number.isSafeInteger(interval.startMs) || !Number.isSafeInteger(interval.endMs)
      || interval.startMs < 0 || interval.endMs <= interval.startMs
      || interval.confidence < 0 || interval.confidence > 1)
      return null;
    const startMs = Math.max(sourceOffsetMs, interval.startMs);
    const endMs = Math.min(sourceEndMs, interval.endMs);
    if (endMs <= startMs) continue;
    result.push({
      startMs: Math.max(timelineStartMs, Math.round(timelineStartMs + (startMs - sourceOffsetMs) / tempoRatio)),
      endMs: Math.min(timelineStartMs + durationMs, Math.round(timelineStartMs + (endMs - sourceOffsetMs) / tempoRatio)),
      confidence: interval.confidence,
    });
  }
  return result.filter((interval) => interval.endMs > interval.startMs)
    .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
}

/** Fraction of a timeline window covered by the union of measured vocal activity. */
export function vocalActivityOverlapRatio(
  timelineStartMs: number,
  durationMs: number,
  intervals: readonly VocalActivityInterval[] | null,
): number | null {
  if (intervals === null || !Number.isSafeInteger(timelineStartMs) || timelineStartMs < 0
    || !Number.isSafeInteger(durationMs) || durationMs <= 0
    || !Number.isSafeInteger(timelineStartMs + durationMs)) return null;
  const endMs = timelineStartMs + durationMs;
  const clipped: Array<{ start: number; end: number }> = [];
  for (const interval of intervals) {
    if (!Number.isSafeInteger(interval.startMs) || !Number.isSafeInteger(interval.endMs)
      || interval.endMs <= interval.startMs || !Number.isFinite(interval.confidence)
      || interval.startMs < 0 || interval.confidence < 0 || interval.confidence > 1) return null;
    const start = Math.max(timelineStartMs, interval.startMs);
    const end = Math.min(endMs, interval.endMs);
    if (end > start) clipped.push({ start, end });
  }
  clipped.sort((left, right) => left.start - right.start || left.end - right.end);
  let coveredMs = 0;
  let unionStart: number | null = null;
  let unionEnd = 0;
  for (const interval of clipped) {
    if (unionStart === null) {
      unionStart = interval.start;
      unionEnd = interval.end;
    } else if (interval.start <= unionEnd) {
      unionEnd = Math.max(unionEnd, interval.end);
    } else {
      coveredMs += unionEnd - unionStart;
      unionStart = interval.start;
      unionEnd = interval.end;
    }
  }
  if (unionStart !== null) coveredMs += unionEnd - unionStart;
  return Math.max(0, Math.min(1, coveredMs / durationMs));
}

export type MeetingPointSourceRegion = {
  sourceAssetId: string;
  stemAssetId: string;
  stemType?: string;
  sourceChecksumSha256: string;
  sectionId: string | null;
  startBeatIndex: number;
  endBeatIndex: number;
  startMs: number;
  endMs: number;
  phraseBoundaryStart: boolean;
  phraseBoundaryEnd: boolean;
  /** Manual labels are human evidence, not detector output. */
  sectionEvidence?: "detected" | "manual" | null;
  analysis: MeetingPointAnalysis | null;
};

export type MeetingPointTargetRegion = {
  targetClipId: string;
  sourceAssetId: string;
  sourceChecksumSha256: string;
  timelineStartMs: number;
  durationMs: number;
  barCount: number | null;
  sectionId: string | null;
  beatAligned: boolean;
  analysis: MeetingPointAnalysis | null;
  vocalSlotEvidence?: VocalSlotEvidence | null;
};

export type MusicalMeetingPoint = {
  id: string;
  state: MusicalMeetingPointState;
  source: Pick<MeetingPointSourceRegion, "sourceAssetId" | "stemAssetId" | "sectionId" | "startBeatIndex" | "endBeatIndex" | "startMs" | "endMs">;
  target: Pick<MeetingPointTargetRegion, "targetClipId" | "sourceAssetId" | "timelineStartMs" | "durationMs" | "barCount" | "sectionId">;
  barCount: number | null;
  tempoRatio: number | null;
  tempoSyncEnabled: boolean;
  sourceKey: MusicalKey | null;
  targetKey: MusicalKey | null;
  keyShiftSemitones: number | null;
  keySyncEnabled: boolean;
  beatSnapEnabled: boolean;
  phraseAligned: boolean;
  sectionAligned: boolean;
  reasons: string[];
  vocalSlotEvidence: VocalSlotEvidence | null;
};

function sourceBars(region: MeetingPointSourceRegion) {
  const count = region.endBeatIndex - region.startBeatIndex;
  return Number.isInteger(count) && count > 0 && count % 4 === 0 ? count / 4 : null;
}

function verifiedAnalysis(analysis: MeetingPointAnalysis | null, checksum: string) {
  return analysis?.status === "complete" && analysis.sourceChecksumSha256 === checksum && usableBeatGrid(analysis.beatGridMs);
}

function stablePointId(source: MeetingPointSourceRegion, target: MeetingPointTargetRegion) {
  return `meeting:${source.stemAssetId}:${source.sectionId ?? `${source.startMs}-${source.endMs}`}:${target.targetClipId}`;
}

/**
 * Discovers descriptive placement recommendations from existing source analysis
 * and an existing remix timeline. This returns no clips and changes no musical
 * state; accepting one is a separate ordinary RemixClip mutation.
 */
export function discoverMusicalMeetingPoints(input: {
  source: MeetingPointSourceRegion;
  targets: MeetingPointTargetRegion[];
  remixBpm: number;
  targetKey: string | null;
}): MusicalMeetingPoint[] {
  const sourceAnalysis = verifiedAnalysis(input.source.analysis, input.source.sourceChecksumSha256);
  if (!sourceAnalysis) return [];
  const bars = sourceBars(input.source);
  const sourceKey = normaliseMusicalKey(input.source.analysis?.musicalKey);
  const projectKey = normaliseMusicalKey(input.targetKey);
  const sourceBpm = input.source.analysis?.bpm ?? null;
  const ratio = tempoRatioForBpm(input.remixBpm, sourceBpm ?? Number.NaN);
  if (!ratio) return [];
  return input.targets
    .filter((target) => Number.isSafeInteger(target.timelineStartMs) && target.timelineStartMs >= 0 && target.durationMs > 0)
    .map((target) => {
      const targetAnalysis = verifiedAnalysis(target.analysis, target.sourceChecksumSha256);
      const equalBars = bars !== null && target.barCount !== null && bars === target.barCount;
      const sectionAligned = input.source.sectionEvidence !== "manual"
        && Boolean(input.source.sectionId && target.sectionId);
      const phraseAligned = input.source.phraseBoundaryStart && input.source.phraseBoundaryEnd;
      const sourceWindowFits = input.source.startMs + Math.round(target.durationMs * ratio) <= input.source.endMs;
      const keyShift = sourceKey && projectKey ? semitoneShift(sourceKey, projectKey) : null;
      const tempoSyncEnabled = Math.abs(ratio - 1) > 0.0001;
      const keySyncEnabled = keyShift !== null && keyShift !== 0;
      const reasons: string[] = [];
      if (equalBars) reasons.push(`${bars} bars match the current window`);
      else reasons.push("bar count differs from the current window");
      if (target.beatAligned) reasons.push("target starts on the remix beat grid");
      else reasons.push("target is not currently beat-aligned");
      if (tempoSyncEnabled) reasons.push(`tempo transform required (${ratio.toFixed(4)}×)`);
      else reasons.push("native tempo matches the remix");
      if (projectKey && sourceKey) reasons.push(keySyncEnabled ? `key transform required (${keyShift! >= 0 ? "+" : ""}${keyShift} semitones)` : "native key matches the remix");
      else reasons.push("key relationship is unavailable; no key shift will be applied");
      if (phraseAligned) reasons.push("source region begins and ends on vocal phrase boundaries");
      if (sectionAligned) reasons.push("both sides use detected section boundaries");
      if (input.source.sectionEvidence === "manual") reasons.push("source range and role were marked by the user; the fit remains an analysis recommendation");
      if (input.source.stemType === "vocals") {
        if (target.vocalSlotEvidence?.status === "measured") {
          reasons.push(`existing vocal-role activity overlaps ${Math.round(target.vocalSlotEvidence.overlapRatio * 100)}% of this window`);
        } else if (target.vocalSlotEvidence?.status === "no-existing-vocal-clip") {
          reasons.push("no existing vocal-role clip occupies this window");
        } else {
          reasons.push("existing vocal-role activity is unavailable; no vocal-slot preference was applied");
        }
      }
      if (!sourceWindowFits) reasons.push("source section is shorter than this timeline window");
      if (!targetAnalysis) reasons.push("target source analysis is unavailable");
      const state: MusicalMeetingPointState = equalBars && target.beatAligned && sourceWindowFits && Boolean(projectKey && sourceKey) && Boolean(targetAnalysis)
        ? "ready"
        : equalBars && target.beatAligned && sourceWindowFits && Boolean(targetAnalysis)
          ? "possible"
          : "experimental";
      return {
        id: stablePointId(input.source, target),
        state,
        source: {
          sourceAssetId: input.source.sourceAssetId,
          stemAssetId: input.source.stemAssetId,
          sectionId: input.source.sectionId,
          startBeatIndex: input.source.startBeatIndex,
          endBeatIndex: input.source.endBeatIndex,
          startMs: input.source.startMs,
          endMs: input.source.endMs,
        },
        target: {
          targetClipId: target.targetClipId,
          sourceAssetId: target.sourceAssetId,
          timelineStartMs: target.timelineStartMs,
          durationMs: target.durationMs,
          barCount: target.barCount,
          sectionId: target.sectionId,
        },
        barCount: bars,
        tempoRatio: ratio,
        tempoSyncEnabled,
        sourceKey,
        targetKey: projectKey,
        keyShiftSemitones: keyShift,
        keySyncEnabled,
        // A human-marked vocal boundary may deliberately include a pickup or
        // sit ahead/behind the beat. The target timeline is already checked
        // for beat alignment above; snapping the source offset here would
        // silently replace the listener's selected entrance with a different
        // source moment on the next persisted Studio save.
        beatSnapEnabled: input.source.sectionEvidence !== "manual",
        phraseAligned,
        sectionAligned,
        reasons,
        vocalSlotEvidence: input.source.stemType === "vocals" ? target.vocalSlotEvidence ?? null : null,
      };
    })
    .sort((left, right) => {
      if (input.source.stemType === "vocals") {
        const slotRank = (evidence: VocalSlotEvidence | null) => evidence?.status === "no-existing-vocal-clip"
          ? -1
          : evidence?.status === "measured" && Number.isFinite(evidence.overlapRatio)
            ? evidence.overlapRatio
            : Number.POSITIVE_INFINITY;
        const slotOrder = slotRank(left.vocalSlotEvidence) - slotRank(right.vocalSlotEvidence);
        if (Number.isFinite(slotOrder) && slotOrder !== 0) return slotOrder;
        if (!Number.isFinite(slotOrder)) {
          const leftUnavailable = !Number.isFinite(slotRank(left.vocalSlotEvidence));
          const rightUnavailable = !Number.isFinite(slotRank(right.vocalSlotEvidence));
          if (leftUnavailable !== rightUnavailable) return leftUnavailable ? 1 : -1;
        }
      }
      return left.target.timelineStartMs - right.target.timelineStartMs || left.id.localeCompare(right.id);
    });
}
