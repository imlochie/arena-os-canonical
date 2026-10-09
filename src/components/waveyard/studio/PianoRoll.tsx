"use client";

/**
 * PianoRoll — the native MIDI note editor (vision §V4). A grid of pitch
 * rows against the project's real tempo: draw notes by dragging on empty
 * grid, move/resize with the pointer, multi-select with shift-click,
 * edit velocities in the lane below, and drive everything from the
 * keyboard. All editing logic lives in the pure, fully-tested
 * lib/waveyard/studio/piano-roll.ts — this component is its skin.
 *
 * V1 interactions (deliberate, documented):
 *  - left-drag on empty grid draws a note (FL-style); selection is
 *    click/shift-click + Ctrl+A (rubber-band marquee is a later pass)
 *  - Delete/Backspace removes, Ctrl+D duplicates, arrows nudge
 *    (up/down = semitones, shift = octave, left/right = one snap step)
 *  - placing or selecting a note previews it through a tiny WebAudio
 *    voice (no server round-trip; fails silently if audio is blocked)
 */

import { KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  addNote,
  deleteNotes,
  duplicateNotes,
  fitPitchRange,
  gridHeight,
  hitTest,
  isBlackKey,
  midiToNoteName,
  midiToY,
  moveNotes,
  type PianoNote,
  type PianoRollGeometry,
  resizeNote,
  SNAP_SETTINGS,
  snapMs,
  snapStepMs,
  transposeNotes,
  xToMs,
  yToMidi,
  MIN_NOTE_MS,
  type SnapSetting,
} from "@/lib/waveyard/studio/piano-roll";

const KEYBOARD_WIDTH_PX = 56;
const VELOCITY_LANE_PX = 72;
const A4_HZ = 440;

function previewHz(midi: number): number {
  return A4_HZ * Math.pow(2, (midi - 69) / 12);
}

type DragState =
  | { kind: "draw"; noteId: string; originMs: number }
  | { kind: "move"; originMs: number; originMidi: number; startNotes: PianoNote[] }
  | { kind: "resize"; noteId: string }
  | null;

export type PianoRollProps = {
  notes: PianoNote[];
  onChange: (next: PianoNote[]) => void;
  bpm: number;
  beatsPerBar?: number;
  /** Total timeline extent the grid should show (ms). */
  durationMs: number;
  disabled?: boolean;
};

