"use client";

import { WaveformCanvas } from "@/components/WaveformCanvas";
import type { MixerValues, useStemTransport } from "@/lib/useStemTransport";
import { clock, type Stem } from "./types";

type Transport = ReturnType<typeof useStemTransport>;

export function StemMixer({
  stems,
  selectedId,
  duration,
  controls,
  transport,
  onSelect,
  onControl,
}: {
  stems: Stem[];
  selectedId: string;
  duration: number;
  controls: Record<string, MixerValues>;
  transport: Transport;
  onSelect: (id: string) => void;
  onControl: (id: string, patch: Partial<MixerValues>) => void;
}) {
  const anySolo = Object.values(controls).some((track) => track.solo);
  return (
    <div className="mixer-panel">
      <div className="panel-title">
        <h3>Stem mixer</h3>
        <span>{anySolo ? "Solo active" : "All unmuted stems audible"}</span>
      </div>
      {stems.map((stem) => {
        const control = controls[stem.id] ?? {
          volume: 1,
          pan: 0,
          muted: false,
          solo: false,
        };
        return (
          <article
            key={stem.id}
            data-testid={`stem-${stem.stemType}`}
            className={`studio-stem ${selectedId === stem.id ? "selected" : ""}`}
          >
            <button className="stem-select" onClick={() => onSelect(stem.id)}>
              <b>{stem.stemType}</b>
              <small>
                {clock(stem.durationSeconds)} · {stem.sampleRate} Hz
              </small>
            </button>
            <WaveformCanvas
              assetId={stem.id}
              label={`${stem.stemType} waveform`}
              compact
              position={transport.position}
              duration={duration}
              onSeek={transport.seek}
            />
            <label>
              Vol{" "}
              <input
                aria-label={`${stem.stemType} volume`}
                type="range"
                min="0"
                max="2"
                step="0.01"
                value={control.volume}
                onChange={(event) => onControl(stem.id, { volume: Number(event.target.value) })}
              />
            </label>
            <label>
              Pan{" "}
              <input
                aria-label={`${stem.stemType} pan`}
                type="range"
                min="-1"
                max="1"
                step="0.01"
                value={control.pan}
                onChange={(event) => onControl(stem.id, { pan: Number(event.target.value) })}
              />
            </label>
            <button
              className={`toggle ${control.muted ? "on" : ""}`}
              aria-pressed={control.muted}
              onClick={() => onControl(stem.id, { muted: !control.muted })}
            >
              M
            </button>
            <button
              className={`toggle ${control.solo ? "on" : ""}`}
              aria-pressed={control.solo}
              onClick={() => onControl(stem.id, { solo: !control.solo })}
            >
              S
            </button>
            <audio
              ref={(element) => transport.register(stem.id, element)}
              src={`/api/assets/${stem.id}`}
              preload="auto"
            />
          </article>
        );
      })}
    </div>
  );
}
