import { normaliseMusicalKey, semitoneShift, type MusicalKey } from "./musical-key";
import { tempoRatioForBpm, usableBeatGrid } from "./beat-grid";

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

export type MeetingPointSourceRegion = {
  sourceAssetId: string;
  stemAssetId: string;
  sourceChecksumSha256: string;
  sectionId: string | null;
  startBeatIndex: number;
  endBeatIndex: number;
  startMs: number;
  endMs: number;
  phraseBoundaryStart: boolean;
  phraseBoundaryEnd: boolean;
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
      const sectionAligned = Boolean(input.source.sectionId && target.sectionId);
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
        beatSnapEnabled: true,
        phraseAligned,
        sectionAligned,
        reasons,
      };
    })
    .sort((left, right) => left.target.timelineStartMs - right.target.timelineStartMs || left.id.localeCompare(right.id));
}
