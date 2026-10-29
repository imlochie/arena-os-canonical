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
};

type BufferStretcher = (
  context: AudioContext,
  buffer: AudioBuffer,
  ratio: number,
  signal: AbortSignal,
) => Promise<AudioBuffer>;

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
  private pending = new Map<string, AbortController>();
  private retired = new Set<Layer>();
  private timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(
    private context: () => AudioContext,
    private channel: (id: string) => Channel | null,
    private stretchBuffer: BufferStretcher = stretchBufferInWorker,
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

  async replace(id: string, url: string | null, tempoStretchRatio = 1) {
    this.pending.get(id)?.abort();
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
    if (!Number.isFinite(tempoStretchRatio) || tempoStretchRatio < 0.5 || tempoStretchRatio > 2) {
      throw new Error("The live stem tempo ratio must be between 0.5× and 2×.");
    }
    if (previous?.url === url && Math.abs(previous.tempoStretchRatio - tempoStretchRatio) < 0.001) return;
    const operation = new AbortController();
    this.pending.set(id, operation);
    try {
      const response = await fetch(url, { signal: operation.signal });
      if (!response.ok) throw new Error(`Stem download failed (${response.status}).`);
      const bytes = await response.arrayBuffer();
      const ctx = this.context();
      const decoded = await ctx.decodeAudioData(bytes);
      if (operation.signal.aborted || this.pending.get(id) !== operation) return;
      const buffer = Math.abs(tempoStretchRatio - 1) < 0.001
        ? decoded
        : await this.stretchBuffer(ctx, decoded, tempoStretchRatio, operation.signal);
      if (operation.signal.aborted || this.pending.get(id) !== operation) return;
      if (!(buffer.duration > 0)) throw new Error("The donor stem has no playable audio.");
      const channel = this.channel(id);
      if (!channel) throw new Error("The receiving stem is no longer loaded.");
      const input = ctx.createGain();
      input.gain.value = 0;
      input.connect(channel.gain);
      const layer: Layer = { url, tempoStretchRatio, buffer, input, source: null };
      this.start(layer, channel);
      this.layers.set(id, layer);
      this.ramp(input, 1);
      this.ramp(channel.inputGain, 0);
      if (previous) this.retire(previous);
    } catch (error) {
      if (!operation.signal.aborted) throw error;
    } finally {
      if (this.pending.get(id) === operation) this.pending.delete(id);
    }
  }

  sync(ids: string[]) {
    for (const id of ids) {
      const layer = this.layers.get(id);
      const channel = layer && this.channel(id);
      if (layer && channel) this.start(layer, channel);
    }
  }

  pause() {
    for (const layer of [...this.layers.values(), ...this.retired]) this.stop(layer);
  }

  remove(id: string) {
    this.pending.get(id)?.abort();
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
    for (const layer of this.retired) layer.input.disconnect();
    this.retired.clear();
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }
}
