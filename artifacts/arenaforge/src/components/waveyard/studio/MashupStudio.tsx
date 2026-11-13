"use client";

/**
 * MashupStudio — song × song (Waveyard's main goal). Pick a vocal track and
 * an instrumental track; Waveyard reads both songs' real structure (tempo,
 * key, sections) and PROPOSES the mashup: master tempo, stretch, key move,
 * entry point — every decision explained, every risk warned. Render it to a
 * real WAV, or take the plan as a starting point. Extending a song (loop a
 * section to lengthen it) lives here too.
 *
 * Authority: the plan is a proposal. Nothing here touches the user's own
 * arrangement, and the rationale is shown so disagreement is informed.
 */

import { useEffect, useRef, useState } from "react";

import type { MashupArrangement } from "@workspace/arena/lib/waveyard/studio/mashup";
import type { Source } from "./types";
import { compactMusicAnalysisLabel } from "@workspace/arena/lib/waveyard/types";

type Plan = {
  masterBpm: number;
  vocalsStretchRatio: number;
  vocalsPitchSemitones: number;
  keyRelationship: string;
  segments: Array<{ mashupStartMs: number; mashupEndMs: number; rationale: string }>;
  passageSearch?: {
    evaluatedDonorPassageCount: number;
    rankableDonorPassageCount: number;
    selectedDonorSectionId: string | null;
    selectedBedSectionId: string | null;
    evaluations: Array<{
      donorSectionId: string;
      donorStartMs: number;
      donorEndMs: number;
      voicedPhraseCount: number;
      vocalIntervalKind?: "activity" | "pitch-continuity" | "combined";
      status: "ranked" | "no-candidate";
      selected: boolean;
      bestBedSectionId: string | null;
      bedStartMs: number | null;
      bedEndMs: number | null;
      plannedEntryMs: number | null;
      relativeScore: number | null;
      minimumFeatureConfidence: number | null;
      rankedBedCandidates?: Array<{
        rank: number;
        bedSectionId: string;
        bedStartMs: number;
        bedEndMs: number;
        plannedEntryMs: number;
        relativeScore: number;
        minimumFeatureConfidence: number;
        similarities: {
          duration: number;
          rhythm: number | null;
          harmony: number | null;
          beatPhase: number | null;
        };
        selected: boolean;
      }>;
      reason: string;
    }>;
  };
  arrangement?: MashupArrangement | null;
  durationMs: number;
  rationale: string[];
  warnings: string[];
};

type EvidenceFeatureSummary =
  | { status: "measured"; analysisEngine: string; analysisEngineVersion: string; persistence: "database" | "request" }
  | { status: "unavailable"; reason: string };

type EvidenceSummary = {
  vocals: Record<string, EvidenceFeatureSummary> | null;
  bed: Record<string, EvidenceFeatureSummary> | null;
};

const EVIDENCE_FEATURE_LABELS: Record<string, string> = {
  tempo: "Tempo",
  key: "Key",
  beatGrid: "Beat grid",
  sections: "Sections",
  vocalPhrases: "Vocal activity",
  harmony: "Chord events",
  drumEvents: "Drum events",
  bassAttacks: "Bass attacks",
};

