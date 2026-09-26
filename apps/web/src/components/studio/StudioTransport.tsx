"use client";

import type { useStemTransport } from "@/lib/useStemTransport";
import { clock } from "./types";

type Transport = ReturnType<typeof useStemTransport>;

export function StudioTransport({
  transport,
  onMasterVolume,
}: {
  transport: Transport;
  onMasterVolume: (volume: number) => void;
}) {
  return (
    <section className="transport-panel" aria-label="Transport controls">
      <div className="transport-actions">
        <button
          className="button"
          data-testid="play-all"
          aria-label={transport.playing ? "Pause" : "Play"}
          onClick={() => {
            if (transport.playing) transport.pause();
            else void transport.play();
          }}
        >
          {transport.playing ? "Pause" : "Play"}
        </button>
        <button className="button secondary" aria-label="Stop" onClick={transport.stop}>
          Stop
        </button>
        <button
          className={`button secondary ${transport.loop.enabled ? "active" : ""}`}
          aria-label="Toggle loop"
          onClick={() =>
            transport.setLoop((current) => ({
              ...current,
              enabled: !current.enabled,
              end: current.end || transport.duration,
            }))
          }
        >
          Loop
        </button>
        <button
          className="button secondary"
          onClick={() =>
            transport.setLoop((current) => ({
              ...current,
              start: transport.position,
              end: current.end || transport.duration,
            }))
          }
        >
          Set loop in
        </button>
        <button
          className="button secondary"
          onClick={() =>
            transport.setLoop((current) => ({
              ...current,
              end: Math.max(current.start + 0.05, transport.position),
            }))
          }
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
        onChange={(event) => transport.seek(Number(event.target.value))}
      />
      <output>
        {clock(transport.position)} / {clock(transport.duration)}
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
    </section>
  );
}
