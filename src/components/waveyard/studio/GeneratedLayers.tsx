"use client";

/**
 * Generated arrangement layers — durable, playable, deletable.
 * Every layer listed here is persisted project metadata (arrangement_layers
 * table) + a real rendered WAV in project storage. Reload-safe by design.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export type ArrangementLayerSummary = {
  id: string;
  instrument: string;
  mood: string;
  density: string;
  register: string;
  level: number;
  seed: number;
  originalPrompt: string;
  events: Array<{ startMs: number; durationMs: number; midi: number; velocity: number }>;
  notes: { realization: string[]; interpretation: string[] };
  durationSeconds: number;
  sampleRate: number;
  audioUrl: string;
  createdAt: string;
};

export function GeneratedLayers({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const [layers, setLayers] = useState<ArrangementLayerSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [playErrorId, setPlayingErrorId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const load = useCallback(async () => {
    const response = await fetch(`/api/waveyard/projects/${projectId}/arrangement-layers`, { cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      setError(body.error ?? "Could not load generated layers.");
      return;
    }
    setLayers(body.layers ?? []);
    setError(null);
  }, [projectId]);

  useEffect(() => {
    void load();
    return () => {
      audioRef.current?.pause();
    };
  }, [load]);

  const generate = async () => {
    if (!prompt.trim() || generating) return;
    setGenerating(true);
    setGenerateError(null);
    const response = await fetch(`/api/waveyard/projects/${projectId}/arrangement-layers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    const body = await response.json().catch(() => ({}));
    setGenerating(false);
    if (!response.ok) {
      setGenerateError(body.error ?? "Generation failed.");
      return;
    }
    setPrompt("");
    await load();
  };

  const remove = async (layerId: string) => {
    const response = await fetch(
      `/api/waveyard/projects/${projectId}/arrangement-layers?layerId=${layerId}`,
      { method: "DELETE" },
    );
    if (response.ok && playingId === layerId) {
      audioRef.current?.pause();
      setPlayingId(null);
    }
    await load();
  };

  const play = (layer: ArrangementLayerSummary) => {
    if (playingId === layer.id) {
      audioRef.current?.pause();
      setPlayingId(null);
      return;
    }
    if (audioRef.current === null) audioRef.current = new Audio();
    audioRef.current.src = layer.audioUrl;
    void audioRef.current.play().then(() => setPlayingId(layer.id)).catch(() => setPlayingErrorId(layer.id));
  };

  return (
    <section className="remix-panel" data-testid="generated-layers">
      <div className="panel-title">
        <div>
          <span className="eyebrow">Prompt-driven composition</span>
          <h3>Generated layers</h3>
        </div>
        <small>{layers === null ? "Loading…" : `${layers.length} persisted layer${layers.length === 1 ? "" : "s"}`}</small>
      </div>

      {canEdit && (
        <div className="layer-composer">
          <label>
            Describe a layer
            <input
              aria-label="Arrangement prompt"
              value={prompt}
              placeholder='e.g. "add some sinister sounding strings on this beat"'
              maxLength={400}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void generate();
              }}
            />
          </label>
          <button className="button" disabled={!prompt.trim() || generating} onClick={() => void generate()}>
            {generating ? "Composing…" : "Compose layer"}
          </button>
        </div>
      )}
      {generateError && <p className="form-error" role="alert">{generateError}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}

      {layers !== null && layers.length === 0 && (
        <p className="empty-state">
          No generated layers yet. Analysis (tempo, key, beat grid, sections) of the source must be complete —
          then a prompt like “add some sinister sounding strings” composes a real, on-key, on-grid layer.
        </p>
      )}

      <ul className="layer-list">
        {(layers ?? []).map((layer) => (
          <li key={layer.id} className={`layer-item ${playingId === layer.id ? "playing" : ""}`}>
            <div className="layer-head">
              <button className="stem-select" onClick={() => setExpanded(expanded === layer.id ? null : layer.id)}>
                <b>{layer.instrument} · {layer.mood}</b>
                <small>
                  {layer.density}/{layer.register} · {layer.events.length} notes · {layer.durationSeconds.toFixed(1)}s · {layer.sampleRate / 1000} kHz
                  {layer.originalPrompt ? ` · “${layer.originalPrompt}”` : ""}
                </small>
              </button>
              <div className="console-toggles">
                <button
                  className={`toggle ${playingId === layer.id ? "on" : ""}`}
                  aria-label={playingId === layer.id ? `Stop ${layer.instrument} layer` : `Play ${layer.instrument} layer`}
                  onClick={() => play(layer)}
                >▶</button>
                {canEdit && (
                  <button
                    className="toggle"
                    aria-label={`Delete ${layer.instrument} layer`}
                    onClick={() => void remove(layer.id)}
                  >✕</button>
                )}
              </div>
            </div>
            {playErrorId === layer.id && <small className="form-error">Playback was blocked by the browser.</small>}
            {expanded === layer.id && (
              <div className="layer-notes">
                <b>How it was placed</b>
                <ul>
                  {layer.notes.realization.map((note, index) => <li key={`r${index}`}>{note}</li>)}
                </ul>
                <b>How the prompt was read</b>
                <ul>
                  {layer.notes.interpretation.map((note, index) => <li key={`i${index}`}>{note}</li>)}
                </ul>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
