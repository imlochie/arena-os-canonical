"use client";

import type { AutomaticRemixCompatibilityReport } from "@workspace/arena/lib/waveyard/types/automatic-remix";

const dimensions = [
  ["tempo", "Tempo"],
  ["phraseAlignment", "Phrase length"],
  ["rhythm", "Rhythm"],
  ["harmony", "Chroma"],
  ["beatPhase", "Beat phase"],
  ["vocalActivity", "Vocal activity"],
  ["instrumentalDensity", "Instrument activity"],
  ["stemActivity", "Per-stem changes"],
  ["downbeatConfidence", "Downbeat"],
] as const;

export function AutomaticRemixEvidence({ report }: { report?: AutomaticRemixCompatibilityReport | null }) {
  if (!report) return null;
  return <details className="automatic-remix-evidence" open>
    <summary>
      Passage evidence · {report.eligiblePairs} core matches of {report.evaluatedPairs} comparisons
    </summary>
    <p>{report.note}</p>
    {!report.pairs.length && <p>No passage pair could be compared. {report.missingEvidence.join("; ") || "Current section fingerprints are unavailable."}</p>}
    <ol>
      {report.pairs.slice(0, 4).map((pair) => <li key={`${pair.anchorSectionId}:${pair.donorSectionId}`}>
        <strong>{pair.anchorSourceName} → {pair.donorSourceName}</strong>
        <div>{pair.barCount} bars · {pair.beatCount} beats{pair.eligible ? " · core-compatible audition candidate" : " · not matched"}</div>
        <ul>
          {dimensions.map(([key, label]) => {
            const evidence = pair.dimensions[key];
            return <li key={key}><b>{label}:</b> {evidence.detail}</li>;
          })}
        </ul>
      </li>)}
    </ol>
    {report.missingEvidence.length > 0 && <p><b>Still unmeasured:</b> {report.missingEvidence.join(", ")}.</p>}
    <p>These are measured compatibility cues, not a claim that the resulting audio sounds good. Listen to the generated arrangement before keeping it.</p>
  </details>;
}
