/** The existing canonical PCM engine runs here, never on the UI thread. */
import {
  addArrangementTrackToMix, arrangementPreMasterCacheKey, finishArrangementMix,
  prepareArrangementPcm, startArrangementMix, MAX_MIX_CACHE_BYTES,
  type ArrangementMixCache, type ArrangementMixPass, type ArrangementPreviewState,
} from "./arrangement-pcm";

export type PreviewSource = { key: string; sampleRate: number; channels: Float32Array[] };
export type PreviewWork = {
  kind: "render"; id: number; state: ArrangementPreviewState; sampleRate: number;
  retain: string[]; revision: string; trackOrder: number[]; lastUseByKey: Record<string, number>;
  warmSourceKeys?: string[]; warmSourceByteBudget?: number;
};
type PreviewMessage =
  | PreviewWork
  | { kind: "source"; source: PreviewSource }
  | { kind: "retain"; retain: string[] }
  | { kind: "release-sources"; id: number }
  | { kind: "render-track"; id: number; trackIndex: number }
  | { kind: "finish-render"; id: number };
type RenderSession = {
  id: number; state: ArrangementPreviewState; sampleRate: number; revision: string;
  trackOrder: number[]; nextTrack: number; lastUseByKey: Record<string, number>;
  warmSourceKeys: Set<string>; warmSourcePriority: string[]; warmSourceByteBudget: number;
  pass: ArrangementMixPass; evictedSourceBytes: number;
};
type SourceStats = {
  mixCacheHit: boolean; retainedMixBytes: number; sourceBytes: number;
  sourceBytesByKey: Record<string, number>; evictedSourceBytes: number; warmSourceBytes: number;
  workerSourcesEvicted: boolean;
};
const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<PreviewMessage>) => void;
  postMessage(value: unknown, transfer?: Transferable[]): void;
};
const sources = new Map<string, PreviewSource>();
const mixCache: ArrangementMixCache = { revision: "" };
let session: RenderSession | null = null;
let warmSourceKeys = new Set<string>();

function sourceBytes(source: PreviewSource) {
  return source.channels.reduce((bytes, channel) => bytes + channel.byteLength, 0);
}
function currentSourceStats(mixCacheHit: boolean, evictedSourceBytes: number): SourceStats {
  const sourceBytesByKey = Object.fromEntries([...sources].map(([key, source]) => [key, sourceBytes(source)]));
  return {
    mixCacheHit, retainedMixBytes: mixCache.pcm?.byteLength ?? 0,
    sourceBytesByKey, sourceBytes: Object.values(sourceBytesByKey).reduce((sum, bytes) => sum + bytes, 0),
    warmSourceBytes: Object.entries(sourceBytesByKey).reduce((sum, [key, bytes]) => sum + (warmSourceKeys.has(key) ? bytes : 0), 0),
    evictedSourceBytes, workerSourcesEvicted: sources.size === 0,
  };
}
function buffersForSources() {
  return new Map([...sources].map(([key, source]) => [key, {
    sampleRate: source.sampleRate, numberOfChannels: source.channels.length,
    length: source.channels[0]?.length ?? 0, getChannelData: (channel: number) => source.channels[channel],
  }]));
}
function postResult(id: number, pcm: Float32Array, mixCacheHit: boolean, evictedSourceBytes: number) {
  const left = new Float32Array(pcm.length / 2), right = new Float32Array(pcm.length / 2);
  for (let frame = 0; frame < left.length; frame++) { left[frame] = pcm[frame * 2]; right[frame] = pcm[frame * 2 + 1]; }
  scope.postMessage({ kind: "result", id, left, right, stats: currentSourceStats(mixCacheHit, evictedSourceBytes) }, [left.buffer, right.buffer]);
}
function fail(id: number, error: unknown) {
  session = null;
  scope.postMessage({ kind: "render-error", id, error: error instanceof Error ? error.message : "Arrangement preparation failed." });
}

