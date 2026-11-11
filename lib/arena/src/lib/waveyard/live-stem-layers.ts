import type { SessionAudioAssetPool } from "./session-audio-asset-pool";

export const LIVE_STEM_SWITCH_TIMEOUT_MS = 15_000;
export const LIVE_STEM_MIN_DONOR_RMS_DBFS = -55;
export const SESSION_PLAYBACK_RATE_MIN = 0.8;
export const SESSION_PLAYBACK_RATE_MAX = 1.2;

function measureAudioBufferRmsDbfs(buffer: {
  numberOfChannels: number;
  getChannelData?: (channel: number) => Float32Array;
}): number | null {
  if (!Number.isInteger(buffer.numberOfChannels) || buffer.numberOfChannels < 1) return null;
  if (typeof buffer.getChannelData !== "function") return null;
  const maximumSamplesPerChannel = 48_000;
  let sumSquares = 0;
  let sampleCount = 0;
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const samples = buffer.getChannelData(channel);
    const stride = Math.max(1, Math.floor(samples.length / maximumSamplesPerChannel));
    for (let index = 0; index < samples.length; index += stride) {
      const sample = samples[index]!;
      if (!Number.isFinite(sample)) return null;
      sumSquares += sample * sample;
      sampleCount += 1;
    }
  }
  if (sampleCount === 0) return Number.NEGATIVE_INFINITY;
  const rms = Math.sqrt(sumSquares / sampleCount);
  return rms > 0 ? 20 * Math.log10(rms) : Number.NEGATIVE_INFINITY;
}
export const LIVE_STEM_PITCH_LOCK_SESSION_BUDGET_BYTES = 512 * 1024 * 1024;

const MEBIBYTE = 1024 * 1024;

export function estimateLiveStemPitchLockMemory(pcmBytes: number[]) {
  const retainedBytes = pcmBytes.reduce((total, bytes) => total + Math.max(0, bytes), 0);
  const migrationCopyBytes = Math.max(0, ...pcmBytes);
  return {
    retainedBytes,
    // Budget both the active transfer copy and one decoded donor whose backing
    // store has not been reclaimed yet by the browser.
    peakBytes: retainedBytes + migrationCopyBytes * 2,
  };
}

function audioBufferPcmBytes(buffer: AudioBuffer) {
  return buffer.length * buffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT;
}

export function normalizeSessionPlaybackRate(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(SESSION_PLAYBACK_RATE_MAX, Math.max(SESSION_PLAYBACK_RATE_MIN, value));
}

export function copyPcmChannelsForWorklet(
  buffer: Pick<AudioBuffer, "numberOfChannels" | "getChannelData">,
) {
  const left = Float32Array.from(buffer.getChannelData(0));
  return buffer.numberOfChannels > 1
    ? [left, Float32Array.from(buffer.getChannelData(1))]
    : [left];
}

export class LiveStemSwitchTimeoutError extends Error {
  constructor() {
    super("The stem switch timed out after 15 seconds. The previous audio continues; try again.");
    this.name = "LiveStemSwitchTimeoutError";
  }
}

export class LiveStemPitchMemoryBudgetError extends Error {
  constructor(estimatedBytes: number) {
    super(
      `Pitch lock needs about ${(estimatedBytes / MEBIBYTE).toFixed(1)} MiB for this mix, above the ${LIVE_STEM_PITCH_LOCK_SESSION_BUDGET_BYTES / MEBIBYTE} MiB session limit. The current mix is unchanged; shorten or remove donor stems, then try again.`,
    );
    this.name = "LiveStemPitchMemoryBudgetError";
  }
}

type Channel = {
  source: MediaElementAudioSourceNode;
  inputGain: GainNode;
  gain: GainNode;
};
type Layer = {
  url: string;
  tempoStretchRatio: number;
  beatOffsetSeconds: number;
  keyShiftSemitones: number;
  keyShiftNode: AudioWorkletNode | null;
  buffer: AudioBuffer | null;
  pcmBytes: number;
  duration: number;
  sampleRate: number;
  input: GainNode;
  source: AudioBufferSourceNode | AudioWorkletNode | null;
  sourceMode: "buffer" | "worklet" | null;
  timing: PreparedAudio | null;
};

type PreparedAudio = {
  buffer: AudioBuffer;
  selectedAt: number;
  downloadMs: number;
  decodeMs: number;
  tempoMatchMs: number;
  transferBytes: number;
};

export type LiveStemTiming = {
  recipientStemId: string;
  selectedAt: number;
  audibleAtSeconds: number;
  selectionToAudibleMs: number;
  downloadMs: number;
  decodeMs: number;
  tempoMatchMs: number;
  tempoStretchRatio: number;
  transferBytes: number;
};

type PreparedStem = {
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
  promise: Promise<PreparedAudio>;
};

type RecentStem = {
  buffer: AudioBuffer;
  bytes: number;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
};

type PrefetchedAsset = {
  controller: AbortController;
  promise: Promise<ArrayBuffer>;
  timer: ReturnType<typeof setTimeout>;
  byteLength: number;
};

type InFlightAsset = {
  controller: AbortController;
  promise: Promise<ArrayBuffer>;
  consumers: number;
  shared: boolean;
  settled: boolean;
};

type PendingSwap = {
  controller: AbortController;
  key: string;
  promise: Promise<void | false>;
};

type BufferStretcher = (
  context: AudioContext,
  buffer: AudioBuffer,
  ratio: number,
  signal: AbortSignal,
) => Promise<AudioBuffer>;

