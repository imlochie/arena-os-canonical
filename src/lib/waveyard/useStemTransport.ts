"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type MixerValues = {
  volume: number;
  pan: number;
  muted: boolean;
  solo: boolean;
  /** Polarity inversion (negative gain — real phase flip). */
  phaseInvert?: boolean;
  /** Mono monitoring (explicit downmix to 1 channel, then back up). */
  monoMonitor?: boolean;
};
type AudioGraph = {
  source: MediaElementAudioSourceNode;
  gain: GainNode;
  pan: StereoPannerNode | null;
  /** Explicit-channel-count downmix node: 1 = mono monitor, 2 = stereo. */
  mono: GainNode;
  analyser: AnalyserNode;
};

export type ChannelMeter = { peak: number; rms: number; clipped: boolean };
export type MeterSnapshot = {
  channels: Record<string, ChannelMeter>;
  master: ChannelMeter & { left: number; right: number; correlation: number | null };
};

const CLIP_LEVEL = 0.997;

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
  const masterAnalyser = useRef<AnalyserNode | null>(null);
  const masterLeft = useRef<AnalyserNode | null>(null);
  const masterRight = useRef<AnalyserNode | null>(null);
  const clipHold = useRef<Record<string, number>>({});
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
      const ctx = context.current;
      masterAnalyser.current = ctx.createAnalyser();
      masterAnalyser.current.fftSize = 2048;
      const splitter = ctx.createChannelSplitter(2);
      masterLeft.current = ctx.createAnalyser();
      masterRight.current = ctx.createAnalyser();
      masterLeft.current.fftSize = 2048;
      masterRight.current.fftSize = 2048;
      masterGain.current.connect(masterAnalyser.current);
      masterGain.current.connect(splitter);
      splitter.connect(masterLeft.current, 0);
      splitter.connect(masterRight.current, 1);
      masterGain.current.connect(ctx.destination);
    }
    if (!graphs.current[id]) {
      const ctx = context.current;
      const source = ctx.createMediaElementSource(element);
      const gain = ctx.createGain();
      const pan =
        "createStereoPanner" in ctx ? ctx.createStereoPanner() : null;
      const mono = ctx.createGain();
      mono.channelCount = 2;
      mono.channelCountMode = "explicit";
      mono.channelInterpretation = "speakers";
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(gain);
      if (pan) {
        gain.connect(pan);
        pan.connect(mono);
      } else gain.connect(mono);
      mono.connect(analyser);
      analyser.connect(masterGain.current!);
      graphs.current[id] = { source, gain, pan, mono, analyser };
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
        // Phase inversion is a real polarity flip (negative gain), not a flag.
        const magnitude = isEffectivelyMuted(control, anySolo) ? 0 : control.volume;
        graph.gain.gain.value = control.phaseInvert ? -magnitude : magnitude;
        if (graph.pan) graph.pan.pan.value = control.pan;
        // Mono monitoring: explicit 1-channel downmix (speakers interpretation
        // sums L+R correctly), then the analyser output upmixes back to stereo.
        graph.mono.channelCount = control.monoMonitor ? 1 : 2;
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
  /**
   * Real meter readings from the audio graph's AnalyserNode taps.
   * Returns zeros when the graph does not exist yet (before first play).
   */
  const readMeters = useCallback((): MeterSnapshot => {
    const scratch = new Float32Array(2048);
    const readChannel = (analyser: AnalyserNode | null | undefined): ChannelMeter => {
      if (!analyser) return { peak: 0, rms: 0, clipped: false };
      analyser.getFloatTimeDomainData(scratch);
      let peak = 0;
      let sum = 0;
      for (let i = 0; i < scratch.length; i += 1) {
        const magnitude = Math.abs(scratch[i]);
        if (magnitude > peak) peak = magnitude;
        sum += scratch[i] * scratch[i];
      }
      return { peak, rms: Math.sqrt(sum / scratch.length), clipped: peak >= CLIP_LEVEL };
    };
    const channels: Record<string, ChannelMeter> = {};
    for (const [id, graph] of Object.entries(graphs.current)) {
      const meter = readChannel(graph.analyser);
      if (meter.clipped) clipHold.current[id] = Date.now();
      const held = clipHold.current[id] ?? 0;
      channels[id] = { ...meter, clipped: meter.clipped || Date.now() - held < 900 };
    }
    const master = readChannel(masterAnalyser.current);
    let left = 0;
    let right = 0;
    let correlation: number | null = null;
    if (masterLeft.current && masterRight.current) {
      const l = new Float32Array(2048);
      const r = new Float32Array(2048);
      masterLeft.current.getFloatTimeDomainData(l);
      masterRight.current.getFloatTimeDomainData(r);
      let sumL = 0, sumR = 0, sumLR = 0, sumLL = 0, sumRR = 0;
      for (let i = 0; i < l.length; i += 1) {
        left = Math.max(left, Math.abs(l[i]));
        right = Math.max(right, Math.abs(r[i]));
        sumL += l[i]; sumR += r[i];
        sumLR += l[i] * r[i]; sumLL += l[i] * l[i]; sumRR += r[i] * r[i];
      }
      const n = l.length;
      const cov = sumLR - (sumL * sumR) / n;
      const denom = Math.sqrt((sumLL - (sumL * sumL) / n) * (sumRR - (sumR * sumR) / n));
      correlation = denom > 0 ? cov / denom : null;
    }
    if (master.clipped) clipHold.current["__master"] = Date.now();
    const masterHeld = clipHold.current["__master"] ?? 0;
    return {
      channels,
      master: {
        ...master,
        clipped: master.clipped || Date.now() - masterHeld < 900,
        left,
        right,
        correlation,
      },
    };
  }, []);

  return {
    register,
    readMeters,
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
