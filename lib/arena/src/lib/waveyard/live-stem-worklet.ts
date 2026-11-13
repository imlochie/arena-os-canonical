import { LiveStemWsola } from "./live-stem-wsola";
import { LiveKeyShift } from "./live-key-shift";

type WorkletMessage =
  | {
      type: "load";
      channels: ArrayBuffer[];
      startFrame: number;
      rate: number;
      pitchPreserving: boolean;
      playing: boolean;
      activationFrame?: number;
    }
  | { type: "rate"; value: number }
  | { type: "pitch"; enabled: boolean }
  | { type: "key-shift"; semitones: number }
  | { type: "seek"; frame: number }
  | { type: "play" | "pause" | "dispose" };

type WorkletPort = {
  onmessage: ((event: MessageEvent<WorkletMessage>) => void) | null;
  postMessage(value: unknown): void;
};
type WorkletProcessorInstance = { port: WorkletPort };
type WorkletProcessorConstructor = new () => WorkletProcessorInstance & {
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
};

const workletGlobal = globalThis as unknown as {
  AudioWorkletProcessor: new () => WorkletProcessorInstance;
  registerProcessor: (name: string, constructor: WorkletProcessorConstructor) => void;
  currentFrame?: number;
};

class WaveyardLiveStemProcessor extends workletGlobal.AudioWorkletProcessor {
  private processor: LiveStemWsola | null = null;
  private activationFrame: number | null = null;

  constructor() {
    super();
    this.port.onmessage = (event) => {
      const message = event.data;
      if (message.type === "load") {
        try {
          this.processor = new LiveStemWsola(
            message.channels.map((channel) => new Float32Array(channel)),
            sampleRate,
            message.startFrame,
          );
          this.processor.setRate(message.rate);
          this.processor.setPitchPreserving(message.pitchPreserving);
          this.processor.setPlaying(message.playing);
          this.activationFrame = Number.isSafeInteger(message.activationFrame)
            ? message.activationFrame!
            : null;
          this.port.postMessage({ type: "ready" });
        } catch (error) {
          this.port.postMessage({
            type: "error",
            message: error instanceof Error ? error.message : "The live pitch processor could not load audio.",
          });
        }
      } else if (message.type === "rate") {
        this.processor?.setRate(message.value);
      } else if (message.type === "pitch") {
        this.processor?.setPitchPreserving(message.enabled);
      } else if (message.type === "seek") {
        this.processor?.seek(message.frame);
      } else if (message.type === "play") {
        this.processor?.setPlaying(true);
      } else if (message.type === "pause") {
        this.processor?.setPlaying(false);
      } else if (message.type === "dispose") {
        this.processor = null;
        this.port.close();
      }
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]) {
    const output = outputs[0];
    if (!output) return true;
    if (
      this.activationFrame !== null
      && (workletGlobal.currentFrame ?? 0) >= this.activationFrame
    ) {
      this.processor?.setPlaying(true);
      this.activationFrame = null;
    }
    if (this.processor) this.processor.process(output);
    else for (const channel of output) channel.fill(0);
    return true;
  }
}

class WaveyardKeyShiftProcessor extends workletGlobal.AudioWorkletProcessor {
  private processor = new LiveKeyShift(sampleRate, 2);
  private disposed = false;

  constructor() {
    super();
    this.port.onmessage = (event) => {
      if (event.data.type === "key-shift") {
        try {
          this.processor.setSemitones(event.data.semitones);
        } catch (error) {
          this.port.postMessage({
            type: "error",
            message: error instanceof Error ? error.message : "The live key shift could not be changed.",
          });
        }
      } else if (event.data.type === "dispose") {
        this.disposed = true;
        this.port.close();
      }
    };
    this.port.postMessage({ type: "key-ready" });
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]) {
    const input = inputs[0] ?? [];
    const output = outputs[0] ?? [];
    if (output.length > 0) this.processor.process(input, output);
    return !this.disposed;
  }
}

workletGlobal.registerProcessor("waveyard-live-stem", WaveyardLiveStemProcessor);
workletGlobal.registerProcessor("waveyard-key-shift", WaveyardKeyShiftProcessor);
