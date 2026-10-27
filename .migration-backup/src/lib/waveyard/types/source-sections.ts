import { usableBeatGrid } from "./beat-grid";

/** Immutable, source-coordinate structural range. endBeatIndex is a boundary index. */
export type SourceSection = {
  id: string;
  sectionIndex: number;
  startMs: number;
  endMs: number;
  startBeatIndex: number;
  endBeatIndex: number;
  startBar: number;
  endBar: number;
  label: "section";
  labelConfidence: number;
  structuralConfidence: number;
  analysisEngine: string;
  analysisEngineVersion: string;
  sourceChecksumSha256: string;
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

const clampUnit = (value: unknown) => typeof value === "number" && Number.isFinite(value)
  ? Math.max(0, Math.min(1, value)) : 0;

/**
 * Converts worker candidates to monotonic section records only when every range
 * is an existing source beat range. It never invents a fallback whole-song
 * section: callers should expose unavailable/insufficient evidence instead.
 */
export function normalizeSourceSections(
  candidates: readonly SourceSectionCandidate[],
  beatGridMs: unknown,
  provenance: Pick<SourceSection, "analysisEngine" | "analysisEngineVersion" | "sourceChecksumSha256">,
  makeId: (candidate: { startBeatIndex: number; endBeatIndex: number; sectionIndex: number }) => string,
): SourceSection[] {
  const beats = usableBeatGrid(beatGridMs);
  if (!beats || beats.length < 2) return [];
  const seen = new Set<string>();
  const sorted = [...candidates]
    .filter((candidate) => Number.isInteger(candidate.startBeatIndex) && Number.isInteger(candidate.endBeatIndex)
      && candidate.startBeatIndex >= 0 && candidate.endBeatIndex > candidate.startBeatIndex
      && candidate.endBeatIndex < beats.length)
    .sort((left, right) => left.startBeatIndex - right.startBeatIndex || left.endBeatIndex - right.endBeatIndex);
  const normalized: SourceSection[] = [];
  for (const candidate of sorted) {
    const key = `${candidate.startBeatIndex}:${candidate.endBeatIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const previous = normalized.at(-1);
    // Overlaps are non-canonical; adjacent ranges remain valid and ordered.
    if (previous && candidate.startBeatIndex < previous.endBeatIndex) continue;
    const sectionIndex = normalized.length;
    normalized.push({
      id: makeId({ startBeatIndex: candidate.startBeatIndex, endBeatIndex: candidate.endBeatIndex, sectionIndex }),
      sectionIndex,
      startMs: beats[candidate.startBeatIndex],
      endMs: beats[candidate.endBeatIndex],
      startBeatIndex: candidate.startBeatIndex,
      endBeatIndex: candidate.endBeatIndex,
      startBar: Math.floor(candidate.startBeatIndex / 4) + 1,
      endBar: Math.max(1, Math.ceil(candidate.endBeatIndex / 4)),
      label: "section",
      labelConfidence: clampUnit(candidate.labelConfidence),
      structuralConfidence: clampUnit(candidate.structuralConfidence),
      ...provenance,
    });
  }
  return normalized;
}

/** Validates durable records independently of transport or database shape. */
export function sourceSectionsAreValid(sections: readonly SourceSection[], beatGridMs: unknown): boolean {
  const beats = usableBeatGrid(beatGridMs);
  if (!beats) return sections.length === 0;
  return sections.every((section, index) =>
    section.sectionIndex === index
    && section.label === "section"
    && Number.isInteger(section.startBeatIndex)
    && Number.isInteger(section.endBeatIndex)
    && section.startBeatIndex >= 0
    && section.endBeatIndex > section.startBeatIndex
    && section.endBeatIndex < beats.length
    && section.startMs === beats[section.startBeatIndex]
    && section.endMs === beats[section.endBeatIndex]
    && section.startBar === Math.floor(section.startBeatIndex / 4) + 1
    && section.endBar === Math.max(1, Math.ceil(section.endBeatIndex / 4))
    && (index === 0 || section.startBeatIndex >= sections[index - 1].endBeatIndex)
    && section.structuralConfidence >= 0 && section.structuralConfidence <= 1
    && section.labelConfidence >= 0 && section.labelConfidence <= 1,
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
