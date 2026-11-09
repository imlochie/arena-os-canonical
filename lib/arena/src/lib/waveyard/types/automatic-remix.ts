import { normaliseMusicalKey, semitoneShift, type MusicalKey } from "./musical-key";
import { usableBeatGrid } from "./beat-grid";
import {
  trustedAnalysisBpm,
  trustedAnalysisKey,
  WAVEYARD_MIXING_CONFIDENCE_THRESHOLD,
} from "./analysis-confidence";

export const AUTOMATIC_REMIX_ENGINE = "waveyard-deterministic-arranger";
export const AUTOMATIC_REMIX_ENGINE_VERSION = "2";
export const AUTOMATIC_REMIX_VARIANTS = ["original", "hybrid"] as const;
export type AutomaticRemixVariant = (typeof AUTOMATIC_REMIX_VARIANTS)[number];

export type AutomaticRemixStem = {
  id: string;
  sourceAssetId: string;
  stemType: string;
  durationMs: number;
};

export type AutomaticRemixSection = {
  id: string;
  sectionIndex: number;
  startMs: number;
  endMs: number;
  label: string;
  labelConfidence: number;
  structuralConfidence: number;
};

export type AutomaticRemixSource = {
  id: string;
  originalFilename: string;
  checksumSha256: string;
  durationMs: number;
  analysis: {
    id: string;
    status: string;
    sourceChecksumSha256: string;
    bpm: number | null;
    bpmConfidence: number | null;
    musicalKey: string | null;
    keyConfidence: number | null;
    beatConfidence: number | null;
    beatGridMs: unknown;
  } | null;
  sections: AutomaticRemixSection[];
  stems: AutomaticRemixStem[];
};

/** High-level preferences only. Clip-level editing remains in the existing Studio. */
export type AutomaticRemixConstraints = {
  variant?: AutomaticRemixVariant;
  anchorSourceId?: string;
  vocalStemId?: string;
  drumsStemId?: string;
  instrumental?: boolean;
};

export type AutomaticRemixClipPlan = {
  stemAssetId: string;
  timelineStartMs: number;
  durationMs: number;
  sourceOffsetMs: number;
  gain: number;
  fadeInMs: number;
  fadeOutMs: number;
  tempoSyncEnabled: boolean;
  keySyncEnabled: boolean;
  beatSnapEnabled: boolean;
};

export type AutomaticRemixTrackPlan = {
  stemAssetId: string;
  name: string;
  stemType: string;
  sortOrder: number;
  volume: number;
  pan: number;
  clips: AutomaticRemixClipPlan[];
};

export type AutomaticRemixProvenance = {
  engine: typeof AUTOMATIC_REMIX_ENGINE;
  engineVersion: typeof AUTOMATIC_REMIX_ENGINE_VERSION;
  variant: AutomaticRemixVariant;
  anchorSourceId: string;
  anchorSourceChecksumSha256: string;
  sourceAnalysisIds: string[];
  targetBpm: number | null;
  targetKey: MusicalKey | null;
  constraints: Required<Pick<AutomaticRemixConstraints, "instrumental">> & Omit<AutomaticRemixConstraints, "instrumental">;
  decisions: string[];
};

export type AutomaticRemixPlan = {
  name: string;
  tempoBpm: number;
  targetKey: MusicalKey | null;
  tracks: AutomaticRemixTrackPlan[];
  provenance: AutomaticRemixProvenance;
  notices: string[];
};

export type AutomaticRemixResult =
  | { ok: true; plan: AutomaticRemixPlan }
  | {
      ok: false;
      reason:
        | "no_usable_source"
        | "no_stems"
        | "hybrid_evidence_unavailable"
        | "no_compatible_hybrid_source"
        | "unsafe_hybrid_alignment";
    };

const roleOrder = ["drums", "percussion", "bass", "other", "melody", "vocals"];
const defaultVolume: Record<string, number> = { vocals: 0.94, drums: 0.88, percussion: 0.82, bass: 0.84, other: 0.82, melody: 0.82 };

function usableSections(source: AutomaticRemixSource) {
  return [...source.sections]
    .filter((section) => Number.isSafeInteger(section.startMs) && Number.isSafeInteger(section.endMs)
      && section.startMs >= 0 && section.endMs > section.startMs && section.endMs <= source.durationMs)
    .sort((left, right) => left.sectionIndex - right.sectionIndex || left.startMs - right.startMs)
    .filter((section, index, all) => index === 0 || section.startMs >= all[index - 1].endMs);
}

function sourceIsUsable(source: AutomaticRemixSource) {
  return source.stems.length > 0 && source.durationMs > 0;
}

