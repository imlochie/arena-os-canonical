"use client";

import Link from "@/routing/Link";
import { useEffect, useMemo, useRef, useState } from "react";
import { keyCompatibility, tempoCompatibility } from "@workspace/arena/lib/waveyard/library/session-logic";

export interface LiveStemDonorOption {
  id: string;
  title: string;
  artist: string;
  bpm: number | null;
  musicalKey: string | null;
  collection: "session" | "library";
}

interface LiveStemSwapPickerProps {
  stemType: string;
  currentBpm: number | null;
  currentKey: string | null;
  candidates: LiveStemDonorOption[];
  selectedDonorId: string | null;
  selectedDonorTitle: string | null;
  swapStatus: string | null;
  isOpen: boolean;
  pending: boolean;
  busy: boolean;
  onToggle: () => void;
  onClose: () => void;
  onChoose: (donorId: string) => void;
  onRestore: () => void;
}

function matchLabel(label: string, known: boolean, compatible: boolean) {
  if (!known) return `${label} unknown`;
  return compatible ? `${label} match` : `${label} differs`;
}

export default function LiveStemSwapPicker({
  stemType,
  currentBpm,
  currentKey,
  candidates,
  selectedDonorId,
  selectedDonorTitle,
  swapStatus,
  isOpen,
  pending,
  busy,
  onToggle,
  onClose,
  onChoose,
  onRestore,
}: LiveStemSwapPickerProps) {
  const [query, setQuery] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const firstCandidateRef = useRef<HTMLButtonElement>(null);
  const pickerId = `live-swap-picker-${stemType}`;

  const filteredCandidates = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (normalizedQuery === "") return candidates;
    return candidates.filter((candidate) =>
      `${candidate.title} ${candidate.artist}`.toLocaleLowerCase().includes(normalizedQuery),
    );
  }, [candidates, query]);

  useEffect(() => {
    if (!isOpen) {
      setQuery("");
      return;
    }
    if (candidates.length > 4) searchRef.current?.focus();
    else firstCandidateRef.current?.focus();
  }, [candidates.length, isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  const closeAndReturnFocus = () => {
    onClose();
    triggerRef.current?.focus();
  };
  const sessionCandidates = filteredCandidates.filter((candidate) => candidate.collection === "session");
  const libraryCandidates = filteredCandidates.filter((candidate) => candidate.collection === "library");

  const renderCandidate = (candidate: LiveStemDonorOption, index: number) => {
    const tempo = tempoCompatibility(currentBpm, candidate.bpm);
    const key = keyCompatibility(currentKey, candidate.musicalKey);
    const tempoKnown = currentBpm !== null && candidate.bpm !== null;
    const keyKnown = currentKey !== null && candidate.musicalKey !== null;
    const tempoLabel = matchLabel("BPM", tempoKnown, tempo.compatible);
    const keyLabel = matchLabel("Key", keyKnown, key.compatible);
    const selected = candidate.id === selectedDonorId;
    return (
      <button
        key={candidate.id}
        ref={index === 0 ? firstCandidateRef : undefined}
        className={`wy-swap-candidate${selected ? " selected" : ""}`}
        type="button"
        aria-pressed={selected}
        aria-label={`Use ${candidate.title} for ${stemType}; ${tempoLabel}; ${keyLabel}`}
        data-testid={`live-swap-candidate-${stemType}-${candidate.id}`}
        disabled={busy}
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
          <span className={`wy-swap-fit-chip ${tempoKnown ? (tempo.compatible ? "match" : "different") : "unknown"}`}>
            {tempoLabel}
          </span>
          <span className={`wy-swap-fit-chip ${keyKnown ? (key.compatible ? "match" : "different") : "unknown"}`}>
            {keyLabel}
          </span>
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
          disabled={pending || busy}
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
          id={pickerId}
          className="wy-swap-picker"
          role="region"
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
          {candidates.length > 4 && (
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
          {filteredCandidates.length === 0 && (
            <div className="wy-swap-empty">
              <strong>{candidates.length > 0 ? "No matches" : `No ${stemType} sources ready`}</strong>
              <small>
                {candidates.length > 0
                  ? "Try a shorter search."
                  : "Add another track and wait for its separated stems to finish."}
              </small>
              {candidates.length === 0 && <Link href="/waveyard">Open music library</Link>}
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
