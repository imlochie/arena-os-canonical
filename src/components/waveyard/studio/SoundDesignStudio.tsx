"use client";

/**
 * Sound design studio — procedural, real-DSP sound generation.
 *
 * Every render is synthesized by the actual engine (oscillators, biquads,
 * saturators — no AI, no samples, no fakes), previewed as real audio, and
 * persisted with its full recipe as provenance. Mute is persisted. Delete
 * removes asset + file.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import {
  SOUND_DESIGN_KINDS,
  SOUND_DESIGN_PARAM_RANGES,
  type SoundDesignKind,
} from "@/lib/waveyard/design/sounddesign";

type Asset = {
  id: string;
  kind: string;
  muted: boolean;
  durationSeconds: number;
  audioUrl: string;
  description: string;
  createdAt: string;
};

export function SoundDesignStudio({ projectId }: { projectId: string }) {
  const [kind, setKind] = useState<SoundDesignKind>("impact");
  const [lengthSeconds, setLengthSeconds] = useState<number>(SOUND_DESIGN_PARAM_RANGES.lengthSeconds.default);
  const [baseMidi, setBaseMidi] = useState<number>(SOUND_DESIGN_PARAM_RANGES.baseMidi.default);
  const [level, setLevel] = useState<number>(SOUND_DESIGN_PARAM_RANGES.level.default);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [phase, setPhase] = useState<"idle" | "rendering">("idle");
  const [error, setError] = useState<string | null>(null);
  const lastPlayed = useRef<HTMLAudioElement | null>(null);

  const load = useCallback(async () => {
    const response = await fetch(`/api/waveyard/projects/${projectId}/sound-design`, { cache: "no-store" }).catch(() => null);
    if (response !== null && response.ok) {
      const data = (await response.json()) as { assets: Asset[] };
      setAssets(data.assets ?? []);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
    return () => {
      if (lastPlayed.current !== null) lastPlayed.current.pause();
    };
  }, [load]);

  const render = async () => {
    setError(null);
    setPhase("rendering");
    const response = await fetch(`/api/waveyard/projects/${projectId}/sound-design`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind, params: { lengthSeconds, baseMidi, level } }),
    }).catch(() => null);
    setPhase("idle");
    if (response === null) {
      setError("Network request failed.");
      return;
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      setError(String(data.error ?? "Render failed."));
      return;
    }
    setAssets((current) => [...current, data.asset]);
  };

  const toggleMute = async (asset: Asset) => {
    const response = await fetch(`/api/waveyard/projects/${projectId}/sound-design`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assetId: asset.id, muted: !asset.muted }),
    }).catch(() => null);
    if (response !== null && response.ok) {
      const data = await response.json();
      setAssets((current) => current.map((candidate) => (candidate.id === asset.id ? data.asset : candidate)));
    }
  };

  const remove = async (asset: Asset) => {
    const response = await fetch(
      `/api/waveyard/projects/${projectId}/sound-design?assetId=${asset.id}`,
      { method: "DELETE" },
    ).catch(() => null);
    if (response !== null && response.ok) {
      setAssets((current) => current.filter((candidate) => candidate.id !== asset.id));
    } else {
      setError("Delete failed.");
    }
  };

  const play = (asset: Asset) => {
    if (asset.muted) return;
    if (lastPlayed.current !== null) lastPlayed.current.pause();
    const element = new Audio(asset.audioUrl);
    element.volume = 1;
    lastPlayed.current = element;
    void element.play().catch(() => setError("Playback was blocked by the browser."));
  };

  return (
    <section className="sounddesign-studio" aria-label="Sound design">
      <header>
        <h3>Design</h3>
        <p className="muted">Procedural sound design — real synthesis, real processors, full provenance. No AI, no sample packs.</p>
      </header>
      <div className="sd-controls">
        <label>
          Kind
          <select value={kind} onChange={(event) => setKind(event.target.value as SoundDesignKind)}>
            {SOUND_DESIGN_KINDS.map((candidate) => (
              <option key={candidate} value={candidate}>{candidate}</option>
            ))}
          </select>
        </label>
        <label>
          length {lengthSeconds.toFixed(1)} s
          <input
            aria-label="Render length seconds" type="range"
            min={SOUND_DESIGN_PARAM_RANGES.lengthSeconds.min}
            max={SOUND_DESIGN_PARAM_RANGES.lengthSeconds.max}
            step={0.5}
            value={lengthSeconds}
            onChange={(event) => setLengthSeconds(Number(event.target.value))}
          />
        </label>
        <label>
          base note {baseMidi}
          <input
            aria-label="Base MIDI note" type="range"
            min={SOUND_DESIGN_PARAM_RANGES.baseMidi.min}
            max={SOUND_DESIGN_PARAM_RANGES.baseMidi.max}
            step={1}
            value={baseMidi}
            onChange={(event) => setBaseMidi(Number(event.target.value))}
          />
        </label>
        <label>
          level {level.toFixed(2)}
          <input
            aria-label="Output level" type="range"
            min={SOUND_DESIGN_PARAM_RANGES.level.min}
            max={SOUND_DESIGN_PARAM_RANGES.level.max}
            step={0.05}
            value={level}
            onChange={(event) => setLevel(Number(event.target.value))}
          />
        </label>
        <button onClick={render} disabled={phase === "rendering"}>
          {phase === "rendering" ? "Rendering…" : "Render"}
        </button>
      </div>
      {error !== null && <p className="error-message" role="alert">{error}</p>}
      {assets.length > 0 && (
        <ul className="sd-assets" data-testid="sound-design-assets">
          {assets.map((asset) => (
            <li key={asset.id} className={asset.muted ? "muted-asset" : ""}>
              <div className="sd-asset-info">
                <b>{asset.kind}</b>
                <small className="muted">{asset.description}</small>
              </div>
              <audio controls preload="none" src={asset.audioUrl} />
              <div className="console-toggles">
                <button
                  className={`toggle ${asset.muted ? "" : "on"}`}
                  aria-pressed={asset.muted}
                  aria-label={`${asset.muted ? "Unmute" : "Mute"} ${asset.kind}`}
                  onClick={() => toggleMute(asset)}
                >M</button>
                <button
                  className="toggle"
                  aria-label={`Delete ${asset.kind}`}
                  onClick={() => remove(asset)}
                >✕</button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
