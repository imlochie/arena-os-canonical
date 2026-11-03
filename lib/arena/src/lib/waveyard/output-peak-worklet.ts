import { OutputPeakLimiter } from "./output-peak-limiter";

const scope = globalThis as unknown as {
  AudioWorkletProcessor: new () => object;
  registerProcessor(name: string, constructor: new () => object): void;
};
class OutputPeakProcessor extends scope.AudioWorkletProcessor {
  private limiter = new OutputPeakLimiter(sampleRate);
  process(inputs: Float32Array[][], outputs: Float32Array[][]) {
    if (outputs[0]) this.limiter.process(inputs[0] ?? [], outputs[0]);
    return true;
  }
}
scope.registerProcessor("waveyard-output-peak", OutputPeakProcessor);
