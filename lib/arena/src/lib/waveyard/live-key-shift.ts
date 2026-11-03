const MIN_KEY_SHIFT = -11;
const MAX_KEY_SHIFT = 11;
const DEFAULT_DELAY_MS = 36;

/**
 * A small, streaming dual-read-head pitch shifter for the live session bus.
 * It changes pitch without changing the input timeline, so the media element
 * remains the authoritative shared playhead. The two overlapping read heads
 * hide their delay resets; their phase is shared across channels to preserve
 * the stereo image.
 */
export class LiveKeyShift {
  private readonly delaySamples: number;
  private readonly ringLength: number;
  private readonly ring: Float32Array[];
  private readonly filterState: number[];
  private writeIndex = 0;
  private phase = 0;
  private ratio = 1;
  private targetRatio = 1;
  private rampRemaining = 0;

  constructor(
    private readonly sampleRate: number,
    channels = 2,
    delayMs = DEFAULT_DELAY_MS,
  ) {
    const count = Math.max(1, Math.min(2, Math.floor(channels)));
    this.delaySamples = Math.max(64, Math.round(sampleRate * Math.max(10, delayMs) / 1000));
    this.ringLength = this.delaySamples * 2 + 8;
    this.ring = Array.from({ length: count }, () => new Float32Array(this.ringLength));
    this.filterState = Array.from({ length: count }, () => 0);
  }

  setSemitones(value: number) {
    if (!Number.isInteger(value) || value < MIN_KEY_SHIFT || value > MAX_KEY_SHIFT) {
      throw new Error("Live key shift must be an integer from -11 to +11 semitones.");
    }
    this.targetRatio = 2 ** (value / 12);
    this.rampRemaining = Math.max(1, Math.round(this.sampleRate * 0.04));
  }

  process(inputChannels: Float32Array[], outputChannels: Float32Array[]) {
    const frameCount = outputChannels[0]?.length ?? 0;
    for (let frame = 0; frame < frameCount; frame += 1) {
      if (this.rampRemaining > 0) {
        this.ratio += (this.targetRatio - this.ratio) / this.rampRemaining;
        this.rampRemaining -= 1;
      } else {
        this.ratio = this.targetRatio;
      }

      const ratio = this.ratio;
      const shifted = Math.abs(ratio - 1) >= 0.0005;
      const phaseStep = shifted ? Math.abs(1 - ratio) / this.delaySamples : 0;
      const phaseB = (this.phase + 0.5) % 1;
      const weightA = 0.5 - 0.5 * Math.cos(this.phase * Math.PI * 2);
      const weightB = 1 - weightA;
      const delayA = ratio > 1
        ? this.delaySamples - this.phase * this.delaySamples
        : 2 + this.phase * this.delaySamples;
      const delayB = ratio > 1
        ? this.delaySamples - phaseB * this.delaySamples
        : 2 + phaseB * this.delaySamples;
      const inputFallback = inputChannels[0];

      for (let channel = 0; channel < outputChannels.length; channel += 1) {
        const buffer = this.ring[channel] ?? this.ring[0];
        if (!buffer) {
          outputChannels[channel][frame] = 0;
          continue;
        }
        const input = inputChannels[channel] ?? inputFallback;
        const raw = input?.[frame] ?? 0;
        // Band-limit upward shifts before the read heads raise frequency.
        const cutoff = ratio > 1 ? 1 - Math.exp(-Math.PI / ratio) : 1;
        this.filterState[channel] += (raw - this.filterState[channel]) * cutoff;
        buffer[this.writeIndex] = this.filterState[channel];
        outputChannels[channel][frame] = shifted
          ? this.read(buffer, this.writeIndex - delayA) * weightA
            + this.read(buffer, this.writeIndex - delayB) * weightB
          : raw;
      }

      this.writeIndex = (this.writeIndex + 1) % this.ringLength;
      if (shifted) this.phase = (this.phase + phaseStep) % 1;
    }
  }

  private read(buffer: Float32Array, position: number) {
    const wrapped = ((position % this.ringLength) + this.ringLength) % this.ringLength;
    const first = Math.floor(wrapped);
    const second = (first + 1) % this.ringLength;
    const fraction = wrapped - first;
    return buffer[first] * (1 - fraction) + buffer[second] * fraction;
  }
}
