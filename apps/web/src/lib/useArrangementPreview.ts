"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { effectiveMuted, type RemixTrackInput } from "./remix";

type PreviewClip = RemixTrackInput["clips"][number];
type PreviewTrack = RemixTrackInput;
type PreviewState = {
  masterVolume: number;
  loopStartMs: number;
  loopEndMs: number | null;
  tracks: PreviewTrack[];
};

type ScheduledSource = { source: AudioBufferSourceNode; gain: GainNode };

function clipLevelAt(clip: PreviewClip, offsetMs: number) {
  if (clip.fadeInMs > 0 && offsetMs < clip.fadeInMs) return offsetMs / clip.fadeInMs;
  const fadeOutStart = clip.durationMs - clip.fadeOutMs;
  if (clip.fadeOutMs > 0 && offsetMs > fadeOutStart) return Math.max(0, (clip.durationMs - offsetMs) / clip.fadeOutMs);
  return 1;
}

/**
 * A deliberately browser-only audition graph. It reads the same private asset
 * route as the stem inspector but never writes audio or becomes an export
 * source; persisted clips and the worker snapshot remain authoritative.
 */
export function useArrangementPreview(onPosition: (milliseconds: number) => void) {
  const context = useRef<AudioContext | null>(null);
  const buffers = useRef(new Map<string, AudioBuffer>());
  const scheduled = useRef<ScheduledSource[]>([]);
  const raf = useRef<number | null>(null);
  const origin = useRef({ contextTime: 0, positionMs: 0 });
  const currentState = useRef<PreviewState | null>(null);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clear = useCallback(() => {
    if (raf.current !== null) cancelAnimationFrame(raf.current);
    raf.current = null;
    for (const item of scheduled.current) {
      try { item.source.stop(); } catch { /* already finished */ }
      item.source.disconnect();
      item.gain.disconnect();
    }
    scheduled.current = [];
  }, []);

  const ensureContext = useCallback(() => {
    if (!context.current) context.current = new AudioContext();
    return context.current;
  }, []);
  const ensureBuffer = useCallback(async (assetId: string) => {
    const existing = buffers.current.get(assetId);
    if (existing) return existing;
    const response = await fetch(`/api/assets/${assetId}`);
    if (!response.ok) throw new Error("A stem could not be loaded for arrangement preview.");
    const data = await response.arrayBuffer();
    const decoded = await ensureContext().decodeAudioData(data);
    buffers.current.set(assetId, decoded);
    return decoded;
  }, [ensureContext]);

  const schedule = useCallback(async (state: PreviewState, startMs: number) => {
    const audio = ensureContext();
    const assetIds = [...new Set(state.tracks.flatMap((track) => track.clips.map((clip) => clip.stemAssetId)))];
    await Promise.all(assetIds.map(ensureBuffer));
    clear();
    const master = audio.createGain();
    master.gain.value = state.masterVolume;
    master.connect(audio.destination);
    const anySolo = state.tracks.some((track) => track.solo);
    for (const track of state.tracks) {
      if (effectiveMuted(track, anySolo)) continue;
      for (const clip of track.clips) {
        const elapsedMs = Math.max(0, startMs - clip.timelineStartMs);
        if (elapsedMs >= clip.durationMs) continue;
        const buffer = buffers.current.get(clip.stemAssetId);
        if (!buffer) continue;
        const source = audio.createBufferSource();
        const gain = audio.createGain();
        const panner = "createStereoPanner" in audio ? audio.createStereoPanner() : null;
        source.buffer = buffer;
        source.connect(gain);
        if (panner) { gain.connect(panner); panner.pan.value = track.pan; panner.connect(master); }
        else gain.connect(master);
        const baseGain = track.volume * clip.gain;
        const startAt = audio.currentTime + Math.max(0, (clip.timelineStartMs - startMs) / 1000);
        const remainingMs = clip.durationMs - elapsedMs;
        const level = baseGain * clipLevelAt(clip, elapsedMs);
        gain.gain.setValueAtTime(level, startAt);
        if (clip.fadeInMs > elapsedMs)
          gain.gain.linearRampToValueAtTime(baseGain, startAt + (clip.fadeInMs - elapsedMs) / 1000);
        const fadeOutStart = clip.durationMs - clip.fadeOutMs;
        if (clip.fadeOutMs > 0) {
          const untilFadeMs = fadeOutStart - elapsedMs;
          const endAt = startAt + remainingMs / 1000;
          if (untilFadeMs > 0) {
            gain.gain.setValueAtTime(baseGain, startAt + untilFadeMs / 1000);
            gain.gain.linearRampToValueAtTime(0, endAt);
          } else gain.gain.linearRampToValueAtTime(0, endAt);
        }
        source.start(startAt, (clip.sourceOffsetMs + elapsedMs) / 1000, remainingMs / 1000);
        source.onended = () => { source.disconnect(); gain.disconnect(); };
        scheduled.current.push({ source, gain });
      }
    }
    origin.current = { contextTime: audio.currentTime, positionMs: startMs };
  }, [clear, ensureBuffer, ensureContext]);

  const pause = useCallback(() => {
    if (!context.current) return;
    const next = origin.current.positionMs + (context.current.currentTime - origin.current.contextTime) * 1000;
    clear();
    origin.current = { contextTime: 0, positionMs: next };
    onPosition(next);
    setPlaying(false);
  }, [clear, onPosition]);

  const play = useCallback(async (state: PreviewState, fromMs: number) => {
    try {
      setError(null);
      currentState.current = state;
      const audio = ensureContext();
      if (audio.state === "suspended") await audio.resume();
      await schedule(state, fromMs);
      setPlaying(true);
      const tick = () => {
        const active = currentState.current;
        if (!active || !context.current) return;
        const positionMs = origin.current.positionMs + (context.current.currentTime - origin.current.contextTime) * 1000;
        if (active.loopEndMs !== null && active.loopEndMs > active.loopStartMs && positionMs >= active.loopEndMs) {
          void schedule(active, active.loopStartMs).then(() => {
            raf.current = requestAnimationFrame(tick);
          });
          return;
        }
        const endMs = Math.max(0, ...active.tracks.flatMap((track) => track.clips.map((clip) => clip.timelineStartMs + clip.durationMs)));
        if (positionMs >= endMs) { pause(); return; }
        onPosition(positionMs);
        raf.current = requestAnimationFrame(tick);
      };
      raf.current = requestAnimationFrame(tick);
    } catch (cause) {
      clear();
      setPlaying(false);
      setError(cause instanceof Error ? cause.message : "Arrangement preview could not start.");
    }
  }, [clear, ensureContext, onPosition, pause, schedule]);

  const stop = useCallback(() => {
    clear();
    origin.current = { contextTime: 0, positionMs: 0 };
    onPosition(0);
    setPlaying(false);
  }, [clear, onPosition]);
  useEffect(() => () => { clear(); void context.current?.close(); }, [clear]);
  return { playing, error, play, pause, stop };
}
