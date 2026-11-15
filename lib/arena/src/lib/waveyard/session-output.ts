/** One protected summing bus per live session; standalone Studio transports are unchanged. */
type SessionOutput = {
  context: AudioContext;
  input: GainNode;
  readonly ready: Promise<void>;
  /** Temporary diagnostic: which output instance this is and whether its
   *  readiness promise has settled. Removed once the WebKit stall is fixed. */
  debug(): string;
  stream(): MediaStream;
  release(): void;
};
let debugInstanceCount = 0;
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
  // Temporary diagnostic counters for the WebKit session-controls stall.
  const debugId = ++debugInstanceCount;
  let debugAttempts = 0;
  let debugReadiness: "none" | "pending" | "resolved" | "rejected" = "none";
  let recording: MediaStreamAudioDestinationNode | null = null;
  let readiness: Promise<void> | null = null;
  const ensureReady = () => {
    if (processor) return Promise.resolve();
    if (readiness) {
      console.error(`TRANSPORT_TRACE output:${debugId}:cached readiness=${debugReadiness} ctx=${context.state} users=${groups.get(key)?.users ?? 0}`);
      return readiness;
    }
    debugAttempts += 1;
    debugReadiness = "pending";
    console.error(`TRANSPORT_TRACE output:${debugId}:attempt${debugAttempts} ctx=${context.state} worklet=${typeof context.audioWorklet}/${typeof AudioWorkletNode}`);
    const attempt = (async () => {
      if (!context.audioWorklet || typeof AudioWorkletNode === "undefined") {
        throw new Error("Protected session playback needs AudioWorklet support. Use a current browser and retry.");
      }
      try {
        await context.audioWorklet.addModule(workletUrl);
        if (context.state === "closed") return;
        const nextProcessor = new AudioWorkletNode(context, "waveyard-output-peak", {
          numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
        });
        try {
          input.connect(nextProcessor);
          nextProcessor.connect(analyser);
          analyser.connect(context.destination);
          processor = nextProcessor;
        } catch (error) {
          nextProcessor.disconnect();
          input.disconnect();
          analyser.disconnect();
          throw error;
        }
      } catch {
        throw new Error(
          "Protected session output could not be loaded. Playback was not started. Check your connection and retry.",
        );
      }
    })();
    debugReadiness = "pending";
    const tracked = attempt.then(() => { debugReadiness = "resolved"; },
      (error: unknown) => { debugReadiness = "rejected"; throw error; })
      .catch((error: unknown) => {
      if (readiness === tracked) readiness = null;
      throw error;
    });
    readiness = tracked;
    return tracked;
  };
  const output: SessionOutput = {
    context, input,
    get ready() { return ensureReady(); },
    debug() {
      return `output:${debugId} ctx=${context.state} attempts=${debugAttempts} readiness=${debugReadiness}`
        + ` processor=${processor ? "yes" : "no"} users=${groups.get(key)?.users ?? 0}`;
    },
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
  // Start loading when the first deck creates its bus, but allow a later Play
  // to retry if this transient attempt rejects.
  void output.ready.catch(() => undefined);
  return output;
}
