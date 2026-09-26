"use client";

import { WaveformCanvas } from "@/components/WaveformCanvas";
import type { MixerValues, useStemTransport } from "@/lib/useStemTransport";
import { clock, sourceStemLabel, type Source, type Stem } from "./types";

type Transport = ReturnType<typeof useStemTransport>;

type SourceGroup = {
  id: string;
  source?: Source;
  stems: Stem[];
};

export function StemMixer({
  stems,
  sources,
  selectedId,
  duration,
  controls,
  transport,
  onSelect,
  onControl,
}: {
  stems: Stem[];
  sources: Source[];
  selectedId: string;
  duration: number;
  controls: Record<string, MixerValues>;
  transport: Transport;
  onSelect: (id: string) => void;
  onControl: (id: string, patch: Partial<MixerValues>) => void;
}) {
  const anySolo = Object.values(controls).some((track) => track.solo);
  const grouped: SourceGroup[] = sources
    .map((source) => ({
      id: source.id,
      source,
      stems: stems.filter((stem) => stem.sourceAssetId === source.id),
    }))
    .filter((group) => group.stems.length > 0);
  const groupedIds = new Set(grouped.flatMap((group) => group.stems.map((stem) => stem.id)));
  const unlinkedStems = stems.filter((stem) => !groupedIds.has(stem.id));
  if (unlinkedStems.length)
    grouped.push({ id: "unknown-source", stems: unlinkedStems });

  return (
    <div className="mixer-panel">
      <div className="panel-title">
        <h3>Stem mixer</h3>
        <span>{anySolo ? "Solo active" : "All unmuted stems audible"}</span>
      </div>
      {grouped.map((group, groupIndex) => (
        <section
          className="source-stem-group"
          data-testid={group.source ? `source-stems-${group.source.id}` : "source-stems-unknown"}
          aria-label={group.source ? `${group.source.originalFilename} stems` : "Unknown-source stems"}
          key={group.id}
        >
          <header className="source-stem-heading">
            <span>Source {groupIndex + 1}</span>
            <b>{group.source?.originalFilename ?? "Unknown source"}</b>
            <small>{group.stems.length} stem{group.stems.length === 1 ? "" : "s"}</small>
          </header>
          {group.stems.map((stem) => {
            const control = controls[stem.id] ?? {
              volume: 1,
              pan: 0,
              muted: false,
              solo: false,
            };
            const label = sourceStemLabel(group.source, stem.stemType);
            return (
              <article
                key={stem.id}
                data-testid={`stem-${stem.stemType}`}
                className={`studio-stem ${selectedId === stem.id ? "selected" : ""}`}
              >
                <button className="stem-select" onClick={() => onSelect(stem.id)}>
                  <b>{label}</b>
                  <small>
                    {clock(stem.durationSeconds)} · {stem.sampleRate} Hz
                  </small>
                </button>
                <WaveformCanvas
                  assetId={stem.id}
                  label={`${label} waveform`}
                  compact
                  position={transport.position}
                  duration={duration}
                  onSeek={transport.seek}
                />
                <label>
                  Vol{" "}
                  <input
                    aria-label={`${label} volume`}
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
                    aria-label={`${label} pan`}
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
                  aria-label={`Mute ${label}`}
                  aria-pressed={control.muted}
                  onClick={() => onControl(stem.id, { muted: !control.muted })}
                >
                  M
                </button>
                <button
                  className={`toggle ${control.solo ? "on" : ""}`}
                  aria-label={`Solo ${label}`}
                  aria-pressed={control.solo}
                  onClick={() => onControl(stem.id, { solo: !control.solo })}
                >
                  S
                </button>
                <audio
                  aria-label={`${label} audio`}
                  ref={(element) => transport.register(stem.id, element)}
                  src={`/api/assets/${stem.id}`}
                  preload="auto"
                />
              </article>
            );
          })}
        </section>
      ))}
    </div>
  );
}
