type Channel = {
  source: MediaElementAudioSourceNode;
  inputGain: GainNode;
  gain: GainNode;
};
type Layer = {
  url: string;
  tempoStretchRatio: number;
  buffer: AudioBuffer;
  input: GainNode;
  source: AudioBufferSourceNode | null;
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

type PendingSwap = {
  controller: AbortController;
  key: string;
  promise: Promise<void>;
};

type BufferStretcher = (
  context: AudioContext,
  buffer: AudioBuffer,
  ratio: number,
  signal: AbortSignal,
) => Promise<AudioBuffer>;

const PREPARED_STEM_TTL_MS = 30_000;
const MAX_PREPARED_STEMS = 2;

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
  private retired = new Set<Layer>();
  private timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(
    private context: () => AudioContext,
    private channel: (id: string) => Channel | null,
    private stretchBuffer: BufferStretcher = stretchBufferInWorker,
    private onTiming?: (timing: LiveStemTiming) => void,
  ) {}

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

  private stop(layer: Layer) {
    if (layer.source) {
      layer.source.stop();
      layer.source.disconnect();
      layer.source = null;
    }
  }

  private retire(layer: Layer) {
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

  private start(layer: Layer, channel: Channel) {
    this.stop(layer);
    const media = channel.source.mediaElement;
    if (media.paused || media.ended) return;
    const source = this.context().createBufferSource();
    source.buffer = layer.buffer;
    // Short donors repeat without ending or resetting the recipient's clock.
    source.loop = true;
    source.connect(layer.input);
    source.start(0, media.currentTime % layer.buffer.duration);
    layer.source = source;
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
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`Stem download failed (${response.status}).`);
    const bytes = await response.arrayBuffer();
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
    if (!prepared) return this.prepareBuffer(url, tempoStretchRatio, signal, selectedAt);

    // A live replacement now owns the warm operation. Cancelling that swap
    // also stops its download or tempo worker, rather than leaving work behind.
    this.discardPrepared(key, false);
    const abortPrepared = () => prepared.controller.abort();
    signal.addEventListener("abort", abortPrepared, { once: true });
    if (signal.aborted) abortPrepared();
    try {
      return await prepared.promise;
    } finally {
      signal.removeEventListener("abort", abortPrepared);
    }
  }

  async replace(id: string, url: string | null, tempoStretchRatio = 1) {
    const selectedAt = performance.now();
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

  private async installReplacement(
    id: string,
    url: string,
    tempoStretchRatio: number,
    selectedAt: number,
    previous: Layer | undefined,
    operation: PendingSwap,
  ) {
    try {
      const prepared = await this.getPreparedBuffer(url, tempoStretchRatio, operation.controller.signal, selectedAt);
      if (operation.controller.signal.aborted || this.pending.get(id) !== operation) return;
      const ctx = this.context();
      const channel = this.channel(id);
      if (!channel) throw new Error("The receiving stem is no longer loaded.");
      const input = ctx.createGain();
      input.gain.value = 0;
      input.connect(channel.gain);
      const layer: Layer = { url, tempoStretchRatio, buffer: prepared.buffer, input, source: null, timing: prepared };
      this.start(layer, channel);
      this.layers.set(id, layer);
      this.ramp(input, 1);
      this.ramp(channel.inputGain, 0);
      if (layer.source) this.reportAudible(layer);
      if (previous) this.retire(previous);
    } catch (error) {
      if (!operation.controller.signal.aborted) throw error;
    } finally {
      if (this.pending.get(id) === operation) this.pending.delete(id);
    }
  }

  sync(ids: string[]) {
    for (const id of ids) {
      const layer = this.layers.get(id);
      const channel = layer && this.channel(id);
      if (layer && channel) {
        this.start(layer, channel);
        if (layer.source) this.reportAudible(layer);
      }
    }
  }

  pause() {
    for (const layer of [...this.layers.values(), ...this.retired]) this.stop(layer);
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
    for (const layer of this.retired) layer.input.disconnect();
    this.retired.clear();
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }
}
