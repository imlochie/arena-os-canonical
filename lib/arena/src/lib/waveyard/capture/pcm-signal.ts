/** Observes endpoint PCM without changing the bytes written to the recording. */
export interface CaptureSignal {
  state: "waiting" | "silent" | "active" | "unsupported";
  peak: number;
  capturedSeconds: number;
  signalSeen: boolean;
  clippedSamples: number;
  invalidSamples: number;
}

export function isCaptureSignal(value: unknown): value is CaptureSignal {
  if (!value || typeof value !== "object") return false;
  const signal = value as CaptureSignal;
  return ["waiting", "silent", "active", "unsupported"].includes(signal.state)
    && typeof signal.signalSeen === "boolean"
    && Number.isFinite(signal.peak) && signal.peak >= 0 && signal.peak <= 1
    && Number.isFinite(signal.capturedSeconds) && signal.capturedSeconds >= 0
    && Number.isSafeInteger(signal.clippedSamples) && signal.clippedSamples >= 0
    && Number.isSafeInteger(signal.invalidSamples) && signal.invalidSamples >= 0;
}

// -80 dBFS is a detection threshold, not a claim about audibility or fidelity.
const SIGNAL_THRESHOLD = 0.0001;
const STALE_PACKET_MS = 3000;

export class PcmSignalMonitor {
  private readonly channels: number;
  private readonly sampleRate: number;
  private readonly blockAlign: number;
  private readonly width: number;
  private readonly encoding: number;
  private readonly supported: boolean;
  private readonly partialFrame: Buffer;
  private readonly sampleDivisor: number;
  private readonly fullScale: number;
  private tail: Buffer = Buffer.alloc(0);
  private frames = 0;
  private lastDataAt: number | undefined;
  private lastSignalAt: number | undefined;
  private peak = 0;
  private signalSeen = false;
  private clippedSamples = 0;
  private invalidSamples = 0;

  constructor(formatChunk: Uint8Array) {
    const format = Buffer.from(formatChunk);
    if (format.length < 16) throw new Error("Signal monitoring requires a WAVE format chunk.");
    this.channels = format.readUInt16LE(2);
    this.sampleRate = format.readUInt32LE(4);
    this.blockAlign = format.readUInt16LE(12);
    this.width = format.readUInt16LE(14) / 8;
    let encoding = format.readUInt16LE(0);
    if (encoding === 0xfffe) {
      // Only the standard PCM and IEEE_FLOAT extensible subformats are decoded.
      const guidSuffix = "00001000800000aa00389b71";
      encoding = format.length >= 40 && format.subarray(28, 40).toString("hex") === guidSuffix
        ? format.readUInt32LE(24)
        : 0;
    }
    this.encoding = encoding;
    this.supported = this.channels > 0 && this.channels <= 64 && this.sampleRate > 0
      && this.blockAlign >= this.channels * this.width
      && ((encoding === 1 && [1, 2, 3, 4].includes(this.width))
        || (encoding === 3 && [4, 8].includes(this.width)));
    this.partialFrame = Buffer.alloc(this.supported ? this.blockAlign : 0);
    this.sampleDivisor = encoding === 1 ? 2 ** (this.width * 8 - 1) : 1;
    this.fullScale = encoding === 1 ? 1 - 1 / this.sampleDivisor : 1;
  }

  write(chunk: Buffer, now = Date.now()): void {
    if (!this.supported || chunk.length === 0) return;
    let peak = 0;
    let frames = 0;
    let start = 0;
    if (this.tail.length) {
      const needed = this.blockAlign - this.tail.length;
      const taken = Math.min(needed, chunk.length);
      chunk.copy(this.partialFrame, this.tail.length, 0, taken);
      if (taken < needed) {
        this.tail = this.partialFrame.subarray(0, this.tail.length + taken);
        return;
      }
      peak = this.observe(this.partialFrame, 0, this.blockAlign);
      frames++;
      start = needed;
    }
    const end = chunk.length - (chunk.length - start) % this.blockAlign;
    if (end > start) {
      peak = Math.max(peak, this.observe(chunk, start, end));
      frames += (end - start) / this.blockAlign;
    }
    // Only the incomplete frame is copied. Never concatenate a previous tail
    // with an entire incoming pipe chunk or retain a view of that chunk.
    chunk.copy(this.partialFrame, 0, end);
    this.tail = this.partialFrame.subarray(0, chunk.length - end);
    if (frames === 0) return;
    this.frames += frames;
    this.peak = peak;
    this.lastDataAt = now;
    if (peak >= SIGNAL_THRESHOLD) {
      this.signalSeen = true;
      this.lastSignalAt = now;
    }
  }

  private observe(bytes: Buffer, start: number, end: number): number {
    let peak = 0;
    for (let frame = start; frame < end; frame += this.blockAlign) {
      for (let channel = 0; channel < this.channels; channel++) {
        const offset = frame + channel * this.width;
        let value: number;
        if (this.encoding === 3) {
          value = this.width === 4 ? bytes.readFloatLE(offset) : bytes.readDoubleLE(offset);
        } else if (this.width === 1) {
          value = (bytes[offset] - 128) / 128;
        } else {
          value = bytes.readIntLE(offset, this.width) / this.sampleDivisor;
        }
        if (!Number.isFinite(value)) {
          this.invalidSamples++;
          continue;
        }
        const magnitude = Math.abs(value);
        if (magnitude >= this.fullScale) this.clippedSamples++;
        peak = Math.max(peak, Math.min(1, magnitude));
      }
    }
    return peak;
  }

  snapshot(now = Date.now()): CaptureSignal {
    const fresh = this.lastDataAt !== undefined && now - this.lastDataAt <= STALE_PACKET_MS;
    return {
      state: !this.supported ? "unsupported" : !fresh ? "waiting"
        : this.lastSignalAt !== undefined && now - this.lastSignalAt <= STALE_PACKET_MS ? "active" : "silent",
      peak: fresh ? this.peak : 0,
      capturedSeconds: this.frames / (this.sampleRate || 1),
      signalSeen: this.signalSeen,
      clippedSamples: this.clippedSamples,
      invalidSamples: this.invalidSamples,
    };
  }
}