function formatPassageTime(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function MashupStudio({ projectId, sources, canEdit }: { projectId: string; sources: Source[]; canEdit: boolean }) {
  const [vocalsId, setVocalsId] = useState(sources[0]?.id ?? "");
  const [bedId, setBedId] = useState(sources[1]?.id ?? sources[0]?.id ?? "");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [evidence, setEvidence] = useState<EvidenceSummary | null>(null);
  const [planning, setPlanning] = useState(false);
  const [rendering, setRendering] = useState<"mashup" | "extend" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [renderUrl, setRenderUrl] = useState<string | null>(null);
  const [renderKind, setRenderKind] = useState<"mashup" | "extended" | null>(null);
  const [bedInfo, setBedInfo] = useState<{
    source: string;
    warning: string;
    includedStemTypes?: string[];
  } | null>(null);
  const [savingRemix, setSavingRemix] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);
  const renderUrlRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      if (renderUrlRef.current !== null) URL.revokeObjectURL(renderUrlRef.current);
    };
  }, []);

  const call = async (payload: Record<string, unknown>, kind: "mashup" | "extended") => {
    setRendering(kind === "mashup" ? "mashup" : "extend");
    setError(null);
    const response = await fetch(`/api/waveyard/projects/${projectId}/mashup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (kind === "mashup" && response.headers.get("content-type")?.includes("application/json")) {
      const body = await response.json().catch(() => ({}));
      setRendering(null);
      if (!response.ok) {
        setError(body.error ?? "The mashup could not be planned.");
        return null;
      }
      if (body.bed) {
        setBedInfo(body.bed as { source: string; warning: string; includedStemTypes?: string[] });
      }
      setEvidence((body.evidence as EvidenceSummary | undefined) ?? null);
      return body.plan as Plan;
    }
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setRendering(null);
      setError(body.error ?? "The render failed.");
      return null;
    }
    const bedSource = response.headers.get("x-waveyard-bed-source");
    const bedWarning = response.headers.get("x-waveyard-bed-warning");
    if (bedSource) {
      setBedInfo({
        source: bedSource,
        warning: bedWarning ? decodeURIComponent(bedWarning) : "",
        includedStemTypes: response.headers.get("x-waveyard-bed-stems")?.split(",").filter(Boolean),
      });
    }
    const blob = await response.blob();
    if (renderUrlRef.current !== null) URL.revokeObjectURL(renderUrlRef.current);
    const url = URL.createObjectURL(blob);
    renderUrlRef.current = url;
    setRenderUrl(url);
    setRenderKind(kind);
    setRendering(null);
    return null;
  };

  const planMashup = async () => {
    setPlanning(true);
    setError(null);
    setEvidence(null);
    const result = await call({ action: "plan", vocalsSourceId: vocalsId, instrumentalSourceId: bedId }, "mashup");
    setPlan(result);
    setPlanning(false);
  };

  const renderMashup = async () => {
    if (plan === null) return;
    await call({ action: "render", vocalsSourceId: vocalsId, instrumentalSourceId: bedId }, "mashup");
  };

  const saveMashupAsRemix = async () => {
    if (plan === null) return;
    setSavingRemix(true);
    setError(null);
    setSaveSuccess(null);
    try {
      const response = await fetch(`/api/waveyard/projects/${projectId}/mashup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save", vocalsSourceId: vocalsId, instrumentalSourceId: bedId }),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.error ?? "Could not save mashup as remix.");
      } else {
        setSaveSuccess("Mashup saved to project arrangement timeline as an editable remix.");
      }
    } catch {
      setError("Failed to save mashup as remix.");
    } finally {
      setSavingRemix(false);
    }
  };

  const extendTrack = async () => {
    if (bedId === "") return;
    await call({ action: "extend", sourceAssetId: bedId, repeats: 2 }, "extended");
  };

  if (sources.length < 2) {
    return (
      <section className="remix-panel" data-testid="mashup-studio">
        <div className="panel-title">
          <div>
            <span className="eyebrow">Song × song</span>
            <h3>Mashup studio</h3>
          </div>
        </div>
        <p className="empty-state">
          Add a second track to the project — Waveyard reads both songs’ structure (tempo, key,
          sections) and proposes the mashup: which tempo wins, how the vocal is stretched and
          pitched, where it enters, and why.
        </p>
      </section>
    );
  }

  return (
    <section className="remix-panel" data-testid="mashup-studio">
      <div className="panel-title">
        <div>
          <span className="eyebrow">Song × song</span>
          <h3>Mashup studio</h3>
        </div>
        <small>{sources.length} available track{sources.length === 1 ? "" : "s"}</small>
      </div>

      {canEdit && (
        <div className="mashup-pickers">
          <label>
            Vocals from
            <select aria-label="Vocal track" value={vocalsId} onChange={(event) => setVocalsId(event.target.value)}>
              {sources.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.originalFilename} · {compactMusicAnalysisLabel(source.analysis)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Over the instrumental of
            <select aria-label="Instrumental track" value={bedId} onChange={(event) => setBedId(event.target.value)}>
              {sources.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.originalFilename} · {compactMusicAnalysisLabel(source.analysis)}
                </option>
              ))}
            </select>
          </label>
          <button className="button" disabled={planning || vocalsId === "" || bedId === "" || vocalsId === bedId} onClick={() => void planMashup()}>
            {planning ? "Reading both songs…" : "Plan the mashup"}
          </button>
        </div>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}

      {plan !== null && (
        <div className="mashup-plan" data-testid="mashup-plan">
          <div className="mashup-plan-summary">
            <div><b>{plan.masterBpm} BPM</b><small>master tempo (bed wins)</small></div>
            <div><b>×{plan.vocalsStretchRatio.toFixed(3)}</b><small>vocal stretch</small></div>
            <div><b>{plan.vocalsPitchSemitones === 0 ? "0" : plan.vocalsPitchSemitones > 0 ? `+${plan.vocalsPitchSemitones}` : plan.vocalsPitchSemitones} st</b><small>vocal pitch ({plan.keyRelationship})</small></div>
            <div><b>{(plan.durationMs / 1000 / 60).toFixed(1)} min</b><small>mashup length</small></div>
          </div>
          {plan.warnings.length > 0 && (
            <ul className="mashup-warnings">
              {plan.warnings.map((warning, index) => <li key={index}>⚠ {warning}</li>)}
            </ul>
          )}
          <details open>
            <summary>Why these decisions</summary>
            <ul className="mashup-rationale">
              {plan.rationale.map((line, index) => <li key={index}>{line}</li>)}
              {plan.segments.map((segment, index) => <li key={`s${index}`}>{segment.rationale}.</li>)}
            </ul>
          </details>
          {plan.passageSearch && (
            <details className="mashup-passage-search" data-testid="details-passage-search">
              <summary data-testid="summary-passage-search">
                Whole-song passage search · {plan.passageSearch.rankableDonorPassageCount}/
                {plan.passageSearch.evaluatedDonorPassageCount} donor sections ranked
              </summary>
              <p>
                These are analyzer-defined time windows, not human-verified verse/chorus labels.
                Relative score compares available passages; it is not a probability of musical fit.
                Feature confidence is detector confidence, not a prediction that the mashup will sound good.
              </p>
              {plan.passageSearch.evaluations.length === 0
                 ? <p>No confidence-qualified vocal activity or pitch runs were assigned to a measured section.</p>
                : (
                  <ol>
                    {plan.passageSearch.evaluations.map((evaluation) => (
                      <li key={evaluation.donorSectionId} data-testid={`passage-evaluation-${evaluation.donorSectionId}`}>
                        <b>
                          Donor passage {formatPassageTime(evaluation.donorStartMs)}–
                          {formatPassageTime(evaluation.donorEndMs)}
                          {evaluation.selected ? " · selected" : ""}
                        </b>
                        <small>
                          {evaluation.voicedPhraseCount} {
                            evaluation.vocalIntervalKind === "activity"
                              ? "coarse vocal-activity intervals"
                              : evaluation.vocalIntervalKind === "combined"
                                ? "combined activity intervals and pitch-continuity runs"
                                : "pitch-continuity runs"
                          } · {evaluation.status}
                          {evaluation.bestBedSectionId && evaluation.bedStartMs !== null && evaluation.bedEndMs !== null
                            ? ` · bed passage ${formatPassageTime(evaluation.bedStartMs)}–${formatPassageTime(evaluation.bedEndMs)}`
                            : ""}
                          {evaluation.plannedEntryMs !== null
                            ? ` · proposed entry ${formatPassageTime(evaluation.plannedEntryMs)}`
                            : ""}
                          {evaluation.relativeScore !== null
                            ? ` · relative score ${evaluation.relativeScore.toFixed(3)}`
                            : ""}
                          {evaluation.minimumFeatureConfidence !== null
                            ? ` · minimum feature confidence ${evaluation.minimumFeatureConfidence.toFixed(2)}`
                            : ""}
                        </small>
                        <small>{evaluation.reason}</small>
                        {evaluation.rankedBedCandidates && evaluation.rankedBedCandidates.length > 0 && (
                          <details className="mashup-bed-alternatives">
                            <summary>Compare {evaluation.rankedBedCandidates.length} measured bed options</summary>
                            <ol>
                              {evaluation.rankedBedCandidates.map((candidate) => (
                                <li key={candidate.bedSectionId}>
                                  <b>
                                    {candidate.selected ? "Selected · " : `Option ${candidate.rank} · `}
                                    bed passage {formatPassageTime(candidate.bedStartMs)}–
                                    {formatPassageTime(candidate.bedEndMs)}
                                  </b>
                                  <small>
                                    Entry {formatPassageTime(candidate.plannedEntryMs)} · relative score {candidate.relativeScore.toFixed(3)}
                                    {" · duration"} {candidate.similarities.duration.toFixed(3)}
                                    {" · rhythm"} {candidate.similarities.rhythm?.toFixed(3) ?? "unavailable"}
                                    {" · harmony"} {candidate.similarities.harmony?.toFixed(3) ?? "unavailable"}
                                    {" · beat phase"} {candidate.similarities.beatPhase?.toFixed(3) ?? "unavailable"}
                                  </small>
                                </li>
                              ))}
                            </ol>
                            <small>Scores are relative rankings, not probabilities or a guarantee of a good-sounding mix. These are analyzer-defined windows, not verified verse or chorus labels.</small>
                          </details>
                        )}
                      </li>
                    ))}
                  </ol>
                )}
            </details>
          )}
          {plan.arrangement && (
            <details className="mashup-arrangement" data-testid="details-mashup-arrangement">
              <summary>
                Whole-track placement · {plan.arrangement.selected === "segmented" ? "repositioned" : "kept continuous"}
                {" · "}{plan.arrangement.unitsPlaced}/{plan.arrangement.unitsTotal} vocal units
              </summary>
              <p>
                Relative placement evidence, not a quality prediction or verse/chorus label.
                {" "}Segmented {plan.arrangement.segmentedScore.toFixed(2)} · continuous {plan.arrangement.overlayScore.toFixed(2)}
                {plan.arrangement.improvementRatio === null
                  ? ""
                  : ` · difference ${(plan.arrangement.improvementRatio * 100).toFixed(1)}%`}
              </p>
              <p>
                Available: {[
                  plan.arrangement.evidence.chordTimeline ? "vocal/chord fit" : null,
                  plan.arrangement.evidence.drumTransients ? "drum transients" : null,
                  plan.arrangement.evidence.bassAttacks ? "bass attacks" : null,
                  plan.arrangement.evidence.beatGrid ? "trusted beat grid" : null,
                  plan.arrangement.evidence.sectionRoles ? "unverified section-role hints" : null,
                ].filter(Boolean).join(", ") || "no independent placement channels"}
              </p>
              <ol>
                {plan.arrangement.placements.map((placement, index) => (
                  <li key={`${placement.donorFromMs}-${placement.bedStartMs}-${index}`}>
                    Donor {formatPassageTime(placement.donorFromMs)}–{formatPassageTime(placement.donorToMs)}
                    {" → "}bed {formatPassageTime(placement.bedStartMs)}
                    {" · score "}{placement.unitScore.toFixed(2)}
                    {placement.evidence.length > 0 && <small>{placement.evidence.join("; ")}</small>}
                  </li>
                ))}
              </ol>
              {plan.arrangement.unitsSkipped > 0 && (
                <p role="status">
                  {plan.arrangement.unitsSkipped} vocal unit{plan.arrangement.unitsSkipped === 1 ? "" : "s"} could not fit and were omitted.
                </p>
              )}
            </details>
          )}
          {evidence && (
            <details className="mashup-evidence">
              <summary>Analysis evidence used</summary>
              <div className="mashup-evidence-grid">
                {([
                  ["vocals", sources.find((source) => source.id === vocalsId)?.originalFilename ?? "Vocal source", evidence.vocals],
                  ["bed", sources.find((source) => source.id === bedId)?.originalFilename ?? "Instrumental source", evidence.bed],
                ] as const).map(([key, title, features]) => (
                  <section key={key} aria-label={`${title} analysis evidence`}>
                    <b>{title}</b>
                    {Object.entries(features ?? {}).map(([name, feature]) => (
                      <div className="mashup-evidence-item" key={name}>
                        <span>{EVIDENCE_FEATURE_LABELS[name] ?? name}</span>
                        <small>
                          {feature.status === "measured"
                            ? `Measured · ${feature.persistence === "database" ? "saved" : "this run"} · ${feature.analysisEngine} ${feature.analysisEngineVersion}`
                            : `Unavailable · ${feature.reason}`}
                        </small>
                      </div>
                    ))}
                  </section>
                ))}
              </div>
            </details>
          )}
          {canEdit && (
            <div className="remix-actions">
              <button className="button" disabled={rendering !== null} onClick={() => void renderMashup()}>
                {rendering === "mashup" ? "Rendering…" : "Render mashup (WAV)"}
              </button>
              <button className="button secondary" disabled={savingRemix} onClick={() => void saveMashupAsRemix()}>
                {savingRemix ? "Saving…" : "Save as project remix"}
              </button>
              <small>The plan is a proposal — your arrangement is never touched.</small>
            </div>
          )}
          {saveSuccess && <p className="success" role="status" style={{ color: "var(--playback)", fontSize: 13, marginTop: 8 }}>✓ {saveSuccess}</p>}
        </div>
      )}

      {bedInfo && (
        <p className="mashup-bed-warning" role="status">
          <b>Bed:</b>{" "}
          {bedInfo.source === "separated"
            ? `separated stems${bedInfo.includedStemTypes?.length ? ` (${bedInfo.includedStemTypes.join(", ")})` : ""}`
            : "original file fallback"}
          . {bedInfo.warning}
        </p>
      )}

      {canEdit && (
        <div className="remix-actions mashup-extend">
          <button className="button secondary" disabled={rendering !== null || bedId === ""} onClick={() => void extendTrack()}>
            {rendering === "extend" ? "Extending…" : "Extend the instrumental (+2 chorus loops)"}
          </button>
        </div>
      )}

      {renderUrl !== null && (
        <div className="chop-render-result">
          <audio controls src={renderUrl} />
          <a className="button secondary" href={renderUrl} download={`waveyard-${renderKind}.wav`}>Download WAV</a>
        </div>
      )}
    </section>
  );
}
