/**
 * Streaming WSOLA for a single looping stereo stem.
 *
 * It keeps only one 20 ms output hop and one overlap tail in memory. Input
 * PCM is owned by the AudioWorklet; the main thread can release its decoded
 * AudioBuffer after transferring the channel arrays.
 */
export class LiveStemWsola {
  private readonly frameCount: number;
  private readonly hop: number;
  private readonly tolerance: number;
  private readonly output: Float32Array[];
  private readonly tail: Float32Array[];
  private cursor: number;
  private position: number;
  private rate = 1;
  private pitchPreserving = false;
  private playing = false;
  private hasTail = false;

  constructor(
    private readonly channels: Float32Array[],
    private readonly sampleRate: number,
    startFrame = 0,
  ) {
    this.frameCount = channels[0]?.length ?? 0;
    this.hop = Math.max(128, Math.round(Math.max(1, sampleRate) * 0.02));
    this.tolerance = Math.max(8, Math.round(Math.max(1, sampleRate) * 0.01));
    this.output = channels.map(() => new Float32Array(this.hop));
    this.tail = channels.map(() => new Float32Array(this.hop));
    this.cursor = this.hop;
    this.position = this.wrap(startFrame);
  }

  setRate(value: number) {
    this.rate = Number.isFinite(value) ? Math.min(2.4, Math.max(0.4, value)) : 1;
  }

  setPitchPreserving(enabled: boolean) {
    if (this.pitchPreserving === enabled) return;
    this.pitchPreserving = enabled;
    this.hasTail = false;
    this.cursor = this.hop;
  }

  seek(frame: number) {
    this.position = this.wrap(frame);
    this.hasTail = false;
    this.cursor = this.hop;
  }

  setPlaying(playing: boolean) {
    this.playing = playing;
  }

  process(outputChannels: Float32Array[]) {
    const count = outputChannels[0]?.length ?? 0;
    for (let index = 0; index < count; index += 1) {
      if (!this.playing || this.frameCount === 0 || this.channels.length === 0) {
        for (const channel of outputChannels) channel[index] = 0;
        continue;
      }
      if (this.cursor >= this.hop) this.fillHop();
      for (let channel = 0; channel < outputChannels.length; channel += 1) {
        const source = this.output[channel] ?? this.output[0];
        outputChannels[channel][index] = source?.[this.cursor] ?? 0;
      }
      this.cursor += 1;
    }
  }

  private wrap(frame: number) {
    if (this.frameCount < 1) return 0;
    return ((frame % this.frameCount) + this.frameCount) % this.frameCount;
  }

  private sample(channel: number, frame: number) {
    const data = this.channels[channel] ?? this.channels[0];
    if (!data || data.length === 0) return 0;
    const wrapped = this.wrap(frame);
    const first = Math.floor(wrapped);
    const second = (first + 1) % this.frameCount;
    const fraction = wrapped - first;
    return data[first] * (1 - fraction) + data[second] * fraction;
  }

  private similarity(candidate: number) {
    let xy = 0;
    let yy = 1e-9;
    for (let frame = 0; frame < this.hop; frame += 4) {
      let previous = 0;
      let current = 0;
      for (let channel = 0; channel < this.channels.length; channel += 1) {
        previous += this.tail[channel][frame] ?? 0;
        current += this.sample(channel, candidate + frame);
      }
      previous /= this.channels.length;
      current /= this.channels.length;
      xy += previous * current;
      yy += current * current;
    }
    return xy / Math.sqrt(yy);
  }

  private fillHop() {
    if (!this.pitchPreserving || Math.abs(this.rate - 1) < 0.001) {
      for (let frame = 0; frame < this.hop; frame += 1) {
        for (let channel = 0; channel < this.channels.length; channel += 1) {
          this.output[channel][frame] = this.sample(channel, this.position);
        }
        this.position = this.wrap(this.position + this.rate);
      }
      this.hasTail = false;
      this.cursor = 0;
      return;
    }

    const nominal = Math.round(this.position);
    let start = nominal;
    if (this.hasTail) {
      let bestScore = -Infinity;
      const coarseStep = Math.max(8, Math.round(this.sampleRate / 6000));
      for (let offset = -this.tolerance; offset <= this.tolerance; offset += coarseStep) {
        const candidate = this.wrap(nominal + offset);
        const score = this.similarity(candidate);
        if (score > bestScore) {
          bestScore = score;
          start = candidate;
        }
      }
    }

    for (let frame = 0; frame < this.hop; frame += 1) {
      const blend = this.hasTail
        ? 0.5 - 0.5 * Math.cos(Math.PI * frame / this.hop)
        : 1;
      for (let channel = 0; channel < this.channels.length; channel += 1) {
        const head = this.sample(channel, start + frame);
        this.output[channel][frame] = this.hasTail
          ? this.tail[channel][frame] * (1 - blend) + head * blend
          : head;
        this.tail[channel][frame] = this.sample(channel, start + this.hop + frame);
      }
    }

    this.position = this.wrap(start + this.hop * this.rate);
    this.hasTail = true;
    this.cursor = 0;
  }
}
