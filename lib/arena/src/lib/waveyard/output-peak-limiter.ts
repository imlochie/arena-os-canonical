const TRUE_PEAK_OVERSAMPLE = 4;
const TRUE_PEAK_TAPS_PER_PHASE = 24;
const TRUE_PEAK_DETECTION_DELAY = TRUE_PEAK_TAPS_PER_PHASE >> 1;
const TRUE_PEAK_HEADROOM_FACTOR = 0.93; // Extra margin below the caller's ceiling.

/** Stereo-linked 4× true-peak limiter. No file-sized buffers or per-frame allocations. */
export class OutputPeakLimiter {
  readonly delayFrames: number;
  private readonly size: number;
  private readonly audio: Float32Array[];
  private readonly peaks: Float32Array;
  private readonly indices: Float64Array;
  private readonly oversampleBranches: Float32Array[] = designOversamplePolyphase(
    TRUE_PEAK_OVERSAMPLE,
    TRUE_PEAK_TAPS_PER_PHASE,
  );
  private readonly release: number;
  private head = 0;
  private tail = 0;
  private frame = 0;
  private gain = 1;

  constructor(sampleRate: number, readonly ceiling = 0.98) {
    if (!(sampleRate > 0) || !(ceiling > 0 && ceiling < 1)) throw new Error("Invalid output limiter settings.");
    // Keep the existing 5 ms lookahead plus the FIR's 12-frame analysis delay.
    this.delayFrames = Math.ceil(sampleRate * 0.005) + TRUE_PEAK_DETECTION_DELAY;
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
      // Reconstruct four phases with a 24-tap/phase windowed-sinc FIR. The
      // center trails the newest input by 12 frames, which the lookahead adds
      // to the audio delay. Stereo channels share the larger reconstructed peak.
      const center = this.frame - TRUE_PEAK_DETECTION_DELAY;
      for (let ch = 0; ch < 2; ch += 1) {
        for (let phase = 0; phase < this.oversampleBranches.length; phase += 1) {
          const taps = this.oversampleBranches[phase];
          let reconstructed = 0;
          for (let k = 0; k < taps.length; k += 1) {
            const sourceFrame = center + k - TRUE_PEAK_DETECTION_DELAY;
            if (sourceFrame < 0) continue;
            reconstructed += this.audio[ch][sourceFrame % this.size] * taps[k];
          }
          peak = Math.max(peak, Math.abs(reconstructed));
        }
      }
      // Monotonic deque gives the maximum reconstructed peak over the delayed
      // output and its lookahead, in O(1) amortized time.
      while (this.head !== this.tail &&
        this.indices[this.head] < this.frame - this.delayFrames - TRUE_PEAK_DETECTION_DELAY)
        this.head = (this.head + 1) % capacity;
      while (this.head !== this.tail) {
        const last = (this.tail + capacity - 1) % capacity;
        if (this.peaks[last] > peak) break;
        this.tail = last;
      }
      this.peaks[this.tail] = peak;
      this.indices[this.tail] = center;
      this.tail = (this.tail + 1) % capacity;
      // Target 93% of the requested ceiling: transient gain envelopes can
      // reconstruct above the input estimate. Lower-level audio remains unity.
      const target = Math.min(1, (this.ceiling * TRUE_PEAK_HEADROOM_FACTOR) /
        Math.max(this.peaks[this.head], 1e-20));
      this.gain = target < this.gain ? target : target + (this.gain - target) * this.release;
      const read = (write + 1) % this.size;
      for (let ch = 0; ch < output.length; ch += 1)
        output[ch][i] = this.audio[Math.min(ch, 1)][read] * this.gain;
    }
  }
}

/** Polyphase branches of a unity-gain windowed-sinc reconstruction filter. */
function designOversamplePolyphase(oversample: number, tapsPerPhase: number): Float32Array[] {
  const total = oversample * tapsPerPhase;
  const impulse = new Float32Array(total);
  const cutoff = 0.45 / oversample;
  const center = (total - 1) / 2;
  for (let i = 0; i < total; i += 1) {
    const offset = i - center;
    const sinc = offset === 0
      ? 2 * cutoff
      : Math.sin(2 * Math.PI * cutoff * offset) / (Math.PI * offset);
    const window = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (total - 1));
    impulse[i] = sinc * window;
  }
  let sum = 0;
  for (const coefficient of impulse) sum += coefficient;
  const scale = sum !== 0 ? oversample / sum : 1;
  return Array.from({ length: oversample }, (_, phase) => {
    const taps = new Float32Array(tapsPerPhase);
    for (let k = 0; k < tapsPerPhase; k += 1)
      taps[k] = impulse[phase + k * oversample] * scale;
    return taps;
  });
}
