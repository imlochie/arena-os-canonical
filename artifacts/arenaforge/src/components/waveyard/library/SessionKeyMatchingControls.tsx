"use client";

import type { SessionKeyMatch, SessionKeyMode } from "@workspace/arena/lib/waveyard/library/session-key-matching";

const MODES: Array<{ value: SessionKeyMode; label: string; hint: string }> = [
  { value: "camelot", label: "Camelot", hint: "Nearest compatible key" },
  { value: "match", label: "Match Key", hint: "Match the lead tonic" },
  { value: "preserve", label: "Preserve", hint: "Keep the original key" },
  { value: "off", label: "Off", hint: "No key correction" },
];

export default function SessionKeyMatchingControls({
  mode,
  leadKey,
  complementKey,
  match,
  hasComplement,
  supported,
  busy,
  error,
  onChange,
}: {
  mode: SessionKeyMode;
  leadKey: string | null;
  complementKey: string | null;
  match: SessionKeyMatch;
  hasComplement: boolean;
  supported: boolean;
  busy: boolean;
  error: string | null;
  onChange: (mode: SessionKeyMode) => void;
}) {
  const harmonicMode = mode === "camelot" || mode === "match";
  const unavailable = harmonicMode && (!supported || !leadKey || !complementKey);
  const status = error
    ?? (!hasComplement
      ? "Choose a next track to set its key."
      : !supported && harmonicMode
        ? "Live key matching needs AudioWorklet support in a secure browser context."
        : match.semitones === null
          ? match.reason
          : `${match.reason} ${match.semitones === 0 ? "Native pitch." : `${match.semitones > 0 ? "+" : ""}${match.semitones} semitones.`}`);

  return (
    <section className="wy-key-match" aria-label="Pitch shift" data-testid="session-key-matching">
      <div className="wy-key-match-heading">
        <div>
          <span className="eyebrow">Pitch shift</span>
          <h3>Key matching</h3>
        </div>
        <span className="wy-key-match-live">{busy ? "Applying…" : "LIVE"}</span>
      </div>
      <p className="wy-key-match-description">Tune the incoming track against the current lead. The same shift follows its live stem swaps.</p>
      <div className="wy-key-match-options" role="group" aria-label="Key matching mode">
        {MODES.map((option) => {
          const requiresKeys = option.value === "camelot" || option.value === "match";
          return (
            <button
              key={option.value}
              type="button"
              className={mode === option.value ? "is-selected" : ""}
              aria-pressed={mode === option.value}
              disabled={busy || !hasComplement || (requiresKeys && (!supported || !leadKey || !complementKey))}
              data-testid={`session-key-mode-${option.value}`}
              onClick={() => onChange(option.value)}
            >
              <b>{option.label}</b>
              <small>{option.hint}</small>
            </button>
          );
        })}
      </div>
      <dl className="wy-key-match-keys">
        <div><dt>Lead</dt><dd>{leadKey ?? "Unknown"}</dd></div>
        <div><dt>Comp</dt><dd>{complementKey ?? "Unknown"}</dd></div>
        <div><dt>In key</dt><dd>{match.targetKey ?? (harmonicMode ? "Unavailable" : complementKey ?? "—")}</dd></div>
      </dl>
      <p className={error || unavailable ? "wy-key-match-status is-warning" : "wy-key-match-status"} role="status" data-testid="session-key-match-status">
        {status}
      </p>
      <small className="wy-key-match-note">Pitch shifts do not seek or restart the deck; speed pitch-lock stays separate.</small>
    </section>
  );
}
