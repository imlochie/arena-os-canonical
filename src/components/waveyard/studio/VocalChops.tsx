"use client";

/**
 * VocalChops — the chipmunk-soul sampler panel (vision §V4).
 *
 * "Scan a song to find the best vocal chops for a beat": the scan reads the
 * project's SEPARATED VOCAL STEM (not the mix), detects the best one-shot
 * vocal notes, and persists them as playable, downloadable WAVs. Then the
 * chop builder: arm a chop, draw notes in the piano roll (each note plays
 * its chop resampled to the drawn pitch — up an octave = chipmunk), and
 * render the whole pattern to a real WAV.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { PianoRoll } from "./PianoRoll";
import { midiToNoteName, type PianoNote } from "@/lib/waveyard/studio/piano-roll";
import { assignChopToNewNotes } from "@/lib/waveyard/studio/vocal-chops";
import { cleanupPattern } from "@/lib/waveyard/studio/soul-chef";
import { useUndoRedo } from "@/lib/waveyard/studio/history";

type VocalChop = {
  id: string;
  startMs: number;
  durationMs: number;
  rootMidi: number;
  cents: number;
  confidence: number;
  sampleRate: number;
  audioUrl: string;
};

export function VocalChops({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const [chops, setChops] = useState<VocalChop[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [playErrorId, setPlayErrorId] = useState<string | null>(null);
  const [chipmunk, setChipmunk] = useState(false);
  const [scanStemType, setScanStemType] = useState("vocals");
  const [armedChopId, setArmedChopId] = useState<string | null>(null);
  const [bpm, setBpm] = useState(120);
  /** The chef/cleanup context: key from the analysed vocal source. */
  const [musicalKey, setMusicalKey] = useState<string | null>(null);
  const [cooking, setCooking] = useState(false);
  const [chefRationale, setChefRationale] = useState<string[]>([]);
  const [cleanupReport, setCleanupReport] = useState<string[] | null>(null);
  const pattern = useUndoRedo<PianoNote[]>([]);
  const [rendering, setRendering] = useState(false);
  const [renderError, setRenderError] = useState<string | null>(null);
  const patternNotes = pattern.value;
  const [renderUrl, setRenderUrl] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const renderUrlRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    const response = await fetch(`/api/waveyard/projects/${projectId}/vocal-chops`, { cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      setError(body.error ?? "Could not load vocal chops.");
      return;
    }
    setChops(body.chops ?? []);
    setError(null);
  }, [projectId]);

  useEffect(() => {
    void load();
    // The piano-roll grid wants the project's analysed tempo.
    void (async () => {
      const response = await fetch(`/api/waveyard/projects/${projectId}/arrangement-layers`, { cache: "no-store" });
      if (!response.ok) return;
      const body = await response.json().catch(() => ({}));
      if (typeof body.bpm === "number" && body.bpm > 0) setBpm(body.bpm);
    })();
    // The analysed key of the vocal source (for the chef + cleanup).
    void (async () => {
      const response = await fetch(`/api/waveyard/projects/${projectId}`, { cache: "no-store" });
      if (!response.ok) return;
      const body = await response.json().catch(() => ({}));
      const withKey = (body.sources ?? []).find(
        (source: { analysis?: { musicalKey?: string | null } }) => typeof source.analysis?.musicalKey === "string",
      );
      if (withKey !== undefined) setMusicalKey(withKey.analysis.musicalKey);
    })();
    return () => {
      audioRef.current?.pause();
      if (renderUrlRef.current !== null) URL.revokeObjectURL(renderUrlRef.current);
    };
  }, [load, projectId]);

  const scan = async () => {
    if (scanning) return;
    setScanning(true);
    setError(null);
    const response = await fetch(`/api/waveyard/projects/${projectId}/vocal-chops`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stemType: scanStemType }),
    });
    const body = await response.json().catch(() => ({}));
    setScanning(false);
    if (!response.ok) {
      setError(body.error ?? "The vocal chop scan failed.");
      return;
    }
    pattern.reset([]);
    await load();
  };

  const remove = async (chopId: string) => {
    await fetch(`/api/waveyard/projects/${projectId}/vocal-chops/${chopId}`, { method: "DELETE" });
    if (armedChopId === chopId) setArmedChopId(null);
    pattern.set(patternNotes.filter((note) => !note.id.startsWith(`${chopId}:`)));
    await load();
  };

  const play = (chop: VocalChop) => {
    if (playingId === chop.id) {
      audioRef.current?.pause();
      setPlayingId(null);
      return;
    }
    if (audioRef.current === null) audioRef.current = new Audio();
    audioRef.current.src = chop.audioUrl;
    audioRef.current.playbackRate = chipmunk ? 2 : 1;
    void audioRef.current
      .play()
      .then(() => setPlayingId(chop.id))
      .catch(() => setPlayErrorId(chop.id));
  };

  const renderPattern = async () => {
    if (rendering || patternNotes.length === 0) return;
    setRendering(true);
    setRenderError(null);
    const response = await fetch(`/api/waveyard/projects/${projectId}/vocal-chops/render`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events: patternNotes }),
    });
    setRendering(false);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setRenderError(body.error ?? "The chop pattern could not be rendered.");
      return;
    }
    const blob = await response.blob();
    if (renderUrlRef.current !== null) URL.revokeObjectURL(renderUrlRef.current);
    const url = URL.createObjectURL(blob);
    renderUrlRef.current = url;
    setRenderUrl(url);
  };

  const cookPattern = async () => {
    if (cooking) return;
    setCooking(true);
    setRenderError(null);
    setCleanupReport(null);
    const response = await fetch(`/api/waveyard/projects/${projectId}/vocal-chops/auto-sequence`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seed: Math.floor(Math.random() * 1_000_000), bars: 4, style: "chopped" }),
    });
    const body = await response.json().catch(() => ({}));
    setCooking(false);
    if (!response.ok) {
      setRenderError(body.error ?? "The chef could not sequence a pattern.");
      return;
    }
    pattern.reset(body.notes ?? []);
    setChefRationale(body.rationale ?? []);
    if (body.context?.musicalKey) setMusicalKey(body.context.musicalKey);
    if (body.context?.bpm) setBpm(body.context.bpm);
  };

  const tidyEdits = () => {
    const result = cleanupPattern(patternNotes, { bpm, musicalKey }, 60_000 / bpm / 2);
    if (result.changes.length === 0) {
      setCleanupReport(["Nothing to tidy — your edit is already on the grid and in key."]);
      return;
    }
    setCleanupReport(result.changes);
    pattern.set(result.notes);
  };

  const armed = chops?.find((chop) => chop.id === armedChopId) ?? null;
  const patternEndMs = patternNotes.reduce((latest, note) => Math.max(latest, note.startMs + note.durationMs), 0);

  return (
    <section className="remix-panel" data-testid="vocal-chops">
      <div className="panel-title">
        <div>
          <span className="eyebrow">Chipmunk-soul sampler</span>
          <h3>Vocal chops</h3>
        </div>
        <small>{chops === null ? "Loading…" : `${chops.length} chop${chops.length === 1 ? "" : "s"} from your vocal stem`}</small>
      </div>

      {canEdit && (
        <div className="remix-actions">
          <label className="chop-scan-stem">
            Scan stem
            <select aria-label="Stem to scan for chops" value={scanStemType} onChange={(event) => setScanStemType(event.target.value)}>
              <option value="vocals">Vocals</option>
              <option value="other">Melody (grab a flute, a lead…)</option>
              <option value="bass">Bass</option>
              <option value="drums">Drums</option>
              <option value="instrumental">Instrumental</option>
            </select>
          </label>
          <button className="button" disabled={scanning} onClick={() => void scan()}>
            {scanning ? `Scanning ${scanStemType === "other" ? "melody" : scanStemType} stem…` : chops !== null && chops.length > 0 ? "Rescan stem for chops" : "Scan stem for chops"}
          </button>
          <label className="chop-chipmunk-toggle">
            <input type="checkbox" checked={chipmunk} onChange={(event) => setChipmunk(event.target.checked)} />
            Preview +12 (chipmunk)
          </label>
        </div>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
      {chops !== null && chops.length === 0 && (
        <p className="empty-state">
          No chops yet. Separate a source first — then the scan reads the stem you pick (vocals, melody,
          bass…) and finds the best one-shot notes to chop, pitch, and build a beat from. On the melody
          stem that means grabbing a flute line or a lead — something stem.fm simply cannot do.
        </p>
      )}

      <ul className="chop-list">
        {(chops ?? []).map((chop, index) => (
          <li key={chop.id} className={`chop-item ${armedChopId === chop.id ? "armed" : ""}`}>
            <button
              className="stem-select"
              onClick={() => setArmedChopId(armedChopId === chop.id ? null : chop.id)}
              aria-pressed={armedChopId === chop.id}
            >
              <b>#{index + 1} · {midiToNoteName(chop.rootMidi)}{Math.abs(chop.cents) >= 15 ? (chop.cents > 0 ? " +" : " −") + Math.abs(chop.cents) : ""}</b>
              <small>
                {(chop.durationMs / 1000).toFixed(2)}s · at {(chop.startMs / 1000).toFixed(1)}s in the vocal
              </small>
              <span className="chop-confidence" title={`Detection confidence ${(chop.confidence * 100).toFixed(0)}%`}>
                <i style={{ width: `${Math.round(chop.confidence * 100)}%` }} />
              </span>
            </button>
            <div className="console-toggles">
              <button
                className={`toggle ${playingId === chop.id ? "on" : ""}`}
                aria-label={`Play vocal chop ${index + 1}`}
                onClick={() => play(chop)}
              >▶</button>
              <a className="toggle" aria-label={`Download vocal chop ${index + 1} as WAV`} href={`${chop.audioUrl}?download=1`}>⇩</a>
              {canEdit && (
                <button
                  className={`toggle ${armedChopId === chop.id ? "on" : ""}`}
                  aria-label={`Arm vocal chop ${index + 1} for the pattern`}
                  onClick={() => setArmedChopId(armedChopId === chop.id ? null : chop.id)}
                  title={armedChopId === chop.id ? "Armed for drawing" : "Arm for the chop pattern"}
                >🎹</button>
              )}
              {canEdit && (
                <button className="toggle" aria-label={`Delete vocal chop ${index + 1}`} onClick={() => void remove(chop.id)}>✕</button>
              )}
            </div>
            {playErrorId === chop.id && <small className="form-error">Playback was blocked by the browser.</small>}
          </li>
        ))}
      </ul>

      {canEdit && (
        <div className="chop-builder" data-testid="chop-builder">
          <div className="layer-editor-bar">
            <b>Chop pattern</b>
            <small>
              {armed === null
                ? "Arm a chop above (🎹), then draw notes — each note plays that chop at the drawn pitch"
                : `Armed: ${midiToNoteName(armed.rootMidi)} chop — draw at any pitch (up = chipmunk)`}
            </small>
            <button className="button secondary" disabled={cooking} onClick={() => void cookPattern()}>
              {cooking ? "Cooking…" : "Cook a pattern 🧑‍🍳"}
            </button>
            <button className="button secondary" disabled={!pattern.canUndo} onClick={pattern.undo} title="Undo (Ctrl+Z)">↶</button>
            <button className="button secondary" disabled={!pattern.canRedo} onClick={pattern.redo} title="Redo (Ctrl+Shift+Z)">↷</button>
            <button className="button secondary" disabled={patternNotes.length === 0} onClick={tidyEdits} title="Snap my edits back to the grid and key — I will show you every change first">Tidy my edits</button>
            <button
              className="button"
              disabled={rendering || patternNotes.length === 0 || armedChopId === null}
              onClick={() => void renderPattern()}
            >
              {rendering ? "Rendering…" : "Render chop pattern"}
            </button>
          </div>
          {chefRationale.length > 0 && (
            <details className="chef-rationale">
              <summary>How the chef sequenced it</summary>
              <ul>{chefRationale.map((line, index) => <li key={index}>{line}</li>)}</ul>
            </details>
          )}
          {cleanupReport !== null && (
            <div className="cleanup-report" role="status">
              <b>Tidied:</b>
              <ul>{cleanupReport.map((line, index) => <li key={index}>{line}</li>)}</ul>
              <small>Undo (↶ or Ctrl+Z) restores your exact version if your ears preferred it.</small>
            </div>
          )}
          {renderError && <p className="form-error" role="alert">{renderError}</p>}
          {renderUrl !== null && (
            <div className="chop-render-result">
              <audio controls src={renderUrl} />
              <a className="button secondary" href={renderUrl} download="waveyard-chop-pattern.wav">Download WAV</a>
            </div>
          )}
          {armedChopId !== null ? (
            <PianoRoll
              notes={patternNotes}
              onChange={(next) => pattern.set(assignChopToNewNotes(next, armedChopId))}
              bpm={bpm}
              durationMs={Math.max(8000, patternEndMs + 2000)}
              onUndo={pattern.undo}
              onRedo={pattern.redo}
            />
          ) : (
            <p className="empty-state">Arm a chop to start drawing its pattern.</p>
          )}
        </div>
      )}
    </section>
  );
}
