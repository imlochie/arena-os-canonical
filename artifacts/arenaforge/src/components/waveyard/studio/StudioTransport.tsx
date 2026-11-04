"use client";

import * as React from "react";
import type { MusicalTiming } from "@workspace/arena/lib/waveyard/timing";
import { formatMusicalPosition, snapTimelineMs } from "@workspace/arena/lib/waveyard/timing";
import type { useStemTransport } from "@workspace/arena/lib/waveyard/useStemTransport";
import { clock } from "./types";

type Transport = ReturnType<typeof useStemTransport>;

export function StudioTransport({
  transport,
  timing,
  loopStartMs,
  loopEndMs,
  hasArrangement,
  onMasterVolume,
  onLoopChange,
  arrangementPlaying,
  arrangementPending,
  arrangementError,
  onToggleArrangement,
  onToggleStemPreview,
  onStop,
  onSeek,
}: {
  transport: Transport;
  timing: MusicalTiming;
  loopStartMs: number;
  loopEndMs: number | null;
  hasArrangement: boolean;
  onMasterVolume: (volume: number) => void;
  onLoopChange: (startMs: number, endMs: number | null) => void;
  arrangementPlaying: boolean;
  arrangementPending: boolean;
  arrangementError: string | null;
  onToggleArrangement: () => void;
  onToggleStemPreview: () => void;
  onStop: () => void;
  onSeek: (seconds: number) => void;
}) {
  const recoveryId = React.useId();
  const stemErrorId = `${recoveryId}-stem-error`;
  const arrangementErrorId = `${recoveryId}-arrangement-error`;
  const positionMs = Math.round(transport.position * 1000);
  const snapSeek = (seconds: number) =>
    onSeek(snapTimelineMs(seconds * 1000, timing) / 1000);
  return (
    <section className="transport-panel" aria-label="Transport controls">
      <div className="transport-actions">
        <button
          className="button"
          data-testid="play-all"
          aria-label={transport.playing ? "Pause stems" : "Play stems"}
          aria-describedby={transport.error ? stemErrorId : undefined}
          onClick={onToggleStemPreview}
        >
          {transport.playing ? "Pause stems" : "Play stems"}
        </button>
        <button
          className={`button ${arrangementPlaying ? "active" : "secondary"}`}
          data-testid="arrangement-preview"
          aria-label={
            arrangementPending
              ? "Cancel arrangement preview"
              : arrangementPlaying
                ? "Pause arrangement"
                : hasArrangement
                  ? "Preview arrangement"
                  : "Create arrangement to preview"
          }
          aria-describedby={arrangementError ? arrangementErrorId : undefined}
          aria-busy={arrangementPending}
          disabled={!hasArrangement && !arrangementPending}
          onClick={onToggleArrangement}
        >
          {arrangementPending
            ? "Loading arrangement… · Cancel"
            : arrangementPlaying
              ? "Pause arrangement"
              : hasArrangement
                ? "Preview arrangement"
                : "Create arrangement to preview"}
        </button>
        <button className="button secondary" aria-label="Stop" onClick={onStop}>
          Stop stems
        </button>
        <button
          className={`button secondary ${loopEndMs !== null ? "active" : ""}`}
          aria-label="Toggle loop"
          onClick={() =>
            onLoopChange(
              loopStartMs,
              loopEndMs === null
                ? Math.max(loopStartMs + 1, Math.round(transport.duration * 1000))
                : null,
            )
          }
        >
          Loop
        </button>
        <button
          className="button secondary"
          onClick={() => {
            const start = snapTimelineMs(positionMs, timing);
            onLoopChange(start, loopEndMs && loopEndMs > start ? loopEndMs : Math.round(transport.duration * 1000));
          }}
        >
          Set loop in
        </button>
        <button
          className="button secondary"
          onClick={() => onLoopChange(loopStartMs, Math.max(loopStartMs + 1, snapTimelineMs(positionMs, timing)))}
        >
          Set loop out
        </button>
      </div>
      <input
        aria-label="Seek project"
        type="range"
        min="0"
        max={transport.duration || 1}
        value={transport.position}
        step="0.01"
        onChange={(event) => snapSeek(Number(event.target.value))}
      />
      <output>
        {clock(transport.position)} / {clock(transport.duration)} · {formatMusicalPosition(positionMs, timing)}
      </output>
      <label>
        Master{" "}
        <input
          aria-label="Master volume"
          type="range"
          min="0"
          max="2"
          step="0.01"
          value={transport.masterVolume}
          onChange={(event) => onMasterVolume(Number(event.target.value))}
        />
      </label>
      {transport.error && (
        <p className="error" id={stemErrorId} role="alert" aria-atomic="true">
          {transport.error}
        </p>
      )}
      {arrangementError && (
        <p className="error" id={arrangementErrorId} role="alert" aria-atomic="true">
          {arrangementError}
        </p>
      )}
    </section>
  );
}
