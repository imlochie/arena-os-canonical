"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { prepareArrangementPcm, type ArrangementPreviewState } from "./arrangement-pcm";

/** Prepared canonical-DSP audition. One connected source per run; generation
 * fencing prevents cancelled loads/older edits from starting a stale graph. */
export function useArrangementPreview(onPosition: (milliseconds: number) => void, state?: ArrangementPreviewState | null) {
  const context = useRef<AudioContext | null>(null);
  const buffers = useRef(new Map<string, AudioBuffer>());
  const source = useRef<AudioBufferSourceNode | null>(null);
  const generation = useRef(0);
  const raf = useRef<number | null>(null);
  const origin = useRef({ contextTime: 0, positionMs: 0 });
  const active = useRef(false);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clear = useCallback(() => {
    generation.current++;
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
    onPosition(next); setPlaying(false);
  }, [clear, onPosition, position]);
  const play = useCallback(async (snapshot: ArrangementPreviewState, fromMs: number) => {
    clear(); const token = generation.current; active.current = true; origin.current.positionMs = fromMs; setError(null);
    try {
      const audio = context.current ??= new AudioContext({ sampleRate: 44100 });
      if (audio.state === "suspended") await audio.resume();
      const ids = [...new Set(snapshot.tracks.filter((track) => !track.muted).flatMap((track) => track.clips.map((clip) => clip.stemAssetId)))];
      await Promise.all(ids.map(async (id) => {
        if (buffers.current.has(id)) return;
        const response = await fetch(`/api/assets/${id}`);
        if (!response.ok) throw new Error("A stem could not be loaded for arrangement audition.");
        const decoded = await audio.decodeAudioData(await response.arrayBuffer());
        if (token === generation.current) buffers.current.set(id, decoded);
      }));
      if (token !== generation.current) return;
      const pcm = prepareArrangementPcm(snapshot, buffers.current, audio.sampleRate);
      if (token !== generation.current) return;
      const buffer = audio.createBuffer(2, pcm.length / 2, audio.sampleRate);
      for (let channel = 0; channel < 2; channel++) { const data = buffer.getChannelData(channel); for (let frame = 0; frame < data.length; frame++) data[frame] = pcm[frame * 2 + channel]; }
      const node = audio.createBufferSource(); node.buffer = buffer; node.connect(audio.destination);
      const offset = Math.max(0, Math.min(fromMs / 1000, buffer.duration));
      if (snapshot.loopEndMs !== null && snapshot.loopEndMs > snapshot.loopStartMs) { node.loop = true; node.loopStart = snapshot.loopStartMs / 1000; node.loopEnd = Math.min(buffer.duration, snapshot.loopEndMs / 1000); }
      source.current = node; origin.current = { contextTime: audio.currentTime, positionMs: offset * 1000 };
      node.onended = () => { if (token === generation.current) pause(); };
      node.start(0, offset); setPlaying(true);
      const tick = () => {
        if (token !== generation.current) return;
        let next = position();
        if (node.loop && next >= node.loopEnd * 1000) next = node.loopStart * 1000 + (next - node.loopStart * 1000) % ((node.loopEnd - node.loopStart) * 1000);
        onPosition(next); raf.current = requestAnimationFrame(tick);
      };
      raf.current = requestAnimationFrame(tick);
    } catch (cause) {
      if (token !== generation.current) return;
      active.current = false; clear(); setPlaying(false); setError(cause instanceof Error ? cause.message : "Arrangement audition failed.");
    }
  }, [clear, onPosition, pause, position]);
  const stop = useCallback(() => { active.current = false; clear(); origin.current = { contextTime: 0, positionMs: 0 }; onPosition(0); setPlaying(false); }, [clear, onPosition]);
  // Edits invalidate the old graph immediately and prepare the new snapshot at
  // the observed cursor. No effect nodes or old requests survive replacement.
  useEffect(() => { if (active.current) { if (state) void play(state, position()); else stop(); } }, [state, play, position, stop]);
  useEffect(() => () => { active.current = false; clear(); void context.current?.close(); }, [clear]);
  const seek = useCallback((seconds: number) => { if (active.current && state) void play(state, seconds * 1000); else { origin.current.positionMs = seconds * 1000; onPosition(seconds * 1000); } }, [onPosition, play, state]);
  return { playing, error, play, pause, stop, seek };
}
