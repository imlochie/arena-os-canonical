// Only instrumentation; all loading, caching, transformation and DSP are the
// same controller used by StudioCore. Never a replacement transport/processor.
import { ArrangementPreparation } from "../../src/lib/waveyard/arrangement-preparation";
import type { ArrangementPreviewState } from "../../src/lib/waveyard/arrangement-pcm";
const WORKER_SOURCE_IDLE_EVICTION_MS = 5_000;
let heldMeasurement: { engine: ArrangementPreparation; context: AudioContext; buffer: AudioBuffer; changed: AudioBuffer } | null = null;
Object.assign(window, { async releasePreparationMeasurement() {
  heldMeasurement?.engine.dispose(); await heldMeasurement?.context.close(); heldMeasurement = null;
} });
async function stereoPcmHash(buffer: AudioBuffer) {
  // Complete planar stereo float32 PCM, L then R, not sparse sample probes.
  const pcm = new Float32Array(buffer.length * buffer.numberOfChannels);
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) pcm.set(buffer.getChannelData(channel), channel * buffer.length);
  const digest = await crypto.subtle.digest("SHA-256", pcm.buffer);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
Object.assign(window, { async measurePreparation(state: ArrangementPreviewState, retainForMeasurement = false, expectWorkerEviction = false, activeTrackIds: string[] = []) {
  const context = new AudioContext({ sampleRate: 44100 }), engine = new ArrangementPreparation();
  const NativeWorker = window.Worker;
  const originalFetch = window.fetch;
  let assetFetches = 0, decodeCalls = 0, decodeMs = 0;
  const stageMetrics: Record<string, number> = {
    assetFetchMs: 0, responseBodyMs: 0, recoveryArrayBufferMs: 0,
    sourceChannelCopyMs: 0, sourceTransferPostMs: 0, workerTrackAckMs: 0,
    workerRenderResultMs: 0, workerFinishAckMs: 0,
    encodedRecoveryLookupMs: 0, encodedRecoveryLookupCount: 0,
    decodedOwnerLookupMs: 0, decodedOwnerLookupCount: 0,
    workerSourceCacheLookupMs: 0, workerSourceCacheLookupCount: 0, workerSourceCacheHits: 0,
  };
  const stageSnapshot = () => ({ ...stageMetrics, decodeMs, decodeCalls });
  const stageDelta = (before: Record<string, number>) => Object.fromEntries(
    Object.entries(stageSnapshot()).map(([key, value]) => [key, value - (before[key] ?? 0)]),
  );
  const trackedRecoveryBlobs = new WeakSet<Blob>();
  const nativeBlobArrayBuffer = Blob.prototype.arrayBuffer;
  Blob.prototype.arrayBuffer = async function() {
    const started = performance.now();
    try { return await nativeBlobArrayBuffer.call(this); }
    finally { if (trackedRecoveryBlobs.has(this)) stageMetrics.recoveryArrayBufferMs += performance.now() - started; }
  };
  const sourceChannelViews = new WeakSet<Float32Array>();
  const nativeGetChannelData = AudioBuffer.prototype.getChannelData;
  AudioBuffer.prototype.getChannelData = function(channel: number) {
    const view = nativeGetChannelData.call(this, channel);
    sourceChannelViews.add(view);
    return view;
  };
  const nativeFloat32Slice = Float32Array.prototype.slice;
  Float32Array.prototype.slice = function(start?: number, end?: number) {
    const measure = sourceChannelViews.has(this), started = measure ? performance.now() : 0;
    try { return nativeFloat32Slice.call(this, start, end); }
    finally { if (measure) stageMetrics.sourceChannelCopyMs += performance.now() - started; }
  };
  window.fetch = (input, init) => {
    if (!String(input).startsWith("/api/assets/")) return originalFetch(input, init);
    assetFetches++;
    const started = performance.now();
    return originalFetch(input, init).then(response => {
      stageMetrics.assetFetchMs += performance.now() - started;
      const readBlob = response.blob.bind(response);
      response.blob = async () => {
        const bodyStarted = performance.now();
        try { const blob = await readBlob(); trackedRecoveryBlobs.add(blob); return blob; }
        finally { stageMetrics.responseBodyMs += performance.now() - bodyStarted; }
      };
      return response;
    });
  };
  const nativeDecode = context.decodeAudioData.bind(context);
  Object.defineProperty(context, "decodeAudioData", { configurable: true, value: async (data: ArrayBuffer) => {
    decodeCalls++; const started = performance.now();
    try { return await nativeDecode(data); } finally { decodeMs += performance.now() - started; }
  } });
  const workerSourceBytes = new Map<string, number>();
  const workerSourceBytesAfterTrack: { trackIndex: number; sourceBytes: number }[] = [];
  const workerMessageStarts = new Map<string, number>();
  let peakAccountedSourcePcmOverlapBytes = 0;
  let peakDecodedSourceBytes = 0;
  let peakWorkerSourceBytes = 0;
  const internals = engine as unknown as { decoded?: Map<string, AudioBuffer> };
  const restoreMapMethods: (() => void)[] = [];
  const instrumentMapLookups = (map: Map<unknown, unknown> | undefined, prefix: string) => {
    if (!map) return;
    const ownGet = Object.prototype.hasOwnProperty.call(map, "get");
    const originalGet = map.get;
    map.get = function(key: unknown) {
      const started = performance.now();
      try { return originalGet.call(this, key); }
      finally {
        stageMetrics[`${prefix}LookupMs`] += performance.now() - started;
        stageMetrics[`${prefix}LookupCount`]++;
      }
    };
    const ownHas = Object.prototype.hasOwnProperty.call(map, "has");
    const originalHas = map.has;
    map.has = function(key: unknown) {
      const started = performance.now();
      try { return originalHas.call(this, key); }
      finally {
        stageMetrics[`${prefix}LookupMs`] += performance.now() - started;
        stageMetrics[`${prefix}LookupCount`]++;
      }
    };
    restoreMapMethods.push(() => {
      if (ownGet) map.get = originalGet; else Reflect.deleteProperty(map, "get");
      if (ownHas) map.has = originalHas; else Reflect.deleteProperty(map, "has");
    });
  };
  instrumentMapLookups(internals.decoded as Map<unknown, unknown> | undefined, "decodedOwner");
  instrumentMapLookups((engine as unknown as { encodedRecovery?: Map<string, Blob> }).encodedRecovery as Map<unknown, unknown> | undefined, "encodedRecovery");
  const sentSet = (engine as unknown as { sent?: Set<string> }).sent;
  let restoreSentHas = () => {};
  if (sentSet) {
    const ownHas = Object.prototype.hasOwnProperty.call(sentSet, "has"), originalHas = sentSet.has;
    sentSet.has = function(key: string) {
      const started = performance.now();
      try { const hit = originalHas.call(this, key); if (hit) stageMetrics.workerSourceCacheHits++; return hit; }
      finally { stageMetrics.workerSourceCacheLookupMs += performance.now() - started; stageMetrics.workerSourceCacheLookupCount++; }
    };
    restoreSentHas = () => { if (ownHas) sentSet.has = originalHas; else Reflect.deleteProperty(sentSet, "has"); };
  }
  window.Worker = class extends NativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      this.addEventListener("message", event => {
        const data = event.data as { kind?: string; id?: number; trackIndex?: number; left?: Float32Array; right?: Float32Array; stats?: { workerSourcesEvicted?: boolean; sourceBytes?: number; sourceBytesByKey?: Record<string, number> } };
        if (data.kind === "track-rendered" && data.stats?.sourceBytesByKey) {
          const started = workerMessageStarts.get(`track:${data.id}:${data.trackIndex}`);
          if (started !== undefined) { stageMetrics.workerTrackAckMs += performance.now() - started; workerMessageStarts.delete(`track:${data.id}:${data.trackIndex}`); }
          workerSourceBytes.clear();
          for (const [key, bytes] of Object.entries(data.stats.sourceBytesByKey)) workerSourceBytes.set(key, bytes);
          workerSourceBytesAfterTrack.push({ trackIndex: data.trackIndex ?? -1, sourceBytes: data.stats.sourceBytes ?? 0 });
        }
        if (data.kind === "result" || (!data.kind && data.left instanceof Float32Array && data.right instanceof Float32Array)) {
          const renderStarted = workerMessageStarts.get(`render:${data.id}`);
          if (renderStarted !== undefined) { stageMetrics.workerRenderResultMs += performance.now() - renderStarted; workerMessageStarts.delete(`render:${data.id}`); }
          const finishStarted = workerMessageStarts.get(`finish:${data.id}`);
          if (finishStarted !== undefined) { stageMetrics.workerFinishAckMs += performance.now() - finishStarted; workerMessageStarts.delete(`finish:${data.id}`); }
        }
        if (data.stats?.workerSourcesEvicted) workerSourceBytes.clear();
      });
    }
    postMessage(message: unknown, options?: Transferable[] | StructuredSerializeOptions) {
      const payload = message as {
        kind?: string;
        source?: { key: string; channels: Float32Array[] };
        sources?: { key: string; channels: Float32Array[] }[];
        retain?: string[];
      };
      const added = payload.kind === "source" && payload.source
        ? [payload.source]
        : Array.isArray(payload.sources) ? payload.sources : [];
      const addedBytes = added.map(source => [
        source.key,
        source.channels.reduce((sum, channel) => sum + channel.byteLength, 0),
      ] as const);
      const started = performance.now();
      if (payload.kind === "render") workerMessageStarts.set(`render:${(message as { id?: number }).id}`, started);
      else if (payload.kind === "render-track") {
        const value = message as { id?: number; trackIndex?: number };
        workerMessageStarts.set(`track:${value.id}:${value.trackIndex}`, started);
      } else if (payload.kind === "finish-render") workerMessageStarts.set(`finish:${(message as { id?: number }).id}`, started);
      try {
        if (Array.isArray(options)) super.postMessage(message, options);
        else super.postMessage(message, options);
      } finally {
        if (payload.kind === "source") stageMetrics.sourceTransferPostMs += performance.now() - started;
      }
      if (payload.retain) {
        const retained = new Set(payload.retain);
        for (const key of workerSourceBytes.keys()) if (!retained.has(key)) workerSourceBytes.delete(key);
      }
      for (const [key, bytes] of addedBytes) workerSourceBytes.set(key, bytes);
      const decodedBytes = [...(internals.decoded?.values() ?? [])]
        .reduce((sum, buffer) => sum + buffer.length * buffer.numberOfChannels * 4, 0);
      const workerBytes = [...workerSourceBytes.values()].reduce((sum, bytes) => sum + bytes, 0);
      peakDecodedSourceBytes = Math.max(peakDecodedSourceBytes, decodedBytes);
      peakWorkerSourceBytes = Math.max(peakWorkerSourceBytes, workerBytes);
      peakAccountedSourcePcmOverlapBytes = Math.max(peakAccountedSourcePcmOverlapBytes, decodedBytes + workerBytes);
    }
  } as typeof Worker;
  let last = performance.now(), maximumGapMs = 0, ticks = 0;
  const timer = setInterval(() => { const now = performance.now(); maximumGapMs = Math.max(maximumGapMs, now - last); last = now; ticks++; }, 5);
  try {
    const started = performance.now();
    const coldStageStart = stageSnapshot();
    const coldFetchStart = assetFetches, coldDecodeStart = decodeCalls, coldDecodeTime = decodeMs;
    const buffer = await engine.prepare(state, context, "", new Map(), activeTrackIds); const readyMs = performance.now() - started;
    const coldStageBreakdown = stageDelta(coldStageStart);
    const coldDiagnostics = engine.diagnostics;
    const coldWorkerSourceBytesAfterTrack = workerSourceBytesAfterTrack.splice(0);
    const coldFetches = assetFetches - coldFetchStart, coldDecodeCalls = decodeCalls - coldDecodeStart, coldDecodeMs = decodeMs - coldDecodeTime;
    await new Promise(resolve => setTimeout(resolve, 15));
    const replayStageStart = stageSnapshot();
    const replayFetchStart = assetFetches, replayDecodeStart = decodeCalls;
    const cached = performance.now(); const replay = await engine.prepare(state, context, "", new Map(), activeTrackIds); const replayMs = performance.now() - cached;
    const replayStageBreakdown = stageDelta(replayStageStart);
    const replayFetches = assetFetches - replayFetchStart, replayDecodeCalls = decodeCalls - replayDecodeStart;
    const replaySame = replay === buffer;
    if (!replaySame) throw new Error("Replay did not retain the actual finished musical buffer.");
    const edited = structuredClone(state); edited.masterVolume *= 0.5;
    const masterStageStart = stageSnapshot();
    const masterFetchStart = assetFetches, masterDecodeStart = decodeCalls, masterDecodeTime = decodeMs;
    const editStart = performance.now(); const changed = await engine.prepare(edited, context, "", new Map(), activeTrackIds); const editMs = performance.now() - editStart;
    const masterStageBreakdown = stageDelta(masterStageStart);
    const masterEditFetches = assetFetches - masterFetchStart, masterEditDecodeCalls = decodeCalls - masterDecodeStart, masterEditDecodeMs = decodeMs - masterDecodeTime;
    const masterDiagnostics = engine.diagnostics;
    const activeTrackSet = new Set(activeTrackIds);
    const hotTrackId = activeTrackIds[0] ?? state.tracks[0]?.id;
    const coldTrackId = state.tracks.find(track => !activeTrackSet.has(track.id))?.id ?? state.tracks.find(track => track.id !== hotTrackId)?.id ?? hotTrackId;
    const trackEdited = structuredClone(state);
    const hotTrack = trackEdited.tracks.find(track => track.id === hotTrackId);
    if (hotTrack) hotTrack.volume *= 0.5;
    const hotStageStart = stageSnapshot();
    const trackFetchStart = assetFetches, trackDecodeStart = decodeCalls, trackDecodeTime = decodeMs;
    const trackEditStart = performance.now(); const trackChanged = await engine.prepare(trackEdited, context, "", new Map(), activeTrackIds); const trackEditMs = performance.now() - trackEditStart;
    const hotStageBreakdown = stageDelta(hotStageStart);
    const trackEditFetches = assetFetches - trackFetchStart, trackEditDecodeCalls = decodeCalls - trackDecodeStart, trackEditDecodeMs = decodeMs - trackDecodeTime;
    const trackDiagnostics = engine.diagnostics;
    const repeatedHotTrack = structuredClone(trackEdited);
    const repeatedHotTrackState = repeatedHotTrack.tracks.find(track => track.id === hotTrackId);
    if (repeatedHotTrackState) repeatedHotTrackState.volume *= 0.75;
    const repeatedHotStageStart = stageSnapshot();
    const repeatedHotFetchStart = assetFetches, repeatedHotDecodeStart = decodeCalls, repeatedHotDecodeTime = decodeMs;
    const repeatedHotStarted = performance.now(); const repeatedHotBuffer = await engine.prepare(repeatedHotTrack, context, "", new Map(), activeTrackIds);
    const repeatedHotTrackEditMs = performance.now() - repeatedHotStarted;
    const repeatedHotStageBreakdown = stageDelta(repeatedHotStageStart);
    const repeatedHotTrackEditFetches = assetFetches - repeatedHotFetchStart;
    const repeatedHotTrackEditDecodeCalls = decodeCalls - repeatedHotDecodeStart;
    const repeatedHotTrackEditDecodeMs = decodeMs - repeatedHotDecodeTime;
    const repeatedHotDiagnostics = engine.diagnostics;
    const coldTrack = structuredClone(state);
    const coldTrackState = coldTrack.tracks.find(track => track.id === coldTrackId);
    if (coldTrackState) coldTrackState.volume *= 0.5;
    const coldTrackStageStart = stageSnapshot();
    const coldTrackFetchStart = assetFetches, coldTrackDecodeStart = decodeCalls, coldTrackDecodeTime = decodeMs;
    const coldTrackEditStarted = performance.now(); const coldTrackBuffer = await engine.prepare(coldTrack, context, "", new Map(), activeTrackIds);
    const coldTrackEditMs = performance.now() - coldTrackEditStarted;
    const coldTrackStageBreakdown = stageDelta(coldTrackStageStart);
    const coldTrackEditFetches = assetFetches - coldTrackFetchStart;
    const coldTrackEditDecodeCalls = decodeCalls - coldTrackDecodeStart;
    const coldTrackEditDecodeMs = decodeMs - coldTrackDecodeTime;
    const coldTrackDiagnostics = engine.diagnostics;
    const waitForIdle = async () => {
      const waitStarted = performance.now();
      if (expectWorkerEviction) {
        const deadline = waitStarted + WORKER_SOURCE_IDLE_EVICTION_MS + 10_000;
        while (!(engine.diagnostics.workerSourcesEvicted && engine.diagnostics.sourceBytes === 0)) {
          if (performance.now() >= deadline) throw new Error("Prototype 3 did not acknowledge idle Worker source eviction.");
          await new Promise(resolve => setTimeout(resolve, 25));
        }
      }
      const remaining = WORKER_SOURCE_IDLE_EVICTION_MS + 100 - (performance.now() - waitStarted);
      if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
      return performance.now() - waitStarted;
    };
    const firstIdleWaitMs = await waitForIdle();
    const idleDiagnostics = engine.diagnostics;
    const postIdleMaster = structuredClone(coldTrack); postIdleMaster.masterVolume *= 0.75;
    const postIdleMasterStageStart = stageSnapshot();
    const postIdleMasterFetchStart = assetFetches, postIdleMasterDecodeStart = decodeCalls, postIdleMasterDecodeTime = decodeMs;
    const postIdleMasterStarted = performance.now(); const postIdleMasterBuffer = await engine.prepare(postIdleMaster, context, "", new Map(), activeTrackIds);
    const postIdleMasterEditMs = performance.now() - postIdleMasterStarted;
    const postIdleMasterStageBreakdown = stageDelta(postIdleMasterStageStart);
    const postIdleMasterEditFetches = assetFetches - postIdleMasterFetchStart;
    const postIdleMasterEditDecodeCalls = decodeCalls - postIdleMasterDecodeStart;
    const postIdleMasterEditDecodeMs = decodeMs - postIdleMasterDecodeTime;
    const postIdleMasterDiagnostics = engine.diagnostics;
    const postIdleTrack = structuredClone(coldTrack);
    const postIdleTrackState = postIdleTrack.tracks.find(track => track.id === coldTrackId);
    if (postIdleTrackState) postIdleTrackState.volume *= 0.75;
    const postIdleTrackStageStart = stageSnapshot();
    const postIdleTrackFetchStart = assetFetches, postIdleTrackDecodeStart = decodeCalls, postIdleTrackDecodeTime = decodeMs;
    const postIdleTrackStarted = performance.now(); const postIdleTrackBuffer = await engine.prepare(postIdleTrack, context, "", new Map(), activeTrackIds);
    const postIdleTrackEditMs = performance.now() - postIdleTrackStarted;
    const postIdleTrackStageBreakdown = stageDelta(postIdleTrackStageStart);
    const postIdleTrackEditFetches = assetFetches - postIdleTrackFetchStart;
    const postIdleTrackEditDecodeCalls = decodeCalls - postIdleTrackDecodeStart;
    const postIdleTrackEditDecodeMs = decodeMs - postIdleTrackDecodeTime;
    const postIdleTrackDiagnostics = engine.diagnostics;
    const finalIdleWaitMs = await waitForIdle();
    const finalDiagnostics = engine.diagnostics;
    // Let the sampler observe preparation's last UI task, then stop it BEFORE
    // test-only full-PCM verification. Millions of WebAudio accessor calls in
    // that verification used to masquerade as a production UI stall on CI.
    await new Promise(resolve => setTimeout(resolve, 15));
    const preparationMaximumGapMs = maximumGapMs; clearInterval(timer);
    const verificationStarted = performance.now(), changedSamples = changed.getChannelData(0), originalSamples = buffer.getChannelData(0);
    let error = 0; for (let frame = 0; frame < buffer.length; frame++) error = Math.max(error, Math.abs(changedSamples[frame] - originalSamples[frame] * 0.5));
    const verificationMs = performance.now() - verificationStarted;
    const pcmSha256 = await stereoPcmHash(buffer), editedPcmSha256 = await stereoPcmHash(changed);
    const trackEditedPcmSha256 = await stereoPcmHash(trackChanged), repeatedHotTrackEditedPcmSha256 = await stereoPcmHash(repeatedHotBuffer);
    const coldTrackEditedPcmSha256 = await stereoPcmHash(coldTrackBuffer);
    const postIdleMasterPcmSha256 = await stereoPcmHash(postIdleMasterBuffer), postIdleTrackPcmSha256 = await stereoPcmHash(postIdleTrackBuffer);
    if (retainForMeasurement) heldMeasurement = { engine, context, buffer, changed };
    return {
      pcmSha256, editedPcmSha256, trackEditedPcmSha256, repeatedHotTrackEditedPcmSha256, coldTrackEditedPcmSha256,
      postIdleMasterPcmSha256, postIdleTrackPcmSha256,
      readyMs, replayMs, editMs, trackEditMs, maximumGapMs: preparationMaximumGapMs,
      verificationMs, ticks, frames: buffer.length, latestEditError: error, outputPlanarBytes: buffer.length * 2 * 4,
      stageBreakdown: {
        initial: coldStageBreakdown, replay: replayStageBreakdown, masterEdit: masterStageBreakdown,
        hotTrackEdit: hotStageBreakdown, repeatedHotTrackEdit: repeatedHotStageBreakdown,
        coldTrackEdit: coldTrackStageBreakdown, postIdleMasterEdit: postIdleMasterStageBreakdown,
        postIdleTrackEdit: postIdleTrackStageBreakdown,
      },
      peakAccountedSourcePcmOverlapBytes, peakDecodedSourceBytes, peakWorkerSourceBytes,
        workerSourceBytesAfterTrack: coldWorkerSourceBytesAfterTrack, coldWorkerSourceBytes: coldDiagnostics.sourceBytes ?? 0,
       coldEvictedSourceBytes: coldDiagnostics.evictedSourceBytes ?? 0,
      replaySame,
      coldFetches, coldDecodeCalls, coldDecodeMs, replayFetches, replayDecodeCalls,
      masterEditFetches, masterEditDecodeCalls, masterEditDecodeMs,
      trackEditFetches, trackEditDecodeCalls, trackEditDecodeMs,
      trackEditWorkerSourceBytes: trackDiagnostics.sourceBytes ?? 0,
       warmSourceBytes: coldDiagnostics.warmSourceBytes ?? 0,
       warmSourceBytesAfterHotEdit: trackDiagnostics.warmSourceBytes ?? 0,
       warmSourceBytesAfterRepeatedHotEdit: repeatedHotDiagnostics.warmSourceBytes ?? 0,
       warmSourceBytesAfterColdEdit: coldTrackDiagnostics.warmSourceBytes ?? 0,
       repeatedHotTrackEditMs, repeatedHotTrackEditFetches, repeatedHotTrackEditDecodeCalls, repeatedHotTrackEditDecodeMs,
       repeatedHotTrackMixCacheHit: repeatedHotDiagnostics.mixCacheHit ?? false,
       coldTrackEditMs, coldTrackEditFetches, coldTrackEditDecodeCalls, coldTrackEditDecodeMs,
       coldTrackEditWorkerSourceBytes: coldTrackDiagnostics.sourceBytes ?? 0,
       coldTrackEditMixCacheHit: coldTrackDiagnostics.mixCacheHit ?? false,
      firstIdleWaitMs, idleWorkerSourceBytes: idleDiagnostics.sourceBytes ?? 0,
      idleWorkerSourcesEvicted: idleDiagnostics.workerSourcesEvicted ?? false,
      postIdleMasterEditMs, postIdleMasterEditFetches, postIdleMasterEditDecodeCalls, postIdleMasterEditDecodeMs,
      postIdleMasterMixCacheHit: postIdleMasterDiagnostics.mixCacheHit ?? false,
      postIdleMasterWorkerSourceBytes: postIdleMasterDiagnostics.sourceBytes ?? 0,
      postIdleTrackEditMs, postIdleTrackEditFetches, postIdleTrackEditDecodeCalls, postIdleTrackEditDecodeMs,
      postIdleTrackMixCacheHit: postIdleTrackDiagnostics.mixCacheHit ?? false,
      postIdleTrackWorkerSourceBytes: postIdleTrackDiagnostics.sourceBytes ?? 0,
      finalIdleWaitMs,
      masterMixCacheHit: masterDiagnostics.mixCacheHit ?? false, masterRetainedMixBytes: masterDiagnostics.retainedMixBytes ?? 0,
      masterWorkerSourceBytes: masterDiagnostics.sourceBytes ?? 0, masterDecodedBytes: masterDiagnostics.decodedBytes,
      trackEditMixCacheHit: trackDiagnostics.mixCacheHit ?? false,
      diagnostics: finalDiagnostics,
    };
  } finally {
    clearInterval(timer);
    if (!retainForMeasurement || !heldMeasurement) { engine.dispose(); await context.close(); }
    for (const restore of restoreMapMethods) restore();
    restoreSentHas();
    Blob.prototype.arrayBuffer = nativeBlobArrayBuffer;
    AudioBuffer.prototype.getChannelData = nativeGetChannelData;
    Float32Array.prototype.slice = nativeFloat32Slice;
    window.Worker = NativeWorker; window.fetch = originalFetch;
  }
} });

