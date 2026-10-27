export type AutomaticBuildSourceStage = {
  id: string;
  analysisStatus?: string;
  sectionStatus?: string;
  hasRealStems: boolean;
};

export type AutomaticBuildFinalizationInput = {
  acceptedSourceCount: number;
  persistedFailedSourceCount: number;
  processing: boolean;
  failedJobSourceIds: Iterable<string>;
  sources: AutomaticBuildSourceStage[];
};

export type AutomaticBuildFinalization = {
  expectedReadySourceCount: number;
  eligibleSourceCount: number;
  failedSourceCount: number;
  reportedAcceptedSourceCount: number;
  stage: "separating" | "understanding" | "finding-structure" | "building";
  canBuildAutomaticRemix: boolean;
};

const TERMINAL_SECTION_STATUSES = new Set(["complete", "unavailable", "failed"]);

/**
 * Separation and authoritative source analysis decide whether a source can
 * enter the first automatic arrangement. Structural sections are enrichment,
 * but the arranger must wait for their durable terminal result: otherwise it
 * can snapshot the continuous fallback in the short gap between authoritative
 * analysis completing and the section worker publishing verified windows.
 */
export function evaluateAutomaticBuildFinalization(
  input: AutomaticBuildFinalizationInput,
): AutomaticBuildFinalization {
  const failedSourceIds = new Set(input.failedJobSourceIds);
  for (const source of input.sources) {
    if (source.analysisStatus === "failed") failedSourceIds.add(source.id);
  }

  const expectedReadySourceCount = Math.max(
    0,
    input.acceptedSourceCount - failedSourceIds.size,
  );
  const eligibleSources = input.sources.filter(
    (source) => source.analysisStatus === "complete" && source.hasRealStems,
  );
  const sourceAnalysisReady =
    expectedReadySourceCount > 0 &&
    eligibleSources.length >= expectedReadySourceCount;
  // A completed source analysis always provisions a durable section-analysis
  // row. Until that row reaches a terminal state, treating absent/pending
  // structure as a fallback would race the worker and permanently snapshot a
  // one-window arrangement even when verified sections arrive moments later.
  const structurePending = eligibleSources.some(
    (source) => !TERMINAL_SECTION_STATUSES.has(source.sectionStatus ?? ""),
  );

  const stage = input.processing
    ? "separating"
    : !sourceAnalysisReady
      ? "understanding"
      : structurePending
        ? "finding-structure"
        : "building";

  return {
    expectedReadySourceCount,
    eligibleSourceCount: eligibleSources.length,
    failedSourceCount: Math.max(
      input.persistedFailedSourceCount,
      failedSourceIds.size,
    ),
    // This is the number accepted at intake, not the number whose downstream
    // analysis has completed. Reducing it while analysis is still queued makes
    // the next evaluation believe no source can ever become ready.
    reportedAcceptedSourceCount: input.acceptedSourceCount,
    stage,
    canBuildAutomaticRemix: !input.processing && sourceAnalysisReady && !structurePending,
  };
}
