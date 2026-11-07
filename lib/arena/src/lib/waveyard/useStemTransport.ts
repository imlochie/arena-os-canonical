"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import liveStemWorkletUrl from "./live-stem-worklet.ts?worker&url";
import { RESUME_TIMEOUT_MS, resumeWithin } from "./audio-context-resume";
import outputPeakWorkletUrl from "./output-peak-worklet.ts?worker&url";
import { acquireSessionOutput } from "./session-output";
import { ensureLiveStemWorklet, LiveStemLayers, normalizeSessionPlaybackRate } from "./live-stem-layers";
import type { SessionAudioAssetPool } from "./session-audio-asset-pool";
export { SessionAudioAssetPool } from "./session-audio-asset-pool";
export type { SessionAudioMediaLease } from "./session-audio-asset-pool";
export {
  SESSION_PLAYBACK_RATE_MAX,
  SESSION_PLAYBACK_RATE_MIN,
  normalizeSessionPlaybackRate,
} from "./live-stem-layers";
export { LiveStemSwitchTimeoutError } from "./live-stem-layers";

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
  inputGain: GainNode;
  gain: GainNode;
  pan: StereoPannerNode | null;
  /** Explicit-channel-count downmix node: 1 = mono monitor, 2 = stereo. */
  mono: GainNode;
  analyser: AnalyserNode;
  /** Live insert subgraph between pan and mono; rebuilt on chain change. */
  inserts: InsertSubgraph | null;
  /** The tail node feeding mono (pan or gain). */
  tail: AudioNode;
  /** Dry/wet split keeps live key-shift preparation from interrupting audio. */
  keyShiftDry: GainNode;
  keyShiftWet: GainNode;
  keyShiftNode: AudioWorkletNode | null;
};

