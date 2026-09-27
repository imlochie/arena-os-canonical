"use client";

import { sourceSectionStatus } from "@waveyard/types";
import type { Source, SourceSectionAnalysis } from "./types";

export function SourceSectionSummary({ source, onRetry }: {
  source: Source;
  onRetry?: (analysis: SourceSectionAnalysis) => void;
}) {
  const state = sourceSectionStatus(
    source.sectionAnalysis?.status,
    source.analysis?.status,
    source.analysis?.beatGrid,
  );
  const sections = source.sections ?? [];
  return (
    <section className="source-sections-summary" data-testid={`source-sections-${source.id}`} aria-label={`${source.originalFilename} structural sections`}>
      <span className="eyebrow">Source structure</span>
      {state === "not_started" && <p className="notice">Structural detection has not started.</p>}
      {state === "insufficient_analysis" && <p className="notice">Structural detection needs a complete usable beat grid.</p>}
      {["queued", "preparing", "processing"].includes(state) && <p className="notice">Finding bar-aligned structure… {source.sectionAnalysis?.stage}</p>}
      {state === "failed" && source.sectionAnalysis && <div>
        <p className="error">Structural detection failed{source.sectionAnalysis.errorMessage ? `: ${source.sectionAnalysis.errorMessage}` : "."}</p>
        {onRetry && <button className="button secondary" onClick={() => onRetry(source.sectionAnalysis!)}>Retry structure</button>}
      </div>}
      {state === "unavailable" && <div>
        <p className="notice">No conservative structural boundary was supported by this source.</p>
        {onRetry && source.sectionAnalysis && <button className="button secondary" onClick={() => onRetry(source.sectionAnalysis!)}>Recheck structure</button>}
      </div>}
      {state === "complete" && <>
        <p className="notice">{sections.length} ordered generic section{sections.length === 1 ? "" : "s"}; labels avoid semantic guesses.</p>
        <ol className="source-section-list">
          {sections.map((section) => <li key={section.id}>
            <b>Section {section.sectionIndex + 1}</b> · bars {section.startBar}–{section.endBar} · beats {section.startBeatIndex}–{section.endBeatIndex}
          </li>)}
        </ol>
        <p className="analysis-provenance">Structure engine {source.sectionAnalysis?.analysisEngine} {source.sectionAnalysis?.analysisEngineVersion}</p>
      </>}
    </section>
  );
}