/** A short, quiet preview voice for note placement/selection. */
function useNotePreview() {
  const contextRef = useRef<AudioContext | null>(null);
  return useCallback((midi: number) => {
    try {
      if (contextRef.current === null) {
        const Ctor = (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext
          ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (Ctor === undefined) return;
        contextRef.current = new Ctor();
      }
      const context = contextRef.current;
      const now = context.currentTime;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "triangle";
      oscillator.frequency.value = previewHz(midi);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.12, now + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(now);
      oscillator.stop(now + 0.2);
    } catch {
      /* preview is a courtesy, never a requirement */
    }
  }, []);
}

export function PianoRoll({ notes, onChange, bpm, beatsPerBar = 4, durationMs, disabled = false }: PianoRollProps) {
  const [snapSetting, setSnapSetting] = useState<SnapSetting>("beat");
  const [pixelsPerSecond, setPixelsPerSecond] = useState(120);
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const gridRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState>(null);
  const preview = useNotePreview();

  const stepMs = useMemo(() => snapStepMs(snapSetting, bpm, beatsPerBar), [snapSetting, bpm, beatsPerBar]);
  const pitchRange = useMemo(() => fitPitchRange(notes, 4), [notes]);
  const geometry: PianoRollGeometry = useMemo(
    () => ({ pixelsPerSecond, rowHeight: 14, midiLow: pitchRange.midiLow, midiHigh: pitchRange.midiHigh }),
    [pixelsPerSecond, pitchRange],
  );
  // Handlers read live geometry through a ref (they close over one drag).
  const geometryRef = useRef(geometry);
  useEffect(() => {
    geometryRef.current = geometry;
  }, [geometry]);

  const timelineMs = useMemo(
    () => Math.max(durationMs, ...notes.map((note) => note.startMs + note.durationMs), 4000) + 500,
    [durationMs, notes],
  );
  const beatMs = 60_000 / (bpm > 0 ? bpm : 120);
  const barMs = beatMs * beatsPerBar;
  const gridWidthPx = (timelineMs / 1000) * pixelsPerSecond;
  const totalHeight = gridHeight(geometry);

  const rows = useMemo(() => {
    const list: Array<{ midi: number; black: boolean; label: string | null }> = [];
    for (let midi = geometry.midiHigh; midi >= geometry.midiLow; midi -= 1) {
      list.push({ midi, black: isBlackKey(midi), label: midi % 12 === 0 ? midiToNoteName(midi) : null });
    }
    return list;
  }, [geometry.midiHigh, geometry.midiLow]);

  const gridPosition = useCallback((event: { clientX: number; clientY: number }) => {
    const grid = gridRef.current;
    if (grid === null) return null;
    const bounds = grid.getBoundingClientRect(); // already reflects scroll offset
    return {
      ms: xToMs(event.clientX - bounds.left, geometryRef.current),
      y: event.clientY - bounds.top,
    };
  }, []);

  const commit = useCallback(
    (next: PianoNote[], nextSelection?: ReadonlySet<string>) => {
      if (disabled) return;
      onChange(next);
      if (nextSelection !== undefined) setSelection(nextSelection);
    },
    [disabled, onChange],
  );

  const onPointerDownGrid = (event: React.PointerEvent<HTMLDivElement>) => {
    if (disabled || event.button !== 0) return;
    const position = gridPosition(event);
    if (position === null) return;
    const hit = hitTest(notes, position, geometryRef.current);
    const additive = event.shiftKey || event.ctrlKey || event.metaKey;

    if (hit === null) {
      // Draw a note from this point; the drag extends it.
      const midi = yToMidi(position.y, geometryRef.current);
      const created = addNote(notes, { startMs: position.ms, durationMs: stepMs ?? 250, midi }, stepMs);
      const note = created[created.length - 1];
      preview(midi);
      commit(created, new Set([note.id]));
      dragRef.current = { kind: "draw", noteId: note.id, originMs: note.startMs };
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }

    if (hit.kind === "body") {
      const alreadySelected = selection.has(hit.noteId);
      const nextSelection = additive
        ? new Set(alreadySelected ? [...selection].filter((id) => id !== hit.noteId) : [...selection, hit.noteId])
        : alreadySelected
          ? selection
          : new Set([hit.noteId]);
      if (!alreadySelected && !additive) preview(notes.find((note) => note.id === hit.noteId)?.midi ?? 60);
      setSelection(nextSelection);
      dragRef.current = { kind: "move", originMs: position.ms, originMidi: yToMidi(position.y, geometryRef.current), startNotes: notes };
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }

    // Resize handle.
    setSelection(new Set([hit.noteId]));
    dragRef.current = { kind: "resize", noteId: hit.noteId };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMoveGrid = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag === null || disabled) return;
    const position = gridPosition(event);
    if (position === null) return;

    if (drag.kind === "draw") {
      const endMs = snapMs(position.ms, stepMs);
      const duration = Math.max(stepMs ?? MIN_NOTE_MS, endMs - drag.originMs);
      commit(
        notes.map((note) => (note.id === drag.noteId ? { ...note, durationMs: Math.max(MIN_NOTE_MS, duration) } : note)),
      );
      return;
    }
    if (drag.kind === "move") {
      const deltaMs = position.ms - drag.originMs;
      const deltaMidi = yToMidi(position.y, geometryRef.current) - drag.originMidi;
      commit(moveNotes(drag.startNotes, selection, deltaMs, deltaMidi, stepMs));
      return;
    }
    commit(resizeNote(notes, drag.noteId, position.ms, stepMs));
  };

  const onPointerUpGrid = () => {
    dragRef.current = null;
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const meta = event.ctrlKey || event.metaKey;
    if (event.key === "Delete" || event.key === "Backspace") {
      if (selection.size === 0) return;
      event.preventDefault();
      commit(deleteNotes(notes, selection), new Set());
      return;
    }
    if (meta && event.key.toLowerCase() === "d") {
      event.preventDefault();
      const { notes: withCopies, newIds } = duplicateNotes(notes, selection, stepMs);
      commit(withCopies, new Set(newIds));
      return;
    }
    if (meta && event.key.toLowerCase() === "a") {
      event.preventDefault();
      setSelection(new Set(notes.map((note) => note.id)));
      return;
    }
    if (event.key === "Escape") {
      setSelection(new Set());
      return;
    }
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      if (selection.size === 0) return;
      event.preventDefault();
      const semitones = (event.key === "ArrowUp" ? 1 : -1) * (event.shiftKey ? 12 : 1);
      commit(transposeNotes(notes, selection, semitones));
      return;
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      if (selection.size === 0) return;
      event.preventDefault();
      const nudge = (event.key === "ArrowRight" ? 1 : -1) * (stepMs ?? 100);
      commit(moveNotes(notes, selection, nudge, 0, null));
    }
  };

  const setNoteVelocity = (noteId: string, ratio: number) => {
    if (disabled) return;
    const velocity = Math.round((1 - ratio) * 127);
    commit(
      notes.map((note) => (note.id === noteId ? { ...note, velocity: Math.max(1, Math.min(127, velocity)) } : note)),
      new Set([noteId]),
    );
  };

  const barCount = Math.ceil(timelineMs / barMs);

  return (
    <div className="piano-roll" data-testid="piano-roll">
      <div className="piano-roll-toolbar">
        <label>
          Snap
          <select aria-label="Snap grid" value={snapSetting} onChange={(event) => setSnapSetting(event.target.value as SnapSetting)}>
            {SNAP_SETTINGS.map((setting) => (
              <option key={setting} value={setting}>{setting === "off" ? "Off" : setting}</option>
            ))}
          </select>
        </label>
        <label>
          Zoom
          <input
            aria-label="Piano roll zoom"
            type="range"
            min={40}
            max={400}
            step={10}
            value={pixelsPerSecond}
            onChange={(event) => setPixelsPerSecond(Number(event.target.value))}
          />
        </label>
        <small>
          {notes.length} note{notes.length === 1 ? "" : "s"} · {selection.size} selected · {bpm} bpm
        </small>
      </div>
      <div
        className="piano-roll-body"
        tabIndex={0}
        role="application"
        aria-label="Piano roll editor"
        onKeyDown={onKeyDown}
      >
        <div className="piano-roll-scroll">
          <div className="piano-roll-inner" style={{ width: KEYBOARD_WIDTH_PX + gridWidthPx }}>
            <div className="piano-roll-keys" style={{ height: totalHeight, width: KEYBOARD_WIDTH_PX }}>
              {rows.map((row) => (
                <div key={row.midi} className={`piano-roll-key ${row.black ? "black" : "white"}`} style={{ height: geometry.rowHeight }}>
                  {row.label !== null && <span>{row.label}</span>}
                </div>
              ))}
            </div>
            <div className="piano-roll-track">
            <div
              ref={gridRef}
              className={`piano-roll-grid ${disabled ? "disabled" : ""}`}
              style={{ height: totalHeight, width: gridWidthPx }}
              onPointerDown={onPointerDownGrid}
              onPointerMove={onPointerMoveGrid}
              onPointerUp={onPointerUpGrid}
              onPointerCancel={onPointerUpGrid}
            >
              {rows.map((row) => (
                <div key={row.midi} className={`piano-roll-row ${row.black ? "black" : "white"}`} style={{ top: midiToY(row.midi, geometry), height: geometry.rowHeight }} />
              ))}
              {Array.from({ length: barCount }, (_, index) => index).map((bar) => (
                <div key={bar} className={`piano-roll-barline ${bar % 4 === 0 ? "strong" : ""}`} style={{ left: (bar * barMs / 1000) * pixelsPerSecond }} />
              ))}
              {notes.map((note) => (
                <div
                  key={note.id}
                  className={`piano-roll-note ${selection.has(note.id) ? "selected" : ""}`}
                  style={{
                    left: (note.startMs / 1000) * pixelsPerSecond,
                    top: midiToY(note.midi, geometry) + 1,
                    width: Math.max(3, (note.durationMs / 1000) * pixelsPerSecond),
                    height: geometry.rowHeight - 2,
                    opacity: 0.35 + (note.velocity / 127) * 0.65,
                  }}
                  title={`${midiToNoteName(note.midi)} · ${(note.startMs / 1000).toFixed(2)}s · ${note.durationMs}ms · vel ${note.velocity}`}
                />
              ))}
            </div>
            {/* Velocity lane — inside the same scroll, aligned under the grid */}
            <div className="piano-roll-velocity" style={{ width: gridWidthPx, height: VELOCITY_LANE_PX }} aria-label="Note velocities">
              {notes.map((note) => (
                <div
                  key={note.id}
                  className={`piano-roll-velocity-bar ${selection.has(note.id) ? "selected" : ""}`}
                  style={{ left: (note.startMs / 1000) * pixelsPerSecond, height: Math.max(2, (note.velocity / 127) * VELOCITY_LANE_PX) }}
                  title={`${midiToNoteName(note.midi)} velocity ${note.velocity} — drag to edit`}
                  onPointerDown={(event) => {
                    if (disabled || event.button !== 0) return;
                    event.currentTarget.setPointerCapture(event.pointerId);
                    setNoteVelocity(note.id, (event.clientY - event.currentTarget.getBoundingClientRect().top) / VELOCITY_LANE_PX);
                  }}
                  onPointerMove={(event) => {
                    if (disabled || event.buttons !== 1) return;
                    setNoteVelocity(note.id, (event.clientY - event.currentTarget.getBoundingClientRect().top) / VELOCITY_LANE_PX);
                  }}
                />
              ))}
            </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