const PREPARED_STEM_TTL_MS = 30_000;
const MAX_PREPARED_STEMS = 2;
const RECENT_STEM_TTL_MS = 30_000;
const MAX_RECENT_STEMS = 2;
const MAX_RECENT_STEM_BYTES = 64 * 1024 * 1024;
const PREFETCHED_ASSET_TTL_MS = 30_000;
const MAX_PREFETCHED_ASSETS = 2;
const MAX_PREFETCHED_ASSET_BYTES = 8 * 1024 * 1024;
const WORKLET_READY_TIMEOUT_MS = 5_000;
const workletModules = new WeakMap<AudioContext, Promise<void>>();
const pitchLockBudgetOwners = new WeakMap<AudioContext, Set<LiveStemLayers>>();

export function ensureLiveStemWorklet(context: AudioContext, workletUrl: string) {
  if (!context.audioWorklet || typeof AudioWorkletNode === "undefined") {
    return Promise.reject(new Error("Pitch lock is unavailable in this browser."));
  }
  if (!workletUrl) {
    return Promise.reject(new Error("Pitch lock is unavailable in this playback surface."));
  }
  let loading = workletModules.get(context);
  if (!loading) {
    loading = context.audioWorklet.addModule(workletUrl).catch((error) => {
      workletModules.delete(context);
      throw error;
    });
    workletModules.set(context, loading);
  }
  return loading;
}

