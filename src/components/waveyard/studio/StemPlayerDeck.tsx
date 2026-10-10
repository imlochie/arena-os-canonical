"use client";

/**
 * StemPlayerDeck — the stem.fm experience (vision: "visually nearly the
 * same UI as stem.fm", "it needs to feel easy to use").
 *
 * The instant loop: song separated → colored stem lanes, one big play
 * button, per-stem volume + mute + isolate. This is the hero surface; the
 * deep studio (mixer console, inserts, timeline) lives below it for people
 * who want to go further.
 *
 * Every control is REAL: volume/mute/solo write the same MixerValues the
 * mixer console uses (one graph, two views), play/seek drive the shared
 * transport, and the waveforms are the assets' real computed peaks.
 */

import { useState } from "react";

import { WaveformCanvas } from "../WaveformCanvas";
import type { MixerValues, useStemTransport } from "@/lib/waveyard/useStemTransport";
import { clock, type Source, type Stem } from "./types";

/** Second-pass separation targets offered per stem (stem-layers route). */
const LAYER_TARGETS = [
  { id: "kim_vocal_2", label: "Backing vocals", blurb: "pull vocal content out of this stem — backing vocals, ad-libs, buried harmonies" },
  { id: "kuielab_b_drums", label: "Drums residue", blurb: "pull percussion leakage out" },
  { id: "kuielab_b_bass", label: "Bass residue", blurb: "pull low-end leakage out" },
  { id: "stems_4", label: "4-way layers", blurb: "split this stem four ways" },
];

type Transport = ReturnType<typeof useStemTransport>;

/** stem.fm's four, with the studio's existing palette. */
const STEM_COLORS: Record<string, string> = {
  vocals: "#ff98bd",
  drums: "#8be5ff",
  bass: "#b7a0ff",
  other: "#f8ca7b",
  melody: "#f8ca7b",
  instrumental: "#9ee79b",
};

function stemColor(stemType: string): string {
  return STEM_COLORS[stemType.split("/")[0]] ?? "#7ae5e7";
}

