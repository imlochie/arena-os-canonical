import { timeStretch } from "./elastic";

type StretchRequest = {
  left: ArrayBuffer;
  right: ArrayBuffer;
  ratio: number;
  sampleRate: number;
};

type StretchResponse =
  | { left: ArrayBuffer; right: ArrayBuffer }
  | { error: string };

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<StretchRequest>) => void) | null;
  postMessage: (message: StretchResponse, transfer: Transferable[]) => void;
};

workerScope.onmessage = ({ data }) => {
  try {
    const left = new Float32Array(data.left);
    const right = new Float32Array(data.right);
    if (left.length === 0 || left.length !== right.length) {
      throw new Error("The donor stem has invalid channel data.");
    }
    const interleaved = new Float32Array(left.length * 2);
    for (let frame = 0; frame < left.length; frame += 1) {
      interleaved[frame * 2] = left[frame];
      interleaved[frame * 2 + 1] = right[frame];
    }
    const stretched = timeStretch(interleaved, data.ratio, data.sampleRate);
    const frameCount = stretched.length / 2;
    const outputLeft = new Float32Array(frameCount);
    const outputRight = new Float32Array(frameCount);
    for (let frame = 0; frame < frameCount; frame += 1) {
      outputLeft[frame] = stretched[frame * 2];
      outputRight[frame] = stretched[frame * 2 + 1];
    }
    workerScope.postMessage(
      { left: outputLeft.buffer, right: outputRight.buffer },
      [outputLeft.buffer, outputRight.buffer],
    );
  } catch (error) {
    workerScope.postMessage(
      { error: error instanceof Error ? error.message : "Live tempo matching failed." },
      [],
    );
  }
};