function sourceHasVerifiedAnalysis(source: AutomaticRemixSource) {
  return source.analysis?.status === "complete"
    && source.analysis.sourceChecksumSha256 === source.checksumSha256;
}

function sourceCanStructure(source: AutomaticRemixSource) {
  return sourceHasVerifiedAnalysis(source)
    && trustedBpm(source) !== null
    && confidenceAtLeast(source.analysis?.beatConfidence, WAVEYARD_MIXING_CONFIDENCE_THRESHOLD)
    && usableSections(source).length > 0
    && Boolean(usableBeatGrid(source.analysis?.beatGridMs));
}

function sourceLabel(source: AutomaticRemixSource, stem: AutomaticRemixStem) {
  const role = stem.stemType === "other" ? "Melody" : `${stem.stemType[0]?.toUpperCase() ?? ""}${stem.stemType.slice(1)}`;
  return `${source.originalFilename} — ${role}`;
}

function roleRank(stem: AutomaticRemixStem) {
  const index = roleOrder.indexOf(stem.stemType);
  return index === -1 ? roleOrder.length : index;
}

const semanticRoles = new Set(["intro", "verse", "pre-chorus", "chorus", "post-chorus", "bridge", "breakdown", "instrumental", "outro"]);
const STRUCTURAL_ROLE_CONFIDENCE = 0.75;
const MAX_RELATIVE_POSITION_ERROR = 0.25;

function confidenceAtLeast(value: number | null | undefined, minimum: number): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= 1;
}

function trustedBpm(source: AutomaticRemixSource): number | null {
  return trustedAnalysisBpm(source.analysis?.bpm, source.analysis?.bpmConfidence);
}

function trustedKey(source: AutomaticRemixSource): MusicalKey | null {
  return normaliseMusicalKey(trustedAnalysisKey(source.analysis?.musicalKey, source.analysis?.keyConfidence));
}

function semanticRole(section: AutomaticRemixSection): string | null {
  if (
    !confidenceAtLeast(section.labelConfidence, STRUCTURAL_ROLE_CONFIDENCE)
    || !confidenceAtLeast(section.structuralConfidence, 0.5)
  ) return null;
  const normalized = section.label.trim().toLowerCase().replace(/[_\s]+/g, "-").replace(/-(?:[ivx]+|\d+)$/i, "");
  return semanticRoles.has(normalized) ? normalized : null;
}

/**
 * Cross-source section matching requires explicit, high-confidence musical
 * roles. Same-index or repeated-rhythm labels alone are never correspondence.
 * When a role repeats, prefer the instance with the closest relative position
 * and tempo-adjusted duration, and never reuse one donor section twice.
 */
function matchStructuralCounterparts(
  anchor: AutomaticRemixSource,
  candidate: AutomaticRemixSource,
  anchorSections: AutomaticRemixSection[],
  candidateSections: AutomaticRemixSection[],
  tempoRatio: number,
): Map<string, AutomaticRemixSection> | null {
  const available = new Set(candidateSections.filter((section) => semanticRole(section)).map((section) => section.id));
  const matches = new Map<string, AutomaticRemixSection>();
  let lastCandidateStartMs = -1;
  for (const anchorSection of anchorSections) {
    const role = semanticRole(anchorSection);
    if (!role) return null;
    const anchorDuration = anchorSection.endMs - anchorSection.startMs;
    const anchorCenter = (anchorSection.startMs + anchorSection.endMs) / (2 * anchor.durationMs);
    const choices = candidateSections.flatMap((section) => {
      if (!available.has(section.id) || semanticRole(section) !== role || section.startMs < lastCandidateStartMs) return [];
      const durationAfterStretch = (section.endMs - section.startMs) / tempoRatio;
      const durationTolerance = Math.max(750, anchorDuration * 0.12);
      const durationError = Math.abs(durationAfterStretch - anchorDuration);
      if (durationError > durationTolerance) return [];
      const candidateCenter = (section.startMs + section.endMs) / (2 * candidate.durationMs);
      const relativePositionError = Math.abs(candidateCenter - anchorCenter);
      if (relativePositionError > MAX_RELATIVE_POSITION_ERROR) return [];
      return [{ section, score: durationError / durationTolerance + relativePositionError }];
    }).sort((left, right) => left.score - right.score);
    const selected = choices[0]?.section;
    if (!selected) return null;
    available.delete(selected.id);
    lastCandidateStartMs = selected.startMs;
    matches.set(anchorSection.id, selected);
  }
  return matches;
}

/**
 * A second source is admitted only when the existing analysis can explain both
 * tempo/key intent and one-to-one section correspondence. This deliberately
 * falls back to a complete faithful arrangement instead of guessing.
 */
