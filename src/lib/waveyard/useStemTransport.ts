"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
  /** Live insert subgraph between pan and mono; rebuilt on chain change. */
  inserts: InsertSubgraph | null;
  /** The tail node feeding mono (pan or gain). */
  tail: AudioNode;
};

function disconnectGraph(graph: AudioGraph) {
  graph.source.mediaElement.pause();
  graph.source.disconnect();
  graph.gain.disconnect();
  graph.pan?.disconnect();
  graph.mono.disconnect();
  graph.analyser.disconnect();
  graph.inserts?.input.disconnect();
  graph.inserts?.output.disconnect();
}

export type ChannelMeter = { peak: number; rms: number; clipped: boolean };

// ---------------------------------------------------------------------------
// Live insert chains — every processor maps to REAL Web Audio nodes.
// gate has no native node and is honestly excluded from live monitoring
// (it applies on cleanup previews/renders — the render path).
// ---------------------------------------------------------------------------

type InsertChain = Array<{
  id: string;
  processor: string;
  enabled: boolean;
  wet: number;
  params: Record<string, number>;
}>;

type InsertSubgraph = { input: AudioNode; output: AudioNode };

function dbToGainLinear(db: number): number {
  return Math.pow(10, db / 20);
}

function tanhCurve(drive: number): Float32Array<ArrayBuffer> {
  const n = 2048;
  const curve = new Float32Array(n);
  const norm = 1 / Math.tanh(drive);
  for (let i = 0; i < n; i += 1) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = norm * Math.tanh(drive * x);
  }
  return curve;
}

function softClipCurve(ceiling: number): Float32Array<ArrayBuffer> {
  const n = 2048;
  const curve = new Float32Array(n);
  const knee = ceiling * 0.85;
  for (let i = 0; i < n; i += 1) {
    const x = (i / (n - 1)) * 2 - 1; // -1..1 input domain
    const scaled = x * ceiling;      // compare in ceiling domain
    const absScaled = Math.abs(scaled);
    const sign = scaled < 0 ? -1 : 1;
    const y =
      absScaled <= knee
        ? scaled
        : sign * (knee + (ceiling - knee) * Math.tanh((absScaled - knee) / Math.max(1e-9, ceiling - knee)));
    curve[i] = Math.max(-1, Math.min(1, y / ceiling)); // back to -1..1
  }
  return curve;
}

function buildInsertNodes(ctx: AudioContext, insert: InsertChain[number]): InsertSubgraph | null {
  const p = insert.params;
  switch (insert.processor) {
    case "gain": {
      const g = ctx.createGain();
      g.gain.value = dbToGainLinear(p.gainDb);
      return { input: g, output: g };
    }
    case "highpass":
    case "lowpass":
    case "notch":
    case "eq-band": {
      const f = ctx.createBiquadFilter();
      f.type =
        insert.processor === "eq-band" ? "peaking"
        : insert.processor === "notch" ? "notch"
        : insert.processor;
      f.frequency.value = p.freqHz ?? p.cutoffHz;
      if (p.q !== undefined) f.Q.value = p.q;
      if (p.gainDb !== undefined) f.gain.value = p.gainDb;
      return { input: f, output: f };
    }
    case "compressor": {
      const c = ctx.createDynamicsCompressor();
      c.threshold.value = p.thresholdDb;
      c.ratio.value = p.ratio;
      c.attack.value = p.attackMs / 1000;
      c.release.value = p.releaseMs / 1000;
      c.knee.value = 6;
      const makeup = ctx.createGain();
      makeup.gain.value = dbToGainLinear(p.makeupDb);
      c.connect(makeup);
      return { input: c, output: makeup };
    }
    case "saturator": {
      const shaper = ctx.createWaveShaper();
      shaper.curve = tanhCurve(p.drive);
      shaper.oversample = "2x";
      return { input: shaper, output: shaper };
    }
    case "softclip": {
      const shaper = ctx.createWaveShaper();
      shaper.curve = softClipCurve(dbToGainLinear(p.ceilingDb));
      shaper.oversample = "2x";
      return { input: shaper, output: shaper };
    }
    case "width": {
      // Real mid/side matrix from native nodes.
      const splitter = ctx.createChannelSplitter(2);
      const merger = ctx.createChannelMerger(2);
      const midL = ctx.createGain(); midL.gain.value = 0.5;
      const midR = ctx.createGain(); midR.gain.value = 0.5;
      const sideL = ctx.createGain(); sideL.gain.value = 0.5;
      const sideR = ctx.createGain(); sideR.gain.value = -0.5;
      const mid = ctx.createGain();
      const side = ctx.createGain(); side.gain.value = p.width;
      const outLpos = ctx.createGain(); outLpos.gain.value = 1;
      const outRpos = ctx.createGain(); outRpos.gain.value = 1;
      const outRneg = ctx.createGain(); outRneg.gain.value = -1;
      splitter.connect(midL, 0); splitter.connect(midR, 1);
      splitter.connect(sideL, 0); splitter.connect(sideR, 1);
      midL.connect(mid); midR.connect(mid);
      sideL.connect(side); sideR.connect(side);
      mid.connect(outLpos); side.connect(outLpos);
      mid.connect(outRpos); side.connect(outRneg);
      outLpos.connect(merger, 0, 0);
      outRpos.connect(merger, 0, 1);
      outRneg.connect(merger, 0, 1);
      return { input: splitter, output: merger };
    }
    case "delay": {
      const input = ctx.createGain();
      const output = ctx.createGain();
      const dry = ctx.createGain(); dry.gain.value = 1 - p.mix;
      const wet = ctx.createGain(); wet.gain.value = p.mix;
      const delay = ctx.createDelay(2.0);
      delay.delayTime.value = p.delayMs / 1000;
      const feedback = ctx.createGain(); feedback.gain.value = p.feedback;
      input.connect(dry); dry.connect(output);
      input.connect(delay); delay.connect(wet); wet.connect(output);
      delay.connect(feedback); feedback.connect(delay);
      return { input, output };
    }
    default:
      return null; // gate and anything unknown: not live-monitorable
  }
}

