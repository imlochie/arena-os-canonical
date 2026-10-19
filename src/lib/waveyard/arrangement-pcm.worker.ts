/** The existing canonical PCM engine runs here, never on the UI thread. */
import { prepareArrangementPcm, type ArrangementPreviewState } from "./arrangement-pcm";
export type PreviewSource = { key: string; sampleRate: number; channels: Float32Array[] };
export type PreviewWork = { id: number; state: ArrangementPreviewState; sampleRate: number; sources: PreviewSource[]; retain: string[] };
const scope = globalThis as unknown as { onmessage: (event: MessageEvent<PreviewWork>) => void; postMessage(value: unknown, transfer?: Transferable[]): void };
const sources = new Map<string, PreviewSource>();
scope.onmessage = ({ data }) => {
  try {
    for (const source of data.sources) sources.set(source.key, source);
    const retain = new Set(data.retain); for (const key of sources.keys()) if (!retain.has(key)) sources.delete(key);
    const buffers = new Map([...sources].map(([key, source]) => [key, { sampleRate: source.sampleRate, numberOfChannels: source.channels.length, length: source.channels[0].length, getChannelData: (channel: number) => source.channels[channel] }]));
    const pcm = prepareArrangementPcm(data.state, buffers, data.sampleRate);
    const left = new Float32Array(pcm.length / 2), right = new Float32Array(pcm.length / 2);
    for (let frame = 0; frame < left.length; frame++) { left[frame] = pcm[frame * 2]; right[frame] = pcm[frame * 2 + 1]; }
    scope.postMessage({ id: data.id, left, right }, [left.buffer, right.buffer]);
  } catch (error) { scope.postMessage({ id: data.id, error: error instanceof Error ? error.message : "Arrangement preparation failed." }); }
};