function compatibleHybridCounterparts(anchor: AutomaticRemixSource, candidate: AutomaticRemixSource) {
  if (anchor.id === candidate.id || !sourceCanStructure(anchor) || !sourceCanStructure(candidate)) return null;
  const anchorBpm = trustedBpm(anchor);
  const candidateBpm = trustedBpm(candidate);
  const anchorKey = trustedKey(anchor);
  const candidateKey = trustedKey(candidate);
  if (!anchorBpm || !candidateBpm || !anchorKey || !candidateKey) return null;
  const tempoRatio = anchorBpm / candidateBpm;
  const keyShift = semitoneShift(candidateKey, anchorKey);
  if (tempoRatio < 0.92 || tempoRatio > 1.08 || keyShift === null || Math.abs(keyShift) > 2) return null;
  const anchorSections = usableSections(anchor);
  const candidateSections = usableSections(candidate);
  return matchStructuralCounterparts(anchor, candidate, anchorSections, candidateSections, tempoRatio);
}

function requestedStem(sources: AutomaticRemixSource[], stemId: string | undefined, stemType: string) {
  if (!stemId) return null;
  return sources.flatMap((source) => source.stems.map((stem) => ({ source, stem })))
    .find((candidate) => candidate.stem.id === stemId && candidate.stem.stemType === stemType) ?? null;
}

function firstStem(source: AutomaticRemixSource, stemType: string) {
  return source.stems.find((stem) => stem.stemType === stemType) ?? null;
}

function clipWindows(
  source: AutomaticRemixSource,
  anchor: AutomaticRemixSource,
  targetBpm: number | null,
  counterparts?: ReadonlyMap<string, AutomaticRemixSection>,
) {
  const anchorSections = sourceCanStructure(anchor) ? usableSections(anchor) : [];
  const foreign = source.id !== anchor.id;
  const sourceSections = sourceCanStructure(source) ? usableSections(source) : [];
  if (foreign && !counterparts) return null;
  const sourceBpm = trustedBpm(source);
  const ratio = foreign && targetBpm && sourceBpm ? targetBpm / sourceBpm : 1;
  const tempoSyncEnabled = foreign && ratio !== 1;
  const targetKey = trustedKey(anchor);
  const sourceKey = trustedKey(source);
  const keySyncEnabled = foreign && Boolean(targetKey && sourceKey && semitoneShift(sourceKey, targetKey));
  const beatSnapEnabled = sourceCanStructure(source);
  if (!anchorSections.length) return [{ timelineStartMs: 0, durationMs: source.durationMs, sourceOffsetMs: 0, gain: 1, fadeInMs: 0, fadeOutMs: 0, tempoSyncEnabled: false, keySyncEnabled: false, beatSnapEnabled: false }];
  let cursor = 0;
  const clips: Omit<AutomaticRemixClipPlan, "stemAssetId">[] = [];
  for (const anchorSection of anchorSections) {
    const section = foreign ? counterparts?.get(anchorSection.id) : anchorSection;
    if (!section || (foreign && !sourceSections.some((candidate) => candidate.id === section.id))) return null;
    const durationMs = anchorSection.endMs - anchorSection.startMs;
    clips.push({
      timelineStartMs: cursor,
      durationMs,
      sourceOffsetMs: section.startMs,
      gain: 1,
      fadeInMs: 0,
      fadeOutMs: 0,
      tempoSyncEnabled,
      keySyncEnabled,
      beatSnapEnabled,
    });
    cursor += durationMs;
  }
  return clips;
}

function completeConstraints(constraints: AutomaticRemixConstraints, variant: AutomaticRemixVariant) {
  return {
    variant,
    ...(constraints.anchorSourceId ? { anchorSourceId: constraints.anchorSourceId } : {}),
    ...(constraints.vocalStemId ? { vocalStemId: constraints.vocalStemId } : {}),
    ...(constraints.drumsStemId ? { drumsStemId: constraints.drumsStemId } : {}),
    instrumental: constraints.instrumental === true,
  };
}

/**
 * Builds only ordinary RemixTrack/RemixClip-shaped decisions. No new timeline,
 * beat grid, audio renderer, or persistent opaque arrangement object is made.
 */
