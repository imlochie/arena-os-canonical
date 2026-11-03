/** One protected summing bus per live session; standalone Studio transports are unchanged. */
type SessionOutput = {
  context: AudioContext;
  input: GainNode;
  ready: Promise<void>;
  stream(): MediaStream;
  release(): void;
};
const groups = new Map<string, { output: SessionOutput; users: number }>();

export function acquireSessionOutput(key: string, workletUrl: string): SessionOutput {
  const existing = groups.get(key);
  if (existing) {
    existing.users += 1;
    return existing.output;
  }
  const context = new AudioContext();
  const input = context.createGain();
  input.channelCount = 2;
  input.channelCountMode = "explicit";
  const analyser = context.createAnalyser();
  analyser.fftSize = 2048;
  let processor: AudioWorkletNode | null = null;
  let recording: MediaStreamAudioDestinationNode | null = null;
  const ready = (async () => {
    if (!context.audioWorklet || typeof AudioWorkletNode === "undefined")
      throw new Error("Protected session playback needs AudioWorklet support. Use a current browser and retry.");
    await context.audioWorklet.addModule(workletUrl);
    if (context.state === "closed") return;
    processor = new AudioWorkletNode(context, "waveyard-output-peak", {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
    });
    input.connect(processor);
    processor.connect(analyser);
    analyser.connect(context.destination);
  })();
  // A lazy graph can be created before play awaits readiness. Keep failures
  // handled here, but retain the rejected promise so Play reports the error.
  void ready.catch(() => undefined);
  const output: SessionOutput = {
    context, input, ready,
    stream() {
      if (!recording) {
        recording = context.createMediaStreamDestination();
        analyser.connect(recording);
      }
      return recording.stream;
    },
    release() {
      const group = groups.get(key);
      if (!group || group.output !== output || --group.users > 0) return;
      groups.delete(key);
      input.disconnect();
      processor?.disconnect();
      analyser.disconnect();
      recording?.disconnect();
      void context.close().catch(() => undefined);
    },
  };
  groups.set(key, { output, users: 1 });
  return output;
}