Object.assign(window, { async verifyWarmSourceBudget(state: ArrangementPreviewState, activeTrackIds: string[]) {
  const context = new AudioContext({ sampleRate: 44100 }), engine = new ArrangementPreparation();
  try {
    const buffer = await engine.prepare(state, context, "", new Map(), activeTrackIds);
    const diagnostics = engine.diagnostics;
    const priorityKeys = activeTrackIds.flatMap(trackId =>
      state.tracks.find(track => track.id === trackId)?.clips.map(clip => clip.stemAssetId) ?? []);
    return {
      frames: buffer.length, warmSourceBytes: diagnostics.warmSourceBytes ?? 0,
      sourceBytes: diagnostics.sourceBytes ?? 0,
      sourceBytesByKey: diagnostics.sourceBytesByKey ?? {},
      priorityKeys,
    };
  } finally { engine.dispose(); await context.close(); }
} });

Object.assign(window, { async verifyWarmSourceTransitions(state: ArrangementPreviewState) {
  const context = new AudioContext({ sampleRate: 44100 }), engine = new ArrangementPreparation();
  const originalFetch = window.fetch;
  let fetches = 0, outageFetches = 0, outage = false;
  window.fetch = (...args) => {
    if (String(args[0]).startsWith("/api/assets/")) {
      if (outage) { outageFetches++; return Promise.reject(new TypeError("Controlled source endpoint outage")); }
      fetches++;
    }
    return originalFetch(...args);
  };
  const firstTrack = state.tracks[0], secondTrack = state.tracks[1];
  try {
    if (!firstTrack || !secondTrack) throw new Error("Two distinct tracks are required.");
    await engine.prepare(state, context, "", new Map(), [firstTrack.id]);
    const firstDiagnostics = engine.diagnostics;
    outage = true;
    const switched = structuredClone(state); switched.tracks[0].volume *= 0.8;
    const switchedBuffer = await engine.prepare(switched, context, "", new Map(), [secondTrack.id]);
    const switchedHash = await stereoPcmHash(switchedBuffer), switchedDiagnostics = engine.diagnostics;
    const later = structuredClone(switched); later.tracks[0].volume *= 0.75;
    const laterBuffer = await engine.prepare(later, context, "", new Map(), [secondTrack.id]);
    const laterHash = await stereoPcmHash(laterBuffer);
    const pending = engine.prepare(switched, context, "", new Map(), [firstTrack.id]);
    engine.cancel();
    let cancelled = "";
    try { await pending; } catch (error) { cancelled = error instanceof Error ? error.name : String(error); }
    const recovered = await engine.prepare(switched, context, "", new Map(), [firstTrack.id]);
    const recoveredHash = await stereoPcmHash(recovered), recoveredDiagnostics = engine.diagnostics;
    const internals = engine as unknown as { worker: Worker | null };
    const failedWorker = internals.worker;
    if (!failedWorker) throw new Error("Warm preparation did not create its real Worker.");
    failedWorker.dispatchEvent(new ErrorEvent("error", { message: "Controlled warm Worker failure" }));
    const afterFailure = await engine.prepare(later, context, "", new Map(), [secondTrack.id]);
    const afterFailureHash = await stereoPcmHash(afterFailure);
    const workerReplaced = internals.worker !== null && internals.worker !== failedWorker;
    const replaySame = await engine.prepare(later, context, "", new Map(), [secondTrack.id]) === afterFailure;
    const master = structuredClone(later); master.masterVolume *= 0.8;
    await engine.prepare(master, context, "", new Map(), [secondTrack.id]);
    return {
      fetches, outageFetches, cancelled, switchedHash, recoveredHash, laterHash, afterFailureHash,
      workerReplaced, replaySame, masterMixCacheHit: engine.diagnostics.mixCacheHit,
      firstDiagnostics, switchedDiagnostics, recoveredDiagnostics,
    };
  } finally { engine.dispose(); window.fetch = originalFetch; await context.close(); }
} });

