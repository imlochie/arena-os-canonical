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
import {
  CandidateAlignmentLab,
  type CandidateAlignmentCandidate,
  type CandidateAlignmentId,
} from "./CandidateAlignmentLab";

type Plan = {
  masterBpm: number;
  vocalsStretchRatio: number;
  vocalsPitchSemitones: number;
  keyRelationship: string;
  segments: Array<{
    mashupStartMs: number;
    mashupEndMs: number;
    rationale: string;
    localTempoMap?: { maximumRateDeviationPercent: number } | null;
  }>;
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

type AlignmentCandidatePlan = {
  id: CandidateAlignmentId;
  title: string;
  available: boolean;
  unavailableReason?: string;
  plan: Plan | null;
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
  const [alignmentCandidates, setAlignmentCandidates] = useState<AlignmentCandidatePlan[]>([]);
  const [selectedAlignment, setSelectedAlignment] = useState<CandidateAlignmentId | null>(null);
  /**
   * The user's chosen arrangement mode.
   *
   * "Full Length" is a first-class mode, not just another entry in the lab: when
   * the user picks it, this strategy must be the one planned and rendered. The
   * previous auto-select list omitted "full-length" entirely, so Full Length was
   * reachable through the API but never actually selected in production.
   */
  const [arrangementMode, setArrangementMode] = useState<CandidateAlignmentId>("phrase-aware");
  const [candidateRendering, setCandidateRendering] = useState<CandidateAlignmentId | null>(null);
  const [renderedCandidateUrls, setRenderedCandidateUrls] = useState<Partial<Record<CandidateAlignmentId, string>>>({});
  const [bedInfo, setBedInfo] = useState<{
    source: string;
    warning: string;
    includedStemTypes?: string[];
  } | null>(null);
  /**
   * What the mix bus actually did to the last render, read from response
   * headers so the numbers come from the rendered PCM rather than from the
   * plan. These are measurements, never a quality score.
   */
  const [mixReport, setMixReport] = useState<{
    balanceDb: string | null;
    balanceClamped: boolean;
    staticGainDb: string | null;
    limiter: string | null;
    truePeakDb: string | null;
    layerStems: string[];
    clippedRegions: string | null;
    /** "replace" removes the bed's matching stem; "layer" keeps both. */
    stemLayerMode: string | null;
    replacedBedStems: string[];
  } | null>(null);

  const readMixReport = (response: Response) => {
    if (!response.headers.get("x-waveyard-mix-static-gain-db")) return;
    setMixReport({
      balanceDb: response.headers.get("x-waveyard-mix-balance-db"),
      balanceClamped: response.headers.get("x-waveyard-mix-balance-clamped") === "true",
      staticGainDb: response.headers.get("x-waveyard-mix-static-gain-db"),
      limiter: response.headers.get("x-waveyard-mix-limiter"),
      truePeakDb: response.headers.get("x-waveyard-mix-true-peak-db"),
      layerStems: response.headers.get("x-waveyard-layer-stems")?.split(",").filter(Boolean) ?? [],
      clippedRegions: response.headers.get("x-waveyard-mix-clipped-regions"),
      stemLayerMode: response.headers.get("x-waveyard-stem-layer-mode"),
      replacedBedStems: response.headers.get("x-waveyard-replaced-bed-stems")?.split(",").filter(Boolean) ?? [],
    });
  };
  /**
   * Composition choice, surfaced explicitly because it changes which audio is
   * rendered. "replace" removes the bed's matching stem; "layer" keeps both.
   * It is sent to render, preview and save alike so the saved session cannot
   * describe a different arrangement than the one heard.
   */
  const [layerStemTypes, setLayerStemTypes] = useState<string[]>([]);
  const [stemLayerMode, setStemLayerMode] = useState<"replace" | "layer">("replace");
  const compositionPayload = layerStemTypes.length > 0
    ? { layerStemTypes, stemLayerMode }
    : {};
  const [savingRemix, setSavingRemix] = useState(false);
  // A composition change invalidates the previous render: the mix report and
  // the saved-session claim describe audio that no longer matches the choice.
  const setComposition = (types: string[], mode: "replace" | "layer") => {
    setLayerStemTypes(types);
    setStemLayerMode(mode);
    setMixReport(null);
    setSaveSuccess(null);
  };
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);
  const renderUrlRef = useRef<string | null>(null);
  const candidateRenderUrlsRef = useRef(new Map<CandidateAlignmentId, string>());
  const candidateRenderOrderRef = useRef<CandidateAlignmentId[]>([]);
  const sourceGenerationRef = useRef(0);

  useEffect(() => {
    return () => {
      if (renderUrlRef.current !== null) URL.revokeObjectURL(renderUrlRef.current);
      for (const url of candidateRenderUrlsRef.current.values()) URL.revokeObjectURL(url);
    };
  }, []);

  useEffect(() => {
    sourceGenerationRef.current += 1;
    for (const url of candidateRenderUrlsRef.current.values()) URL.revokeObjectURL(url);
    candidateRenderUrlsRef.current.clear();
    candidateRenderOrderRef.current = [];
    if (renderUrlRef.current !== null) URL.revokeObjectURL(renderUrlRef.current);
    renderUrlRef.current = null;
    setRenderedCandidateUrls({});
    setAlignmentCandidates([]);
    setSelectedAlignment(null);
    setPlan(null);
    setEvidence(null);
    setBedInfo(null);
    setError(null);
    setCandidateRendering(null);
    setPlanning(false);
    setRendering(null);
    setRenderUrl(null);
    setRenderKind(null);
    setSaveSuccess(null);
  }, [vocalsId, bedId, projectId]);

  const call = async (payload: Record<string, unknown>, kind: "mashup" | "extended") => {
    const sourceGeneration = sourceGenerationRef.current;
    setRendering(kind === "mashup" ? "mashup" : "extend");
    setError(null);
    try {
      const response = await fetch(`/api/waveyard/projects/${projectId}/mashup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (sourceGeneration !== sourceGenerationRef.current) return null;
      if (kind === "mashup" && response.headers.get("content-type")?.includes("application/json")) {
        const body = await response.json().catch(() => ({}));
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
      readMixReport(response);
      const url = URL.createObjectURL(await response.blob());
      if (sourceGeneration !== sourceGenerationRef.current) {
        URL.revokeObjectURL(url);
        return null;
      }
      if (renderUrlRef.current !== null) URL.revokeObjectURL(renderUrlRef.current);
      renderUrlRef.current = url;
      setRenderUrl(url);
      setRenderKind(kind);
      return null;
    } catch {
      if (sourceGeneration === sourceGenerationRef.current) {
        setError(kind === "mashup" ? "The mashup request failed." : "The instrumental extension failed.");
      }
      return null;
    } finally {
      if (sourceGeneration === sourceGenerationRef.current) setRendering(null);
    }
  };

  const planMashup = async () => {
    const sourceGeneration = sourceGenerationRef.current;
    setPlanning(true);
    setError(null);
    setEvidence(null);
    setPlan(null);
    setAlignmentCandidates([]);
    setSelectedAlignment(null);
    for (const url of candidateRenderUrlsRef.current.values()) URL.revokeObjectURL(url);
    candidateRenderUrlsRef.current.clear();
    candidateRenderOrderRef.current = [];
    setRenderedCandidateUrls({});
    try {
      const response = await fetch(`/api/waveyard/projects/${projectId}/mashup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "compare", vocalsSourceId: vocalsId, instrumentalSourceId: bedId }),
      });
      const body = await response.json().catch(() => ({}));
      if (sourceGeneration !== sourceGenerationRef.current) return;
      if (!response.ok) {
        setError(body.error ?? "Waveyard could not compare alignment options.");
        return;
      }
      if (body.bed) setBedInfo(body.bed as { source: string; warning: string; includedStemTypes?: string[] });
      setEvidence((body.evidence as EvidenceSummary | undefined) ?? null);
      const candidates = Array.isArray(body.candidates) ? body.candidates as AlignmentCandidatePlan[] : [];
      setAlignmentCandidates(candidates);
      // Honour the chosen mode first. Only if it is genuinely unavailable does the
      // fallback chain run, and the UI must say which mode it actually used.
      const preferred = candidates.find((candidate) => candidate.id === arrangementMode && candidate.available);
      const selected = preferred
        ?? (["phrase-aware", "paired-grid", "downbeat", "continuous"] as CandidateAlignmentId[])
          .map((id) => candidates.find((candidate) => candidate.id === id && candidate.available))
          .find((candidate) => candidate !== undefined);
      if (selected) {
        setSelectedAlignment(selected.id);
        setPlan(selected.plan);
        if (selected.id !== arrangementMode) {
          setError(
            `Full Length was unavailable for this pair: ${
              candidates.find((candidate) => candidate.id === arrangementMode)?.unavailableReason
              ?? "the planner could not place the performance"
            } Using ${selected.title} instead.`,
          );
        }
      } else {
        setError("No alignment option could place a vocal segment. Check the selected sources and their analysis.");
      }
    } catch {
      if (sourceGeneration === sourceGenerationRef.current) setError("Failed to compare mashup alignment options.");
    } finally {
      if (sourceGeneration === sourceGenerationRef.current) setPlanning(false);
    }
  };

  const selectAlignment = (id: CandidateAlignmentId) => {
    const candidate = alignmentCandidates.find((item) => item.id === id);
    if (!candidate?.available || !candidate.plan) return;
    setSelectedAlignment(id);
    setPlan(candidate.plan);
    setSaveSuccess(null);
  };

  const renderAlignment = async (id: CandidateAlignmentId) => {
    const candidate = alignmentCandidates.find((item) => item.id === id);
    if (!candidate?.available || candidateRendering !== null || rendering !== null) {
      if (candidateRendering !== null || rendering !== null) setError("Wait for the current render to finish before starting another.");
      return;
    }
    const sourceGeneration = sourceGenerationRef.current;
    setCandidateRendering(id);
    setError(null);
    try {
      const response = await fetch(`/api/waveyard/projects/${projectId}/mashup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "render",
          vocalsSourceId: vocalsId,
          instrumentalSourceId: bedId,
          alignmentStrategy: id,
          ...compositionPayload,
        }),
      });
      if (sourceGeneration !== sourceGenerationRef.current) return;
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        setError(body.error ?? `The ${candidate.title} render failed.`);
        return;
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
      readMixReport(response);
      const url = URL.createObjectURL(await response.blob());
      if (sourceGeneration !== sourceGenerationRef.current) {
        URL.revokeObjectURL(url);
        return;
      }
      const urls = candidateRenderUrlsRef.current;
      const previousUrl = urls.get(id);
      if (previousUrl) URL.revokeObjectURL(previousUrl);
      else if (urls.size >= 2) {
        const oldestId = candidateRenderOrderRef.current.shift();
        if (oldestId) {
          const oldestUrl = urls.get(oldestId);
          if (oldestUrl) URL.revokeObjectURL(oldestUrl);
          urls.delete(oldestId);
        }
      }
      urls.set(id, url);
      candidateRenderOrderRef.current = candidateRenderOrderRef.current.filter((candidateId) => candidateId !== id);
      candidateRenderOrderRef.current.push(id);
      setRenderedCandidateUrls(Object.fromEntries(urls) as Partial<Record<CandidateAlignmentId, string>>);
    } catch {
      if (sourceGeneration === sourceGenerationRef.current) setError(`Failed to render the ${candidate.title} candidate.`);
    } finally {
      if (sourceGeneration === sourceGenerationRef.current) setCandidateRendering(null);
    }
  };

  const keepOneCandidatePlaying = (playingId: CandidateAlignmentId) => {
    document.querySelectorAll<HTMLAudioElement>('[data-testid^="audio-candidate-"]').forEach((audio) => {
      if (audio.dataset.testid !== `audio-candidate-${playingId}` && !audio.paused) audio.pause();
    });
  };

  const saveMashupAsRemix = async () => {
    if (plan === null || selectedAlignment === null) return;
    setSavingRemix(true);
    setError(null);
    setSaveSuccess(null);
    try {
      const response = await fetch(`/api/waveyard/projects/${projectId}/mashup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save",
          vocalsSourceId: vocalsId,
          instrumentalSourceId: bedId,
          alignmentStrategy: selectedAlignment,
          ...compositionPayload,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.error ?? "Could not save mashup as remix.");
      } else {
          setSaveSuccess(`The ${alignmentCandidates.find((candidate) => candidate.id === selectedAlignment)?.title ?? "selected"} plan was saved to the project arrangement timeline as an editable remix.`);
      }
    } catch {
      setError("Failed to save mashup as remix.");
    } finally {
      setSavingRemix(false);
    }
  };

  const extendTrack = async () => {
    if (bedId === "") return;
    if (candidateRendering !== null) {
      setError("Wait for the current mashup render to finish before extending the track.");
      return;
    }
    await call({ action: "extend", sourceAssetId: bedId, repeats: 2 }, "extended");
  };

  const candidateViews: CandidateAlignmentCandidate[] = alignmentCandidates.map((candidate) => {
    const candidatePlan = candidate.plan;
    const selectedPassage = candidatePlan?.passageSearch?.evaluations.find((evaluation) => evaluation.selected) ?? null;
    const localDeviation = candidatePlan?.segments
      .map((segment) => segment.localTempoMap?.maximumRateDeviationPercent)
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
      .reduce((maximum, value) => Math.max(maximum, value), 0) ?? null;
    const evidenceNotes = candidatePlan?.rationale.filter((line) =>
      /beat|downbeat|phrase|entry|passage|continuous/i.test(line),
    ) ?? [];
    return {
      id: candidate.id,
      title: candidate.title,
      available: candidate.available,
      ...(candidate.unavailableReason ? { unavailableReason: candidate.unavailableReason } : {}),
      selected: candidate.id === selectedAlignment,
      rendering: candidate.id === candidateRendering,
      ...(renderedCandidateUrls[candidate.id] ? { renderedUrl: renderedCandidateUrls[candidate.id] } : {}),
      entryMs: candidatePlan?.segments[0]?.mashupStartMs ?? null,
      vocalTempoRatio: candidatePlan?.vocalsStretchRatio ?? null,
      pitchShiftSemitones: candidatePlan?.vocalsPitchSemitones ?? null,
      pairedGridFit: candidatePlan?.arrangement?.pairedBeatPhaseFit ?? null,
      localRateDeviationPercent: localDeviation,
      selectedDonorPassage: selectedPassage ? { startMs: selectedPassage.donorStartMs, endMs: selectedPassage.donorEndMs } : null,
      selectedBedPassage: selectedPassage && selectedPassage.bedStartMs !== null && selectedPassage.bedEndMs !== null
        ? { startMs: selectedPassage.bedStartMs, endMs: selectedPassage.bedEndMs }
        : null,
      evidenceNotes,
      limitations: candidatePlan?.warnings ?? [],
    };
  });

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
          <label>
            Arrangement
            <select
              aria-label="Arrangement mode"
              value={arrangementMode}
              onChange={(event) => {
                const next = event.target.value as CandidateAlignmentId;
                setArrangementMode(next);
                // The mode is the user's intent: a composition change must not
                // quietly drop it back to the default.
                const candidate = alignmentCandidates.find((item) => item.id === next && item.available);
                if (candidate) {
                  setSelectedAlignment(next);
                  setPlan(candidate.plan);
                  setSaveSuccess(null);
                }
              }}
            >
              <option value="full-length">Full Length — complete performance, looped if the bed has room</option>
              <option value="phrase-aware">Fingerprint-ranked passage</option>
              <option value="continuous">Continuous baseline</option>
              <option value="paired-grid">Paired beat-grid</option>
              <option value="downbeat">Measured downbeat</option>
            </select>
          </label>
          <button className="button" disabled={planning || candidateRendering !== null || rendering !== null || vocalsId === "" || bedId === "" || vocalsId === bedId} onClick={() => void planMashup()}>
            {planning ? "Comparing real alternatives…" : "Compare alignment options"}
          </button>
        </div>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
      {canEdit && (
        <CandidateAlignmentLab
          candidates={candidateViews}
          selectedId={selectedAlignment}
          onSelect={selectAlignment}
          onRender={(id) => void renderAlignment(id)}
          onAudioPlay={keepOneCandidatePlaying}
        />
      )}
      {canEdit && alignmentCandidates.length > 0 && (
        <p className="mashup-memory-note">
          To keep long WAV previews from using excessive memory, Waveyard retains at most two rendered candidates at a time; rendering another replaces the oldest preview.
        </p>
      )}

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
                Whole-track placement · {plan.arrangement.selected === "coherent-overlay" ? "moved as one flow" : "kept continuous"}
                {" · "}{plan.arrangement.unitsPlaced}/{plan.arrangement.unitsTotal} activity windows
              </summary>
              <p>
                Relative placement evidence, not a quality prediction or verse/chorus label.
                {" "}Coherent {plan.arrangement.coherentScore.toFixed(2)} · current entry {plan.arrangement.overlayScore.toFixed(2)}
                {plan.arrangement.improvementRatio === null
                  ? ""
                  : ` · difference ${(plan.arrangement.improvementRatio * 100).toFixed(1)}%`}
              </p>
              <p>
                Activity windows placed: coherent {plan.arrangement.coherentUnitsPlaced}/{plan.arrangement.unitsTotal}
                {" · "}continuous {plan.arrangement.continuousUnitsPlaced}/{plan.arrangement.unitsTotal}
              </p>
              {plan.arrangement.selected === "coherent-overlay" && (
                <p>The vocal body stays in one continuous clip from {(plan.arrangement.coherentEntryMs / 1000).toFixed(1)}s; its internal pauses keep their original timing.</p>
              )}
              {plan.arrangement.pairedBeatPhaseFit && plan.arrangement.baselineBeatPhaseFit && (
                <p>
                  Donor-to-bed beat phase: {plan.arrangement.pairedBeatPhaseFit.matchedBeats}/
                  {plan.arrangement.pairedBeatPhaseFit.comparedBeats} donor beats within{" "}
                  {plan.arrangement.pairedBeatPhaseFit.toleranceMs} ms
                  {" · "}current entry {plan.arrangement.baselineBeatPhaseFit.matchedBeats}/
                  {plan.arrangement.baselineBeatPhaseFit.comparedBeats}
                  {" · "}mean error {plan.arrangement.pairedBeatPhaseFit.meanErrorMs.toFixed(1)} ms.
                  {" "}This measures grid alignment only, not mix quality.
                </p>
              )}
              {plan.arrangement.warnings.map((warning, index) => <p key={`${warning}-${index}`} role="status">{warning}</p>)}
              <p>
                Available: {[
                  plan.arrangement.evidence.chordTimeline ? "vocal/chord fit" : null,
                  plan.arrangement.evidence.drumTransients ? "drum transients" : null,
                  plan.arrangement.evidence.bassAttacks ? "bass attacks" : null,
                  plan.arrangement.evidence.beatGrid ? "trusted beat grid" : null,
                  plan.arrangement.evidence.pairedBeatGrids ? "paired donor/bed beat grids" : null,
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
              <button className="button secondary" disabled={savingRemix || selectedAlignment === null || candidateRendering !== null} onClick={() => void saveMashupAsRemix()}>
                {savingRemix ? "Saving…" : "Save as project remix"}
              </button>
              <small>Save the selected alignment as an editable project remix. Rendering a candidate above creates a separate WAV to audition.</small>
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

      {mixReport && (
        <p className="mashup-mix-report" role="status" style={{ fontSize: 13 }}>
          <b>Composition:</b>{" "}
          {mixReport.layerStems.length === 0
            ? "vocal donor over the bed's own drums, bass and other (no donor rhythm section added)."
            : mixReport.stemLayerMode === "layer"
              ? `vocal donor over the bed, plus deliberately doubled donor ${mixReport.layerStems.join(", ")} (two sources cover the same role).`
              : `vocal donor over the bed, with donor ${mixReport.layerStems.join(", ")} replacing the bed's ${mixReport.replacedBedStems.length > 0 ? mixReport.replacedBedStems.join(", ") : "matching stems"}.`}
          <br />
          <b>Mix (measured from this render):</b>{" "}
          vocal-to-bed balance {mixReport.balanceDb !== null ? `${mixReport.balanceDb} dB` : "not measurable"}
          {mixReport.balanceClamped ? " (clamped — the pair is very unbalanced)" : ""}; static gain{" "}
          {mixReport.staticGainDb ?? "n/a"} dB; limiter{" "}
          {mixReport.limiter === "active" ? "active" : "not required"}; true peak{" "}
          {mixReport.truePeakDb === "not-measured" || mixReport.truePeakDb === null
            ? "true peak not re-measured on a render this long"
            : `${mixReport.truePeakDb} dBTP`};{" "}
          {mixReport.clippedRegions ?? "0"} clipped region(s). Measurements, not a quality score.
        </p>
      )}

      <fieldset className="mashup-composition" style={{ fontSize: 13, marginTop: 12 }}>
        <legend><b>Donor rhythm section</b></legend>
        <p style={{ margin: "4px 0", opacity: 0.85 }}>
          Default: the donor supplies the vocal and the bed keeps its own drums, bass and other.
          Adding a donor stem either replaces the bed&apos;s copy or doubles it — never silently,
          and never when either half cannot be verified.
        </p>
        {(["drums", "bass"] as const).map((stemType) => (
          <label key={stemType} style={{ marginRight: 12 }}>
            <input
              type="checkbox"
              checked={layerStemTypes.includes(stemType)}
              onChange={(event) => setComposition(
                event.target.checked
                  ? [...layerStemTypes, stemType]
                  : layerStemTypes.filter((type) => type !== stemType),
                stemLayerMode,
              )}
            />{" "}
            Donor {stemType}
          </label>
        ))}
        <label style={{ marginLeft: 8 }}>
          Applying as{" "}
          <select
            value={stemLayerMode}
            disabled={layerStemTypes.length === 0}
            onChange={(event) => setComposition(layerStemTypes, event.target.value === "layer" ? "layer" : "replace")}
          >
            <option value="replace">replace the bed&apos;s {layerStemTypes.join(" and ") || "stem"}</option>
            <option value="layer">double it on top</option>
          </select>
        </label>
      </fieldset>

      {canEdit && (
        <div className="remix-actions mashup-extend">
          <button className="button secondary" disabled={rendering !== null || candidateRendering !== null || bedId === ""} onClick={() => void extendTrack()}>
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