function disconnectGraph(graph: AudioGraph) {
  graph.source.mediaElement.pause();
  graph.source.disconnect();
  graph.inputGain.disconnect();
  graph.gain.disconnect();
  graph.pan?.disconnect();
  graph.keyShiftDry.disconnect();
  graph.keyShiftWet.disconnect();
  graph.keyShiftNode?.port.postMessage({ type: "dispose" });
  graph.keyShiftNode?.port.close();
  graph.keyShiftNode?.disconnect();
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

const DEFAULT_MIXER_VALUES: MixerValues = {
  volume: 1,
  pan: 0,
  muted: false,
  solo: false,
};

const mediaPitchProperties = ["preservesPitch", "webkitPreservesPitch", "mozPreservesPitch"] as const;

export function supportsLiveKeyMatching() {
  if (typeof window === "undefined") return false;
  const AudioContextConstructor = window.AudioContext;
  return Boolean(
    window.isSecureContext
    && typeof AudioWorkletNode !== "undefined"
    && AudioContextConstructor
    && "audioWorklet" in AudioContextConstructor.prototype
    && liveStemWorkletUrl,
  );
}

function setMediaPitchPreserving(element: HTMLAudioElement, enabled: boolean) {
  const capabilities = element as unknown as Record<string, unknown>;
  for (const property of mediaPitchProperties) {
    if (!(property in capabilities)) continue;
    try {
      capabilities[property] = enabled;
      if (capabilities[property] === enabled) return true;
    } catch {
      // Try a browser-prefixed implementation before declaring the mode unavailable.
    }
  }
  return false;
}

export function supportsSessionPitchModes() {
  if (typeof window === "undefined" || typeof document === "undefined") return false;
  const AudioContextConstructor = window.AudioContext;
  if (
    !window.isSecureContext
    || typeof AudioWorkletNode === "undefined"
    || !AudioContextConstructor
    || !("audioWorklet" in AudioContextConstructor.prototype)
    || !liveStemWorkletUrl
  ) return false;

  const testElement = document.createElement("audio");
  const capabilities = testElement as unknown as Record<string, unknown>;
  const property = mediaPitchProperties.find((candidate) => candidate in capabilities);
  if (!property) return false;
  const previous = capabilities[property];
  try {
    capabilities[property] = true;
    const canEnable = capabilities[property] === true;
    capabilities[property] = false;
    const canDisable = capabilities[property] === false;
    capabilities[property] = previous;
    return canEnable && canDisable;
  } catch {
    try { capabilities[property] = previous; } catch { /* keep capability probing isolated */ }
    return false;
  }
}

function applyMediaPlaybackRate(element: HTMLAudioElement, rate: number, pitchPreserving = false) {
  if (pitchPreserving && !setMediaPitchPreserving(element, true)) {
    throw new Error("Pitch lock is unavailable for this audio element.");
  }
  if (!pitchPreserving) setMediaPitchPreserving(element, false);
  element.playbackRate = rate;
}

/** Resolve mixer intent only for the currently loaded audio channels. */
export function resolveActiveMixerState(
  ids: readonly string[],
  values: Readonly<Record<string, MixerValues>>,
) {
  const controls = Object.fromEntries(
    ids.map((id) => [id, values[id] ?? DEFAULT_MIXER_VALUES]),
  ) as Record<string, MixerValues>;
  return {
    controls,
    anySolo: ids.some((id) => controls[id].solo),
  };
}

export function useStemTransport(
  assetIds: string[],
  duration: number,
  playbackAssetIds: string[] = assetIds,
  outputGroup?: string,
  assetPool?: SessionAudioAssetPool,
) {
  // Polling may construct a fresh array for identical assets. Treat equal IDs
  // as the same deck so renders do not restart its audio clock or effects.
  const idsKey = JSON.stringify(assetIds);
  const ids = useMemo<string[]>(() => JSON.parse(idsKey), [idsKey]);
  const playbackIdsKey = JSON.stringify(playbackAssetIds);
  const playbackIds = useMemo<string[]>(() => JSON.parse(playbackIdsKey), [playbackIdsKey]);
  const currentIds = useRef(ids);
  currentIds.current = ids;
  const currentPlaybackIds = useRef(playbackIds);
  currentPlaybackIds.current = playbackIds;
  const previousIds = useRef(ids);
  const media = useRef<Record<string, HTMLAudioElement | null>>({});
  const graphs = useRef<Record<string, AudioGraph>>({});
  const context = useRef<AudioContext | null>(null);
  const sessionOutput = useRef<ReturnType<typeof acquireSessionOutput> | null>(null);
  const outputGroupRef = useRef(outputGroup);
  const contextStateHandler = useRef<(() => void) | null>(null);
  const masterGain = useRef<GainNode | null>(null);
  const masterAnalyser = useRef<AnalyserNode | null>(null);
  const insertChains = useRef<Record<string, InsertChain>>({});
  const masterChain = useRef<InsertChain>([]);
  const masterInsertsSubgraph = useRef<InsertSubgraph | null>(null);
  const masterLeft = useRef<AnalyserNode | null>(null);
  const masterRight = useRef<AnalyserNode | null>(null);
  const clipHold = useRef<Record<string, number>>({});
  const mixValues = useRef<Record<string, MixerValues>>({});
  const playbackRate = useRef(1);
  const pitchPreserving = useRef(false);
  const keyShiftSemitones = useRef(0);
  const keyShiftRequest = useRef(0);
  const masterTap = useRef<MediaStreamAudioDestinationNode | null>(null);
  const clockId = useRef<number | null>(null);
  const lastUiUpdate = useRef(0);
  const playRequest = useRef(0);
  const wantsPlayback = useRef(false);
  const recoveryInFlight = useRef(false);
  const wasBackgrounded = useRef(false);
  const recoverAudioContext = useRef<() => void>(() => undefined);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  // Commands such as seek(0); play() run in one event/effect. React state
  // has not rerendered between them, so playback must use a synchronous clock.
  const positionRef = useRef(0);
  const [masterVolume, setMasterVolumeState] = useState(1);
  const masterVolumeRef = useRef(1);
  const [loop, setLoop] = useState({ enabled: false, start: 0, end: 0 });
  const [error, setError] = useState<string | null>(null);

  const applyMasterVolumeRealtime = useCallback((volume: number) => {
    const audioContext = context.current;
    const gain = masterGain.current?.gain;
    if (!audioContext || !gain || !Number.isFinite(volume)) return;
    gain.setValueAtTime(Math.min(2, Math.max(0, volume)), audioContext.currentTime);
  }, []);
  const setMasterVolume = useCallback((volume: number) => {
    if (!Number.isFinite(volume)) return;
    const value = Math.min(2, Math.max(0, volume));
    masterVolumeRef.current = value;
    applyMasterVolumeRealtime(value);
    setMasterVolumeState(value);
  }, [applyMasterVolumeRealtime]);

  const ensureGraph = useCallback((id: string) => {
    const element = media.current[id];
    if (!element) return null;
    if (!context.current) {
      if (outputGroupRef.current) {
        sessionOutput.current = acquireSessionOutput(outputGroupRef.current, outputPeakWorkletUrl);
        context.current = sessionOutput.current.context;
      } else context.current = new AudioContext();
      contextStateHandler.current = () => recoverAudioContext.current();
      context.current.addEventListener("statechange", contextStateHandler.current);
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
      masterGain.current.connect(sessionOutput.current?.input ?? ctx.destination);
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
      const inputGain = ctx.createGain();
      const keyShiftDry = ctx.createGain();
      const keyShiftWet = ctx.createGain();
      keyShiftDry.gain.value = 1;
      keyShiftWet.gain.value = 0;
      source.connect(inputGain);
      inputGain.connect(gain);
      const tail: AudioNode = pan ?? gain;
      if (pan) gain.connect(pan);
      let insertSubgraph: InsertSubgraph | null = null;
      const chain = insertChains.current[id];
      tail.connect(keyShiftDry);
      if (chain !== undefined && chain.length > 0) {
        insertSubgraph = buildChainSubgraph(ctx, chain);
        keyShiftDry.connect(insertSubgraph.input);
        keyShiftWet.connect(insertSubgraph.input);
        insertSubgraph.output.connect(mono);
      } else {
        keyShiftDry.connect(mono);
        keyShiftWet.connect(mono);
      }
      mono.connect(analyser);
      analyser.connect(masterGain.current!);
      graphs.current[id] = {
        source, inputGain, gain, pan, mono, analyser, inserts: insertSubgraph, tail,
        keyShiftDry, keyShiftWet, keyShiftNode: null,
      };
    }
    return graphs.current[id];
  }, []);

  const liveLayers = useRef<LiveStemLayers | null>(null);
  if (!liveLayers.current) {
    liveLayers.current = new LiveStemLayers(
      () => {
        if (!context.current) throw new Error("Load a stem channel before swapping.");
        return context.current;
      },
      (id) => ensureGraph(id),
      undefined,
      (timing) => {
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("waveyard:live-stem-timing", { detail: timing }));
        }
      },
      liveStemWorkletUrl,
      assetPool,
    );
    if (pitchPreserving.current) {
      void liveLayers.current.setPitchPreserving(true).catch(() => undefined);
    }
  }
  liveLayers.current.setAssetPool(assetPool);
  const replaceStem = useCallback((id: string, url: string | null, tempoStretchRatio = 1, selectedAt?: number, beatOffsetSeconds = 0, keyShiftSemitones = 0) => {
    if (url) ensureGraph(id);
    return liveLayers.current!.replace(id, url, tempoStretchRatio, selectedAt, beatOffsetSeconds, keyShiftSemitones);
  }, [ensureGraph]);
  const preloadStem = useCallback((id: string, url: string, tempoStretchRatio = 1, selectedAt?: number) => {
    if (!ensureGraph(id)) throw new Error("A stem audio channel could not be prepared.");
    return liveLayers.current!.preload(url, tempoStretchRatio, selectedAt);
  }, [ensureGraph]);
  const preloadStemAsset = useCallback((url: string) => {
    return liveLayers.current!.preloadAsset(url);
  }, []);
  const setPlaybackRate = useCallback((value: number) => {
    const rate = normalizeSessionPlaybackRate(value);
    playbackRate.current = rate;
    for (const element of Object.values(media.current)) {
      if (element) applyMediaPlaybackRate(element, rate, pitchPreserving.current);
    }
    liveLayers.current?.setPlaybackRate(rate);
  }, []);
  const setPitchPreserving = useCallback(async (enabled: boolean) => {
    if (enabled === pitchPreserving.current) return;
    const elements = Object.values(media.current).filter((element): element is HTMLAudioElement => element !== null);
    if (enabled) {
      if (!supportsSessionPitchModes()) {
        throw new Error("Pitch lock requires native media pitch control and AudioWorklet support.");
      }
      const changed: HTMLAudioElement[] = [];
      try {
        for (const element of elements) {
          applyMediaPlaybackRate(element, playbackRate.current, true);
          changed.push(element);
        }
        await liveLayers.current?.setPitchPreserving(true);
      } catch (error) {
        for (const element of changed) applyMediaPlaybackRate(element, playbackRate.current, false);
        throw error;
      }
      pitchPreserving.current = true;
      return;
    }
    await liveLayers.current?.setPitchPreserving(false);
    pitchPreserving.current = false;
    for (const element of elements) {
      applyMediaPlaybackRate(element, playbackRate.current, false);
    }
  }, []);
  const setKeyShiftSemitones = useCallback(async (value: number) => {
    if (!Number.isInteger(value) || value < -11 || value > 11) {
      throw new Error("Live key shift must be an integer from -11 to +11 semitones.");
    }
    const request = ++keyShiftRequest.current;
    const audioContext = context.current;
    if (!audioContext) {
      keyShiftSemitones.current = value;
      return;
    }
    const graphsToUpdate = Object.values(graphs.current);
    if (value === 0) {
      keyShiftSemitones.current = 0;
      const now = audioContext.currentTime;
      for (const graph of graphsToUpdate) {
        graph.keyShiftDry.gain.cancelScheduledValues(now);
        graph.keyShiftWet.gain.cancelScheduledValues(now);
        graph.keyShiftDry.gain.setValueAtTime(graph.keyShiftDry.gain.value, now);
        graph.keyShiftWet.gain.setValueAtTime(graph.keyShiftWet.gain.value, now);
        graph.keyShiftDry.gain.linearRampToValueAtTime(1, now + 0.04);
        graph.keyShiftWet.gain.linearRampToValueAtTime(0, now + 0.04);
      }
      window.setTimeout(() => {
        if (
          keyShiftRequest.current !== request
          || keyShiftSemitones.current !== 0
          || context.current !== audioContext
        ) return;
        for (const graph of graphsToUpdate) {
          if (!graph.keyShiftNode || !Object.values(graphs.current).includes(graph)) continue;
          graph.tail.disconnect(graph.keyShiftNode);
          graph.keyShiftNode.port.postMessage({ type: "dispose" });
          graph.keyShiftNode.port.close();
          graph.keyShiftNode.disconnect();
          graph.keyShiftNode = null;
        }
      }, 80);
      return;
    }

    if (!audioContext.audioWorklet || typeof AudioWorkletNode === "undefined" || !liveStemWorkletUrl) {
      throw new Error("Live key matching needs AudioWorklet support in a secure browser context.");
    }
    await ensureLiveStemWorklet(audioContext, liveStemWorkletUrl);
    if (keyShiftRequest.current !== request || context.current !== audioContext) return;

    const pendingNodes: Array<{ graph: AudioGraph; node: AudioWorkletNode }> = [];
    try {
      for (const graph of graphsToUpdate) {
        if (graph.keyShiftNode) continue;
        const node = new AudioWorkletNode(audioContext, "waveyard-key-shift", {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          channelCount: 2,
          channelCountMode: "explicit",
          outputChannelCount: [2],
        });
        try {
          await new Promise<void>((resolve, reject) => {
            const timeout = window.setTimeout(() => finish(new Error("Live key matching did not start in time.")), 5_000);
            const finish = (error?: Error) => {
              window.clearTimeout(timeout);
              node.port.onmessage = null;
              if (error) reject(error);
              else resolve();
            };
            node.port.onmessage = (event: MessageEvent<{ type?: string; message?: string }>) => {
              if (event.data.type === "key-ready") finish();
              else if (event.data.type === "error") finish(new Error(event.data.message ?? "Live key matching failed."));
            };
          });
          pendingNodes.push({ graph, node });
        } catch (error) {
          node.port.postMessage({ type: "dispose" });
          node.port.close();
          node.disconnect();
          throw error;
        }
      }
    } catch (error) {
      for (const { node } of pendingNodes) {
        node.port.postMessage({ type: "dispose" });
        node.port.close();
        node.disconnect();
      }
      throw error;
    }
    if (keyShiftRequest.current !== request || context.current !== audioContext) {
      for (const { node } of pendingNodes) {
        node.port.postMessage({ type: "dispose" });
        node.port.close();
        node.disconnect();
      }
      return;
    }

    for (const { graph, node } of pendingNodes) {
      graph.tail.connect(node);
      node.connect(graph.keyShiftWet);
      graph.keyShiftNode = node;
    }
    for (const graph of graphsToUpdate) {
      graph.keyShiftNode?.port.postMessage({ type: "key-shift", semitones: value });
    }
    keyShiftSemitones.current = value;
    const now = audioContext.currentTime;
    for (const graph of graphsToUpdate) {
      graph.keyShiftDry.gain.cancelScheduledValues(now);
      graph.keyShiftWet.gain.cancelScheduledValues(now);
      graph.keyShiftDry.gain.setValueAtTime(graph.keyShiftDry.gain.value, now);
      graph.keyShiftWet.gain.setValueAtTime(graph.keyShiftWet.gain.value, now);
      graph.keyShiftDry.gain.linearRampToValueAtTime(0, now + 0.04);
      graph.keyShiftWet.gain.linearRampToValueAtTime(1, now + 0.04);
    }
  }, []);
  const cancelPendingStem = useCallback((id: string) => liveLayers.current!.cancelPending(id), []);
  const prepareChannels = useCallback((channelIds: string[]) => {
    for (const id of channelIds) {
      if (!ensureGraph(id)) throw new Error("A stem audio channel could not be prepared.");
    }
  }, [ensureGraph]);
  const playChannels = useCallback(async (channelIds: string[], at: number) => {
    prepareChannels(channelIds);
    await Promise.all(channelIds.map(async (id) => {
      const element = media.current[id];
      if (!element) throw new Error("A prepared stem audio element is no longer available.");
      applyMediaPlaybackRate(element, playbackRate.current, pitchPreserving.current);
      element.currentTime = Math.max(0, Math.min(at, Number.isFinite(element.duration) ? element.duration - 0.01 : at));
      await element.play();
    }));
  }, [prepareChannels]);

  const register = useCallback(
    (id: string, element: HTMLAudioElement | null) => {
      const graph = graphs.current[id];
      if (element && graph && graph.source.mediaElement !== element) {
        // Returning to a track creates new media elements. A source node
        // belongs to its original element, not merely to its asset id.
        liveLayers.current?.remove(id);
        disconnectGraph(graph);
        delete graphs.current[id];
      }
      media.current[id] = element;
      if (element) applyMediaPlaybackRate(element, playbackRate.current, pitchPreserving.current);
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
      positionRef.current = next;
      for (const id of ids) {
        const element = media.current[id];
        if (element && Math.abs(element.currentTime - next) > 0.015)
          element.currentTime = next;
      }
      setPosition(next);
      liveLayers.current?.sync(ids);
    },
    [duration, ids],
  );

  const currentPosition = useCallback(() => {
    const anchor = playbackIds
      .map((id) => media.current[id])
      .find((element) => element && !element.paused)
      ?? media.current[playbackIds[0]];
    const current = anchor?.currentTime;
    if (typeof current === "number" && Number.isFinite(current)) {
      positionRef.current = current;
      return current;
    }
    return positionRef.current;
  }, [playbackIds]);

  /** Apply insert chains (live): rebuilds the subgraph of every playing graph. */
  const applyInserts = useCallback(
    (chains: Record<string, InsertChain>, master: InsertChain) => {
      insertChains.current = chains;
      masterChain.current = master;
      for (const [id, graph] of Object.entries(graphs.current)) {
        const chain = chains[id];
        if (graph.inserts !== null) {
          try { graph.inserts.input.disconnect(); graph.inserts.output.disconnect(); } catch {}
          graph.inserts = null;
          try {
            graph.keyShiftDry.disconnect();
            graph.keyShiftWet.disconnect();
            graph.keyShiftDry.connect(graph.mono);
            graph.keyShiftWet.connect(graph.mono);
          } catch {}
        }
        if (chain !== undefined && chain.length > 0) {
          const sub = buildChainSubgraph(context.current!, chain);
          try {
            graph.keyShiftDry.disconnect();
            graph.keyShiftWet.disconnect();
          } catch {}
          graph.keyShiftDry.connect(sub.input);
          graph.keyShiftWet.connect(sub.input);
          sub.output.connect(graph.mono);
          graph.inserts = sub;
        }
      }
      // Master chain sits between masterGain and its analyser/splitter/destination.
      if (context.current && masterGain.current && masterAnalyser.current) {
        try { masterGain.current.disconnect(); } catch {}
        if (masterInsertsSubgraph.current) {
          try { masterInsertsSubgraph.current.input.disconnect(); } catch {}
          try { masterInsertsSubgraph.current.output.disconnect(); } catch {}
          masterInsertsSubgraph.current = null;
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
        head.connect(sessionOutput.current?.input ?? context.current.destination);
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
      const { controls, anySolo } = resolveActiveMixerState(ids, values);
      mixValues.current = controls;
      for (const id of ids) {
        const graph = graphs.current[id];
        const control = controls[id];
        if (!graph) continue;
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
    playRequest.current += 1;
    wantsPlayback.current = false;
    for (const element of Object.values(media.current)) element?.pause();
    liveLayers.current?.pause();
    stopClock();
    setPlaying(false);
  }, [stopClock]);

  useEffect(() => {
    const previous = previousIds.current;
    const replacedDeck =
      previous.length > 0 && !previous.some((id) => ids.includes(id));
    previousIds.current = ids;
    if (replacedDeck) {
      pause();
      positionRef.current = 0;
      setPosition(0);
    }
    for (const [id, graph] of Object.entries(graphs.current)) {
      if (ids.includes(id)) continue;
      liveLayers.current?.remove(id);
      disconnectGraph(graph);
      delete graphs.current[id];
      delete media.current[id];
    }
  }, [ids, pause]);
  const stop = useCallback(() => {
    pause();
    seek(0);
  }, [pause, seek]);

  const play = useCallback(async () => {
    const request = ++playRequest.current;
    wantsPlayback.current = true;
    try {
      setError(null);
      if (playbackIds.length === 0) {
        throw new Error("No audio is ready. Import audio or wait for processing to finish.");
      }
      const elements = playbackIds.map((id) => {
        const element = media.current[id];
        if (!element) throw new Error(`Stem ${id} is not loaded. Reopen this track and retry.`);
        if (element.error) throw new Error(`Stem ${id} could not be loaded. Check its source file and retry.`);
        applyMediaPlaybackRate(element, playbackRate.current, pitchPreserving.current);
        return element;
      });
      for (const id of playbackIds) ensureGraph(id);
      if (masterGain.current) masterGain.current.gain.value = masterVolumeRef.current;
      applyMix(mixValues.current);
      // Saved insert intent may have been restored before any audio graph
      // existed. Build it now, inside the first user-initiated play action.
      applyInserts(insertChains.current, masterChain.current);
      if (context.current && context.current.state !== "running") {
        // Never await this unbounded. A browser with no usable audio output
        // leaves a suspended AudioContext's resume() promise pending forever:
        // it does not resolve and does not reject. Awaiting that parked Play
        // permanently -- no playback, no error, and the Playing control simply
        // never engaged, which is indistinguishable from a dead button.
        // Confirmed in the Firefox CI leg: resume() on the app's own context and
        // on a brand-new AudioContext both stayed pending past 3 s while
        // AudioWorklet module loading on that same context completed in 35 ms.
        const resuming = context.current;
        await resumeWithin(resuming, RESUME_TIMEOUT_MS);
        // Typed as a string on purpose: TypeScript narrowed the ref to
        // non-"running" above and cannot know resume() changes it.
        const stateAfterResume: string = resuming.state;
        if (stateAfterResume !== "running")
          throw new Error(
            "Audio playback was interrupted. Activate Play stems to resume. "
            + "If this persists, check that this device has a working audio output.",
          );
      }
      if (keyShiftSemitones.current !== 0) {
        await setKeyShiftSemitones(keyShiftSemitones.current);
      }
      // Resume inside the user's activation before waiting on module I/O
      // (important on mobile). There is no destination bypass while loading.
      await sessionOutput.current?.ready;
      if (request !== playRequest.current) {
        if (!wantsPlayback.current) elements.forEach((element) => element.pause());
        return;
      }
      if (playbackIds.some((id) => !currentPlaybackIds.current.includes(id))) {
        elements.forEach((element) => element.pause());
        return;
      }
      const start = duration > 0 && positionRef.current >= duration - 0.01 ? 0 : positionRef.current;
      positionRef.current = start;
      setPosition(start);
      for (const element of elements) element.currentTime = start;
      // Wait for every media promise. Promise.all can reject early while other
      // stems are still pending and may start after a pause/error cleanup.
      const results = await Promise.allSettled(elements.map((element) => element.play()));
      if (request !== playRequest.current) {
        if (!wantsPlayback.current) elements.forEach((element) => element.pause());
        return;
      }
      if (playbackIds.some((id) => !currentPlaybackIds.current.includes(id))) {
        elements.forEach((element) => element.pause());
        return;
      }
      if (results.some((result) => result.status === "rejected")) {
        const blocked = results.find(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected" &&
            typeof result.reason === "object" &&
            result.reason !== null &&
            "name" in result.reason &&
            result.reason.name === "NotAllowedError",
        );
        if (blocked) throw new Error("Audio playback was interrupted. Activate Play stems to resume.");
        throw new Error("One or more stems could not play. Check the audio files and retry.");
      }
      liveLayers.current?.sync(playbackIds);
      setPlaying(true);
    } catch (cause) {
      if (request !== playRequest.current) return;
      const blocked = typeof cause === "object" && cause !== null && "name" in cause && cause.name === "NotAllowedError";
      setError(
        blocked
          ? "Audio playback was interrupted. Activate Play stems to resume."
          : cause instanceof Error ? cause.message : "Audio playback failed. Activate Play stems to retry.",
      );
      pause();
    }
  }, [applyInserts, applyMix, ensureGraph, playbackIds, masterVolume, pause, duration, setKeyShiftSemitones]);

  useEffect(() => {
    const recover = () => {
      if (document.visibilityState !== "visible") {
        wasBackgrounded.current = true;
        return;
      }
      const returnedFromBackground = wasBackgrounded.current;
      wasBackgrounded.current = false;
      if (!wantsPlayback.current || recoveryInFlight.current) return;
      const elements = currentPlaybackIds.current.map((id) => media.current[id]);
      const interrupted = context.current?.state !== "running";
      const needsRecovery =
        returnedFromBackground ||
        interrupted ||
        elements.some((element) => !element || element.paused);
      if (!needsRecovery) return;
      const current = currentPosition();
      positionRef.current = current;
      setPosition(current);
      if (interrupted) {
        elements.forEach((element) => element?.pause());
        setPlaying(false);
      }
      recoveryInFlight.current = true;
      void play().finally(() => { recoveryInFlight.current = false; });
    };
    recoverAudioContext.current = recover;
    document.addEventListener("visibilitychange", recover);
    window.addEventListener("pageshow", recover);
    window.addEventListener("focus", recover);
    const mediaDevices = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
    mediaDevices?.addEventListener("devicechange", recover);
    return () => {
      document.removeEventListener("visibilitychange", recover);
      window.removeEventListener("pageshow", recover);
      window.removeEventListener("focus", recover);
      mediaDevices?.removeEventListener("devicechange", recover);
      recoverAudioContext.current = () => undefined;
    };
  }, [currentPosition, play]);

  useEffect(() => {
    if (!playing) return;
    const tick = (now: number) => {
      // A handoff can replace the active channel set while the previous
      // animation frame is already queued. Do not validate removed elements
      // against that stale closure during the commit before effect cleanup.
      if (playbackIds !== currentPlaybackIds.current) return;
      if (playbackIds.some((id) => !media.current[id] || media.current[id]?.error)) {
        setError("A required stem became unavailable during playback. Reopen the track and retry.");
        pause();
        return;
      }
      const anchor =
        playbackIds
          .map((id) => media.current[id])
          .find((element) => element && !element.paused) ??
        media.current[playbackIds[0]];
      if (!anchor) {
        pause();
        return;
      }
      let current = anchor.currentTime;
      positionRef.current = current;
      if (loop.enabled && loop.end > loop.start && current >= loop.end) {
        seek(loop.start);
        current = loop.start;
        if (playbackIds.some((id) => media.current[id]?.paused)) void play();
      } else if (playbackIds.every((id) => media.current[id]?.ended)) {
        positionRef.current = current;
        setPosition(current);
        pause();
        return;
      }
      for (const id of playbackIds) {
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
  }, [playbackIds, loop, pause, play, playing, seek, stopClock]);

  useEffect(
    () => () => {
      // Track changes replace ids/pause callbacks, but must NOT close this
      // physical deck's AudioContext. Close only when the deck unmounts.
      playRequest.current += 1;
      wantsPlayback.current = false;
      for (const element of Object.values(media.current)) element?.pause();
      liveLayers.current?.dispose();
      stopClock();
      if (contextStateHandler.current)
        context.current?.removeEventListener("statechange", contextStateHandler.current);
      for (const graph of Object.values(graphs.current)) disconnectGraph(graph);
      masterGain.current?.disconnect();
      masterAnalyser.current?.disconnect();
      masterInsertsSubgraph.current?.output.disconnect();
      if (sessionOutput.current) sessionOutput.current.release();
      else context.current?.close().catch(() => undefined);
      sessionOutput.current = null;
      context.current = null;
      graphs.current = {};
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
    if (sessionOutput.current) return sessionOutput.current.stream();
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
    replaceStem,
    preloadStem,
    preloadStemAsset,
    cancelPendingStem,
    prepareChannels,
    playChannels,
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
    currentPosition,
    duration,
    masterVolume,
    setMasterVolume,
    applyMasterVolumeRealtime,
    setPlaybackRate,
    setPitchPreserving,
    setKeyShiftSemitones,
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