Object.assign(window, { async verifyPreparationLifecycle(state: ArrangementPreviewState, outageAfterCancel = false) {
  const context = new AudioContext({ sampleRate: 44100 }), engine = new ArrangementPreparation();
  const originalFetch = window.fetch, NativeWorker = window.Worker;
  let fetches = 0, created = 0, terminated = 0, outage = false;
  let onWork: (() => void) | undefined;
  window.fetch = (...args) => { fetches++; return outage ? Promise.reject(new TypeError("Controlled source endpoint outage")) : originalFetch(...args); };
  window.Worker = class extends NativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) { super(url, options); created++; }
    postMessage(message: unknown, options?: Transferable[] | StructuredSerializeOptions) {
      if (Array.isArray(options)) super.postMessage(message, options); else super.postMessage(message, options);
      const kind = (message as { kind?: string }).kind;
      if (!kind || kind === "render") onWork?.();
    }
    terminate() { terminated++; super.terminate(); }
  } as typeof Worker;
  try {
    const first = await engine.prepare(state, context);
    const coldFetches = fetches;
    const initialDiagnostics = engine.diagnostics;
    const edit = structuredClone(state); edit.masterVolume *= 0.25;
    const workPosted = new Promise<void>(resolve => { onWork = resolve; });
    const pending = engine.prepare(edit, context).then(() => "unexpected success", error => error.name);
    await workPosted; onWork = undefined;
    engine.cancel();
    const cancelled = await pending;
    outage = outageAfterCancel;
    const latest = structuredClone(state); latest.masterVolume *= 0.5;
    const recoveryStarted = performance.now();
    const result = await engine.prepare(latest, context);
    const recoveryMs = performance.now() - recoveryStarted;
    const recoveredDiagnostics = engine.diagnostics;
    let error = 0;
    for (let frame = 0; frame < first.length; frame++) error = Math.max(error, Math.abs(result.getChannelData(0)[frame] - first.getChannelData(0)[frame] * 0.5));
    const afterEditFetches = fetches;
    const cached = await engine.prepare(latest, context);
    engine.dispose();
    const disposedDiagnostics = engine.diagnostics;
    const disposedWorkers = { created, terminated };
    outage = false;
    await engine.prepare(state, context, "reopened-source-revision");
    return {
      coldFetches, afterEditFetches, reopenedFetches: fetches, cancelled, latestError: error, recoveryMs,
      replaySame: cached === result, disposedWorkers,
      initialDiagnostics, recoveredDiagnostics, disposedDiagnostics,
    };
  } finally { engine.dispose(); window.fetch = originalFetch; window.Worker = NativeWorker; await context.close(); }
} });