export function buildAutomaticRemixPlan(
  sources: AutomaticRemixSource[],
  constraints: AutomaticRemixConstraints = {},
): AutomaticRemixResult {
  const usableSources = sources.filter(sourceIsUsable);
  if (!usableSources.length) return { ok: false, reason: "no_usable_source" };
  const variant: AutomaticRemixVariant = constraints.variant === "hybrid" ? "hybrid" : "original";
  const explicitAnchor = usableSources.find((source) => source.id === constraints.anchorSourceId);
  const anchor = explicitAnchor ?? usableSources.find(sourceCanStructure) ?? usableSources[0];
  const anchorBpm = trustedBpm(anchor);
  const targetKey = trustedKey(anchor);
  const notices: string[] = [];
  const decisions = ["anchored to one preserved source structure"];
  if (variant === "hybrid" && !sourceCanStructure(anchor)) return { ok: false, reason: "hybrid_evidence_unavailable" };
  if (!sourceCanStructure(anchor)) notices.push("Structural analysis is incomplete, so Waveyard preserved the source as one continuous arrangement.");
  if (!anchorBpm) notices.push("Tempo confidence is insufficient, so Waveyard will not claim BPM matching or beat snapping for this arrangement.");
  const selected = new Map<string, { source: AutomaticRemixSource; stem: AutomaticRemixStem }>();
  const counterpartsBySource = new Map<string, ReadonlyMap<string, AutomaticRemixSection>>();
  for (const stem of anchor.stems) selected.set(stem.stemType, { source: anchor, stem });

  if (variant === "hybrid" && sourceCanStructure(anchor)) {
    const requestedVocals = requestedStem(usableSources, constraints.vocalStemId, "vocals");
    const requestedDrums = requestedStem(usableSources, constraints.drumsStemId, "drums");
    const candidates = new Map<string, { source: AutomaticRemixSource; stem: AutomaticRemixStem }>();
    for (const value of [requestedVocals, requestedDrums]) {
      if (value) candidates.set(`${value.source.id}:${value.stem.stemType}`, value);
    }
    const defaultVocal = usableSources.flatMap((source) => {
      const stem = firstStem(source, "vocals");
      const counterparts = compatibleHybridCounterparts(anchor, source);
      return stem && counterparts ? [{ source, stem, counterparts }] : [];
    })[0] ?? null;
    if (defaultVocal) {
      candidates.set(`${defaultVocal.source.id}:vocals`, { source: defaultVocal.source, stem: defaultVocal.stem });
      counterpartsBySource.set(defaultVocal.source.id, defaultVocal.counterparts);
    }
    for (const candidate of candidates.values()) {
      const counterparts = compatibleHybridCounterparts(anchor, candidate.source);
      if (!counterparts) {
        notices.push(`${candidate.source.originalFilename} was kept out of the hybrid because current tempo, key, or high-confidence matching section roles were unavailable.`);
        continue;
      }
      if (candidate.stem.stemType === "vocals" || candidate.stem.stemType === "drums") {
        selected.set(candidate.stem.stemType, candidate);
        counterpartsBySource.set(candidate.source.id, counterparts);
      }
    }
    if ([...selected.values()].some((choice) => choice.source.id !== anchor.id)) decisions.push("replaced only verified, structurally compatible featured stems");
    else return { ok: false, reason: "no_compatible_hybrid_source" };
  }

  if (constraints.instrumental) {
    selected.delete("vocals");
    decisions.push("removed vocals at the user’s request");
  }
  if (!selected.size) return { ok: false, reason: "no_stems" };
  const ordered = [...selected.values()].sort((left, right) => roleRank(left.stem) - roleRank(right.stem) || left.stem.id.localeCompare(right.stem.id));
  const tracks: AutomaticRemixTrackPlan[] = [];
  for (const [sortOrder, { source, stem }] of ordered.entries()) {
    const clips = clipWindows(source, anchor, anchorBpm, counterpartsBySource.get(source.id));
    if (!clips) return { ok: false, reason: "unsafe_hybrid_alignment" };
    tracks.push({
      stemAssetId: stem.id,
      stemType: stem.stemType,
      name: sourceLabel(source, stem),
      sortOrder,
      volume: defaultVolume[stem.stemType] ?? 0.82,
      pan: 0,
      clips: clips.map((clip) => ({ ...clip, stemAssetId: stem.id })),
    });
  }
  const analysisIds = [...new Set(ordered.map((choice) => choice.source.analysis?.id).filter((id): id is string => Boolean(id)))];
  return {
    ok: true,
    plan: {
      name: variant === "hybrid" ? "Automatic hybrid" : "Automatic original",
      tempoBpm: anchorBpm ?? 120,
      targetKey,
      tracks,
      notices,
      provenance: {
        engine: AUTOMATIC_REMIX_ENGINE,
        engineVersion: AUTOMATIC_REMIX_ENGINE_VERSION,
        variant,
        anchorSourceId: anchor.id,
        anchorSourceChecksumSha256: anchor.checksumSha256,
        sourceAnalysisIds: analysisIds,
        targetBpm: anchorBpm,
        targetKey,
        constraints: completeConstraints(constraints, variant),
        decisions,
      },
    },
  };
}
