import { usableBeatGrid } from "./beat-grid";
import { parsePassageFingerprint, type PassageFingerprint } from "./passage-compatibility";

/** Immutable, source-coordinate structural range. endBeatIndex is an exclusive beat boundary. */
export type SourceSection = {
  id: string;
  sectionIndex: number;
  startMs: number;
  endMs: number;
  startBeatIndex: number;
  endBeatIndex: number;
  startBar: number;
  endBar: number;
  label: string;
  labelConfidence: number;
  structuralConfidence: number;
  analysisEngine: string;
  analysisEngineVersion: string;
  sourceChecksumSha256: string;
  passageFingerprint?: PassageFingerprint | null;
};

export type SourceSectionStatus =
  | "not_started"
  | "queued"
  | "preparing"
  | "processing"
  | "complete"
  | "failed"
  | "unavailable"
  | "insufficient_analysis";

export type SourceSectionCandidate = Omit<SourceSection, "id" | "sectionIndex" | "startMs" | "endMs" | "startBar" | "endBar" | "analysisEngine" | "analysisEngineVersion" | "sourceChecksumSha256">;

export function displaySourceSectionLabel(section: Pick<SourceSection, "sectionIndex" | "label" | "labelConfidence">): string {
  if (section.label === "section") return `Section ${section.sectionIndex + 1}`;
  const repeatedPattern = /^pattern-repeat-([a-z]+)$/i.exec(section.label);
  const repeatedRhythm = /^rhythm-repeat-([a-z]+)$/i.exec(section.label);
  const repeatedVocalPattern = /^vocal-pattern-repeat-([a-z]+)$/i.exec(section.label);
  const energyChange = /^energy-(rise|drop)$/i.exec(section.label);
  const similarityPercent = `${Math.round(clampUnit(section.labelConfidence) * 100)}%`;
  if (section.label === "stem-change")
    return `Stem activity shift · normalized signal strength ${similarityPercent}`;
  if (section.label === "vocal-change")
    return `Vocal activity shift · sustained presence change ${similarityPercent}`;
  if (repeatedPattern) {
    const prefix = section.labelConfidence >= 0.92 ? "Repeated" : "Candidate";
    return `${prefix} audio pattern ${repeatedPattern[1].toUpperCase()} · ${similarityPercent} rhythm+chroma similarity`;
  }
  if (repeatedVocalPattern) {
    const prefix = section.labelConfidence >= 0.92 ? "Repeated" : "Candidate";
    return `${prefix} audio pattern ${repeatedVocalPattern[1].toUpperCase()} · ${similarityPercent} rhythm+chroma and vocal-activity agreement`;
  }
  if (repeatedRhythm) {
    const prefix = section.labelConfidence >= 0.92 ? "Repeated" : "Candidate";
    return `${prefix} rhythm ${repeatedRhythm[1].toUpperCase()} · ${similarityPercent} rhythm similarity`;
  }
  const readableLabel = energyChange
    ? `Dynamic ${energyChange[1]}`
    : section.label.replace(/(^|[\s-])([a-z])/g, (_match, separator: string, letter: string) => `${separator}${letter.toUpperCase()}`);
  return `${section.labelConfidence < 0.75 ? "Possible " : ""}${readableLabel}`;
}

const clampUnit = (value: unknown) => typeof value === "number" && Number.isFinite(value)
  ? Math.max(0, Math.min(1, value)) : 0;

function medianBeatInterval(beats: number[]) {
  const intervals = beats.slice(1)
    .map((time, index) => time - beats[index]!)
    .filter((interval) => Number.isFinite(interval) && interval > 0)
    .sort((left, right) => left - right);
  return intervals[Math.floor(intervals.length / 2)] ?? 0;
}

function sourceSectionBoundaryMs(beats: number[], index: number, sourceDurationMs?: number) {
  if (!Number.isInteger(index) || index < 0 || index > beats.length || beats.length === 0) return null;
  const estimated = index < beats.length
    ? beats[index]!
    : beats[beats.length - 1]! + medianBeatInterval(beats);
  if (!Number.isFinite(estimated)) return null;
  return typeof sourceDurationMs === "number" && Number.isFinite(sourceDurationMs) && sourceDurationMs >= 0
    ? Math.min(estimated, sourceDurationMs)
    : estimated;
}

/**
 * Converts worker candidates to monotonic section records only when every range
 * uses the persisted beat grid. An exclusive end may be the one-past-last beat
 * boundary; it is extrapolated by the grid's median interval and clamped to
 * the known source duration when supplied.
 */