Object.assign(window, { async verifyWorkerErrorDuringOutage(state: ArrangementPreviewState, expectWorkerEviction = false) {
  const context = new AudioContext({ sampleRate: 44100 }), engine = new ArrangementPreparation();
  const originalFetch = window.fetch, NativeWorker = window.Worker;
  let fetches = 0, outageFetches = 0, outage = false, activeWorker: Worker | null = null;
  window.fetch = (...args) => {
    if (String(args[0]).startsWith("/api/assets/")) {
      fetches++;
      if (outage) { outageFetches++; return Promise.reject(new TypeError("Controlled source endpoint outage")); }
    }
    return originalFetch(...args);
  };
  window.Worker = class extends NativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) { super(url, options); activeWorker = this; }
  } as typeof Worker;
  try {
    const first = await engine.prepare(state, context);
    const firstDiagnostics = engine.diagnostics;
    const idleWaitStarted = performance.now();
    if (expectWorkerEviction) {
      const deadline = idleWaitStarted + WORKER_SOURCE_IDLE_EVICTION_MS + 10_000;
      while (!(engine.diagnostics.workerSourcesEvicted && engine.diagnostics.sourceBytes === 0)) {
        if (performance.now() >= deadline) throw new Error("The candidate did not evict Worker sources before the outage recovery test.");
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    const remainingIdleWindow = WORKER_SOURCE_IDLE_EVICTION_MS + 100 - (performance.now() - idleWaitStarted);
    if (remainingIdleWindow > 0) await new Promise(resolve => setTimeout(resolve, remainingIdleWindow));
    const idleDiagnostics = engine.diagnostics;
    outage = true;
    const workerToFail = activeWorker as unknown as Worker | null;
    if (!workerToFail) throw new Error("Preparation did not create its real Worker.");
    // Deliver a controlled error event to the actual Worker instance so the
    // controller's production onerror path must discard that worker and recover
    // from its local decoded/encoded owner while the endpoint is unavailable.
    workerToFail.dispatchEvent(new ErrorEvent("error", { message: "Controlled Worker failure" }));
    const edited = structuredClone(state); if (edited.tracks[0]) edited.tracks[0].volume *= 0.75;
    const recoveryStarted = performance.now();
    const recovered = await engine.prepare(edited, context);
    const recoveryMs = performance.now() - recoveryStarted;
    let outputError = 0;
    for (let frame = 0; frame < first.length; frame++) outputError = Math.max(outputError, Math.abs(recovered.getChannelData(0)[frame] - first.getChannelData(0)[frame] * 0.75));
    return { fetches, outageFetches, outputError, recoveryMs, firstFrames: first.length, recoveredFrames: recovered.length,
      firstDiagnostics, idleDiagnostics, recoveredDiagnostics: engine.diagnostics };
  } finally { engine.dispose(); window.fetch = originalFetch; window.Worker = NativeWorker; await context.close(); }
} });

