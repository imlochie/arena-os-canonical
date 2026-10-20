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
Object.assign(window, { async measurePreparation(state: ArrangementPreviewState, retainForMeasurement = false, expectWorkerEviction = false) {
  const context = new AudioContext({ sampleRate: 44100 }), engine = new ArrangementPreparation();
  const NativeWorker = window.Worker;
  const originalFetch = window.fetch;
  let assetFetches = 0, decodeCalls = 0, decodeMs = 0;
  window.fetch = (input, init) => {
    if (String(input).startsWith("/api/assets/")) assetFetches++;
    return originalFetch(input, init);
  };
  const nativeDecode = context.decodeAudioData.bind(context);
  Object.defineProperty(context, "decodeAudioData", { configurable: true, value: async (data: ArrayBuffer) => {
    decodeCalls++; const started = performance.now();
    try { return await nativeDecode(data); } finally { decodeMs += performance.now() - started; }
  } });
  const workerSourceBytes = new Map<string, number>();
  let peakAccountedSourcePcmOverlapBytes = 0;
  let peakDecodedSourceBytes = 0;
  let peakWorkerSourceBytes = 0;
  const internals = engine as unknown as { decoded?: Map<string, AudioBuffer> };
  window.Worker = class extends NativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      this.addEventListener("message", event => {
        if ((event.data as { stats?: { workerSourcesEvicted?: boolean } }).stats?.workerSourcesEvicted) workerSourceBytes.clear();
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
      if (Array.isArray(options)) super.postMessage(message, options);
      else super.postMessage(message, options);
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
    const coldFetchStart = assetFetches, coldDecodeStart = decodeCalls, coldDecodeTime = decodeMs;
    const buffer = await engine.prepare(state, context); const readyMs = performance.now() - started;
    const coldFetches = assetFetches - coldFetchStart, coldDecodeCalls = decodeCalls - coldDecodeStart, coldDecodeMs = decodeMs - coldDecodeTime;
    await new Promise(resolve => setTimeout(resolve, 15));
    const replayFetchStart = assetFetches, replayDecodeStart = decodeCalls;
    const cached = performance.now(); const replay = await engine.prepare(state, context); const replayMs = performance.now() - cached;
    const replayFetches = assetFetches - replayFetchStart, replayDecodeCalls = decodeCalls - replayDecodeStart;
    const replaySame = replay === buffer;
    if (!replaySame) throw new Error("Replay did not retain the actual finished musical buffer.");
    const edited = structuredClone(state); edited.masterVolume *= 0.5;
    const masterFetchStart = assetFetches, masterDecodeStart = decodeCalls, masterDecodeTime = decodeMs;
    const editStart = performance.now(); const changed = await engine.prepare(edited, context); const editMs = performance.now() - editStart;
    const masterEditFetches = assetFetches - masterFetchStart, masterEditDecodeCalls = decodeCalls - masterDecodeStart, masterEditDecodeMs = decodeMs - masterDecodeTime;
    const masterDiagnostics = engine.diagnostics;
    const trackEdited = structuredClone(state); if (trackEdited.tracks[0]) trackEdited.tracks[0].volume *= 0.5;
    const trackFetchStart = assetFetches, trackDecodeStart = decodeCalls, trackDecodeTime = decodeMs;
    const trackEditStart = performance.now(); const trackChanged = await engine.prepare(trackEdited, context); const trackEditMs = performance.now() - trackEditStart;
    const trackEditFetches = assetFetches - trackFetchStart, trackEditDecodeCalls = decodeCalls - trackDecodeStart, trackEditDecodeMs = decodeMs - trackDecodeTime;
    const trackDiagnostics = engine.diagnostics;
    const waitForIdle = async () => {
      const waitStarted = performance.now();
      if (expectWorkerEviction) {
        const deadline = waitStarted + WORKER_SOURCE_IDLE_EVICTION_MS + 10_000;
        while (!(engine.diagnostics.workerSourcesEvicted && engine.diagnostics.sourceBytes === 0)) {
          if (performance.now() >= deadline) throw new Error("Prototype 3 did not acknowledge idle Worker source eviction.");
          await new Promise(resolve => setTimeout(resolve, 25));
        }
      } else {
        await new Promise(resolve => setTimeout(resolve, WORKER_SOURCE_IDLE_EVICTION_MS + 100));
      }
      return performance.now() - waitStarted;
    };
    const firstIdleWaitMs = await waitForIdle();
    const idleDiagnostics = engine.diagnostics;
    const postIdleMaster = structuredClone(trackEdited); postIdleMaster.masterVolume *= 0.75;
    const postIdleMasterFetchStart = assetFetches, postIdleMasterDecodeStart = decodeCalls, postIdleMasterDecodeTime = decodeMs;
    const postIdleMasterStarted = performance.now(); const postIdleMasterBuffer = await engine.prepare(postIdleMaster, context);
    const postIdleMasterEditMs = performance.now() - postIdleMasterStarted;
    const postIdleMasterEditFetches = assetFetches - postIdleMasterFetchStart;
    const postIdleMasterEditDecodeCalls = decodeCalls - postIdleMasterDecodeStart;
    const postIdleMasterEditDecodeMs = decodeMs - postIdleMasterDecodeTime;
    const postIdleMasterDiagnostics = engine.diagnostics;
    const postIdleTrack = structuredClone(trackEdited); if (postIdleTrack.tracks[0]) postIdleTrack.tracks[0].volume *= 0.75;
    const postIdleTrackFetchStart = assetFetches, postIdleTrackDecodeStart = decodeCalls, postIdleTrackDecodeTime = decodeMs;
    const postIdleTrackStarted = performance.now(); const postIdleTrackBuffer = await engine.prepare(postIdleTrack, context);
    const postIdleTrackEditMs = performance.now() - postIdleTrackStarted;
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
    const trackEditedPcmSha256 = await stereoPcmHash(trackChanged);
    const postIdleMasterPcmSha256 = await stereoPcmHash(postIdleMasterBuffer), postIdleTrackPcmSha256 = await stereoPcmHash(postIdleTrackBuffer);
    if (retainForMeasurement) heldMeasurement = { engine, context, buffer, changed };
    return {
      pcmSha256, editedPcmSha256, trackEditedPcmSha256, postIdleMasterPcmSha256, postIdleTrackPcmSha256,
      readyMs, replayMs, editMs, trackEditMs, maximumGapMs: preparationMaximumGapMs,
      verificationMs, ticks, frames: buffer.length, latestEditError: error, outputPlanarBytes: buffer.length * 2 * 4,
      peakAccountedSourcePcmOverlapBytes, peakDecodedSourceBytes, peakWorkerSourceBytes,
      replaySame,
      coldFetches, coldDecodeCalls, coldDecodeMs, replayFetches, replayDecodeCalls,
      masterEditFetches, masterEditDecodeCalls, masterEditDecodeMs,
      trackEditFetches, trackEditDecodeCalls, trackEditDecodeMs,
      trackEditWorkerSourceBytes: trackDiagnostics.sourceBytes ?? 0,
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
    window.Worker = NativeWorker; window.fetch = originalFetch;
  }
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
    const result = await engine.prepare(latest, context);
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
      coldFetches, afterEditFetches, reopenedFetches: fetches, cancelled, latestError: error,
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
    if (expectWorkerEviction) {
      const deadline = performance.now() + WORKER_SOURCE_IDLE_EVICTION_MS + 10_000;
      while (!(engine.diagnostics.workerSourcesEvicted && engine.diagnostics.sourceBytes === 0)) {
        if (performance.now() >= deadline) throw new Error("Prototype 3 did not evict Worker sources before the outage recovery test.");
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    } else {
      await new Promise(resolve => setTimeout(resolve, WORKER_SOURCE_IDLE_EVICTION_MS + 100));
    }
    const idleDiagnostics = engine.diagnostics;
    outage = true;
    const workerToFail = activeWorker as unknown as Worker | null;
    if (!workerToFail) throw new Error("Preparation did not create its real Worker.");
    // Deliver a controlled error event to the actual Worker instance so the
    // controller's production onerror path must discard that worker and recover
    // from its local decoded/encoded owner while the endpoint is unavailable.
    workerToFail.dispatchEvent(new ErrorEvent("error", { message: "Controlled Worker failure" }));
    const edited = structuredClone(state); if (edited.tracks[0]) edited.tracks[0].volume *= 0.75;
    const recovered = await engine.prepare(edited, context);
    let outputError = 0;
    for (let frame = 0; frame < first.length; frame++) outputError = Math.max(outputError, Math.abs(recovered.getChannelData(0)[frame] - first.getChannelData(0)[frame] * 0.75));
    return { fetches, outageFetches, outputError, firstFrames: first.length, recoveredFrames: recovered.length,
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
    if (expectWorkerEviction) {
      const deadline = performance.now() + WORKER_SOURCE_IDLE_EVICTION_MS + 10_000;
      while (!(engine.diagnostics.workerSourcesEvicted && engine.diagnostics.sourceBytes === 0)) {
        if (performance.now() >= deadline) throw new Error("Prototype 3 did not evict its large-source Worker copy after idle.");
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    } else {
      await new Promise(resolve => setTimeout(resolve, WORKER_SOURCE_IDLE_EVICTION_MS + 100));
    }
    return { frames: rendered.length, fetches, diagnostics: engine.diagnostics };
  } finally {
    engine.dispose(); window.fetch = originalFetch; await context.close();
  }
} });

Object.assign(window, { async verifyPreparationSourceRevision(state: ArrangementPreviewState) {
  const context = new AudioContext({ sampleRate: 44100 }), engine = new ArrangementPreparation();
  const originalFetch = window.fetch;
  const [first, second] = state.tracks.map(track => track.clips[0].stemAssetId);
  const counts: Record<string, number> = {};
  let replaceFirst = false;
  window.fetch = (input, init) => {
    const url = String(input); counts[url] = (counts[url] ?? 0) + 1;
    return originalFetch(replaceFirst && url === `/api/assets/${first}` ? `/api/assets/${second}` : input, init);
  };
  try {
    const revisions = new Map([[first, "version-one"], [second, "stable-neighbor"]]);
    const before = await engine.prepare(state, context, "session-revision", revisions);
    replaceFirst = true; revisions.set(first, "version-two");
    // Per-asset revision alone must invalidate the finished render as well as
    // the source cache, without fetching/decoding the unaffected neighbor.
    const after = await engine.prepare(state, context, "session-revision", revisions);
    const replay = await engine.prepare(state, context, "session-revision", revisions);
    return { before: await stereoPcmHash(before), after: await stereoPcmHash(after),
      firstFetches: counts[`/api/assets/${first}`], neighborFetches: counts[`/api/assets/${second}`], replaySame: after === replay };
  } finally { engine.dispose(); window.fetch = originalFetch; await context.close(); }
} });
