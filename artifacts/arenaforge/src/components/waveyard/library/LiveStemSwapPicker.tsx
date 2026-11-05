"use client";

import Link from "@/routing/Link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isHalfDoubleTempoPair, keyCompatibility, liveStemTempoStretchRatio } from "@workspace/arena/lib/waveyard/library/session-logic";

export interface LiveStemDonorOption {
  id: string;
  title: string;
  artist: string;
  bpm: number | null;
  musicalKey: string | null;
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
  currentBpm: number | null;
  currentKey: string | null;
  candidates: LiveStemDonorOption[];
  preparationCandidates: LiveStemPreparationOption[];
  preparingTrackIds: ReadonlySet<string>;
  selectedDonorId: string | null;
  selectedDonorTitle: string | null;
  warmingDonorId: string | null;
  swapStatus: string | null;
  isOpen: boolean;
  pending: boolean;
  busy: boolean;
  onToggle: () => void;
  onClose: () => void;
  onChoose: (donorId: string) => void;
  onWarm: (donorId: string) => void;
  onPrefetch: (donorId: string) => void;
  onPrepare: (trackId: string) => void;
  onRestore: () => void;
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

export default function LiveStemSwapPicker({
  stemType,
  currentBpm,
  currentKey,
  candidates,
  preparationCandidates,
  preparingTrackIds,
  selectedDonorId,
  selectedDonorTitle,
  warmingDonorId,
  swapStatus,
  isOpen,
  pending,
  busy,
  onToggle,
  onClose,
  onChoose,
  onWarm,
  onPrefetch,
  onPrepare,
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
  const pickerId = `live-swap-picker-${stemType}`;
  const prefetchCandidateId = candidates.slice(1).find((candidate) => candidate.id !== selectedDonorId)?.id ?? null;
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
    const stretchRatio = liveStemTempoStretchRatio(currentBpm, candidate.bpm);
    const key = keyCompatibility(currentKey, candidate.musicalKey);
    const tempoKnown = currentBpm !== null && candidate.bpm !== null
      && Number.isFinite(currentBpm) && Number.isFinite(candidate.bpm)
      && currentBpm > 0 && candidate.bpm > 0;
    const halfDoubleTempo = tempoKnown && isHalfDoubleTempoPair(currentBpm, candidate.bpm);
    const tempoMatchUnavailable = tempoKnown && stretchRatio === null && !halfDoubleTempo;
    const keyKnown = currentKey !== null && candidate.musicalKey !== null;
    const tempoLabel = !tempoKnown ? "BPM unknown"
      : halfDoubleTempo ? "Half/double-time · no stretch"
      : stretchRatio === null ? "Outside tempo-match range"
      : Math.abs(stretchRatio - 1) < 0.001 ? "Same tempo"
      : `Match ${candidate.bpm} → ${currentBpm} BPM`;
    const keyLabel = matchLabel("Key", keyKnown, key.compatible);
    const selected = candidate.id === selectedDonorId;
    const isWarming = candidate.id === warmingDonorId;
    const warmStatus = tempoKnown && stretchRatio !== null && Math.abs(stretchRatio - 1) > 0.001
      ? "Preparing tempo match…"
      : "Preparing stem audio…";
    return (
      <button
        key={candidate.id}
        ref={index === 0 ? firstCandidateRef : undefined}
        className={`wy-swap-candidate${selected ? " selected" : ""}`}
        type="button"
        disabled={tempoMatchUnavailable}
        title={tempoMatchUnavailable ? "Live swap is disabled because matching would require an extreme tempo change." : undefined}
        aria-pressed={selected}
        aria-busy={isWarming}
        aria-label={`${tempoMatchUnavailable ? "Unavailable; " : `Use ${candidate.title} for ${stemType}; `}${tempoMatchUnavailable ? "tempo change too large for a safe live match" : tempoLabel}; ${keyLabel}${isWarming ? `; ${warmStatus}` : ""}`}
        data-testid={`live-swap-candidate-${stemType}-${candidate.id}`}
        onFocus={() => { clearHoverWarm(); onWarm(candidate.id); }}
        onPointerEnter={() => scheduleHoverWarm(candidate.id)}
        onPointerLeave={clearHoverWarm}
        onPointerDown={() => { clearHoverWarm(); onWarm(candidate.id); }}
        onClick={() => {
          onChoose(candidate.id);
          closeAndReturnFocus();
        }}
      >
        <span className="wy-swap-candidate-copy">
          <strong>{candidate.title}</strong>
          <small>
            {candidate.artist || "Unknown artist"}
            {candidate.bpm !== null ? ` · ${Math.round(candidate.bpm)} BPM` : " · BPM unavailable"}
            {candidate.musicalKey ? ` · ${candidate.musicalKey}` : " · key unavailable"}
          </small>
        </span>
        <span className="wy-swap-fit">
          <span className={`wy-swap-fit-chip ${tempoKnown ? (stretchRatio !== null ? "match" : "different") : "unknown"}`}>
            {tempoLabel}
          </span>
          <span className={`wy-swap-fit-chip ${keyKnown ? (key.compatible ? "match" : "different") : "unknown"}`}>
            {keyLabel}
          </span>
          {isWarming && <span className="wy-swap-fit-chip unknown" role="status">{warmStatus}</span>}
        </span>
      </button>
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
            <strong>{pending ? "Preparing layer…" : selectedDonorId ? "Layer swapped" : "Choose a source"}</strong>
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
              <small>Playback keeps running while the new layer loads.</small>
            </div>
            <button type="button" className="wy-swap-close" aria-label="Close source picker" onClick={closeAndReturnFocus}>×</button>
          </header>
          {selectedDonorId && (
            <div className="wy-swap-original-row">
              <span>Using {selectedDonorTitle ?? "another source"}</span>
              <button type="button" disabled={busy} onClick={() => { onRestore(); closeAndReturnFocus(); }}>
                Restore original
              </button>
            </div>
          )}
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