Object.assign(window, { async verifyRemovedTrackRecovery(state: ArrangementPreviewState) {
  if (state.tracks.length < 2) throw new Error("Track-removal recovery requires two distinct sources.");
  const context = new AudioContext({ sampleRate: 44100 }), engine = new ArrangementPreparation();
  const originalFetch = window.fetch;
  let assetFetches = 0;
  window.fetch = (...args) => { if (String(args[0]).startsWith("/api/assets/")) assetFetches++; return originalFetch(...args); };
  const oneTrack = { ...state, tracks: [state.tracks[0]] };
  try {
    const single = await engine.prepare(oneTrack, context), singleHash = await stereoPcmHash(single);
    const pair = await engine.prepare(state, context), pairHash = await stereoPcmHash(pair);
    const pairDiagnostics = engine.diagnostics, fetchesBeforeRemoval = assetFetches;
    const removed = await engine.prepare(oneTrack, context), removedHash = await stereoPcmHash(removed);
    return { singleHash, pairHash, removedHash, fetchesBeforeRemoval, removalFetches: assetFetches - fetchesBeforeRemoval,
      pairDiagnostics, removedDiagnostics: engine.diagnostics, removedFrames: removed.length };
  } finally { engine.dispose(); window.fetch = originalFetch; await context.close(); }
} });

