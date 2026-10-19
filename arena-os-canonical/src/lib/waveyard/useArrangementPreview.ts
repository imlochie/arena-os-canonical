"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ArrangementPreviewState } from "./arrangement-pcm";
import { ArrangementPreparation, previewStateKey } from "./arrangement-preparation";

// Loop settings change playback, not rendered PCM: apply them immediately while
// reusing the finished mix rather than quietly retaining the previous loop.
const playbackStateKey = (state: ArrangementPreviewState, revision: string) => JSON.stringify([previewStateKey(state, revision), state.loopStartMs, state.loopEndMs]);
const EMPTY_SOURCE_REVISIONS: ReadonlyMap<string, string> = new Map();

/** Prepared canonical-DSP audition. One connected source per run; generation
 * fencing prevents cancelled loads/older edits from starting a stale graph. */
export function useArrangementPreview(onPosition: (milliseconds: number) => void, state?: ArrangementPreviewState | null, sourceRevision = "", scopeKey = "", sourceRevisions: ReadonlyMap<string, string> = EMPTY_SOURCE_REVISIONS) {
  const context = useRef<AudioContext | null>(null);
  const preparation = useRef<ArrangementPreparation | null>(null);
  const preparedKey = useRef("");
  const [preparing, setPreparing] = useState(false);
  const source = useRef<AudioBufferSourceNode | null>(null);
  const generation = useRef(0);
  const raf = useRef<number | null>(null);
  const origin = useRef({ contextTime: 0, positionMs: 0 });
  const active = useRef(false);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clear = useCallback(() => {
    generation.current++;
    preparation.current?.cancel();
    if (raf.current !== null) cancelAnimationFrame(raf.current);
    raf.current = null;
    if (source.current) { source.current.onended = null; try { source.current.stop(); } catch { /* already ended */ } source.current.disconnect(); source.current = null; }
  }, []);
  const position = useCallback(() => {
    const node = source.current;
    let next = origin.current.positionMs + (active.current && node && context.current ? (context.current.currentTime - origin.current.contextTime) * 1000 : 0);
    if (node?.loop && next >= node.loopEnd * 1000) next = node.loopStart * 1000 + (next - node.loopStart * 1000) % ((node.loopEnd - node.loopStart) * 1000);
    return Math.min(next, node?.buffer ? node.buffer.duration * 1000 : Infinity);
  }, []);
  const pause = useCallback(() => {
    const next = position(); active.current = false; clear(); origin.current.positionMs = next;
    onPosition(next); setPlaying(false); setPreparing(false);
  }, [clear, onPosition, position]);
  const play = useCallback(async (snapshot: ArrangementPreviewState, fromMs: number) => {
    preparedKey.current = playbackStateKey(snapshot, sourceRevision);
    clear(); const token = generation.current; active.current = true; origin.current.positionMs = fromMs; setError(null); setPlaying(false); setPreparing(true);
    try {
      const audio = context.current ??= new AudioContext({ sampleRate: 44100 });
      if (audio.state === "suspended") await audio.resume();
      const engine = preparation.current ??= new ArrangementPreparation();
      const buffer = await engine.prepare(snapshot, audio, sourceRevision, sourceRevisions);
      if (token !== generation.current) return;
      preparedKey.current = playbackStateKey(snapshot, sourceRevision);
      const node = audio.createBufferSource(); node.buffer = buffer; node.connect(audio.destination);
      const offset = Math.max(0, Math.min(fromMs / 1000, buffer.duration));
      if (snapshot.loopEndMs !== null && snapshot.loopEndMs > snapshot.loopStartMs) { node.loop = true; node.loopStart = snapshot.loopStartMs / 1000; node.loopEnd = Math.min(buffer.duration, snapshot.loopEndMs / 1000); }
      source.current = node; origin.current = { contextTime: audio.currentTime, positionMs: offset * 1000 };
      node.onended = () => { if (token === generation.current) pause(); };
      node.start(0, offset); setPlaying(true); setPreparing(false);
      const tick = () => {
        if (token !== generation.current) return;
        let next = position();
        if (node.loop && next >= node.loopEnd * 1000) next = node.loopStart * 1000 + (next - node.loopStart * 1000) % ((node.loopEnd - node.loopStart) * 1000);
        onPosition(next); raf.current = requestAnimationFrame(tick);
      };
      raf.current = requestAnimationFrame(tick);
    } catch (cause) {
      if (token !== generation.current) return;
      active.current = false; clear(); setPlaying(false); setPreparing(false); setError(cause instanceof Error ? cause.message : "Arrangement audition failed.");
    }
  }, [clear, onPosition, pause, position, sourceRevision, sourceRevisions]);
  const stop = useCallback(() => { active.current = false; clear(); origin.current = { contextTime: 0, positionMs: 0 }; onPosition(0); setPlaying(false); setPreparing(false); }, [clear, onPosition]);
  // Edits invalidate the old graph immediately and prepare the new snapshot at
  // the observed cursor. No effect nodes or old requests survive replacement.
  const stateKey = state ? playbackStateKey(state, sourceRevision) : "";
  useEffect(() => { if (active.current && stateKey !== preparedKey.current) { if (state) void play(state, position()); else stop(); } }, [stateKey, state, play, position, stop]);
  const previousScope = useRef(scopeKey);
  useEffect(() => { if (previousScope.current !== scopeKey) { previousScope.current = scopeKey; stop(); preparation.current?.dispose(); } }, [scopeKey, stop]);
  useEffect(() => () => { active.current = false; clear(); preparation.current?.dispose(); void context.current?.close(); }, [clear]);
  const seek = useCallback((seconds: number) => { if (active.current && state) void play(state, seconds * 1000); else { origin.current.positionMs = seconds * 1000; onPosition(seconds * 1000); } }, [onPosition, play, state]);
  return { playing, preparing, error, play, pause, stop, seek };
}