export function normalizeSourceSections(
  candidates: readonly SourceSectionCandidate[],
  beatGridMs: unknown,
  provenance: Pick<SourceSection, "analysisEngine" | "analysisEngineVersion" | "sourceChecksumSha256">,
  makeId: (candidate: { startBeatIndex: number; endBeatIndex: number; sectionIndex: number }) => string,
  sourceDurationMs?: number,
): SourceSection[] {
  const beats = usableBeatGrid(beatGridMs);
  if (!beats || beats.length < 2) return [];
  const seen = new Set<string>();
  const sorted = [...candidates]
    .filter((candidate) => typeof candidate.label === "string" && candidate.label.trim().length > 0
      && candidate.label.length <= 64
      && Number.isInteger(candidate.startBeatIndex) && Number.isInteger(candidate.endBeatIndex)
      && candidate.startBeatIndex >= 0 && candidate.endBeatIndex > candidate.startBeatIndex
      && candidate.startBeatIndex < beats.length && candidate.endBeatIndex <= beats.length)
    .sort((left, right) => left.startBeatIndex - right.startBeatIndex || left.endBeatIndex - right.endBeatIndex);
  const normalized: SourceSection[] = [];
  for (const candidate of sorted) {
    const startMs = sourceSectionBoundaryMs(beats, candidate.startBeatIndex, sourceDurationMs);
    const endMs = sourceSectionBoundaryMs(beats, candidate.endBeatIndex, sourceDurationMs);
    if (startMs === null || endMs === null || endMs <= startMs) continue;
    const key = `${candidate.startBeatIndex}:${candidate.endBeatIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const previous = normalized.at(-1);
    // Overlaps are non-canonical; adjacent ranges remain valid and ordered.
    if (previous && candidate.startBeatIndex < previous.endBeatIndex) continue;
    const sectionIndex = normalized.length;
    const fingerprint = candidate.passageFingerprint === undefined || candidate.passageFingerprint === null
      ? null
      : parsePassageFingerprint(candidate.passageFingerprint, {
        sourceChecksumSha256: provenance.sourceChecksumSha256,
        startBeatIndex: candidate.startBeatIndex,
        endBeatIndex: candidate.endBeatIndex,
      });
    if (candidate.passageFingerprint != null && !fingerprint) continue;
    normalized.push({
      id: makeId({ startBeatIndex: candidate.startBeatIndex, endBeatIndex: candidate.endBeatIndex, sectionIndex }),
      sectionIndex,
      startMs,
      endMs,
      startBeatIndex: candidate.startBeatIndex,
      endBeatIndex: candidate.endBeatIndex,
      startBar: Math.floor(candidate.startBeatIndex / 4) + 1,
      endBar: Math.max(1, Math.ceil(candidate.endBeatIndex / 4)),
      label: candidate.label.trim(),
      labelConfidence: clampUnit(candidate.labelConfidence),
      structuralConfidence: clampUnit(candidate.structuralConfidence),
      ...(candidate.passageFingerprint !== undefined ? { passageFingerprint: fingerprint } : {}),
      ...provenance,
    });
  }
  return normalized;
}

/** Validates durable records independently of transport or database shape. */
export function sourceSectionsAreValid(
  sections: readonly SourceSection[],
  beatGridMs: unknown,
  sourceDurationMs?: number,
): boolean {
  const beats = usableBeatGrid(beatGridMs);
  if (!beats) return sections.length === 0;
  return sections.every((section, index) =>
    section.sectionIndex === index
    && typeof section.label === "string"
    && section.label.trim().length > 0
    && section.label.length <= 64
    && Number.isInteger(section.startBeatIndex)
    && Number.isInteger(section.endBeatIndex)
    && section.startBeatIndex >= 0
    && section.startBeatIndex < beats.length
    && section.endBeatIndex > section.startBeatIndex
    && section.endBeatIndex <= beats.length
    && section.startMs === sourceSectionBoundaryMs(beats, section.startBeatIndex, sourceDurationMs)
    && section.endMs === sourceSectionBoundaryMs(beats, section.endBeatIndex, sourceDurationMs)
    && section.endMs > section.startMs
    && section.startBar === Math.floor(section.startBeatIndex / 4) + 1
    && section.endBar === Math.max(1, Math.ceil(section.endBeatIndex / 4))
    && (index === 0 || section.startBeatIndex >= sections[index - 1].endBeatIndex)
    && section.structuralConfidence >= 0 && section.structuralConfidence <= 1
    && section.labelConfidence >= 0 && section.labelConfidence <= 1
    && (section.passageFingerprint == null || parsePassageFingerprint(section.passageFingerprint, {
      sourceChecksumSha256: section.sourceChecksumSha256,
      startBeatIndex: section.startBeatIndex,
      endBeatIndex: section.endBeatIndex,
    }) !== null),
  );
}

/** Explicit UI state for a missing lifecycle row or insufficient beat analysis. */
export function sourceSectionStatus(
  status: unknown,
  sourceAnalysisStatus: unknown,
  beatGridMs: unknown,
): SourceSectionStatus {
  if (sourceAnalysisStatus !== "complete" || !usableBeatGrid(beatGridMs)) return "insufficient_analysis";
  if (status === null || status === undefined) return "not_started";
  if (["queued", "preparing", "processing", "complete", "failed", "unavailable"].includes(String(status)))
    return status as SourceSectionStatus;
  return "not_started";
}