const stretchBufferInWorker: BufferStretcher = (context, buffer, ratio, signal) => {
  if (typeof Worker === "undefined") {
    return Promise.reject(new Error("This browser cannot prepare a tempo-matched live stem."));
  }
  const worker = new Worker(new URL("./live-stem-tempo.worker.ts", import.meta.url), { type: "module" });
  return new Promise<AudioBuffer>((resolve, reject) => {
    const cleanup = () => {
      signal.removeEventListener("abort", abort);
      worker.terminate();
    };
    const abort = () => {
      cleanup();
      reject(new DOMException("Live stem preparation was cancelled.", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    worker.onerror = (event) => {
      cleanup();
      reject(new Error(event.message || "Live tempo matching failed."));
    };
    worker.onmessage = (event: MessageEvent<{ left?: ArrayBuffer; right?: ArrayBuffer; error?: string }>) => {
      cleanup();
      if (event.data.error) {
        reject(new Error(event.data.error));
        return;
      }
      if (!event.data.left || !event.data.right) {
        reject(new Error("Live tempo matching returned incomplete audio."));
        return;
      }
      const left = new Float32Array(event.data.left);
      const right = new Float32Array(event.data.right);
      if (left.length === 0 || left.length !== right.length) {
        reject(new Error("Live tempo matching returned invalid audio."));
        return;
      }
      const stretched = context.createBuffer(2, left.length, buffer.sampleRate);
      stretched.getChannelData(0).set(left);
      stretched.getChannelData(1).set(right);
      resolve(stretched);
    };
    try {
      const left = Float32Array.from(buffer.getChannelData(0));
      const right = buffer.numberOfChannels > 1
        ? Float32Array.from(buffer.getChannelData(1))
        : Float32Array.from(left);
      worker.postMessage(
        { left: left.buffer, right: right.buffer, ratio, sampleRate: buffer.sampleRate },
        [left.buffer, right.buffer],
      );
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
};

/**
 * Donor audio never replaces the transport's media element. The original
 * element remains the deck clock, silently, even if every layer is swapped.
 */
export class LiveStemLayers {
  private layers = new Map<string, Layer>();
  private pending = new Map<string, PendingSwap>();
  private prepared = new Map<string, PreparedStem>();
  private recent = new Map<string, RecentStem>();
  private recentBytes = 0;
  private prefetchedAssets = new Map<string, PrefetchedAsset>();
  private prefetchedAssetBytes = 0;
  private inFlightAssets = new Map<string, InFlightAsset>();
  private retired = new Set<Layer>();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private pendingEngineCleanups = new Set<() => void>();
  private playbackRate = 1;
  private pitchPreserving = false;
  private disposed = false;
  private pitchBudgetContext: AudioContext | null = null;

  constructor(
    private context: () => AudioContext,
    private channel: (id: string) => Channel | null,
    private stretchBuffer: BufferStretcher = stretchBufferInWorker,
    private onTiming?: (timing: LiveStemTiming) => void,
    private workletUrl = "",
    private assetPool?: SessionAudioAssetPool,
  ) {}

  setAssetPool(assetPool?: SessionAudioAssetPool) {
    this.assetPool = assetPool;
  }

  setPlaybackRate(value: number) {
    if (this.disposed) return;
    this.playbackRate = normalizeSessionPlaybackRate(value);
    const layers = [...this.layers.values(), ...this.retired];
    if (!layers.some((layer) => layer.source !== null)) return;
    const now = this.context().currentTime;
    for (const layer of layers) {
      if (layer.sourceMode === "buffer" && layer.source) {
        (layer.source as AudioBufferSourceNode).playbackRate.setValueAtTime(this.playbackRate, now);
      } else if (layer.sourceMode === "worklet" && layer.source) {
        (layer.source as AudioWorkletNode).port.postMessage({ type: "rate", value: this.playbackRate });
      }
    }
  }

  async setPitchPreserving(enabled: boolean) {
    if (this.disposed) return;
    if (this.pitchPreserving === enabled) return;
    if (!enabled) {
      this.pitchPreserving = false;
      for (const layer of this.layers.values()) {
        if (layer.sourceMode === "worklet" && layer.source) {
          (layer.source as AudioWorkletNode).port.postMessage({ type: "pitch", enabled: false });
        }
      }
      return;
    }

    if (this.layers.size === 0) {
      this.pitchPreserving = true;
      return;
    }
    this.assertPitchLockMemoryBudget();
    const context = this.context();
    await ensureLiveStemWorklet(context, this.workletUrl);
    if (this.disposed) return;
    this.assertPitchLockMemoryBudget();
    const migrated: Array<{ layer: Layer; source: AudioWorkletNode }> = [];
    for (const [id, layer] of this.layers) {
      if (layer.sourceMode === "worklet" && layer.source) {
        migrated.push({ layer, source: layer.source as AudioWorkletNode });
        continue;
      }
      const channel = this.channel(id);
      if (!channel || !layer.buffer) continue;
      try {
        this.assertPitchLockMemoryBudget();
      } catch (error) {
        for (const item of migrated) item.source.port.postMessage({ type: "pitch", enabled: false });
        throw error;
      }
      const media = channel.source.mediaElement;
      const offset = layer.duration > 0
        ? this.alignedOffset(layer, media.currentTime) * layer.sampleRate
        : 0;
      const nextInput = context.createGain();
      nextInput.gain.value = 0;
      nextInput.connect(layer.keyShiftNode ?? channel.gain);
      let nextSource: AudioWorkletNode;
      try {
        nextSource = await this.createWorkletSource(
          layer.buffer,
          nextInput,
          offset,
          !media.paused && !media.ended,
          true,
        );
      } catch (error) {
        nextInput.disconnect();
        if (this.disposed) return;
        for (const item of migrated) item.source.port.postMessage({ type: "pitch", enabled: false });
        throw error;
      }
      if (this.disposed || this.layers.get(id) !== layer) {
        this.stopEngine(nextSource, "worklet");
        nextInput.disconnect();
        if (this.disposed) return;
        continue;
      }

      const currentOffset = layer.duration > 0 ? this.alignedOffset(layer, media.currentTime) : media.currentTime;
      nextSource.port.postMessage({ type: "rate", value: this.playbackRate });
      nextSource.port.postMessage({ type: "seek", frame: Math.floor(currentOffset * layer.sampleRate) });
      nextSource.port.postMessage({ type: media.paused || media.ended ? "pause" : "play" });
      const previousSource = layer.source;
      const previousMode = layer.sourceMode;
      const previousInput = layer.input;
      const now = context.currentTime;
      this.ramp(nextInput, 1);
      this.ramp(previousInput, 0);
      layer.input = nextInput;
      layer.source = nextSource;
      layer.sourceMode = "worklet";
      migrated.push({ layer, source: nextSource });
      let timer!: ReturnType<typeof setTimeout>;
      const cleanup = () => {
        this.stopEngine(previousSource, previousMode);
        previousInput.disconnect();
        this.pendingEngineCleanups.delete(cleanup);
        this.timers.delete(timer);
      };
      timer = setTimeout(cleanup, 80);
      this.timers.add(timer);
      this.pendingEngineCleanups.add(cleanup);
      // Let the first replacement become audible before transferring the next
      // donor, keeping the temporary PCM copy bounded to one stem at a time.
      await new Promise((resolve) => setTimeout(resolve, 45));
      if (this.disposed) return;
      if (!layer.buffer) continue;
      this.discardRecent(this.preparedKey(layer.url, layer.tempoStretchRatio));
      layer.buffer = null;
    }

    if (this.disposed) return;
    this.pitchPreserving = true;
    for (const item of migrated) item.source.port.postMessage({ type: "pitch", enabled: true });
  }

  private assertPitchLockMemoryBudget(additionalPcmBytes = 0) {
    const context = this.context();
    this.registerPitchBudgetOwner(context);
    const owners = pitchLockBudgetOwners.get(context) ?? new Set([this]);
    const retainedPcmBytes: number[] = [];
    const migrationPcmBytes: number[] = [];
    for (const owner of owners) {
      for (const layer of [...owner.layers.values(), ...owner.retired]) {
        retainedPcmBytes.push(owner.layerPcmBytes(layer));
      }
      if (owner === this) {
        migrationPcmBytes.push(...[...owner.layers.values()]
          .filter((layer) => layer.sourceMode !== "worklet" && layer.buffer)
          .map((layer) => owner.layerPcmBytes(layer)));
      }
    }
    if (additionalPcmBytes > 0) retainedPcmBytes.push(additionalPcmBytes);
    const retainedEstimate = estimateLiveStemPitchLockMemory(retainedPcmBytes);
    const peakBytes = retainedEstimate.retainedBytes
      + Math.max(additionalPcmBytes, 0, ...migrationPcmBytes) * 2;
    if (peakBytes > LIVE_STEM_PITCH_LOCK_SESSION_BUDGET_BYTES) {
      throw new LiveStemPitchMemoryBudgetError(peakBytes);
    }
  }

  private layerPcmBytes(layer: Layer) {
    return layer.pcmBytes || (layer.buffer ? audioBufferPcmBytes(layer.buffer) : 0);
  }

  private registerPitchBudgetOwner(context: AudioContext) {
    if (this.pitchBudgetContext === context) return;
    if (this.pitchBudgetContext) {
      pitchLockBudgetOwners.get(this.pitchBudgetContext)?.delete(this);
    }
    let owners = pitchLockBudgetOwners.get(context);
    if (!owners) {
      owners = new Set();
      pitchLockBudgetOwners.set(context, owners);
    }
    owners.add(this);
    this.pitchBudgetContext = context;
  }

  private unregisterPitchBudgetOwner() {
    if (!this.pitchBudgetContext) return;
    pitchLockBudgetOwners.get(this.pitchBudgetContext)?.delete(this);
    this.pitchBudgetContext = null;
  }

  private ramp(gain: GainNode, value: number) {
    const now = gain.context.currentTime;
    if (typeof gain.gain.cancelAndHoldAtTime === "function") {
      gain.gain.cancelAndHoldAtTime(now);
    } else {
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(gain.gain.value, now);
    }
    gain.gain.linearRampToValueAtTime(value, now + 0.04);
  }

  private stopEngine(
    source: AudioBufferSourceNode | AudioWorkletNode | null,
    mode: "buffer" | "worklet" | null,
  ) {
    if (!source) return;
    if (mode === "buffer") {
      try { (source as AudioBufferSourceNode).stop(); } catch { /* already stopped */ }
    } else if (mode === "worklet") {
      const worklet = source as AudioWorkletNode;
      worklet.port.postMessage({ type: "dispose" });
      worklet.port.close();
    }
    source.disconnect();
  }

  private stop(layer: Layer) {
    this.stopEngine(layer.source, layer.sourceMode);
    layer.source = null;
    layer.sourceMode = null;
  }

  private pauseLayer(layer: Layer) {
    if (!layer.source) return;
    if (layer.sourceMode === "worklet") {
      (layer.source as AudioWorkletNode).port.postMessage({ type: "pause" });
      return;
    }
    this.stop(layer);
  }

  private async createWorkletSource(
    buffer: AudioBuffer,
    destination: GainNode,
    startFrame: number,
    playing: boolean,
    pitchPreserving: boolean,
    additionalPcmBytes = 0,
  ) {
    const context = this.context();
    await ensureLiveStemWorklet(context, this.workletUrl);
    if (this.disposed) throw new DOMException("Live stem session was closed.", "AbortError");
    if (additionalPcmBytes > 0) this.assertPitchLockMemoryBudget(additionalPcmBytes);
    const node = new AudioWorkletNode(context, "waveyard-live-stem", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    try {
      node.connect(destination);
      const channels = copyPcmChannelsForWorklet(buffer);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error("Pitch lock did not start in time.")), WORKLET_READY_TIMEOUT_MS);
        const finish = (error?: Error) => {
          clearTimeout(timer);
          node.port.onmessage = null;
          if (error) reject(error);
          else resolve();
        };
        node.port.onmessage = (event: MessageEvent<{ type?: string; message?: string }>) => {
          if (event.data.type === "ready") finish();
          else if (event.data.type === "error") finish(new Error(event.data.message ?? "The live pitch processor failed."));
        };
        node.port.postMessage({
          type: "load",
          channels: channels.map((channel) => channel.buffer),
          startFrame,
          rate: this.playbackRate,
          pitchPreserving,
          playing,
        }, channels.map((channel) => channel.buffer));
      });
      return node;
    } catch (error) {
      node.port.postMessage({ type: "dispose" });
      node.port.close();
      node.disconnect();
      throw error;
    }
  }

  private disconnectLayer(layer: Layer) {
    layer.input.disconnect();
    if (layer.keyShiftNode) {
      layer.keyShiftNode.port.postMessage({ type: "dispose" });
      layer.keyShiftNode.port.close();
      layer.keyShiftNode.disconnect();
      layer.keyShiftNode = null;
    }
  }

  private async createKeyShiftNode(semitones: number, signal: AbortSignal) {
    const context = this.context();
    await ensureLiveStemWorklet(context, this.workletUrl);
    if (this.disposed || signal.aborted) throw new DOMException("Stem correction cancelled.", "AbortError");
    const node = new AudioWorkletNode(context, "waveyard-key-shift", {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
          node.port.onmessage = null;
          if (error) reject(error);
          else resolve();
        };
        const abort = () => finish(new DOMException("Stem correction cancelled.", "AbortError"));
        const timer = setTimeout(() => finish(new Error("The donor key processor did not become ready.")), WORKLET_READY_TIMEOUT_MS);
        signal.addEventListener("abort", abort, { once: true });
        node.port.onmessage = (event: MessageEvent<{ type?: string; message?: string }>) => {
          if (event.data.type === "key-ready") finish();
          else if (event.data.type === "error") finish(new Error(event.data.message ?? "Donor key matching failed."));
        };
      });
      node.port.postMessage({ type: "key-shift", semitones });
      return node;
    } catch (error) {
      node.port.postMessage({ type: "dispose" });
      node.port.close();
      node.disconnect();
      throw error;
    }
  }

  private retire(layer: Layer) {
    this.rememberRecent(layer);
    this.ramp(layer.input, 0);
    this.retired.add(layer);
    const timer = setTimeout(() => {
      this.stop(layer);
      this.disconnectLayer(layer);
      this.retired.delete(layer);
      this.timers.delete(timer);
    }, 80);
    this.timers.add(timer);
  }

  private alignedOffset(layer: Layer, position: number) {
    return ((position + layer.beatOffsetSeconds) % layer.duration + layer.duration) % layer.duration;
  }

  private async start(layer: Layer, channel: Channel) {
    if (this.disposed) return;
    if (layer.sourceMode === "worklet" && layer.source) {
      const media = channel.source.mediaElement;
      const worklet = layer.source as AudioWorkletNode;
      worklet.port.postMessage({ type: "rate", value: this.playbackRate });
      worklet.port.postMessage({
        type: "seek",
        frame: layer.duration > 0 ? this.alignedOffset(layer, media.currentTime) * layer.sampleRate : 0,
      });
      worklet.port.postMessage({ type: media.paused || media.ended ? "pause" : "play" });
      return;
    }
    this.stop(layer);
    const media = channel.source.mediaElement;
    if (media.paused || media.ended) return;
    if (!layer.buffer) throw new Error("The prepared live stem audio is no longer available.");
    if (this.pitchPreserving) {
      const pcmBytes = audioBufferPcmBytes(layer.buffer);
      const additionalPcmBytes = [...this.layers.values()].includes(layer) ? 0 : pcmBytes;
      this.assertPitchLockMemoryBudget(additionalPcmBytes);
      const offset = layer.duration > 0
        ? this.alignedOffset(layer, media.currentTime) * layer.sampleRate
        : 0;
      const source = await this.createWorkletSource(
        layer.buffer, layer.input, offset, true, true, additionalPcmBytes,
      );
      if (this.disposed) {
        this.stopEngine(source, "worklet");
        return;
      }
      layer.source = source;
      layer.sourceMode = "worklet";
      layer.pcmBytes = audioBufferPcmBytes(layer.buffer);
      this.discardRecent(this.preparedKey(layer.url, layer.tempoStretchRatio));
      layer.buffer = null;
      return;
    }
    const source = this.context().createBufferSource();
    source.buffer = layer.buffer;
    source.playbackRate.setValueAtTime(this.playbackRate, this.context().currentTime);
    // Short donors repeat without ending or resetting the recipient's clock.
    source.loop = true;
    source.connect(layer.input);
    source.start(0, this.alignedOffset(layer, media.currentTime));
    layer.source = source;
    layer.sourceMode = "buffer";
  }

  private reportAudible(recipientStemId: string, layer: Layer, audibleAtSeconds: number) {
    const timing = layer.timing;
    if (!timing) return;
    this.onTiming?.({
      recipientStemId,
      selectedAt: timing.selectedAt,
      audibleAtSeconds,
      selectionToAudibleMs: Math.max(0, performance.now() - timing.selectedAt),
      downloadMs: timing.downloadMs,
      decodeMs: timing.decodeMs,
      tempoMatchMs: timing.tempoMatchMs,
      tempoStretchRatio: layer.tempoStretchRatio,
      transferBytes: timing.transferBytes,
    });
    layer.timing = null;
  }

  private preparedKey(url: string, tempoStretchRatio: number) {
    return `${url}\u0000${tempoStretchRatio.toFixed(4)}`;
  }

  private discardRecent(key: string) {
    const recent = this.recent.get(key);
    if (!recent) return;
    clearTimeout(recent.timer);
    this.recent.delete(key);
    this.recentBytes -= recent.bytes;
  }

  private discardPrefetchedAsset(url: string, abort = false) {
    const asset = this.prefetchedAssets.get(url);
    if (!asset) return;
    this.prefetchedAssets.delete(url);
    clearTimeout(asset.timer);
    this.prefetchedAssetBytes -= asset.byteLength;
    if (abort) asset.controller.abort();
  }

  private async fetchAssetBytes(url: string, signal: AbortSignal) {
    if (signal.aborted) throw new DOMException("Stem preparation was cancelled.", "AbortError");

    let request = this.inFlightAssets.get(url);
    if (!request) {
      const controller = new AbortController();
      const entry: InFlightAsset = {
        controller,
        promise: Promise.resolve(new ArrayBuffer(0)),
        consumers: 0,
        shared: false,
        settled: false,
      };
      entry.promise = fetch(url, { signal: controller.signal })
        .then(async (response) => {
          if (!response.ok) throw new Error(`Stem download failed (${response.status}).`);
          const bytes = await response.arrayBuffer();
          if (controller.signal.aborted) {
            throw new DOMException("Stem preparation was cancelled.", "AbortError");
          }
          return bytes;
        })
        .finally(() => {
          entry.settled = true;
          if (this.inFlightAssets.get(url) === entry) this.inFlightAssets.delete(url);
        });
      this.inFlightAssets.set(url, entry);
      request = entry;
    }

    request.consumers += 1;
    if (request.consumers > 1) request.shared = true;
    let onAbort: (() => void) | undefined;
    try {
      const bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
        onAbort = () => reject(new DOMException("Stem preparation was cancelled.", "AbortError"));
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
        request!.promise.then(resolve, reject);
      });
      if (signal.aborted) throw new DOMException("Stem preparation was cancelled.", "AbortError");
      // decodeAudioData may detach its input. Coalesced consumers need private
      // copies so a decode cannot corrupt bytes retained by the prefetch cache.
      return request.shared ? bytes.slice(0) : bytes;
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
      request.consumers -= 1;
      if (request.consumers === 0 && !request.settled && this.inFlightAssets.get(url) === request) {
        request.controller.abort();
      }
    }
  }

  private async readAssetBytes(url: string, signal: AbortSignal) {
    if (this.assetPool) {
      try {
        return await this.assetPool.readBytes(url, signal);
      } catch (error) {
        const status = error instanceof Error
          ? /^Audio asset download failed \((\d+)\)\.$/.exec(error.message)?.[1]
          : undefined;
        if (status) throw new Error(`Stem download failed (${status}).`);
        throw error;
      }
    }
    const prefetched = this.prefetchedAssets.get(url);
    if (prefetched) {
      // Refresh LRU order but keep the original expiry; repeated reads must not
      // pin compressed audio in memory indefinitely.
      this.prefetchedAssets.delete(url);
      this.prefetchedAssets.set(url, prefetched);
      try {
        const bytes = await prefetched.promise;
        if (signal.aborted) throw new DOMException("Stem preparation was cancelled.", "AbortError");
        // decodeAudioData may detach the input, so cached bytes need a private copy.
        return bytes.slice(0);
      } catch (error) {
        if (signal.aborted) throw error;
      }
    }
    return this.fetchAssetBytes(url, signal);
  }

  /** Download compressed bytes only for a likely next donor. */
  preloadAsset(url: string) {
    if (this.disposed) return Promise.resolve();
    if (this.assetPool) return this.assetPool.preload(url);
    const existing = this.prefetchedAssets.get(url);
    if (existing) return existing.promise.then(() => undefined);

    while (this.prefetchedAssets.size >= MAX_PREFETCHED_ASSETS) {
      const oldestUrl = this.prefetchedAssets.keys().next().value as string | undefined;
      if (oldestUrl === undefined) break;
      this.discardPrefetchedAsset(oldestUrl, true);
    }

    const controller = new AbortController();
    let entry!: PrefetchedAsset;
    const timer = setTimeout(() => {
      if (this.prefetchedAssets.get(url) === entry) this.discardPrefetchedAsset(url, true);
    }, PREFETCHED_ASSET_TTL_MS);
    const promise = this.fetchAssetBytes(url, controller.signal).then((bytes) => {
      if (this.prefetchedAssets.get(url) !== entry) return bytes;
      if (bytes.byteLength > MAX_PREFETCHED_ASSET_BYTES) {
        this.discardPrefetchedAsset(url);
        return bytes;
      }
      while (this.prefetchedAssetBytes + bytes.byteLength > MAX_PREFETCHED_ASSET_BYTES) {
        const oldestUrl = [...this.prefetchedAssets.keys()].find((candidate) => candidate !== url);
        if (oldestUrl === undefined) break;
        this.discardPrefetchedAsset(oldestUrl, true);
      }
      entry.byteLength = bytes.byteLength;
      this.prefetchedAssetBytes += bytes.byteLength;
      return bytes;
    }).catch((error: unknown) => {
      if (this.prefetchedAssets.get(url) === entry) this.discardPrefetchedAsset(url);
      throw error;
    });
    entry = { controller, promise, timer, byteLength: 0 };
    this.prefetchedAssets.set(url, entry);
    return promise.then(() => undefined);
  }

  private rememberRecent(layer: Layer) {
    const key = this.preparedKey(layer.url, layer.tempoStretchRatio);
    this.discardRecent(key);
    if (!layer.buffer) return;
    const bytes = layer.buffer.length * layer.buffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT;
    // Keep oversized audio available to its live layer, but don't retain it
    // after that layer is replaced.
    if (bytes > MAX_RECENT_STEM_BYTES) return;
    while (
      this.recent.size >= MAX_RECENT_STEMS ||
      this.recentBytes + bytes > MAX_RECENT_STEM_BYTES
    ) {
      const oldestKey = this.recent.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      this.discardRecent(oldestKey);
    }

    const entry: RecentStem = {
      buffer: layer.buffer,
      bytes,
      expiresAt: performance.now() + RECENT_STEM_TTL_MS,
      timer: setTimeout(() => {
        if (this.recent.get(key) === entry) this.discardRecent(key);
      }, RECENT_STEM_TTL_MS),
    };
    this.recent.set(key, entry);
    this.recentBytes += bytes;
  }

  private getRecentBuffer(key: string, selectedAt: number): PreparedAudio | null {
    const recent = this.recent.get(key);
    if (!recent) return null;
    if (recent.expiresAt <= performance.now()) {
      this.discardRecent(key);
      return null;
    }
    // A read makes the buffer recently used, but does not extend its fixed TTL.
    this.recent.delete(key);
    this.recent.set(key, recent);
    return {
      buffer: recent.buffer,
      selectedAt,
      downloadMs: 0,
      decodeMs: 0,
      tempoMatchMs: 0,
      transferBytes: 0,
    };
  }

  private discardPrepared(key: string, abort: boolean) {
    const prepared = this.prepared.get(key);
    if (!prepared) return;
    this.prepared.delete(key);
    clearTimeout(prepared.timer);
    if (abort) prepared.controller.abort();
  }

  private async prepareBuffer(
    url: string,
    tempoStretchRatio: number,
    signal: AbortSignal,
    selectedAt: number,
  ): Promise<PreparedAudio> {
    const downloadStartedAt = performance.now();
    const bytes = await this.readAssetBytes(url, signal);
    const downloadMs = performance.now() - downloadStartedAt;
    // decodeAudioData may detach its input buffer, so keep the transfer size
    // before handing the bytes to the browser decoder.
    const transferBytes = bytes.byteLength;
    if (signal.aborted) throw new DOMException("Stem preparation was cancelled.", "AbortError");
    const ctx = this.context();
    const decodeStartedAt = performance.now();
    let decoded: AudioBuffer;
    try {
      decoded = await ctx.decodeAudioData(bytes);
      if (!(decoded.duration > 0)) throw new Error("The donor stem has no playable audio.");
    } catch (error) {
      // A successful HTTP response may still contain corrupt audio. Do not pin
      // that response in the compressed cache for every subsequent retry.
      this.assetPool?.invalidateBytes(url, bytes);
      if (!this.assetPool) this.discardPrefetchedAsset(url);
      throw error;
    }
    const decodeMs = performance.now() - decodeStartedAt;
    if (signal.aborted) throw new DOMException("Stem preparation was cancelled.", "AbortError");
    const donorRmsDbfs = measureAudioBufferRmsDbfs(decoded);
    if (donorRmsDbfs !== null && donorRmsDbfs < LIVE_STEM_MIN_DONOR_RMS_DBFS) {
      const level = Number.isFinite(donorRmsDbfs) ? `${donorRmsDbfs.toFixed(1)} dBFS` : "silence";
      throw new Error(`The donor stem is nearly silent (${level}); its separation may have failed.`);
    }
    let buffer = decoded;
    let tempoMatchMs = 0;
    if (Math.abs(tempoStretchRatio - 1) >= 0.001) {
      const tempoMatchStartedAt = performance.now();
      buffer = await this.stretchBuffer(ctx, decoded, tempoStretchRatio, signal);
      tempoMatchMs = performance.now() - tempoMatchStartedAt;
    }
    if (signal.aborted) throw new DOMException("Stem preparation was cancelled.", "AbortError");
    if (!(buffer.duration > 0)) throw new Error("The donor stem has no playable audio.");
    return {
      buffer,
      selectedAt,
      downloadMs,
      decodeMs,
      tempoMatchMs,
      transferBytes,
    };
  }

  /**
   * Warm the selected donor while its session change is being saved. The
   * decoded (and, when needed, tempo-matched) buffer is short-lived and never
   * becomes audible until replace() installs it.
   */
  preload(url: string, tempoStretchRatio = 1, selectedAt = performance.now()): Promise<void> {
    if (!Number.isFinite(tempoStretchRatio) || tempoStretchRatio < 0.5 || tempoStretchRatio > 2) {
      return Promise.reject(new Error("The live stem tempo ratio must be between 0.5× and 2×."));
    }
    if (this.disposed) return Promise.resolve();
    const key = this.preparedKey(url, tempoStretchRatio);
    if (this.getRecentBuffer(key, selectedAt)) return Promise.resolve();
    const existing = this.prepared.get(key);
    if (existing) return existing.promise.then(() => undefined);

    while (this.prepared.size >= MAX_PREPARED_STEMS) {
      const oldestKey = this.prepared.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      this.discardPrepared(oldestKey, true);
    }

    const controller = new AbortController();
    let entry!: PreparedStem;
    const promise = this.prepareBuffer(url, tempoStretchRatio, controller.signal, selectedAt).catch((error: unknown) => {
      if (this.prepared.get(key) === entry) this.discardPrepared(key, false);
      throw error;
    });
    const timer = setTimeout(() => {
      if (this.prepared.get(key) === entry) this.discardPrepared(key, true);
    }, PREPARED_STEM_TTL_MS);
    entry = { controller, timer, promise };
    this.prepared.set(key, entry);
    return promise.then(() => undefined);
  }

  private async getPreparedBuffer(
    url: string,
    tempoStretchRatio: number,
    signal: AbortSignal,
    selectedAt: number,
  ) {
    const key = this.preparedKey(url, tempoStretchRatio);
    const prepared = this.prepared.get(key);
    if (!prepared) {
      return this.getRecentBuffer(key, selectedAt) ??
        this.prepareBuffer(url, tempoStretchRatio, signal, selectedAt);
    }

    // A live replacement now owns the warm operation. Cancelling that swap
    // also stops its download or tempo worker, rather than leaving work behind.
    this.discardPrepared(key, false);
    const abortPrepared = () => prepared.controller.abort();
    signal.addEventListener("abort", abortPrepared, { once: true });
    if (signal.aborted) abortPrepared();
    try {
      return { ...await prepared.promise, selectedAt };
    } finally {
      signal.removeEventListener("abort", abortPrepared);
    }
  }

  async replace(id: string, url: string | null, tempoStretchRatio = 1, selectedAt = performance.now(), beatOffsetSeconds = 0, keyShiftSemitones = 0) {
    if (!Number.isFinite(beatOffsetSeconds)) throw new Error("The donor beat offset must be finite.");
    if (!Number.isInteger(keyShiftSemitones) || Math.abs(keyShiftSemitones) > 11) throw new Error("The donor key correction must be an integer from -11 to +11.");
    if (url && (!Number.isFinite(tempoStretchRatio) || tempoStretchRatio < 0.5 || tempoStretchRatio > 2)) {
      throw new Error("The live stem tempo ratio must be between 0.5× and 2×.");
    }
    if (this.disposed) return false;
    const key = url ? `${this.preparedKey(url, tempoStretchRatio)}:${beatOffsetSeconds}:${keyShiftSemitones}` : "";
    const currentPending = this.pending.get(id);
    if (key && currentPending?.key === key) return currentPending.promise;
    currentPending?.controller.abort();
    this.pending.delete(id);
    const previous = this.layers.get(id);
    if (!url) {
      if (!previous) return;
      this.layers.delete(id);
      const channel = this.channel(id);
      if (channel) this.ramp(channel.inputGain, 1);
      this.retire(previous);
      return;
    }
    if (previous?.url === url && Math.abs(previous.tempoStretchRatio - tempoStretchRatio) < 0.001
      && previous.beatOffsetSeconds === beatOffsetSeconds && previous.keyShiftSemitones === keyShiftSemitones) return;
    const operation: PendingSwap = {
      controller: new AbortController(),
      key,
      promise: Promise.resolve(),
    };
    this.pending.set(id, operation);
    operation.promise = this.installReplacement(id, url, tempoStretchRatio, selectedAt, previous, operation, beatOffsetSeconds, keyShiftSemitones);
    return operation.promise;
  }

  /** Stop only the preparation, never the currently audible layer or its clock. */
  cancelPending(id: string) {
    this.pending.get(id)?.controller.abort();
    this.pending.delete(id);
  }

  private async installReplacement(
    id: string,
    url: string,
    tempoStretchRatio: number,
    selectedAt: number,
    previous: Layer | undefined,
    operation: PendingSwap,
    beatOffsetSeconds: number,
    keyShiftSemitones: number,
  ) {
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    let replacementInput: GainNode | null = null;
    let replacementKeyNode: AudioWorkletNode | null = null;
    try {
      const deadline = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new DOMException("Live stem preparation was cancelled.", "AbortError"));
        operation.controller.signal.addEventListener("abort", onAbort, { once: true });
        timer = setTimeout(() => {
          timedOut = true;
          operation.controller.abort();
          reject(new LiveStemSwitchTimeoutError());
        }, LIVE_STEM_SWITCH_TIMEOUT_MS);
      });
      const retainedBuffer = previous?.url === url
        && previous.tempoStretchRatio === tempoStretchRatio ? previous.buffer : null;
      const prepared = await Promise.race([
        retainedBuffer ? Promise.resolve({
          buffer: retainedBuffer, selectedAt, downloadMs: 0, decodeMs: 0,
          tempoMatchMs: 0, transferBytes: 0,
        }) : this.getPreparedBuffer(url, tempoStretchRatio, operation.controller.signal, selectedAt),
        deadline,
      ]);
      if (operation.controller.signal.aborted || this.pending.get(id) !== operation) return false;
      if (keyShiftSemitones !== 0) {
        replacementKeyNode = await this.createKeyShiftNode(keyShiftSemitones, operation.controller.signal);
      }
      if (operation.controller.signal.aborted || this.pending.get(id) !== operation || this.disposed) {
        throw new DOMException("Stem correction cancelled.", "AbortError");
      }
      const ctx = this.context();
      this.registerPitchBudgetOwner(ctx);
      const channel = this.channel(id);
      if (!channel) throw new Error("The receiving stem is no longer loaded.");
      const input = ctx.createGain();
      replacementInput = input;
      input.gain.value = 0;
      input.connect(replacementKeyNode ?? channel.gain);
      replacementKeyNode?.connect(channel.gain);
      const layer: Layer = {
        url,
        tempoStretchRatio,
        beatOffsetSeconds,
        keyShiftSemitones,
        keyShiftNode: replacementKeyNode,
        buffer: prepared.buffer,
        pcmBytes: audioBufferPcmBytes(prepared.buffer),
        duration: prepared.buffer.duration,
        sampleRate: prepared.buffer.sampleRate,
        input,
        source: null,
        sourceMode: null,
        timing: prepared,
      };
      await this.start(layer, channel);
      if (this.disposed || operation.controller.signal.aborted || this.pending.get(id) !== operation) {
        this.stop(layer);
        this.disconnectLayer(layer);
        replacementKeyNode = null;
        replacementInput = null;
        return false;
      }
      this.layers.set(id, layer);
      this.ramp(input, 1);
      this.ramp(channel.inputGain, 0);
      if (layer.source) this.reportAudible(id, layer, channel.source.mediaElement.currentTime);
      if (previous) this.retire(previous);
      replacementKeyNode = null; // The installed layer owns the processor.
      return undefined;
    } catch (error) {
      replacementInput?.disconnect();
      if (replacementKeyNode) {
        replacementKeyNode.port.postMessage({ type: "dispose" });
        replacementKeyNode.port.close();
        replacementKeyNode.disconnect();
      }
      if (timedOut) throw new LiveStemSwitchTimeoutError();
      if (!operation.controller.signal.aborted) throw error;
      return false;
    } finally {
      clearTimeout(timer);
      if (onAbort) operation.controller.signal.removeEventListener("abort", onAbort);
      if (this.pending.get(id) === operation) this.pending.delete(id);
    }
  }

  sync(ids: string[]) {
    if (this.disposed) return;
    for (const id of ids) {
      const layer = this.layers.get(id);
      const channel = layer && this.channel(id);
      if (layer && channel) {
        void this.start(layer, channel).then(() => {
          if (layer.source) this.reportAudible(id, layer, channel.source.mediaElement.currentTime);
        }).catch(() => undefined);
      }
    }
  }

  pause() {
    for (const layer of [...this.layers.values(), ...this.retired]) this.pauseLayer(layer);
  }

  remove(id: string) {
    this.pending.get(id)?.controller.abort();
    this.pending.delete(id);
    const layer = this.layers.get(id);
    if (layer) {
      this.stop(layer);
      this.disconnectLayer(layer);
      this.layers.delete(id);
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.pause();
    for (const id of new Set([...this.layers.keys(), ...this.pending.keys()])) this.remove(id);
    for (const key of this.prepared.keys()) this.discardPrepared(key, true);
    for (const key of this.recent.keys()) this.discardRecent(key);
    for (const key of this.prefetchedAssets.keys()) this.discardPrefetchedAsset(key, true);
    for (const request of this.inFlightAssets.values()) request.controller.abort();
    this.inFlightAssets.clear();
    for (const layer of this.retired) {
      this.stop(layer);
      this.disconnectLayer(layer);
    }
    this.retired.clear();
    for (const cleanup of this.pendingEngineCleanups) cleanup();
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.unregisterPitchBudgetOwner();
  }
}
