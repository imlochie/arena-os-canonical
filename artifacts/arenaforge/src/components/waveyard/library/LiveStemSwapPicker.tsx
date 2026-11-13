"use client";

import Link from "@/routing/Link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  hasReliableLiveStemTempoEvidence,
  hasReliableLiveStemBeatEvidence,
  isHalfDoubleTempoPair,
  keyCompatibilityEvidence,
  liveStemTempoStretchRatio,
  nearestEntryEvidenceMs,
  normalizeManualTempoBpm,
  type LiveStemSectionAlignmentCandidate,
} from "@workspace/arena/lib/waveyard/library/session-logic";
import { displaySourceSectionLabel, type SourceSection } from "@workspace/arena/lib/waveyard/types/source-sections";

export interface LiveStemDonorOption {
  id: string;
  title: string;
  artist: string;
  bpm: number | null;
  bpmConfidence: number | null;
  automaticBpm: number | null;
  tempoCorrected: boolean;
  beatConfidence: number | null;
  musicalKey: string | null;
  keyConfidence: number | null;
  durationSeconds: number | null;
  collection: "session" | "library";
}

export interface LiveStemPreparationOption {
  id: string;
  title: string;
  artist: string;
  status: "source-only" | "not-started" | "processing" | "failed" | "rejected";
  progressLabel?: string;
}

interface LiveStemSwapPickerProps {
  stemType: string;
  currentTrackId: string;
  currentTrackTitle: string;
  currentBpm: number | null;
  currentAutomaticBpm: number | null;
  currentTempoCorrected: boolean;
  currentBpmConfidence: number | null;
  currentBeatConfidence: number | null;
  currentKey: string | null;
  currentKeyConfidence: number | null;
  currentPositionSeconds: number;
  candidates: LiveStemDonorOption[];
  preparationCandidates: LiveStemPreparationOption[];
  preparingTrackIds: ReadonlySet<string>;
  selectedDonorId: string | null;
  selectedDonorTitle: string | null;
  warmingDonorId: string | null;
  swapStatus: string | null;
  vocalHealthMessage: string | null;
  isOpen: boolean;
  pending: boolean;
  busy: boolean;
  onToggle: () => void;
  onClose: () => void;
  onChoose: (donorId: string, donorEntryOffsetMs?: number | null) => void;
  onGetEntryCandidates: (donorId: string) => LiveStemSectionAlignmentCandidate[];
  onResolvePreviewAsset: (donorId: string, stemType: string) => Promise<string | null>;
  onWarm: (donorId: string) => void;
  onPrefetch: (donorId: string) => void;
  onPrepare: (trackId: string) => void;
  onTempoCorrection: (trackId: string, bpm: number | null) => void;
  selectedDonorDurationSeconds: number | null;
  selectedDonorEntryOffsetMs: number | null;
  selectedDonorSections: Pick<SourceSection, "sectionIndex" | "startMs" | "label" | "labelConfidence">[] | null;
  selectedDonorVocalActivityStartsMs: { startMs: number; confidence: number }[] | null;
  selectedDonorVoicedPhraseStartsMs: { startMs: number; confidence: number }[] | null;
  onApplyDonorEntryOffset: (offsetMs: number | null) => void;
  onRestore: () => void;
}

function TempoCorrectionControl({
  trackId,
  trackTitle,
  automaticBpm,
  correctedBpm,
  confidence,
  onApply,
}: {
  trackId: string;
  trackTitle: string;
  automaticBpm: number | null;
  correctedBpm: number | null;
  confidence: number | null;
  onApply: (trackId: string, bpm: number | null) => void;
}) {
  const [draft, setDraft] = useState(correctedBpm?.toString() ?? automaticBpm?.toString() ?? "");
  const uncertain = confidence === null || confidence < 0.5;
  const hasManualTempo = correctedBpm !== null;

  useEffect(() => {
    setDraft(correctedBpm?.toString() ?? automaticBpm?.toString() ?? "");
  }, [automaticBpm, correctedBpm]);

  const normalizedDraft = normalizeManualTempoBpm(draft);
  return (
    <details
      className="wy-tempo-correction"
      open={hasManualTempo}
      data-testid={`tempo-correction-${trackId}`}
    >
      <summary>
        {hasManualTempo
          ? `Manual BPM · ${correctedBpm} · edit`
          : `${trackTitle} · ${uncertain ? "tempo uncertain" : "correct BPM"}`}
      </summary>
      <div className="wy-tempo-correction-controls">
        <label>
          <span>{trackTitle} BPM</span>
          <input
            type="number"
            min="40"
            max="300"
            step="0.1"
            inputMode="decimal"
            value={draft}
            aria-label={`Confirmed tempo for ${trackTitle} in BPM`}
            onChange={(event) => setDraft(event.target.value)}
          />
        </label>
        <button
          type="button"
          disabled={normalizedDraft === null || (hasManualTempo && normalizedDraft === correctedBpm)}
          onClick={() => {
            if (normalizedDraft === null) return;
            setDraft(String(normalizedDraft));
            onApply(trackId, normalizedDraft);
          }}
        >
          Apply
        </button>
        {hasManualTempo && (
          <button
            type="button"
            onClick={() => {
              setDraft(automaticBpm?.toString() ?? "");
              onApply(trackId, null);
            }}
          >
            Use analysis
          </button>
        )}
        <small>
          {hasManualTempo
            ? "This local correction can enable tempo matching. Beat alignment still needs a confident analyzed grid."
            : automaticBpm === null
              ? "No BPM was measured. Enter a tempo from 40–300; beat alignment remains unavailable."
              : `Measured ${Math.round(automaticBpm)} BPM${uncertain ? " · low confidence" : ""}. A correction is local to this session and device.`}
        </small>
      </div>
    </details>
  );
}

