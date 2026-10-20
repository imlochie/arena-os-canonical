/** The existing canonical PCM engine runs here, never on the UI thread. */
import { prepareArrangementPcm, type ArrangementMixCache, type ArrangementPreviewState } from "./arrangement-pcm";
export type PreviewSource = { key: string; sampleRate: number; channels: Float32Array[] };
export type PreviewWork = { kind: "render"; id: number; state: ArrangementPreviewState; sampleRate: number; retain: string[]; revision: string };
type PreviewMessage = PreviewWork | { kind: "source"; source: PreviewSource } | { kind: "retain"; retain: string[] };
const scope = globalThis as unknown as { onmessage: (event: MessageEvent<PreviewMessage>) => void; postMessage(value: unknown, transfer?: Transferable[]): void };
const sources = new Map<string, PreviewSource>();
const mixCache: ArrangementMixCache = { revision: "" };
scope.onmessage = ({ data }) => {
  if (data.kind === "retain") {
    const retain = new Set(data.retain);
    for (const key of sources.keys()) if (!retain.has(key)) sources.delete(key);
    return;
  }
  if (data.kind === "source") {
    sources.set(data.source.key, data.source);
    return;
  }
  try {
    const retain = new Set(data.retain); for (const key of sources.keys()) if (!retain.has(key)) sources.delete(key);
    const buffers = new Map([...sources].map(([key, source]) => [key, { sampleRate: source.sampleRate, numberOfChannels: source.channels.length, length: source.channels[0].length, getChannelData: (channel: number) => source.channels[channel] }]));
    mixCache.revision = data.revision;
    const pcm = prepareArrangementPcm(data.state, buffers, data.sampleRate, mixCache);
    const left = new Float32Array(pcm.length / 2), right = new Float32Array(pcm.length / 2);
    for (let frame = 0; frame < left.length; frame++) { left[frame] = pcm[frame * 2]; right[frame] = pcm[frame * 2 + 1]; }
    const sourceBytesByKey = Object.fromEntries([...sources].map(([key, source]) => [key, source.channels.reduce((bytes, channel) => bytes + channel.byteLength, 0)]));
    scope.postMessage({ id: data.id, left, right, stats: { mixCacheHit: !!mixCache.hit, retainedMixBytes: mixCache.pcm?.byteLength ?? 0, sourceBytesByKey, sourceBytes: Object.values(sourceBytesByKey).reduce((sum, bytes) => sum + bytes, 0) } }, [left.buffer, right.buffer]);
  } catch (error) { scope.postMessage({ id: data.id, error: error instanceof Error ? error.message : "Arrangement preparation failed." }); }
};
