"use client";

/**
 * Generated arrangement layers — durable, playable, deletable.
 * Every layer listed here is persisted project metadata (arrangement_layers
 * table) + a real rendered WAV in project storage. Reload-safe by design.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { PianoRoll } from "./PianoRoll";
import { fromSynthEvents, type PianoNote } from "@/lib/waveyard/studio/piano-roll";
import { useUndoRedo } from "@/lib/waveyard/studio/history";

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
  const [bpm, setBpm] = useState(120);
  const [editingId, setEditingId] = useState<string | null>(null);
  const editHistory = useUndoRedo<PianoNote[]>([]);
  /** The editor's notes ARE the history's present — undo/redo needs no sync. */
  const editNotes: PianoNote[] | null = editingId === null ? null : editHistory.value;
  const [editDirty, setEditDirty] = useState(false);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const load = useCallback(async () => {
    const response = await fetch(`/api/waveyard/projects/${projectId}/arrangement-layers`, { cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      setError(body.error ?? "Could not load generated layers.");
      return;
    }
    setLayers(body.layers ?? []);
    if (typeof body.bpm === "number" && body.bpm > 0) setBpm(body.bpm);
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

  const openEditor = (layer: ArrangementLayerSummary) => {
    setEditingId(layer.id);
    editHistory.reset(fromSynthEvents(layer.events));
    setEditDirty(false);
    setEditError(null);
  };

  const closeEditor = () => {
    setEditingId(null);
    editHistory.reset([]);
    setEditDirty(false);
    setEditError(null);
  };

  const saveEditor = async () => {
    if (editingId === null || editNotes === null || editSaving) return;
    setEditSaving(true);
    setEditError(null);
    const response = await fetch(
      `/api/waveyard/projects/${projectId}/arrangement-layers/${editingId}`,
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ events: editNotes }) },
    );
    const body = await response.json().catch(() => ({}));
    setEditSaving(false);
    if (!response.ok) {
      setEditError(body.error ?? "The edit could not be saved.");
      return;
    }
    setEditDirty(false);
    await load();
  };

  const importMidi = async (layerId: string, file: File) => {
    setEditError(null);
    const response = await fetch(
      `/api/waveyard/projects/${projectId}/arrangement-layers/${layerId}/midi`,
      { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: await file.arrayBuffer() },
    );
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      setEditError(body.error ?? "The MIDI file could not be imported.");
      return;
    }
    editHistory.set(body.notes ?? []);
    setEditDirty(true);
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
                    aria-label={`Edit ${layer.instrument} layer notes in the piano roll`}
                    onClick={() => (editingId === layer.id ? closeEditor() : openEditor(layer))}
                  >🎹</button>
                )}
                <a
                  className="toggle"
                  aria-label={`Export ${layer.instrument} layer as a Standard MIDI File`}
                  href={`/api/waveyard/projects/${projectId}/arrangement-layers/${layer.id}/midi`}
                >⇩MIDI</a>
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
            {editingId === layer.id && editNotes !== null && (
              <div className="layer-editor" data-testid={`piano-roll-editor-${layer.id}`}>
                <div className="layer-editor-bar">
                  <b>Piano roll — {layer.instrument}</b>
                  <small>{editDirty ? "Unsaved changes" : "In sync with the saved layer"}</small>
                  <label className="layer-midi-import">
                    Import MIDI
                    <input
                      aria-label="Import a Standard MIDI File into this layer"
                      type="file"
                      accept=".mid,.midi,audio/midi"
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file !== undefined) void importMidi(layer.id, file);
                        event.target.value = "";
                      }}
                    />
                  </label>
                  {canEdit && (
                    <>
                      <button className="button secondary" disabled={!editHistory.canUndo} onClick={editHistory.undo} title="Undo (Ctrl+Z)">↶</button>
                      <button className="button secondary" disabled={!editHistory.canRedo} onClick={editHistory.redo} title="Redo (Ctrl+Shift+Z)">↷</button>
                      <button className="button" disabled={editSaving || !editDirty} onClick={() => void saveEditor()}>
                        {editSaving ? "Rendering…" : editDirty ? "Save + re-render layer" : "Saved"}
                      </button>
                    </>
                  )}
                  <button className="toggle" aria-label="Close piano roll" onClick={closeEditor}>✕</button>
                </div>
                {editError && <p className="form-error" role="alert">{editError}</p>}
                <PianoRoll
                  notes={editNotes}
                  onChange={(next) => {
                    editHistory.set(next);
                    setEditDirty(true);
                  }}
                  bpm={bpm}
                  durationMs={layer.durationSeconds * 1000}
                  disabled={!canEdit}
                  onUndo={() => {
                    editHistory.undo();
                    setEditDirty(true);
                  }}
                  onRedo={() => {
                    editHistory.redo();
                    setEditDirty(true);
                  }}
                />
              </div>
            )}
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