scope.onmessage = ({ data }) => {
  if (data.kind === "retain") {
    const retain = new Set(data.retain);
    for (const key of sources.keys()) if (!retain.has(key)) sources.delete(key);
    warmSourceKeys = new Set([...warmSourceKeys].filter(key => retain.has(key)));
    return;
  }
  if (data.kind === "source") {
    sources.set(data.source.key, data.source);
    return;
  }
  if (data.kind === "release-sources") {
    const evictedSourceBytes = [...sources.values()].reduce((sum, source) => sum + sourceBytes(source), 0);
    sources.clear();
    warmSourceKeys.clear();
    scope.postMessage({ kind: "sources-released", id: data.id, stats: currentSourceStats(!!mixCache.hit, evictedSourceBytes) });
    return;
  }
  if (data.kind === "render") {
    try {
      const retain = new Set(data.retain);
      for (const key of sources.keys()) if (!retain.has(key)) sources.delete(key);
      const warmPriority = [...new Set(data.warmSourceKeys ?? [])].filter(key => retain.has(key));
      warmSourceKeys = new Set(warmPriority);
      mixCache.revision = data.revision;
      const key = arrangementPreMasterCacheKey(data.state, data.sampleRate, data.revision);
      if (mixCache.key === key && mixCache.pcm) {
        mixCache.hit = true;
        // A cache-only master edit does not consume source PCM. Drop sources
        // that are no longer in the explicitly selected working set.
        for (const sourceKey of sources.keys()) if (!warmSourceKeys.has(sourceKey)) sources.delete(sourceKey);
        const pcm = prepareArrangementPcm(data.state, buffersForSources(), data.sampleRate, mixCache);
        postResult(data.id, pcm, true, 0);
        return;
      }
      mixCache.hit = false; mixCache.pcm = undefined; mixCache.key = undefined;
      session = {
        id: data.id, state: data.state, sampleRate: data.sampleRate, revision: data.revision,
        trackOrder: data.trackOrder, nextTrack: 0, lastUseByKey: data.lastUseByKey,
        warmSourceKeys, warmSourcePriority: warmPriority,
        warmSourceByteBudget: Math.max(0, Math.floor(data.warmSourceByteBudget ?? 0)),
        pass: startArrangementMix(data.state, data.sampleRate), evictedSourceBytes: 0,
      };
    } catch (error) { fail(data.id, error); }
    return;
  }
  if (data.kind === "render-track") {
    try {
      if (!session || session.id !== data.id) throw new Error("Arrangement track render is out of sequence.");
      const expectedTrackIndex = session.trackOrder[session.nextTrack];
      if (expectedTrackIndex !== data.trackIndex) throw new Error("Arrangement track render is out of sequence.");
      const track = session.state.tracks[data.trackIndex];
      if (!track) throw new Error("Arrangement track is unavailable.");
      addArrangementTrackToMix(session.pass, session.state, track, buffersForSources(), session.sampleRate);
      for (const [key, source] of sources) {
        if ((session.lastUseByKey[key] ?? -1) <= data.trackIndex && !session.warmSourceKeys.has(key)) {
          session.evictedSourceBytes += sourceBytes(source);
          sources.delete(key);
        }
      }
      // Keep only completed, explicitly selected sources, in selection
      // priority order, and never exceed the per-worker PCM byte budget.
      let warmBytes = 0;
      const keepWarm = new Set<string>();
      for (const key of session.warmSourcePriority) {
        const source = sources.get(key);
        if (!source || (session.lastUseByKey[key] ?? -1) > data.trackIndex) continue;
        const bytes = sourceBytes(source);
        if (warmBytes + bytes <= session.warmSourceByteBudget) {
          keepWarm.add(key);
          warmBytes += bytes;
        } else {
          session.evictedSourceBytes += bytes;
          sources.delete(key);
        }
      }
      for (const [key, source] of sources) {
        if (session.warmSourceKeys.has(key) &&
            (session.lastUseByKey[key] ?? -1) <= data.trackIndex &&
            !keepWarm.has(key)) {
          session.evictedSourceBytes += sourceBytes(source);
          sources.delete(key);
        }
      }
      session.nextTrack++;
      scope.postMessage({ kind: "track-rendered", id: data.id, trackIndex: data.trackIndex,
        stats: currentSourceStats(false, session.evictedSourceBytes) });
    } catch (error) { fail(data.id, error); }
    return;
  }
  if (data.kind === "finish-render") {
    try {
      if (!session || session.id !== data.id || session.nextTrack !== session.trackOrder.length) {
        throw new Error("Arrangement render finished before all tracks completed.");
      }
      const current = session;
      if (current.pass.mix.byteLength <= MAX_MIX_CACHE_BYTES) {
        mixCache.pcm = current.pass.mix.slice();
        mixCache.key = arrangementPreMasterCacheKey(current.state, current.sampleRate, current.revision);
      }
      const pcm = finishArrangementMix(current.pass.mix, current.state, current.sampleRate, current.pass.drySamples);
      // Drop the reusable dry scratch and any pre-master render array that
      // master processing replaced before allocating the planar transfer pair.
      current.pass.scratch = null;
      current.pass.mix = pcm;
      session = null;
      postResult(data.id, pcm, false, current.evictedSourceBytes);
    } catch (error) { fail(data.id, error); }
  }
};
