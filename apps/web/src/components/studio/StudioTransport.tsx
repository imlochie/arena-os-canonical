"use client";

import type { MusicalTiming } from "@/lib/timing";
import { formatMusicalPosition, snapTimelineMs } from "@/lib/timing";
import type { useStemTransport } from "@/lib/useStemTransport";
import { clock } from "./types";

type Transport = ReturnType<typeof useStemTransport>;

export function StudioTransport({
  transport,
  timing,
  loopStartMs,
  loopEndMs,
  onMasterVolume,
  onLoopChange,
  arrangementPlaying,
  arrangementError,
  onToggleArrangement,
  onToggleStemPreview,
}: {
  transport: Transport;
  timing: MusicalTiming;
  loopStartMs: number;
  loopEndMs: number | null;
  onMasterVolume: (volume: number) => void;
  onLoopChange: (startMs: number, endMs: number | null) => void;
  arrangementPlaying: boolean;
  arrangementError: string | null;
  onToggleArrangement: () => void;
  onToggleStemPreview: () => void;
}) {
  const positionMs = Math.round(transport.position * 1000);
  const snapSeek = (seconds: number) =>
    transport.seek(snapTimelineMs(seconds * 1000, timing) / 1000);
  return (
    <section className="transport-panel" aria-label="Transport controls">
      <div className="transport-actions">
        <button
          className="button"
          data-testid="play-all"
          aria-label={transport.playing ? "Pause" : "Play"}
          onClick={onToggleStemPreview}
        >
          {transport.playing ? "Pause stems" : "Play stems"}
        </button>
        <button className={`button ${arrangementPlaying ? "active" : "secondary"}`} onClick={onToggleArrangement}>
          {arrangementPlaying ? "Pause arrangement" : "Preview arrangement"}
        </button>
        <button className="button secondary" aria-label="Stop" onClick={transport.stop}>
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
      {transport.error && <p className="error">{transport.error}</p>}
      {arrangementError && <p className="error">{arrangementError}</p>}
    </section>
  );
}