Object.assign(window, { async verifyPreparationCloneFailure(state: ArrangementPreviewState) {
  const context = new AudioContext({ sampleRate: 44100 }), engine = new ArrangementPreparation();
  const NativeWorker = window.Worker, originalFetch = window.fetch;
  let failOnce = true, fetches = 0;
  const unhandled: string[] = [];
  const onUnhandled = (event: PromiseRejectionEvent) => { unhandled.push(String(event.reason)); event.preventDefault(); };
  window.addEventListener("unhandledrejection", onUnhandled);
  window.fetch = (...args) => { fetches++; return originalFetch(...args); };
  window.Worker = class extends NativeWorker {
    postMessage(message: unknown, options?: Transferable[] | StructuredSerializeOptions) {
      // Exercise Chromium's real structured-clone rejection, not a fake Worker reply.
      const payload = message as { kind?: string; sources?: unknown[] };
      if (failOnce && (payload.kind === "source" || Array.isArray(payload.sources))) {
        failOnce = false; super.postMessage(() => {}); return;
      }
      if (Array.isArray(options)) super.postMessage(message, options); else super.postMessage(message, options);
    }
  } as typeof Worker;
  try {
    const failure = await engine.prepare(state, context).then(() => "unexpected success", error => error.name);
    const recovered = await engine.prepare(state, context);
    // Let browser unhandledrejection delivery run before observing the result.
    await new Promise(resolve => setTimeout(resolve, 20));
    return { failure, frames: recovered.length, fetches, unhandled, diagnostics: engine.diagnostics };
  } finally {
    engine.dispose(); window.Worker = NativeWorker; window.fetch = originalFetch;
    window.removeEventListener("unhandledrejection", onUnhandled); await context.close();
  }
} });

