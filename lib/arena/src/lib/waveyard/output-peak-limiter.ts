/** Stereo-linked sample-peak limiter. No file-sized buffers or per-frame allocations. */
export class OutputPeakLimiter {
  readonly delayFrames: number;
  private readonly size: number;
  private readonly audio: Float32Array[];
  private readonly peaks: Float32Array;
  private readonly indices: Float64Array;
  private readonly release: number;
  private head = 0;
  private tail = 0;
  private frame = 0;
  private gain = 1;

  constructor(sampleRate: number, readonly ceiling = 0.98) {
    if (!(sampleRate > 0) || !(ceiling > 0 && ceiling < 1)) throw new Error("Invalid output limiter settings.");
    this.delayFrames = Math.ceil(sampleRate * 0.005);
    this.size = this.delayFrames + 1;
    this.audio = [new Float32Array(this.size), new Float32Array(this.size)];
    this.peaks = new Float32Array(this.size + 1);
    this.indices = new Float64Array(this.size + 1);
    this.release = Math.exp(-1 / (sampleRate * 0.08));
  }

  process(input: Float32Array[], output: Float32Array[]) {
    const capacity = this.peaks.length;
    for (let i = 0; i < (output[0]?.length ?? 0); i += 1, this.frame += 1) {
      const write = this.frame % this.size;
      let peak = 0;
      for (let ch = 0; ch < 2; ch += 1) {
        const raw = (input[ch] ?? input[0])?.[i] ?? 0;
        const value = Number.isFinite(raw) ? raw : 0;
        this.audio[ch][write] = value;
        peak = Math.max(peak, Math.abs(value));
      }
      // Monotonic deque gives the maximum over the delayed sample and all
      // samples ahead of it, in O(1) amortized time.
      while (this.head !== this.tail && this.indices[this.head] < this.frame - this.delayFrames)
        this.head = (this.head + 1) % capacity;
      while (this.head !== this.tail) {
        const last = (this.tail + capacity - 1) % capacity;
        if (this.peaks[last] > peak) break;
        this.tail = last;
      }
      this.peaks[this.tail] = peak;
      this.indices[this.tail] = this.frame;
      this.tail = (this.tail + 1) % capacity;
      const target = Math.min(1, this.ceiling / Math.max(this.peaks[this.head], 1e-20));
      this.gain = target < this.gain ? target : target + (this.gain - target) * this.release;
      const read = (write + 1) % this.size;
      for (let ch = 0; ch < output.length; ch += 1)
        output[ch][i] = this.audio[Math.min(ch, 1)][read] * this.gain;
    }
  }
}
