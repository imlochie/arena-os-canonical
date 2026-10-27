"use client";

import { useEffect, useMemo, useState } from "react";
import {
  CAMELOT_CELLS,
  camelotCodeForKey,
  camelotCompatibleCodes,
} from "@workspace/arena/lib/waveyard/library/camelot-wheel";

type CamelotTrack = { id: string; title: string; artist: string; key: string | null };

export default function CamelotWheel({
  currentTrackId,
  currentKey,
  nextTrackId,
  nextKey,
  tracks,
  disabled = false,
  onSetNext,
}: {
  currentTrackId: string;
  currentKey: string | null;
  nextTrackId: string | null;
  nextKey: string | null;
  tracks: CamelotTrack[];
  disabled?: boolean;
  onSetNext: (sessionTrackId: string) => Promise<void>;
}) {
  const [chosenCode, setChosenCode] = useState<CamelotCellCode | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const currentCode = camelotCodeForKey(currentKey);
  const nextCode = camelotCodeForKey(nextKey);
  const focusCode = chosenCode ?? currentCode;
  const compatibleCodes = useMemo(() => new Set(camelotCompatibleCodes(focusCode)), [focusCode]);
  const currentCompatible = useMemo(() => new Set(camelotCompatibleCodes(currentCode)), [currentCode]);
  const matches = tracks.filter((track) => {
    const code = camelotCodeForKey(track.key);
    return track.id !== currentTrackId && code !== null && compatibleCodes.has(code);
  });

  useEffect(() => setChosenCode(null), [currentTrackId]);

  const nextIsCompatible = nextCode !== null && currentCompatible.has(nextCode);
  const keyStatus = currentCode === null || nextCode === null
    ? "Analyze both keys to compare them."
    : nextIsCompatible
      ? "Next track fits the Camelot wheel."
      : "Next track is outside the Camelot neighbors.";

  return (
    <section className="wy-camelot-panel" aria-label="Camelot harmonic matching" data-testid="session-camelot-wheel">
      <div className="wy-camelot-heading">
        <div>
          <span className="eyebrow">Harmonic mixing</span>
          <h3>Camelot wheel</h3>
        </div>
        <span className={nextIsCompatible ? "wy-camelot-status compatible" : "wy-camelot-status"}>
          {keyStatus}
        </span>
      </div>
      <p className="wy-camelot-pair">
        <span>Now <b>{currentCode ?? "—"}</b>{currentKey ? ` · ${currentKey}` : " · key unknown"}</span>
        <span aria-hidden="true">→</span>
        <span>Next <b>{nextCode ?? "—"}</b>{nextKey ? ` · ${nextKey}` : " · key unknown"}</span>
      </p>
      <div className="wy-camelot-wheel" role="group" aria-label="Choose a key to find compatible session tracks">
        <div className="wy-camelot-core" aria-hidden="true"><b>KEY</b><span>A / B</span></div>
        {CAMELOT_CELLS.map((cell) => {
          const angle = ((cell.number - 1) * 30 - 90) * Math.PI / 180;
          const radius = cell.mode === "B" ? 104 : 66;
          const left = 50 + Math.sin(angle) * radius / 2.45;
          const top = 50 - Math.cos(angle) * radius / 2.45;
          const isCurrent = cell.code === currentCode;
          const isNext = cell.code === nextCode;
          const isCompatible = currentCompatible.has(cell.code);
          const isChosen = cell.code === focusCode;
          return (
            <button
              key={cell.code}
              type="button"
              className={[
                "wy-camelot-cell",
                cell.mode === "A" ? "minor" : "major",
                isCompatible ? "compatible" : "",
                isCurrent ? "current" : "",
                isNext ? "next" : "",
                isChosen ? "chosen" : "",
              ].filter(Boolean).join(" ")}
              style={{ left: `${left}%`, top: `${top}%` }}
              title={`${cell.code} · ${cell.key}${isCompatible ? " · compatible with current key" : ""}`}
              aria-label={`Choose ${cell.code}, ${cell.key}`}
              aria-pressed={isChosen}
              data-testid={`camelot-key-${cell.code}`}
              onClick={() => setChosenCode(cell.code)}
            >
              <b>{cell.code}</b>
              <small>{cell.key.split(" ")[0]}</small>
            </button>
          );
        })}
      </div>
      <p className="wy-camelot-hint">Tap a highlighted key to find tracks that fit this mix.</p>
      {matches.length > 0 ? (
        <ul className="wy-camelot-matches" aria-label="Compatible tracks in this session">
          {matches.map((track) => {
            const code = camelotCodeForKey(track.key);
            const alreadyNext = track.id === nextTrackId;
            return (
              <li key={track.id}>
                <span><b>{track.title}</b><small>{code} · {track.key}</small></span>
                <button
                  type="button"
                  className="wy-camelot-next"
                  disabled={disabled || pendingId !== null || alreadyNext}
                  aria-label={alreadyNext ? `${track.title} is already next` : `Set ${track.title} as next`}
                  onClick={async () => {
                    setPendingId(track.id);
                    try {
                      await onSetNext(track.id);
                    } finally {
                      setPendingId(null);
                    }
                  }}
                >
                  {pendingId === track.id ? "Moving…" : alreadyNext ? "Up next" : "Set next"}
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="wy-camelot-empty">
          {focusCode
            ? `No compatible analyzed tracks in this session for ${focusCode}.`
            : "Track keys will appear here after analysis completes."}
        </p>
      )}
    </section>
  );
}

type CamelotCellCode = (typeof CAMELOT_CELLS)[number]["code"];