Object.assign(window, { async verifyRecoveryBudgetFallback(state: ArrangementPreviewState, expectWorkerEviction = false) {
  const context = new AudioContext({ sampleRate: 44100 }), engine = new ArrangementPreparation();
  const originalFetch = window.fetch;
  const assetId = state.tracks[0].clips[0].stemAssetId;
  let fetches = 0;
  window.fetch = async (input, init) => {
    const response = await originalFetch(input, init);
    fetches++;
    if (String(input) !== `/api/assets/${assetId}`) return response;
    const original = new Uint8Array(await response.arrayBuffer());
    const paddingBytes = 200_000;
    const padded = new Uint8Array(original.length + 8 + paddingBytes);
    padded.set(original);
    padded.set([0x4a, 0x55, 0x4e, 0x4b], original.length); // valid RIFF JUNK chunk
    new DataView(padded.buffer).setUint32(original.length + 4, paddingBytes, true);
    new DataView(padded.buffer).setUint32(4, padded.length - 8, true);
    const headers = new Headers(response.headers);
    headers.set("content-length", String(padded.length));
    return new Response(padded, { status: response.status, headers });
  };
  try {
    const rendered = await engine.prepare(state, context);
    const idleWaitStarted = performance.now();
    if (expectWorkerEviction) {
      const deadline = idleWaitStarted + WORKER_SOURCE_IDLE_EVICTION_MS + 10_000;
      while (!(engine.diagnostics.workerSourcesEvicted && engine.diagnostics.sourceBytes === 0)) {
        if (performance.now() >= deadline) throw new Error("The candidate did not release its large-source Worker copy.");
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    const remainingIdleWindow = WORKER_SOURCE_IDLE_EVICTION_MS + 100 - (performance.now() - idleWaitStarted);
    if (remainingIdleWindow > 0) await new Promise(resolve => setTimeout(resolve, remainingIdleWindow));
    return { frames: rendered.length, fetches, diagnostics: engine.diagnostics };
  } finally {
    engine.dispose(); window.fetch = originalFetch; await context.close();
  }
} });

Object.assign(window, { async verifyPreparationSourceRevision(state: ArrangementPreviewState) {
  const context = new AudioContext({ sampleRate: 44100 }), engine = new ArrangementPreparation();
  const originalFetch = window.fetch;
  const [first, second] = state.tracks.map(track => track.clips[0].stemAssetId);
  const activeTrackId = state.tracks.find(track => track.clips.some(clip => clip.stemAssetId === first))?.id;
  const activeTrackIds = activeTrackId ? [activeTrackId] : [];
  const counts: Record<string, number> = {};
  let replaceFirst = false;
  window.fetch = (input, init) => {
    const url = String(input); counts[url] = (counts[url] ?? 0) + 1;
    return originalFetch(replaceFirst && url === `/api/assets/${first}` ? `/api/assets/${second}` : input, init);
  };
  try {
    const revisions = new Map([[first, "version-one"], [second, "stable-neighbor"]]);
    const before = await engine.prepare(state, context, "session-revision", revisions, activeTrackIds);
    const beforeKeys = Object.keys(engine.diagnostics.sourceBytesByKey ?? {});
    replaceFirst = true; revisions.set(first, "version-two");
    // Per-asset revision alone must invalidate the finished render as well as
    // the source cache, without fetching/decoding the unaffected neighbor.
    const after = await engine.prepare(state, context, "session-revision", revisions, activeTrackIds);
    const afterDiagnostics = engine.diagnostics;
    const afterKeys = Object.keys(afterDiagnostics.sourceBytesByKey ?? {});
    const replay = await engine.prepare(state, context, "session-revision", revisions, activeTrackIds);
    return { before: await stereoPcmHash(before), after: await stereoPcmHash(after),
      firstFetches: counts[`/api/assets/${first}`], neighborFetches: counts[`/api/assets/${second}`], replaySame: after === replay,
      beforeKeys, afterKeys, warmSourceBytes: afterDiagnostics.warmSourceBytes ?? 0 };
  } finally { engine.dispose(); window.fetch = originalFetch; await context.close(); }
} });