function stemDisplayName(stemType: string): string {
  return stemType
    .split("/")
    .map((part) => (part === "other" ? "Melody" : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(" · ");
}

export function StemPlayerDeck({
  projectId,
  stems,
  sources,
  duration,
  controls,
  transport,
  onControl,
}: {
  projectId: string;
  stems: Stem[];
  sources: Source[];
  duration: number;
  controls: Record<string, MixerValues>;
  transport: Transport;
  onControl: (id: string, patch: Partial<MixerValues>) => void;
}) {
  const [layersFor, setLayersFor] = useState<string | null>(null);
  const [layerError, setLayerError] = useState<string | null>(null);
  const [layerNotice, setLayerNotice] = useState<string | null>(null);

  const separateLayers = async (stem: Stem, target: string) => {
    setLayerError(null);
    setLayerNotice("Separating layers…");
    const response = await fetch(`/api/waveyard/projects/${projectId}/stem-layers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stemAssetId: stem.id, target }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      setLayerNotice(null);
      setLayerError(body.error ?? "The layer separation could not start.");
      return;
    }
    setLayersFor(null);
    setLayerNotice(`Separating ${body.layering?.target ?? "layers"} out of ${stemDisplayName(stem.stemType)} — new lanes appear when done.`);
  };

  if (stems.length === 0) return null;
  const source = sources.find((item) => item.id === stems[0]?.sourceAssetId);
  const anySolo = stems.some((stem) => controls[stem.id]?.solo);

  const toggleMute = (stem: Stem) => onControl(stem.id, { muted: !controls[stem.id]?.muted });
  const toggleIsolate = (stem: Stem) => {
    const solo = !controls[stem.id]?.solo;
    // Isolate = solo this stem (the transport's mix logic mutes the rest).
    onControl(stem.id, { solo });
  };

  return (
    <section className={`stem-deck ${transport.playing ? "playing" : ""}`} data-testid="stem-deck" aria-label="Stem player">
      <div className="stem-deck-head">
        <div>
          <span className="eyebrow">Stem player</span>
          <h2>{source?.originalFilename ?? "Your song"}</h2>
        </div>
        <small>{stems.length} stems · {clock(duration)}</small>
      </div>

      <div className="stem-deck-lanes">
        {stems.map((stem) => {
          const values = controls[stem.id] ?? { volume: 1, pan: 0, muted: false, solo: false };
          const dimmed = values.muted || (anySolo && !values.solo);
          return (
            <div
              key={stem.id}
              className={`stem-deck-lane ${dimmed ? "dimmed" : ""}`}
              style={{ "--lane": stemColor(stem.stemType) } as React.CSSProperties}
              data-stem={stem.stemType}
            >
              <div className="stem-deck-lane-head">
                <span className="stem-deck-dot" aria-hidden="true" />
                <b>{stemDisplayName(stem.stemType)}</b>
                <div className="stem-deck-lane-controls">
                  <button
                    className={`deck-chip ${values.muted ? "off" : ""}`}
                    aria-pressed={values.muted}
                    aria-label={`${values.muted ? "Unmute" : "Mute"} ${stemDisplayName(stem.stemType)}`}
                    onClick={() => toggleMute(stem)}
                  >M</button>
                  <button
                    className={`deck-chip ${values.solo ? "on" : ""}`}
                    aria-pressed={values.solo}
                    aria-label={`${values.solo ? "Release" : "Isolate"} ${stemDisplayName(stem.stemType)}`}
                    onClick={() => toggleIsolate(stem)}
                  >ISO</button>
                  {!stem.stemType.includes("/") && (
                    <button
                      className="deck-chip"
                      aria-label={`Separate ${stemDisplayName(stem.stemType)} into layers`}
                      title="Separate this stem into layers (recursive separation)"
                      onClick={() => { setLayersFor(layersFor === stem.id ? null : stem.id); setLayerError(null); }}
                    >⋁</button>
                  )}
                  <input
                    className="stem-deck-fader"
                    type="range"
                    min={0}
                    max={1.4}
                    step={0.01}
                    value={values.volume}
                    aria-label={`${stemDisplayName(stem.stemType)} volume`}
                    onChange={(event) => onControl(stem.id, { volume: Number(event.target.value) })}
                    style={{ accentColor: stemColor(stem.stemType) }}
                  />
                </div>
              </div>
              {layersFor === stem.id && (
                <div className="stem-layer-picker" data-testid={`stem-layers-${stem.id}`}>
                  <b>Separate “{stemDisplayName(stem.stemType)}” into layers</b>
                  {LAYER_TARGETS.map((target) => (
                    <button key={target.id} className="deck-chip" onClick={() => void separateLayers(stem, target.id)} title={target.blurb}>
                      {target.label}
                    </button>
                  ))}
                  <small>New lanes appear below when the pass finishes. Grabbing a specific instrument (a flute line, a lead) is the chop scanner’s job — it works on any tonal stem.</small>
                </div>
              )}
              <WaveformCanvas
                assetId={stem.id}
                label={`${stemDisplayName(stem.stemType)} stem`}
                position={transport.position}
                duration={duration}
                onSeek={(seconds) => transport.seek(seconds)}
              />
            </div>
          );
        })}
      </div>
      {layerError && <p className="form-error" role="alert">{layerError}</p>}
      {layerNotice && <p className="stem-layer-notice" role="status">{layerNotice}</p>}

      <div className="stem-deck-transport">
        <button
          className="stem-deck-play"
          aria-label={transport.playing ? "Pause" : "Play"}
          onClick={() => (transport.playing ? transport.pause() : void transport.play())}
        >{transport.playing ? "❚❚" : "▶"}</button>
        <span className="stem-deck-time">{clock(transport.position)} / {clock(duration)}</span>
        <input
          type="range"
          className="stem-deck-seek"
          min={0}
          max={Math.max(0.1, duration)}
          step={0.05}
          value={Math.min(transport.position, duration)}
          aria-label="Seek"
          onChange={(event) => transport.seek(Number(event.target.value))}
        />
        <span className="stem-deck-hint">M mutes · ISO isolates · click a waveform to jump</span>
      </div>
    </section>
  );
}
