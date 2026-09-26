"use client";

import type { Source, SourceAnalysis } from "./types";

function confidenceLabel(value: number | null) {
  if (value === null) return "Confidence unavailable";
  if (value >= 0.75) return "High confidence";
  if (value >= 0.45) return "Medium confidence";
  return "Low confidence";
}

function bpmLabel(value: number | null) {
  if (value === null) return "Unknown";
  return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)} BPM`;
}

export function analysisDisplayState(analysis: SourceAnalysis | null | undefined) {
  if (!analysis) return "legacy" as const;
  if (["queued", "preparing", "processing", "finalizing"].includes(analysis.status))
    return "running" as const;
  return analysis.status;
}

export function SourceAnalysisSummary({
  source,
  onRetry,
  compact = false,
}: {
  source: Source;
  onRetry?: (analysis: SourceAnalysis) => void;
  compact?: boolean;
}) {
  const analysis = source.analysis;
  const displayState = analysisDisplayState(analysis);
  return (
    <section
      className={`source-analysis ${compact ? "compact" : ""}`}
      data-testid={`source-analysis-${source.id}`}
      aria-label={`${source.originalFilename} musical analysis`}
    >
      <span className="eyebrow">Musical analysis</span>
      {displayState === "legacy" && (
        <p className="notice">Analysis has not been recorded for this source.</p>
      )}
      {displayState === "running" && analysis && <p className="notice">Analyzing music… {analysis.stage}</p>}
      {displayState === "failed" && analysis && (
        <div>
          <p className="error">Analysis unavailable{analysis.analysisError ? `: ${analysis.analysisError}` : "."}</p>
          {onRetry && (
            <button className="button secondary" onClick={() => onRetry(analysis)}>
              Retry analysis
            </button>
          )}
        </div>
      )}
      {displayState === "complete" && analysis && (
        <>
          <dl>
            <dt>BPM</dt>
            <dd>
              <b>{bpmLabel(analysis.bpm)}</b>
              <small>{confidenceLabel(analysis.bpmConfidence)}</small>
            </dd>
            <dt>Key</dt>
            <dd>
              <b>{analysis.musicalKey ?? "Unknown"}</b>
              <small>{confidenceLabel(analysis.keyConfidence)}</small>
            </dd>
            <dt>Beat grid</dt>
            <dd>
              <b>{analysis.beatGrid?.length ? "Detected" : "Unavailable"}</b>
              <small>
                {analysis.beatGrid?.length
                  ? `${analysis.beatGrid.length.toLocaleString()} beats · ${confidenceLabel(analysis.beatConfidence)}`
                  : "No reliable beat positions"}
              </small>
            </dd>
          </dl>
          <p className="analysis-provenance">
            Analysis engine {analysis.analysisEngine} {analysis.analysisEngineVersion}
          </p>
        </>
      )}
    </section>
  );
}
