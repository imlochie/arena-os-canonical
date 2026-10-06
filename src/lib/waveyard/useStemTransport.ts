"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type MixerValues = {
  volume: number;
  pan: number;
  muted: boolean;
  solo: boolean;
};
type AudioGraph = {
  source: MediaElementAudioSourceNode;
  gain: GainNode;
  pan: StereoPannerNode | null;
};

export function isEffectivelyMuted(
  values: Pick<MixerValues, "muted" | "solo">,
  anySolo: boolean,
) {
  return values.muted || (anySolo && !values.solo);
}

export function useStemTransport(ids: string[], duration: number) {
  const media = useRef<Record<string, HTMLAudioElement | null>>({});
  const graphs = useRef<Record<string, AudioGraph>>({});
  const context = useRef<AudioContext | null>(null);
  const masterGain = useRef<GainNode | null>(null);
  const mixValues = useRef<Record<string, MixerValues>>({});
  const clockId = useRef<number | null>(null);
  const lastUiUpdate = useRef(0);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [masterVolume, setMasterVolume] = useState(1);
  const [loop, setLoop] = useState({ enabled: false, start: 0, end: 0 });
  const [error, setError] = useState<string | null>(null);

  const ensureGraph = useCallback((id: string) => {
    const element = media.current[id];
    if (!element) return null;
    if (!context.current) {
      context.current = new AudioContext();
      masterGain.current = context.current.createGain();
      masterGain.current.connect(context.current.destination);
    }
    if (!graphs.current[id]) {
      const source = context.current.createMediaElementSource(element);
      const gain = context.current.createGain();
      const pan =
        "createStereoPanner" in context.current
          ? context.current.createStereoPanner()
          : null;
      source.connect(gain);
      if (pan) {
        gain.connect(pan);
        pan.connect(masterGain.current!);
      } else gain.connect(masterGain.current!);
      graphs.current[id] = { source, gain, pan };
    }
    return graphs.current[id];
  }, []);

  const register = useCallback(
    (id: string, element: HTMLAudioElement | null) => {
      media.current[id] = element;
    },
    [],
  );
  const seek = useCallback(
    (seconds: number) => {
      const next = Math.min(
        duration || Number.MAX_SAFE_INTEGER,
        Math.max(0, seconds),
      );
      for (const id of ids) {
        const element = media.current[id];
        if (element && Math.abs(element.currentTime - next) > 0.015)
          element.currentTime = next;
      }
      setPosition(next);
    },
    [duration, ids],
  );

  // Recording mixer intent is safe before a user gesture. We intentionally do
  // not construct an AudioContext here; play() creates graphs lazily.
  const applyMix = useCallback(
    (values: Record<string, MixerValues>) => {
      mixValues.current = values;
      const anySolo = Object.values(values).some((track) => track.solo);
      for (const id of ids) {
        const graph = graphs.current[id];
        const control = values[id];
        if (!graph || !control) continue;
        graph.gain.gain.value = isEffectivelyMuted(control, anySolo)
          ? 0
          : control.volume;
        if (graph.pan) graph.pan.pan.value = control.pan;
      }
    },
    [ids],
  );

  useEffect(() => {
    if (masterGain.current) masterGain.current.gain.value = masterVolume;
  }, [masterVolume]);
  const stopClock = useCallback(() => {
    if (clockId.current) cancelAnimationFrame(clockId.current);
    clockId.current = null;
  }, []);
  const pause = useCallback(() => {
    for (const id of ids) media.current[id]?.pause();
    stopClock();
    setPlaying(false);
  }, [ids, stopClock]);
  const stop = useCallback(() => {
    pause();
    seek(0);
  }, [pause, seek]);

  const play = useCallback(async () => {
    try {
      setError(null);
      for (const id of ids) ensureGraph(id);
      if (masterGain.current) masterGain.current.gain.value = masterVolume;
      applyMix(mixValues.current);
      if (context.current?.state === "suspended")
        await context.current.resume();
      const start = position;
      for (const id of ids) {
        const element = media.current[id];
        if (element) element.currentTime = start;
      }
      await Promise.all(ids.map(async (id) => media.current[id]?.play()));
      setPlaying(true);
    } catch {
      setError("Browser playback was blocked or one stem could not be loaded.");
      pause();
    }
  }, [applyMix, ensureGraph, ids, masterVolume, pause, position]);

  useEffect(() => {
    if (!playing) return;
    const tick = (now: number) => {
      const anchor =
        ids
          .map((id) => media.current[id])
          .find((element) => element && !element.paused) ??
        media.current[ids[0]];
      if (!anchor) {
        pause();
        return;
      }
      const current = anchor.currentTime;
      if (loop.enabled && loop.end > loop.start && current >= loop.end) {
        seek(loop.start);
        void play();
        return;
      }
      for (const id of ids) {
        const element = media.current[id];
        // This is a browser-level drift correction, not a sample-perfect DAW claim.
        if (
          element &&
          element !== anchor &&
          Math.abs(element.currentTime - current) > 0.075
        )
          element.currentTime = current;
      }
      if (now - lastUiUpdate.current > 100) {
        lastUiUpdate.current = now;
        setPosition(current);
      }
      clockId.current = requestAnimationFrame(tick);
    };
    clockId.current = requestAnimationFrame(tick);
    return stopClock;
  }, [ids, loop, pause, play, playing, seek, stopClock]);

  useEffect(
    () => () => {
      pause();
      context.current?.close().catch(() => undefined);
    },
    [pause],
  );
  return {
    register,
    playing,
    position,
    duration,
    masterVolume,
    setMasterVolume,
    loop,
    setLoop,
    error,
    seek,
    play,
    pause,
    stop,
    applyMix,
  };
}