function matchLabel(label: string, known: boolean, compatible: boolean) {
  if (!known) return `${label} unknown`;
  return compatible ? `${label} match` : `${label} differs`;
}

function usesCompactPickerViewport() {
  return window.matchMedia(
    "(max-width: 640px), (max-width: 1000px) and (max-height: 520px) and (orientation: landscape)",
  ).matches;
}

function formatEntryTime(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function formatEvidencePercent(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "unavailable" : `${Math.round(value * 100)}%`;
}

function VocalEntryTimeControl({
  donorId,
  donorTitle,
  durationSeconds,
  entryOffsetMs,
  sections,
  vocalActivityStartsMs,
  voicedPhraseStartsMs,
  disabled,
  onApply,
}: {
  donorId: string;
  donorTitle: string;
  durationSeconds: number | null;
  entryOffsetMs: number | null;
  sections: Pick<SourceSection, "sectionIndex" | "startMs" | "label" | "labelConfidence">[] | null;
  vocalActivityStartsMs: { startMs: number; confidence: number }[] | null;
  voicedPhraseStartsMs: { startMs: number; confidence: number }[] | null;
  disabled: boolean;
  onApply: (offsetMs: number | null) => void;
}) {
  const durationMs = durationSeconds !== null && Number.isFinite(durationSeconds) && durationSeconds > 0
    ? Math.max(1, Math.floor(durationSeconds * 1000) - 1)
    : null;
  const [draftMs, setDraftMs] = useState(entryOffsetMs ?? 0);
  const [snapMessage, setSnapMessage] = useState("");

  useEffect(() => {
    setDraftMs(entryOffsetMs ?? 0);
    setSnapMessage("");
  }, [donorId, donorTitle, entryOffsetMs]);

  const snapTo = (points: readonly { startMs: number }[] | null | undefined, description: string) => {
    const nearest = nearestEntryEvidenceMs(draftMs, points);
    if (nearest === null) {
      setSnapMessage(`No measured ${description.toLowerCase()} is available.`);
      return;
    }
    setDraftMs(nearest);
    setSnapMessage(`Snapped to ${description.toLowerCase()} at ${formatEntryTime(nearest)}.`);
  };

  const activityPoints = vocalActivityStartsMs ?? [];
  const phrasePoints = voicedPhraseStartsMs ?? [];
  const sectionPoints = sections ?? [];
  const boundedDraftMs = durationMs === null ? Math.max(0, Math.round(draftMs))
    : Math.min(durationMs, Math.max(0, Math.round(draftMs)));
  const canApply = durationMs !== null && !disabled && entryOffsetMs !== boundedDraftMs;
  const exactSection = sections?.find((section) => section.startMs === boundedDraftMs);

  return (
    <section className="wy-vocal-entry-control" aria-label={`Vocal entry timing for ${donorTitle}`} data-testid="vocal-entry-timing">
      <div className="wy-vocal-entry-heading">
        <strong>Vocal start in {donorTitle}</strong>
        <span>{entryOffsetMs === null ? "Automatic alignment" : `Manual · ${formatEntryTime(entryOffsetMs)}`}</span>
      </div>
      {durationMs !== null ? (
        <>
          <label className="wy-vocal-entry-time">
            <span>Choose donor start</span>
            <input
              type="range"
              min={0}
              max={durationMs}
              step={50}
              value={boundedDraftMs}
              disabled={disabled}
              aria-label={`Donor vocal start time for ${donorTitle}`}
              data-testid="vocal-entry-time-slider"
              onChange={(event) => setDraftMs(Number(event.target.value))}
            />
            <output data-testid="text-vocal-entry-time">{formatEntryTime(boundedDraftMs)}</output>
          </label>
          <div className="wy-vocal-entry-snaps" aria-label="Snap donor start to analyzed evidence">
            <button type="button" disabled={disabled || activityPoints.length === 0}
              data-testid="button-snap-vocal-activity"
              onClick={() => snapTo(activityPoints, "vocal activity")}>
              Snap to vocal activity
            </button>
            <button type="button" disabled={disabled || phrasePoints.length === 0}
              data-testid="button-snap-voiced-phrase"
              onClick={() => snapTo(phrasePoints, "voiced phrase candidate")}>
              Snap to voiced phrase
            </button>
            <button type="button" disabled={disabled || sectionPoints.length === 0}
              data-testid="button-snap-donor-section"
              onClick={() => snapTo(sectionPoints, "detected section boundary")}>
              Snap to section
            </button>
          </div>
          <div className="wy-vocal-entry-actions">
            <button type="button" disabled={!canApply} data-testid="button-apply-vocal-entry" onClick={() => onApply(boundedDraftMs)}>
              Apply entry
            </button>
            <button type="button" disabled={disabled || entryOffsetMs === null} data-testid="button-auto-vocal-entry" onClick={() => onApply(null)}>
              Automatic alignment
            </button>
          </div>
          <small className="wy-vocal-entry-evidence" role="note" data-testid="text-vocal-entry-limitations">
            Vocal activity is not lyric transcription. Pitch-phrase starts can miss unvoiced consonants; section labels are not guaranteed to mean verse or chorus.
          </small>
          {exactSection && (
            <small className="wy-vocal-entry-section" data-testid="text-vocal-entry-section">
              At {displaySourceSectionLabel(exactSection)}
            </small>
          )}
          {snapMessage && <small className="wy-vocal-entry-snap-status" role="status" data-testid="status-vocal-entry-snap">{snapMessage}</small>}
        </>
      ) : (
        <small className="wy-vocal-entry-evidence" role="note" data-testid="text-vocal-entry-limitations">
          Donor duration is unavailable, so manual entry timing cannot be applied.
        </small>
      )}
    </section>
  );
}

export default function LiveStemSwapPicker({
  stemType,
  currentTrackId,
  currentTrackTitle,
  currentBpm,
  currentAutomaticBpm,
  currentTempoCorrected,
  currentBpmConfidence,
  currentBeatConfidence,
  currentKey,
  currentKeyConfidence,
  currentPositionSeconds,
  candidates,
  preparationCandidates,
  preparingTrackIds,
  selectedDonorId,
  selectedDonorTitle,
  warmingDonorId,
  swapStatus,
  vocalHealthMessage,
  isOpen,
  pending,
  busy,
  onToggle,
  onClose,
  onChoose,
  onGetEntryCandidates,
  onResolvePreviewAsset,
  onWarm,
  onPrefetch,
  onPrepare,
  onTempoCorrection,
  selectedDonorDurationSeconds,
  selectedDonorEntryOffsetMs,
  selectedDonorSections,
  selectedDonorVocalActivityStartsMs,
  selectedDonorVoicedPhraseStartsMs,
  onApplyDonorEntryOffset,
  onRestore,
}: LiveStemSwapPickerProps) {
  const [query, setQuery] = useState("");
  const pickerRef = useRef<HTMLElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const firstCandidateRef = useRef<HTMLButtonElement>(null);
  const firstPreparationRef = useRef<HTMLButtonElement>(null);
  const hoverWarmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prefetchedCandidateKeyRef = useRef<string | null>(null);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const previewResolveSequenceRef = useRef(0);
  const previewStopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [entryDonorId, setEntryDonorId] = useState<string | null>(null);
  const [entryCandidates, setEntryCandidates] = useState<LiveStemSectionAlignmentCandidate[]>([]);
  const [selectedEntryIndex, setSelectedEntryIndex] = useState(0);
  const [manualEntryMs, setManualEntryMs] = useState(0);
  const [previewAssetUrl, setPreviewAssetUrl] = useState<string | null>(null);
  const [previewAssetState, setPreviewAssetState] = useState<"idle" | "loading" | "ready" | "unavailable">("idle");
  const [previewAudioReady, setPreviewAudioReady] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [previewMessage, setPreviewMessage] = useState("");
  const pickerId = `live-swap-picker-${stemType}`;
  const prefetchCandidateId = candidates.slice(1).find((candidate) => candidate.id !== selectedDonorId)?.id ?? null;
  const stopEntryPreview = useCallback(() => {
    if (previewStopTimerRef.current !== null) clearTimeout(previewStopTimerRef.current);
    previewStopTimerRef.current = null;
    const audio = previewAudioRef.current;
    if (audio) {
      audio.pause();
      audio.onended = null;
      audio.ontimeupdate = null;
    }
    setPreviewing(false);
  }, []);
  const stageDonorForEntry = useCallback((donorId: string) => {
    stopEntryPreview();
    const sequence = ++previewResolveSequenceRef.current;
    const alternatives = stemType === "vocals" ? onGetEntryCandidates(donorId) : [];
    setEntryDonorId(donorId);
    setEntryCandidates(alternatives);
    setSelectedEntryIndex(0);
    setManualEntryMs(alternatives[0]?.donorEntryMs ?? 0);
    setPreviewAssetUrl(null);
    setPreviewAudioReady(false);
    setPreviewAssetState("loading");
    setPreviewMessage("");
    void onResolvePreviewAsset(donorId, stemType).then((url) => {
      if (previewResolveSequenceRef.current !== sequence) return;
      setPreviewAssetUrl(url);
      setPreviewAssetState(url === null ? "unavailable" : "ready");
    }).catch(() => {
      if (previewResolveSequenceRef.current !== sequence) return;
      setPreviewAssetUrl(null);
      setPreviewAssetState("unavailable");
    });
  }, [onGetEntryCandidates, onResolvePreviewAsset, stemType, stopEntryPreview]);

  const selectedAlignmentCandidate = entryCandidates[selectedEntryIndex] ?? null;
  const stagedDonor = candidates.find((candidate) => candidate.id === entryDonorId) ?? null;
  const entryTempoEvidence = stagedDonor === null ? null : {
    recipientBpmConfidence: currentBpmConfidence,
    donorBpmConfidence: stagedDonor.bpmConfidence,
    recipientBeatConfidence: currentBeatConfidence,
    donorBeatConfidence: stagedDonor.beatConfidence,
  };
  const entryStretchRatio = stagedDonor === null || entryTempoEvidence === null
    ? 1
    : liveStemTempoStretchRatio(currentBpm, stagedDonor.bpm, entryTempoEvidence) ?? 1;
  const selectedAlignmentIsStale = selectedAlignmentCandidate !== null
    && (currentPositionSeconds * 1000 < selectedAlignmentCandidate.recipientWindowStartMs
      || currentPositionSeconds * 1000 >= selectedAlignmentCandidate.recipientWindowEndMs);

  useEffect(() => {
    const audio = previewAudioRef.current;
    if (!isOpen || !previewAssetUrl) {
      if (audio) {
        audio.pause();
        audio.removeAttribute("src");
        audio.load();
      }
      previewAudioRef.current = null;
      setPreviewAudioReady(false);
      setPreviewing(false);
      return;
    }
    const audition = new Audio(previewAssetUrl);
    audition.preload = "auto";
    audition.volume = 0.5;
    const onLoadedMetadata = () => setPreviewAudioReady(true);
    const onAudioError = () => {
      setPreviewAudioReady(false);
      setPreviewAssetState("unavailable");
    };
    audition.addEventListener("loadedmetadata", onLoadedMetadata);
    audition.addEventListener("error", onAudioError);
    audition.load();
    previewAudioRef.current = audition;
    return () => {
      audition.removeEventListener("loadedmetadata", onLoadedMetadata);
      audition.removeEventListener("error", onAudioError);
      audition.pause();
      audition.removeAttribute("src");
      audition.load();
      if (previewAudioRef.current === audition) previewAudioRef.current = null;
    };
  }, [isOpen, previewAssetUrl]);

  useEffect(() => {
    if (isOpen) return;
    stopEntryPreview();
    setEntryDonorId(null);
    setEntryCandidates([]);
    setPreviewAssetUrl(null);
    setPreviewAudioReady(false);
    setPreviewAssetState("idle");
    setPreviewMessage("");
  }, [isOpen, stopEntryPreview]);

  useEffect(() => () => {
    if (previewStopTimerRef.current !== null) clearTimeout(previewStopTimerRef.current);
    previewAudioRef.current?.pause();
  }, []);

  const refreshEntryCandidates = () => {
    if (entryDonorId !== null) stageDonorForEntry(entryDonorId);
  };

  const previewSelectedEntry = async () => {
    const audio = previewAudioRef.current;
    const candidate = selectedAlignmentCandidate;
    const currentMs = currentPositionSeconds * 1000;
    if (!audio || !candidate || previewAssetState !== "ready" || !previewAudioReady) {
      setPreviewMessage("The donor audio is not ready to audition yet.");
      return;
    }
    if (currentMs < candidate.recipientWindowStartMs || currentMs >= candidate.recipientWindowEndMs) {
      setPreviewMessage("The playhead moved outside this matched window. Refresh alternatives before auditioning.");
      return;
    }
    const donorStartMs = (currentMs + candidate.offsetSeconds * 1000) / entryStretchRatio;
    if (!Number.isFinite(donorStartMs)
      || donorStartMs < candidate.donorWindowStartMs
      || donorStartMs >= candidate.donorWindowEndMs) {
      setPreviewMessage("This candidate no longer maps to a valid donor time. Refresh alternatives.");
      return;
    }
    stopEntryPreview();
    const media = audio as HTMLAudioElement & {
      preservesPitch?: boolean;
      webkitPreservesPitch?: boolean;
      mozPreservesPitch?: boolean;
    };
    audio.currentTime = donorStartMs / 1000;
    audio.playbackRate = 1 / entryStretchRatio;
    if ("preservesPitch" in media) media.preservesPitch = true;
    if ("webkitPreservesPitch" in media) media.webkitPreservesPitch = true;
    if ("mozPreservesPitch" in media) media.mozPreservesPitch = true;
    const donorRemainingMs = candidate.donorWindowEndMs - donorStartMs;
    const recipientRemainingMs = candidate.recipientWindowEndMs - currentMs;
    const previewDurationMs = Math.min(12_000, donorRemainingMs * entryStretchRatio, recipientRemainingMs);
    const stopAtSeconds = donorStartMs / 1000 + previewDurationMs / entryStretchRatio / 1000;
    audio.ontimeupdate = () => {
      if (audio.currentTime >= stopAtSeconds) stopEntryPreview();
    };
    audio.onended = () => {
      setPreviewing(false);
      if (previewStopTimerRef.current !== null) clearTimeout(previewStopTimerRef.current);
      previewStopTimerRef.current = null;
    };
    try {
      await audio.play();
      setPreviewing(true);
      setPreviewMessage("Auditioning the selected donor window at the current playhead. Browser pitch/time processing may differ from the final mix.");
      previewStopTimerRef.current = setTimeout(stopEntryPreview, Math.max(250, previewDurationMs + 200));
    } catch {
      setPreviewing(false);
      setPreviewMessage("The browser blocked playback. Press audition again to retry.");
    }
  };
  const focusSwapTrigger = useCallback(() => {
    const quickTrigger = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-live-swap-anchor]"))
      .find((candidate) =>
        candidate.dataset.liveSwapAnchor === stemType && candidate.getClientRects().length > 0,
      );
    (quickTrigger ?? triggerRef.current)?.focus();
  }, [stemType]);

  const filteredCandidates = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (normalizedQuery === "") return candidates;
    return candidates.filter((candidate) =>
      `${candidate.title} ${candidate.artist}`.toLocaleLowerCase().includes(normalizedQuery),
    );
  }, [candidates, query]);
  const filteredPreparationCandidates = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (normalizedQuery === "") return preparationCandidates;
    return preparationCandidates.filter((candidate) =>
      `${candidate.title} ${candidate.artist}`.toLocaleLowerCase().includes(normalizedQuery),
    );
  }, [preparationCandidates, query]);
  const sourceCount = candidates.length + preparationCandidates.length;
  const clearHoverWarm = useCallback(() => {
    if (hoverWarmTimerRef.current !== null) clearTimeout(hoverWarmTimerRef.current);
    hoverWarmTimerRef.current = null;
  }, []);
  const scheduleHoverWarm = useCallback((donorId: string) => {
    clearHoverWarm();
    hoverWarmTimerRef.current = setTimeout(() => {
      hoverWarmTimerRef.current = null;
      onWarm(donorId);
    }, 140);
  }, [clearHoverWarm, onWarm]);

  useEffect(() => {
    if (!isOpen) {
      setQuery("");
      prefetchedCandidateKeyRef.current = null;
      return;
    }
    if (usesCompactPickerViewport()) pickerRef.current?.focus({ preventScroll: true });
    else if (sourceCount > 4) searchRef.current?.focus();
    else if (candidates.length > 0) firstCandidateRef.current?.focus();
    else firstPreparationRef.current?.focus();
  }, [candidates.length, isOpen, sourceCount]);

  useEffect(() => {
    if (!isOpen || !usesCompactPickerViewport()) return;
    const picker = pickerRef.current;
    if (picker === null) return;

    const visualViewport = window.visualViewport;
    const updateViewportBounds = () => {
      const visualHeight = visualViewport?.height ?? window.innerHeight;
      const visualTop = visualViewport?.offsetTop ?? 0;
      const layoutHeight = Math.max(document.documentElement.clientHeight, window.innerHeight);
      const keyboardInset = Math.max(0, layoutHeight - visualTop - visualHeight);
      picker.style.setProperty("--wy-swap-visual-height", `${Math.round(visualHeight)}px`);
      picker.style.setProperty("--wy-swap-keyboard-inset", `${Math.round(keyboardInset)}px`);
    };

    updateViewportBounds();
    visualViewport?.addEventListener("resize", updateViewportBounds);
    visualViewport?.addEventListener("scroll", updateViewportBounds);
    window.addEventListener("resize", updateViewportBounds);
    return () => {
      visualViewport?.removeEventListener("resize", updateViewportBounds);
      visualViewport?.removeEventListener("scroll", updateViewportBounds);
      window.removeEventListener("resize", updateViewportBounds);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || prefetchCandidateId === null) return;
    const key = `${stemType}:${prefetchCandidateId}`;
    if (prefetchedCandidateKeyRef.current === key) return;
    prefetchedCandidateKeyRef.current = key;
    onPrefetch(prefetchCandidateId);
  }, [isOpen, onPrefetch, prefetchCandidateId, stemType]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        focusSwapTrigger();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [focusSwapTrigger, isOpen, onClose]);

  useEffect(() => {
    if (!isOpen) clearHoverWarm();
  }, [clearHoverWarm, isOpen]);

  useEffect(() => () => clearHoverWarm(), [clearHoverWarm]);

  const closeAndReturnFocus = () => {
    onClose();
    focusSwapTrigger();
  };
  const sessionCandidates = filteredCandidates.filter((candidate) => candidate.collection === "session");
  const libraryCandidates = filteredCandidates.filter((candidate) => candidate.collection === "library");
  const visiblePreparationCandidates = filteredPreparationCandidates.slice(0, 12);

  const renderCandidate = (candidate: LiveStemDonorOption, index: number) => {
    const tempoEvidence = {
      recipientBpmConfidence: currentBpmConfidence,
      donorBpmConfidence: candidate.bpmConfidence,
      recipientBeatConfidence: currentBeatConfidence,
      donorBeatConfidence: candidate.beatConfidence,
    };
    const reliableTempoEvidence = hasReliableLiveStemTempoEvidence(tempoEvidence);
    const reliableBeatEvidence = hasReliableLiveStemBeatEvidence(tempoEvidence);
    const stretchRatio = liveStemTempoStretchRatio(currentBpm, candidate.bpm, tempoEvidence);
    const key = keyCompatibilityEvidence(
      currentKey,
      currentKeyConfidence,
      candidate.musicalKey,
      candidate.keyConfidence,
    );
    const tempoKnown = currentBpm !== null && candidate.bpm !== null
      && Number.isFinite(currentBpm) && Number.isFinite(candidate.bpm)
      && currentBpm > 0 && candidate.bpm > 0;
    const halfDoubleTempo = tempoKnown && reliableTempoEvidence && isHalfDoubleTempoPair(currentBpm, candidate.bpm);
    const lowTempoConfidence = tempoKnown && !reliableTempoEvidence;
    const lowBeatConfidence = tempoKnown && !reliableBeatEvidence;
    const tempoMatchUnavailable = tempoKnown && !lowTempoConfidence && stretchRatio === null && !halfDoubleTempo;
    const keyKnown = currentKey !== null && candidate.musicalKey !== null;
    const tempoLabel = !tempoKnown ? "BPM unknown"
      : lowTempoConfidence ? "Low confidence · native pace"
      : halfDoubleTempo ? "Half/double-time · no stretch"
      : stretchRatio === null ? "Outside tempo-match range"
      : Math.abs(stretchRatio - 1) < 0.001 ? "Same tempo"
      : `Match ${candidate.bpm} → ${currentBpm} BPM`;
    const keyLabel = !keyKnown ? "Key unknown"
      : key.confidenceLevel === "confident" ? matchLabel("Key", true, key.compatible)
      : key.confidenceLevel === "tentative"
        ? `Tentative key · possible ${key.compatible ? "fit" : "clash"}`
        : "Key confidence unavailable";
    const selected = stemType === "vocals"
      ? candidate.id === entryDonorId
      : candidate.id === selectedDonorId;
    const isWarming = candidate.id === warmingDonorId;
    const warmStatus = tempoKnown && stretchRatio !== null && Math.abs(stretchRatio - 1) > 0.001
      ? "Preparing tempo match…"
      : "Preparing stem audio…";
    return (
      <div className="wy-swap-candidate-card" key={candidate.id}>
        <button
          ref={index === 0 ? firstCandidateRef : undefined}
          className={`wy-swap-candidate${selected ? " selected" : ""}`}
          type="button"
          disabled={tempoMatchUnavailable}
          title={tempoMatchUnavailable ? "Live swap is disabled because matching would require an extreme tempo change." : undefined}
          aria-pressed={selected}
          aria-busy={isWarming}
          aria-label={`${tempoMatchUnavailable ? "Unavailable; " : stemType === "vocals" ? `Compare ${candidate.title} vocal entry alternatives; ` : `Use ${candidate.title} for ${stemType}; `}${tempoMatchUnavailable ? "tempo change too large for a safe live match" : tempoLabel}; ${keyLabel}${lowBeatConfidence ? "; beat sync unavailable because analysis confidence is low" : ""}${isWarming ? `; ${warmStatus}` : ""}`}
          data-testid={`live-swap-candidate-${stemType}-${candidate.id}`}
          onFocus={() => { clearHoverWarm(); onWarm(candidate.id); }}
          onPointerEnter={() => scheduleHoverWarm(candidate.id)}
          onPointerLeave={clearHoverWarm}
          onPointerDown={() => { clearHoverWarm(); onWarm(candidate.id); }}
          onClick={() => {
            if (stemType === "vocals") {
              stageDonorForEntry(candidate.id);
              return;
            }
            onChoose(candidate.id);
            closeAndReturnFocus();
          }}
        >
          <span className="wy-swap-candidate-copy">
            <strong>{candidate.title}{stemType === "vocals" && candidate.id === selectedDonorId ? " · current donor" : ""}</strong>
            <small>
              {candidate.artist || "Unknown artist"}
              {candidate.tempoCorrected
                ? ` · Manual ${Math.round(candidate.bpm ?? 0)} BPM`
                : candidate.bpm !== null
                  ? candidate.bpmConfidence === null || candidate.bpmConfidence < 0.5
                    ? ` · ~${Math.round(candidate.bpm)} BPM (uncertain)`
                    : ` · ${Math.round(candidate.bpm)} BPM`
                  : " · BPM unavailable"}
              {candidate.musicalKey ? ` · ${candidate.musicalKey}` : " · key unavailable"}
            </small>
          </span>
          <span className="wy-swap-fit">
            <span className={`wy-swap-fit-chip ${!tempoKnown || lowTempoConfidence ? "unknown" : (stretchRatio !== null ? "match" : "different")}`}>
              {tempoLabel}
            </span>
            <span className={`wy-swap-fit-chip ${keyKnown ? (key.compatible ? "match" : "different") : "unknown"}`}>
              {keyLabel}
            </span>
            {lowBeatConfidence && (
              <span className="wy-swap-fit-chip unknown">Beat sync unavailable</span>
            )}
            {isWarming && <span className="wy-swap-fit-chip unknown" role="status">{warmStatus}</span>}
          </span>
        </button>
        <TempoCorrectionControl
          trackId={candidate.id}
          trackTitle={candidate.title}
          automaticBpm={candidate.automaticBpm}
          correctedBpm={candidate.tempoCorrected ? candidate.bpm : null}
          confidence={candidate.tempoCorrected ? 1 : candidate.bpmConfidence}
          onApply={onTempoCorrection}
        />
      </div>
    );
  };

  return (
    <div className="wy-stem-source-control">
      <span className="wy-swap-label">Live swap</span>
      <div className="wy-swap-actions">
        <button
          ref={triggerRef}
          type="button"
          className={`wy-swap-trigger${selectedDonorId ? " active" : ""}`}
          aria-label={`Swap ${stemType}`}
          aria-expanded={isOpen}
          aria-controls={pickerId}
          data-testid={`open-live-swap-${stemType}`}
          onClick={onToggle}
        >
          <span className="wy-swap-trigger-icon" aria-hidden="true">⇄</span>
          <span className="wy-swap-trigger-copy">
            <strong>{pending ? "Preparing layer…" : selectedDonorId
              ? stemType === "vocals" ? "Donor vocal selected" : "Layer swapped"
              : "Choose a source"}</strong>
            <small>{selectedDonorTitle ?? `Replace only the ${stemType} layer`}</small>
          </span>
          <span className="wy-swap-trigger-chevron" aria-hidden="true">{isOpen ? "−" : "+"}</span>
        </button>
        {selectedDonorId && (
          <button
            type="button"
            className="wy-swap-original"
            aria-label={`Restore original ${stemType}`}
            data-testid={`restore-live-swap-${stemType}`}
            disabled={pending || busy}
            onClick={onRestore}
          >
            Original
          </button>
        )}
      </div>
      {isOpen && (
        <section
          ref={pickerRef}
          id={pickerId}
          className="wy-swap-picker"
          role="region"
          tabIndex={-1}
          aria-labelledby={`${pickerId}-title`}
          data-testid={`live-swap-picker-${stemType}`}
        >
          <header className="wy-swap-picker-head">
            <div>
              <strong id={`${pickerId}-title`}>Swap {stemType}</strong>
              <small
                className={stemType === "vocals" ? "wy-vocal-health-note" : undefined}
                role={stemType === "vocals" ? "note" : undefined}
                data-testid={stemType === "vocals" ? "live-vocal-health-warning" : undefined}
              >
                {stemType === "vocals"
                  ? vocalHealthMessage ?? "Clean vocal removal is unverified; source voice may remain in other stems."
                  : "Playback keeps running while the new layer loads."}
              </small>
            </div>
            <button type="button" className="wy-swap-close" aria-label="Close source picker" onClick={closeAndReturnFocus}>×</button>
          </header>
          <TempoCorrectionControl
            trackId={currentTrackId}
            trackTitle={`Current track · ${currentTrackTitle}`}
            automaticBpm={currentAutomaticBpm}
            correctedBpm={currentTempoCorrected ? currentBpm : null}
            confidence={currentTempoCorrected ? 1 : currentBpmConfidence}
            onApply={onTempoCorrection}
          />
          {sourceCount > 4 && (
            <label className="wy-swap-search">
              <span className="visually-hidden">Search separated sources</span>
              <input
                ref={searchRef}
                type="search"
                value={query}
                placeholder={`Search ${stemType} sources…`}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
          )}
          {sessionCandidates.length > 0 && (
            <div className="wy-swap-group">
              <span className="wy-swap-group-label">In this session</span>
              <div className="wy-swap-candidates">
                {sessionCandidates.map((candidate, index) => renderCandidate(candidate, index))}
              </div>
            </div>
          )}
          {libraryCandidates.length > 0 && (
            <div className="wy-swap-group">
              <span className="wy-swap-group-label">Separated library tracks</span>
              <div className="wy-swap-candidates">
                {libraryCandidates.map((candidate, index) =>
                  renderCandidate(candidate, index + sessionCandidates.length),
                )}
              </div>
            </div>
          )}
          {stemType === "vocals" && entryDonorId !== null && stagedDonor && (
            <section
              className="wy-vocal-entry-alternatives"
              aria-label={`Entry alternatives from ${stagedDonor.title}`}
              data-testid="vocal-entry-alternatives"
            >
              <header>
                <div>
                  <strong>Compare vocal entry windows</strong>
                  <small>{stagedDonor.title} · selection is staged; the current swap stays unchanged until applied</small>
                </div>
                <button type="button" onClick={refreshEntryCandidates} disabled={busy || pending}>
                  Refresh
                </button>
              </header>
              <p className="wy-vocal-entry-evidence">
                These are measured rolling audio windows, not lyric phrases or verified verse/chorus labels. Similarity scores and signal-confidence measurements are shown separately.
              </p>
              {entryCandidates.length > 0 ? (
                <div className="wy-vocal-entry-candidate-list" role="radiogroup" aria-label="Measured donor entry alternatives">
                  {entryCandidates.map((candidate, index) => (
                    <button
                      key={`${candidate.donorSectionIndex}-${candidate.donorWindowStartMs}-${index}`}
                      className={`wy-vocal-entry-candidate${selectedEntryIndex === index ? " selected" : ""}`}
                      type="button"
                      role="radio"
                      aria-checked={selectedEntryIndex === index}
                      data-testid={`vocal-entry-candidate-${index}`}
                      onClick={() => {
                        setSelectedEntryIndex(index);
                        setManualEntryMs(candidate.donorEntryMs);
                        stopEntryPreview();
                        setPreviewMessage("");
                      }}
                    >
                      <strong>Alternative {index + 1} · donor entry {formatEntryTime(candidate.donorEntryMs)}</strong>
                      <small>
                        {candidate.basis === "rhythm-harmony-phrase"
                          ? `Matched ${formatEntryTime(candidate.donorWindowStartMs)}–${formatEntryTime(candidate.donorWindowEndMs)} rolling audio window`
                          : "Trusted section-role match; waveform similarity is unavailable"}
                      </small>
                      <span>
                        Rhythm similarity {formatEvidencePercent(candidate.rhythmSimilarity)}
                        {" · "}measurement {formatEvidencePercent(candidate.rhythmMeasurementConfidence)}
                      </span>
                      <span>
                        Harmony similarity {formatEvidencePercent(candidate.harmonySimilarity)}
                        {" · "}measurement {formatEvidencePercent(candidate.harmonyMeasurementConfidence)}
                      </span>
                      <span>
                        Duration fit {formatEvidencePercent(candidate.durationSimilarity)}
                        {" · "}boundary evidence {formatEvidencePercent(candidate.recipientBoundaryConfidence)}
                        {" / "}{formatEvidencePercent(candidate.donorBoundaryConfidence)}
                      </span>
                      <span>
                        Beat-grid evidence {formatEvidencePercent(candidate.recipientBeatConfidence)}
                        {" / "}{formatEvidencePercent(candidate.donorBeatConfidence)}
                        {candidate.transpositionSemitones !== null && candidate.transpositionSemitones !== 0
                          ? ` · chroma shift ${candidate.transpositionSemitones > 0 ? "+" : ""}${candidate.transpositionSemitones} semitones`
                          : ""}
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="wy-vocal-entry-no-candidates" role="status">
                  No source-verified rhythm/harmony window passed the current evidence gates at this playhead. That does not prove no usable passage exists; automatic safe alignment and manual entry remain available.
                </p>
              )}
              {selectedAlignmentCandidate && (
                <div className="wy-vocal-entry-preview">
                  <span>
                    {previewAssetState === "loading" ? "Loading donor audio…"
                      : previewAssetState === "unavailable" ? "Donor audio is unavailable for audition."
                        : previewAudioReady ? "Donor audio ready"
                          : "Preparing donor audio…"}
                  </span>
                  {previewing ? (
                    <button type="button" onClick={stopEntryPreview} data-testid="button-stop-entry-preview">
                      Stop audition
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={!previewAudioReady || selectedAlignmentIsStale || busy || pending}
                      onClick={() => { void previewSelectedEntry(); }}
                      data-testid="button-preview-entry-candidate"
                    >
                      Audition this window
                    </button>
                  )}
                </div>
              )}
              {selectedAlignmentIsStale && (
                <small className="wy-vocal-entry-stale" role="status">
                  The playhead left this matched window. Refresh alternatives before applying a match.
                </small>
              )}
              {previewMessage && <small className="wy-vocal-entry-snap-status" role="status">{previewMessage}</small>}
              {stagedDonor.durationSeconds !== null && stagedDonor.durationSeconds > 0 ? (
                <label className="wy-vocal-entry-time">
                  <span>Manual donor start · no feature match</span>
                  <input
                    type="range"
                    min={0}
                    max={Math.max(1, Math.floor(stagedDonor.durationSeconds * 1000) - 1)}
                    step={50}
                    value={Math.min(
                      Math.max(0, manualEntryMs),
                      Math.max(1, Math.floor(stagedDonor.durationSeconds * 1000) - 1),
                    )}
                    onChange={(event) => setManualEntryMs(Number(event.target.value))}
                    aria-label={`Manual donor start time for ${stagedDonor.title}`}
                    data-testid="staged-donor-entry-slider"
                  />
                  <output>{formatEntryTime(manualEntryMs)}</output>
                </label>
              ) : null}
              <div className="wy-vocal-entry-actions">
                <button
                  type="button"
                  disabled={busy || pending || selectedAlignmentCandidate === null || selectedAlignmentIsStale}
                  onClick={() => {
                    if (!selectedAlignmentCandidate || selectedAlignmentIsStale) return;
                    onChoose(entryDonorId, Math.round(selectedAlignmentCandidate.donorEntryMs));
                    closeAndReturnFocus();
                  }}
                  data-testid="button-apply-entry-candidate"
                >
                  Apply selected match
                </button>
                <button
                  type="button"
                  disabled={busy || pending || stagedDonor.durationSeconds === null}
                  onClick={() => {
                    onChoose(entryDonorId, Math.round(manualEntryMs));
                    closeAndReturnFocus();
                  }}
                  data-testid="button-apply-manual-entry"
                >
                  Apply manual start
                </button>
                <button
                  type="button"
                  disabled={busy || pending}
                  onClick={() => {
                    onChoose(entryDonorId, null);
                    closeAndReturnFocus();
                  }}
                  data-testid="button-apply-automatic-entry"
                >
                  Use automatic safe alignment
                </button>
              </div>
            </section>
          )}
          {selectedDonorId && (
            <>
              <div className="wy-swap-original-row">
                <span>Using {selectedDonorTitle ?? "another source"}</span>
                <button type="button" disabled={busy} onClick={() => { onRestore(); closeAndReturnFocus(); }}>
                  Restore original
                </button>
              </div>
              {stemType === "vocals" && (
                <VocalEntryTimeControl
                  donorId={selectedDonorId}
                  donorTitle={selectedDonorTitle ?? "another source"}
                  durationSeconds={selectedDonorDurationSeconds}
                  entryOffsetMs={selectedDonorEntryOffsetMs}
                  sections={selectedDonorSections}
                  vocalActivityStartsMs={selectedDonorVocalActivityStartsMs}
                  voicedPhraseStartsMs={selectedDonorVoicedPhraseStartsMs}
                  disabled={busy || pending}
                  onApply={onApplyDonorEntryOffset}
                />
              )}
            </>
          )}
          {visiblePreparationCandidates.length > 0 && (
            <div className="wy-swap-group">
              <span className="wy-swap-group-label">Separate before swapping</span>
              <div className="wy-swap-prepare-list">
                {visiblePreparationCandidates.map((candidate, index) => {
                  const isProcessing = candidate.status === "processing";
                  const needsRetry = candidate.status === "failed" || candidate.status === "rejected";
                  const starting = preparingTrackIds.has(candidate.id);
                  return (
                    <div className="wy-swap-prepare-row" key={candidate.id}>
                      <span className="wy-swap-prepare-copy">
                        <strong>{candidate.title}</strong>
                        <small>
                          {candidate.artist || "Unknown artist"}
                          {isProcessing
                            ? ` · Separating${candidate.progressLabel === undefined ? "…" : ` · ${candidate.progressLabel}`}`
                            : needsRetry ? " · Previous separation failed" : " · Stems not ready"}
                        </small>
                      </span>
                      {isProcessing ? (
                        <span
                          className="wy-swap-prepare-progress"
                          role="status"
                          data-testid={`live-swap-preparing-${stemType}-${candidate.id}`}
                        >
                          {candidate.progressLabel ?? "Separating…"}
                        </span>
                      ) : (
                        <button
                          ref={index === 0 ? firstPreparationRef : undefined}
                          type="button"
                          className="wy-swap-prepare-action"
                          aria-label={`${needsRetry ? "Retry separation for" : "Separate"} ${candidate.title} for ${stemType}`}
                          data-testid={`prepare-live-swap-${stemType}-${candidate.id}`}
                          disabled={busy || starting}
                          onClick={() => onPrepare(candidate.id)}
                        >
                          {starting ? "Starting…" : needsRetry ? "Retry" : "Separate"}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
              {filteredPreparationCandidates.length > visiblePreparationCandidates.length && (
                <small className="wy-swap-prepare-more">Search to narrow the remaining tracks.</small>
              )}
            </div>
          )}
          {filteredCandidates.length === 0 && filteredPreparationCandidates.length === 0 && (
            <div className="wy-swap-empty">
              <strong>{sourceCount > 0 ? "No matches" : `No ${stemType} sources ready`}</strong>
              <small>
                {sourceCount > 0
                  ? "Try a shorter search."
                  : "Add a track, then separate its stems. Your current mix keeps playing."}
              </small>
              {sourceCount === 0 && <Link href="/waveyard">Open music library</Link>}
            </div>
          )}
          <p className="wy-swap-footnote">BPM and key are compatibility hints, not a similarity or sound-quality score.</p>
        </section>
      )}
      {swapStatus !== null && (
        <small className="wy-swap-status" role="status" data-testid={`live-stem-tempo-${stemType}`}>
          {swapStatus}
        </small>
      )}
    </div>
  );
}
