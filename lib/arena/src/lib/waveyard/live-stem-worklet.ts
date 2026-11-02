import { LiveStemWsola } from "./live-stem-wsola";

type WorkletMessage =
  | {
      type: "load";
      channels: ArrayBuffer[];
      startFrame: number;
      rate: number;
      pitchPreserving: boolean;
      playing: boolean;
    }
  | { type: "rate"; value: number }
  | { type: "pitch"; enabled: boolean }
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
};

class WaveyardLiveStemProcessor extends workletGlobal.AudioWorkletProcessor {
  private processor: LiveStemWsola | null = null;

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
    if (this.processor) this.processor.process(output);
    else for (const channel of output) channel.fill(0);
    return true;
  }
}

workletGlobal.registerProcessor("waveyard-live-stem", WaveyardLiveStemProcessor);
