export const LIVE_STEM_SWITCH_TIMEOUT_MS = 15_000;
export const SESSION_PLAYBACK_RATE_MIN = 0.8;
export const SESSION_PLAYBACK_RATE_MAX = 1.2;

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

type Channel = {
  source: MediaElementAudioSourceNode;
  inputGain: GainNode;
  gain: GainNode;
};
type Layer = {
  url: string;
  tempoStretchRatio: number;
  buffer: AudioBuffer | null;
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

function ensureLiveStemWorklet(context: AudioContext, workletUrl: string) {
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
  private retired = new Set<Layer>();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private playbackRate = 1;
  private pitchPreserving = false;

  constructor(
    private context: () => AudioContext,
    private channel: (id: string) => Channel | null,
    private stretchBuffer: BufferStretcher = stretchBufferInWorker,
    private onTiming?: (timing: LiveStemTiming) => void,
    private workletUrl = "",
  ) {}

  setPlaybackRate(value: number) {
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
    const context = this.context();
    await ensureLiveStemWorklet(context, this.workletUrl);
    const migrated: Array<{ layer: Layer; source: AudioWorkletNode }> = [];
    for (const [id, layer] of this.layers) {
      if (layer.sourceMode === "worklet" && layer.source) {
        migrated.push({ layer, source: layer.source as AudioWorkletNode });
        continue;
      }
      const channel = this.channel(id);
      if (!channel || !layer.buffer) continue;
      const media = channel.source.mediaElement;
      const offset = layer.duration > 0
        ? (media.currentTime % layer.duration) * layer.sampleRate
        : 0;
      const nextInput = context.createGain();
      nextInput.gain.value = 0;
      nextInput.connect(channel.gain);
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
        for (const item of migrated) item.source.port.postMessage({ type: "pitch", enabled: false });
        throw error;
      }

      const currentOffset = layer.duration > 0 ? media.currentTime % layer.duration : media.currentTime;
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
      const timer = setTimeout(() => {
        this.stopEngine(previousSource, previousMode);
        previousInput.disconnect();
        this.timers.delete(timer);
      }, 80);
      this.timers.add(timer);
      // Let the first replacement become audible before transferring the next
      // donor, keeping the temporary PCM copy bounded to one stem at a time.
      await new Promise((resolve) => setTimeout(resolve, 45));
      if (!layer.buffer) continue;
      this.discardRecent(this.preparedKey(layer.url, layer.tempoStretchRatio));
      layer.buffer = null;
    }

    this.pitchPreserving = true;
    for (const item of migrated) item.source.port.postMessage({ type: "pitch", enabled: true });
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
  ) {
    const context = this.context();
    await ensureLiveStemWorklet(context, this.workletUrl);
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

  private retire(layer: Layer) {
    this.rememberRecent(layer);
    this.ramp(layer.input, 0);
    this.retired.add(layer);
    const timer = setTimeout(() => {
      this.stop(layer);
      layer.input.disconnect();
      this.retired.delete(layer);
      this.timers.delete(timer);
    }, 80);
    this.timers.add(timer);
  }

  private async start(layer: Layer, channel: Channel) {
    if (layer.sourceMode === "worklet" && layer.source) {
      const media = channel.source.mediaElement;
      const worklet = layer.source as AudioWorkletNode;
      worklet.port.postMessage({ type: "rate", value: this.playbackRate });
      worklet.port.postMessage({
        type: "seek",
        frame: layer.duration > 0 ? (media.currentTime % layer.duration) * layer.sampleRate : 0,
      });
      worklet.port.postMessage({ type: media.paused || media.ended ? "pause" : "play" });
      return;
    }
    this.stop(layer);
    const media = channel.source.mediaElement;
    if (media.paused || media.ended) return;
    if (!layer.buffer) throw new Error("The prepared live stem audio is no longer available.");
    if (this.pitchPreserving) {
      const offset = layer.duration > 0
        ? (media.currentTime % layer.duration) * layer.sampleRate
        : 0;
      const source = await this.createWorkletSource(layer.buffer, layer.input, offset, true, true);
      layer.source = source;
      layer.sourceMode = "worklet";
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
    source.start(0, media.currentTime % layer.buffer.duration);
    layer.source = source;
    layer.sourceMode = "buffer";
  }

  private reportAudible(layer: Layer) {
    const timing = layer.timing;
    if (!timing) return;
    this.onTiming?.({
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
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`Stem download failed (${response.status}).`);
    const bytes = await response.arrayBuffer();
    if (signal.aborted) throw new DOMException("Stem preparation was cancelled.", "AbortError");
    return bytes;
  }

  private async readAssetBytes(url: string, signal: AbortSignal) {
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
    const decoded = await ctx.decodeAudioData(bytes);
    const decodeMs = performance.now() - decodeStartedAt;
    if (signal.aborted) throw new DOMException("Stem preparation was cancelled.", "AbortError");
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

  async replace(id: string, url: string | null, tempoStretchRatio = 1, selectedAt = performance.now()) {
    if (url && (!Number.isFinite(tempoStretchRatio) || tempoStretchRatio < 0.5 || tempoStretchRatio > 2)) {
      throw new Error("The live stem tempo ratio must be between 0.5× and 2×.");
    }
    const key = url ? this.preparedKey(url, tempoStretchRatio) : "";
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
    if (previous?.url === url && Math.abs(previous.tempoStretchRatio - tempoStretchRatio) < 0.001) return;
    const operation: PendingSwap = {
      controller: new AbortController(),
      key,
      promise: Promise.resolve(),
    };
    this.pending.set(id, operation);
    operation.promise = this.installReplacement(id, url, tempoStretchRatio, selectedAt, previous, operation);
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
  ) {
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    let replacementInput: GainNode | null = null;
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
      const prepared = await Promise.race([
        this.getPreparedBuffer(url, tempoStretchRatio, operation.controller.signal, selectedAt),
        deadline,
      ]);
      if (operation.controller.signal.aborted || this.pending.get(id) !== operation) return false;
      const ctx = this.context();
      const channel = this.channel(id);
      if (!channel) throw new Error("The receiving stem is no longer loaded.");
      const input = ctx.createGain();
      replacementInput = input;
      input.gain.value = 0;
      input.connect(channel.gain);
      const layer: Layer = {
        url,
        tempoStretchRatio,
        buffer: prepared.buffer,
        duration: prepared.buffer.duration,
        sampleRate: prepared.buffer.sampleRate,
        input,
        source: null,
        sourceMode: null,
        timing: prepared,
      };
      await this.start(layer, channel);
      this.layers.set(id, layer);
      this.ramp(input, 1);
      this.ramp(channel.inputGain, 0);
      if (layer.source) this.reportAudible(layer);
      if (previous) this.retire(previous);
      return undefined;
    } catch (error) {
      replacementInput?.disconnect();
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
    for (const id of ids) {
      const layer = this.layers.get(id);
      const channel = layer && this.channel(id);
      if (layer && channel) {
        void this.start(layer, channel).then(() => {
          if (layer.source) this.reportAudible(layer);
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
      layer.input.disconnect();
      this.layers.delete(id);
    }
  }

  dispose() {
    this.pause();
    for (const id of new Set([...this.layers.keys(), ...this.pending.keys()])) this.remove(id);
    for (const key of this.prepared.keys()) this.discardPrepared(key, true);
    for (const key of this.recent.keys()) this.discardRecent(key);
    for (const key of this.prefetchedAssets.keys()) this.discardPrefetchedAsset(key, true);
    for (const layer of this.retired) layer.input.disconnect();
    this.retired.clear();
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }
}