function buildChainSubgraph(ctx: AudioContext, chain: InsertChain): InsertSubgraph {
  const input = ctx.createGain();
  const output = ctx.createGain();
  let cursor: AudioNode = input;
  for (const insert of chain) {
    if (!insert.enabled) continue;
    const nodes = buildInsertNodes(ctx, insert);
    if (nodes === null) continue;
    // Per-insert dry/wet (real parallel paths).
    const merge = ctx.createGain();
    const dry = ctx.createGain(); dry.gain.value = 1 - insert.wet;
    const wet = ctx.createGain(); wet.gain.value = insert.wet;
    cursor.connect(dry); dry.connect(merge);
    cursor.connect(nodes.input); nodes.output.connect(wet); wet.connect(merge);
    cursor = merge;
  }
  cursor.connect(output);
  return { input, output };
}
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

export function useStemTransport(assetIds: string[], duration: number) {
  // Polling returns fresh arrays for the same assets. Their identity must not
  // close the audio context or restart a performance.
  const idsKey = JSON.stringify(assetIds);
  const ids = useMemo<string[]>(() => JSON.parse(idsKey), [idsKey]);
  const media = useRef<Record<string, HTMLAudioElement | null>>({});
  const graphs = useRef<Record<string, AudioGraph>>({});
  const context = useRef<AudioContext | null>(null);
  const masterGain = useRef<GainNode | null>(null);
  const masterAnalyser = useRef<AnalyserNode | null>(null);
  const insertChains = useRef<Record<string, InsertChain>>({});
  const masterChain = useRef<InsertChain>([]);
  const masterInsertsSubgraph = useRef<InsertSubgraph | null>(null);
  const masterLeft = useRef<AnalyserNode | null>(null);
  const masterRight = useRef<AnalyserNode | null>(null);
  const clipHold = useRef<Record<string, number>>({});
  const mixValues = useRef<Record<string, MixerValues>>({});
  const masterTap = useRef<MediaStreamAudioDestinationNode | null>(null);
  const clockId = useRef<number | null>(null);
  const lastUiUpdate = useRef(0);
  const positionRef = useRef(0);
  const playRequest = useRef(0);
  const wantsPlayback = useRef(false);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [masterVolume, setMasterVolumeState] = useState(1);
  const masterVolumeRef = useRef(1);
  const setMasterVolume = useCallback((value: number | ((previous: number) => number)) => {
    const next = typeof value === "function" ? value(masterVolumeRef.current) : value;
    if (!Number.isFinite(next)) return;
    masterVolumeRef.current = Math.max(0, next);
    if (masterGain.current) masterGain.current.gain.value = masterVolumeRef.current;
    setMasterVolumeState(masterVolumeRef.current);
  }, []);
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
    const existing = graphs.current[id];
    if (existing && existing.source.mediaElement !== element) {
      disconnectGraph(existing);
      delete graphs.current[id];
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
      const tail: AudioNode = pan ?? gain;
      if (pan) gain.connect(pan);
      let insertSubgraph: InsertSubgraph | null = null;
      const chain = insertChains.current[id];
      if (chain !== undefined && chain.length > 0) {
        insertSubgraph = buildChainSubgraph(ctx, chain);
        tail.connect(insertSubgraph.input);
        insertSubgraph.output.connect(mono);
      } else {
        tail.connect(mono);
      }
      mono.connect(analyser);
      analyser.connect(masterGain.current!);
      graphs.current[id] = { source, gain, pan, mono, analyser, inserts: insertSubgraph, tail };
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
      if (!Number.isFinite(seconds)) return;
      const next = Math.min(
        duration || Number.MAX_SAFE_INTEGER,
        Math.max(0, seconds),
      );
      for (const id of ids) {
        const element = media.current[id];
        if (element && Math.abs(element.currentTime - next) > 0.015)
          element.currentTime = next;
      }
      positionRef.current = next;
      setPosition(next);
    },
    [duration, ids],
  );

  /** Apply insert chains (live): rebuilds the subgraph of every playing graph. */
  const applyInserts = useCallback(
    (chains: Record<string, InsertChain>, master: InsertChain) => {
      insertChains.current = chains;
      masterChain.current = master;
      for (const [id, graph] of Object.entries(graphs.current)) {
        const chain = chains[id];
        if (graph.inserts !== null) {
          try { graph.inserts.input.disconnect(); graph.inserts.output.disconnect(); } catch {}
          try { graph.tail.disconnect(); } catch {}
          graph.inserts = null;
          try { graph.tail.connect(graph.mono); } catch {}
        }
        if (chain !== undefined && chain.length > 0) {
          const sub = buildChainSubgraph(context.current!, chain);
          try { graph.tail.disconnect(); } catch {}
          graph.tail.connect(sub.input);
          sub.output.connect(graph.mono);
          graph.inserts = sub;
        }
      }
      // Master chain sits between masterGain and its analyser/splitter/destination.
      if (context.current && masterGain.current && masterAnalyser.current) {
        try { masterGain.current.disconnect(); } catch {}
        if (masterInsertsSubgraph.current) {
          masterInsertsSubgraph.current.input.disconnect();
          masterInsertsSubgraph.current.output.disconnect();
        }
        let head: AudioNode = masterGain.current;
        if (master.length > 0) {
          const sub = buildChainSubgraph(context.current, master);
          head.connect(sub.input);
          head = sub.output;
          masterInsertsSubgraph.current = sub;
        } else {
          masterInsertsSubgraph.current = null;
        }
        head.connect(masterAnalyser.current);
        head.connect(context.current.destination);
        // The L/R splitter taps re-attach after the chain so correlation
        // reflects the processed master.
        const splitter = context.current.createChannelSplitter(2);
        head.connect(splitter);
        splitter.connect(masterLeft.current!, 0);
        splitter.connect(masterRight.current!, 1);
      }
    },
    [],
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

  const stopClock = useCallback(() => {
    if (clockId.current) cancelAnimationFrame(clockId.current);
    clockId.current = null;
  }, []);
  const pause = useCallback(() => {
    playRequest.current += 1;
    wantsPlayback.current = false;
    for (const element of Object.values(media.current)) element?.pause();
    stopClock();
    setPlaying(false);
  }, [stopClock]);
  const stop = useCallback(() => {
    pause();
    seek(0);
  }, [pause, seek]);

  const play = useCallback(async () => {
    const request = ++playRequest.current;
    wantsPlayback.current = true;
    try {
      setError(null);
      if (!ids.length) throw new Error("No audio is ready. Import audio or wait for processing to finish.");
      const elements = ids.map((id) => {
        const element = media.current[id];
        if (!element) throw new Error(`Stem ${id} is not loaded. Reopen this track and retry.`);
        if (element.error) throw new Error(`Stem ${id} could not be loaded. Check its source file and retry.`);
        return element;
      });
      for (const id of ids) ensureGraph(id);
      if (masterGain.current) masterGain.current.gain.value = masterVolumeRef.current;
      applyMix(mixValues.current);
      // Inserts can be restored before the first user gesture, when no graph
      // exists yet. Apply that saved intent to the newly constructed graph.
      applyInserts(insertChains.current, masterChain.current);
      if (context.current?.state === "suspended") await context.current.resume();
      if (request !== playRequest.current) return false;
      const start = duration > 0 && positionRef.current >= duration ? 0 : positionRef.current;
      positionRef.current = start;
      for (const element of elements) element.currentTime = start;
      // Wait for every stem, including failures: an early rejection must not
      // leave another pending play promise starting audio after failure cleanup.
      const results = await Promise.allSettled(elements.map((element) => element.play()));
      if (request !== playRequest.current) {
        if (!wantsPlayback.current) for (const element of elements) element.pause();
        return false;
      }
      if (results.some((result) => result.status === "rejected")) {
        throw new Error("One or more stems could not play. Check the audio files and retry.");
      }
      setPlaying(true);
      return true;
    } catch (cause) {
      if (request !== playRequest.current) return false;
      setError(cause instanceof Error ? cause.message : "Audio playback failed. Reopen the track and retry.");
      pause();
      return false;
    }
  }, [applyInserts, applyMix, duration, ensureGraph, ids, pause]);

  // An actual asset change stops the old deck, but does not poison the shared
  // context. Equal ID lists from project polling do not enter this effect.
  useEffect(() => {
    pause();
    for (const [id, graph] of Object.entries(graphs.current)) {
      if (ids.includes(id)) continue;
      disconnectGraph(graph);
      delete graphs.current[id];
      delete media.current[id];
    }
  }, [ids, pause]);

  useEffect(() => {
    if (!playing) return;
    const tick = (now: number) => {
      if (ids.some((id) => !media.current[id] || media.current[id]?.error)) {
        setError("A required stem became unavailable during playback. Reopen the track and retry.");
        pause();
        return;
      }
      const anchor =
        ids
          .map((id) => media.current[id])
          .find((element) => element && !element.paused) ??
        media.current[ids[0]];
      if (!anchor) {
        pause();
        return;
      }
      let current = anchor.currentTime;
      if (loop.enabled && loop.end > loop.start && current >= loop.end) {
        seek(loop.start);
        current = loop.start;
        // Seeking active elements keeps playback running. Restart only if a
        // media element ended before the animation clock saw the boundary.
        if (ids.some((id) => media.current[id]?.paused)) void play();
      } else if (ids.every((id) => media.current[id]?.ended)) {
        positionRef.current = current;
        setPosition(current);
        pause();
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
        positionRef.current = current;
        setPosition(current);
      }
      clockId.current = requestAnimationFrame(tick);
    };
    clockId.current = requestAnimationFrame(tick);
    return stopClock;
  }, [ids, loop, pause, play, playing, seek, stopClock]);

  useEffect(
    () => () => {
      playRequest.current += 1;
      wantsPlayback.current = false;
      stopClock();
      for (const element of Object.values(media.current)) element?.pause();
      context.current?.close().catch(() => undefined);
    },
    [stopClock],
  );
  /**
   * Frequency-domain tap for one stem (post gain/pan/inserts — the signal
   * you actually hear). Returns null before the graph exists. The caller
   * owns the returned array.
   */
  const readSpectrum = useCallback((id: string): Uint8Array | null => {
    const graph = graphs.current[id];
    if (!graph) return null;
    const bins = new Uint8Array(graph.analyser.frequencyBinCount);
    graph.analyser.getByteFrequencyData(bins);
    return bins;
  }, []);

  /** Frequency-domain tap of the master bus (the summed mix you hear). */
  const readMasterSpectrum = useCallback((): Uint8Array | null => {
    const analyser = masterAnalyser.current;
    if (!analyser) return null;
    const bins = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(bins);
    return bins;
  }, []);

  /** A recording tap of the master bus (post gain, pan, inserts, master
   *  chain — exactly what you hear). Creates the destination lazily; the
   *  same stream is reused for every recording. Null before the first play
   *  (no audio graph exists yet). */
  const masterTapStream = useCallback((): MediaStream | null => {
    const analyser = masterAnalyser.current;
    const ctx = context.current;
    if (!analyser || !ctx) return null;
    if (masterTap.current === null) {
      masterTap.current = ctx.createMediaStreamDestination();
      analyser.connect(masterTap.current);
    }
    return masterTap.current.stream;
  }, []);

  /** Time-domain tap for one stem (the actual oscillating wave, [-1, 1]).
   *  Returns null before the graph exists. The caller owns the array. */
  const readWaveform = useCallback((id: string): Float32Array | null => {
    const graph = graphs.current[id];
    if (!graph) return null;
    const samples = new Float32Array(graph.analyser.fftSize);
    graph.analyser.getFloatTimeDomainData(samples);
    return samples;
  }, []);

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
    readSpectrum,
    readMasterSpectrum,
    readWaveform,
    masterTapStream,
    /** The audio context's actual rate (bin→Hz math for spectrum consumers). */
    contextSampleRate: () => context.current?.sampleRate ?? 44_100,
    readMeters,
    applyInserts,
    playing,
    position,
    currentPosition: () => positionRef.current,
    isPlaying: () => wantsPlayback.current && ids.length > 0 && ids.every((id) => media.current[id] && !media.current[id]!.paused && !media.current[id]!.ended),
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
