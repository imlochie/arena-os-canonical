import { effectiveMuted } from "./remix";
import { arrangementPreMasterCacheKey, MAX_ARRANGEMENT_SECONDS, type ArrangementPreviewState } from "./arrangement-pcm";
import type { PreviewSource } from "./arrangement-pcm.worker";
/** Only editable audible state enters the cache identity. Save acknowledgements,
 * names, cursors and loop toggles must not redo an unchanged musical bounce. */
export function previewStateKey(state: ArrangementPreviewState, revision = "", sourceRevisions?: ReadonlyMap<string, string>) {
  return JSON.stringify([state.tracks, state.masterVolume, state.masterInserts, state.automation, state.tempoBpm, state.targetKey, revision, sourceRevisions ? [...sourceRevisions].sort(([a], [b]) => a.localeCompare(b)) : []]);
}
export function transformedClipKey(clip: ArrangementPreviewState["tracks"][number]["clips"][number], state: ArrangementPreviewState, revision: string) {
  return JSON.stringify([clip.stemAssetId, clip.sourceOffsetMs, clip.durationMs, clip.tempoSyncEnabled, clip.keySyncEnabled, state.tempoBpm, state.targetKey, revision]);
}
type Prepared = { left: Float32Array; right: Float32Array; stats?: { mixCacheHit: boolean; retainedMixBytes: number; sourceBytes: number; sourceBytesByKey: Record<string, number>; evictedSourceBytes?: number; workerSourcesEvicted?: boolean } };
const MAX_DECODED_BYTES = 128 * 1024 * 1024;
const MAX_ENCODED_RECOVERY_BYTES = 128 * 1024 * 1024;
const MAX_RECOVERY_TO_PCM_RATIO = 0.9;
export const WORKER_SOURCE_IDLE_EVICTION_MS = 5_000;
/** Owns decoded/worker buffers for one open workspace. Hard cancellation kills
 * CPU work as well as fetches. Encoded recovery blobs remain only when they are
 * materially smaller than decoded PCM and fit the bounded per-workspace budget.
 * Worker PCM is staged for each track and released after its last track
 * consumer; local owners support a later rebuild. A retained pre-master mix
 * still serves master-only edits without rehydrating source data. */
export class ArrangementPreparation {
  private worker: Worker | null = null;
  private sent = new Set<string>();
  private decoded = new Map<string, AudioBuffer>();
  private encodedRecovery = new Map<string, Blob>();
  private abort: AbortController | null = null;
  private pending: { id: number; resolve(value: Prepared): void; reject(error: Error): void } | null = null;
  private pendingTrackAcks = new Map<string, { resolve(stats: Prepared["stats"]): void; reject(error: Error): void }>();
  private sequence = 0;
  private rate = 0;
  private workerMixKey: string | null = null;
  private workerStats: Prepared["stats"];
  private sourceEvictionTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingSourceRelease: { id: number; promise: Promise<void>; resolve(): void } | null = null;
  get diagnostics() {
    return {
      decodedBytes: [...this.decoded.values()].reduce((sum, buffer) => sum + buffer.length * buffer.numberOfChannels * 4, 0),
      encodedRecoveryBytes: [...this.encodedRecovery.values()].reduce((sum, blob) => sum + blob.size, 0),
      finishedBytes: this.finished ? this.finished.buffer.length * this.finished.buffer.numberOfChannels * 4 : 0,
      ...this.workerStats,
    };
  }
  private finished: { key: string; buffer: AudioBuffer } | null = null;
  cancel() {
    this.abort?.abort(); this.abort = null;
    if (this.pending) {
      const error = new DOMException("Preparation cancelled", "AbortError");
      const id = this.pending.id; this.pending.reject(error); this.pending = null;
      this.rejectTrackAcks(id, error);
      this.worker?.terminate(); this.worker = null; this.sent.clear(); this.workerMixKey = null; this.workerStats = undefined;
    }
  }
  private rejectTrackAcks(id: number, error: Error) {
    for (const [key, ack] of this.pendingTrackAcks) {
      if (!key.startsWith(`${id}:`)) continue;
      this.pendingTrackAcks.delete(key); ack.reject(error);
    }
  }
  private waitForTrack(id: number, trackIndex: number) {
    return new Promise<Prepared["stats"]>((resolve, reject) => {
      this.pendingTrackAcks.set(`${id}:${trackIndex}`, { resolve, reject });
    });
  }
  private clearSourceEvictionTimer() {
    if (this.sourceEvictionTimer) clearTimeout(this.sourceEvictionTimer);
    this.sourceEvictionTimer = null;
  }
  private scheduleSourceEviction(worker: Worker) {
    this.clearSourceEvictionTimer();
    if (!this.workerStats?.sourceBytes) return;
    this.sourceEvictionTimer = setTimeout(() => {
      this.sourceEvictionTimer = null;
      if (this.worker !== worker || !this.workerStats?.sourceBytes || this.pendingSourceRelease) return;
      const id = ++this.sequence;
      let resolve!: () => void;
      const promise = new Promise<void>(done => { resolve = done; });
      this.pendingSourceRelease = { id, promise, resolve };
      try {
        worker.postMessage({ kind: "release-sources", id });
      } catch {
        const release = this.pendingSourceRelease;
        this.pendingSourceRelease = null;
        release?.resolve();
        worker.terminate();
        if (this.worker === worker) this.worker = null;
        this.sent.clear(); this.workerMixKey = null; this.workerStats = undefined;
      }
    }, WORKER_SOURCE_IDLE_EVICTION_MS);
  }
  dispose() {
    this.clearSourceEvictionTimer();
    const release = this.pendingSourceRelease; this.pendingSourceRelease = null; release?.resolve();
    this.cancel(); this.worker?.terminate(); this.worker = null; this.sent.clear(); this.workerMixKey = null; this.decoded.clear(); this.encodedRecovery.clear(); this.finished = null; this.workerStats = undefined;
  }
  private getWorker() {
    if (this.worker) return this.worker;
    if (typeof Worker === "undefined") throw new Error("This browser cannot run the arrangement DSP worker; no dry substitute was played.");
    const worker = new Worker(new URL("./arrangement-pcm.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = ({ data }) => {
      if (data.kind === "sources-released") {
        const release = this.pendingSourceRelease;
        if (!release || release.id !== data.id) return;
        this.pendingSourceRelease = null;
        this.sent.clear(); this.workerStats = data.stats;
        release.resolve();
        return;
      }
      if (data.kind === "track-rendered") {
        if (!this.pending || data.id !== this.pending.id) return;
        this.workerStats = data.stats;
        this.sent.clear();
        for (const sourceKey of Object.keys(data.stats?.sourceBytesByKey ?? {})) this.sent.add(sourceKey);
        const key = `${data.id}:${data.trackIndex}`;
        const ack = this.pendingTrackAcks.get(key);
        if (ack) { this.pendingTrackAcks.delete(key); ack.resolve(data.stats); }
        return;
      }
      if (data.kind === "render-error") {
        if (!this.pending || data.id !== this.pending.id) return;
        const error = new Error(data.error ?? "Arrangement preparation failed.");
        this.pending.reject(error); this.rejectTrackAcks(data.id, error);
        return;
      }
      if (!this.pending || data.id !== this.pending.id) return;
      const pending = this.pending; this.pending = null;
      if (data.error) pending.reject(new Error(data.error)); else pending.resolve(data);
    };
    worker.onerror = () => {
      this.clearSourceEvictionTimer();
      const id = this.pending?.id;
      this.pending?.reject(new Error("Arrangement DSP worker failed; no dry substitute was played."));
      this.pending = null;
      if (id !== undefined) this.rejectTrackAcks(id, new Error("Arrangement DSP worker failed; no dry substitute was played."));
      const release = this.pendingSourceRelease; this.pendingSourceRelease = null; release?.resolve();
      worker.terminate(); this.worker = null; this.sent.clear(); this.workerMixKey = null; this.workerStats = undefined;
    };
    return this.worker = worker;
  }
  async prepare(snapshot: ArrangementPreviewState, context: AudioContext, revision = "", sourceRevisions: ReadonlyMap<string, string> = new Map()) {
    this.cancel();
    if (this.rate && this.rate !== context.sampleRate) this.dispose();
    this.rate = context.sampleRate;
    const key = previewStateKey(snapshot, revision, sourceRevisions);
    if (this.finished?.key === key) return this.finished.buffer;
    const abort = this.abort = new AbortController(), signal = abort.signal;
    this.clearSourceEvictionTimer();
    const sourceRelease = this.pendingSourceRelease;
    if (sourceRelease) {
      await sourceRelease.promise;
      signal.throwIfAborted();
    }
    const end = Math.max(0, ...snapshot.tracks.flatMap(track => track.clips.map(clip => clip.timelineStartMs + clip.durationMs)));
    if (!Number.isFinite(end) || end > MAX_ARRANGEMENT_SECONDS * 1000) throw new Error("Processed arrangement audition is limited to 5 minutes.");
    const state = structuredClone(snapshot);
    const solo = state.tracks.some(track => track.solo && !track.muted);
    const needed = new Set<string>();
    const requests = new Map<string, { url: string; body?: string }>();
    const trackOrder: number[] = [];
    const lastUseByKey: Record<string, number> = {};
    for (let trackIndex = 0; trackIndex < state.tracks.length; trackIndex++) {
      const track = state.tracks[trackIndex];
      if (effectiveMuted(track, solo)) continue;
      trackOrder.push(trackIndex);
      for (const clip of track.clips) {
        if (clip.tempoSyncEnabled || clip.keySyncEnabled) {
          const id = clip.stemAssetId;
          const sourceKey = transformedClipKey(clip, state, sourceRevisions.get(id) ?? revision);
          requests.set(sourceKey, { url: `/api/assets/${id}/audition`, body: JSON.stringify({ sourceOffsetMs: clip.sourceOffsetMs, durationMs: clip.durationMs, tempoSyncEnabled: clip.tempoSyncEnabled, keySyncEnabled: clip.keySyncEnabled, tempoBpm: state.tempoBpm, targetKey: state.targetKey, sampleRate: context.sampleRate }) });
          clip.stemAssetId = sourceKey; clip.sourceOffsetMs = 0; clip.tempoSyncEnabled = false; clip.keySyncEnabled = false;
          needed.add(sourceKey);
        } else {
          const id = clip.stemAssetId, sourceRevision = sourceRevisions.get(id) ?? revision;
          const sourceKey = sourceRevision ? JSON.stringify([id, sourceRevision]) : id;
          needed.add(sourceKey); requests.set(sourceKey, { url: `/api/assets/${id}` });
          clip.stemAssetId = sourceKey;
        }
        lastUseByKey[clip.stemAssetId] = trackIndex;
      }
    }
    const preMasterKey = arrangementPreMasterCacheKey(state, context.sampleRate, revision);
    // Drop removed clips, old transform variants and closed-project data, rather
    // than keeping every edit's AudioBuffer until the tab eventually exits.
    for (const id of this.decoded.keys()) if (!needed.has(id)) this.decoded.delete(id);
    for (const id of this.encodedRecovery.keys()) if (!needed.has(id)) this.encodedRecovery.delete(id);
    let bytes = [...this.decoded.entries()].reduce((sum, [id, buffer]) => sum + (needed.has(id) ? buffer.length * buffer.numberOfChannels * 4 : 0), 0);
    for (const id of this.sent) if (needed.has(id) && !this.decoded.has(id)) bytes += this.workerStats?.sourceBytesByKey?.[id] ?? 0;
    let recoveryBytes = [...this.encodedRecovery.values()].reduce((sum, blob) => sum + blob.size, 0);
    const id = ++this.sequence;
    const worker = this.getWorker();
    const reusePreMasterMix = this.workerMixKey === preMasterKey;
    const rendered = new Promise<Prepared>((resolve, reject) => { this.pending = { id, resolve, reject }; });
    // Upload or worker failure can reject before the render await; attach an
    // observer immediately while preserving rejection for the original await.
    void rendered.catch(() => undefined);
    try {
      // Prune stale worker-owned audio before adding sources for this snapshot.
      worker.postMessage({ kind: "retain", retain: [...needed] });
      for (const sourceKey of this.sent) if (!needed.has(sourceKey)) this.sent.delete(sourceKey);

      // Decode and transfer only the sources needed by the next track. The
      // Worker releases each source after its final track consumer. A decoded
      // buffer is released only after its bounded encoded recovery copy is
      // safely retained; otherwise it remains the network-independent owner.
      worker.postMessage({ kind: "render", id, state, sampleRate: context.sampleRate, retain: [...needed], revision, trackOrder, lastUseByKey });
      if (!reusePreMasterMix) {
        for (const trackIndex of trackOrder) {
          signal.throwIfAborted();
          const track = state.tracks[trackIndex];
          const trackSources = [...new Set(track.clips.map(clip => clip.stemAssetId))];
          for (const sourceKey of trackSources) {
            if (this.sent.has(sourceKey)) continue;
            const request = requests.get(sourceKey);
            if (!request) throw new Error("Arrangement source request is unavailable.");

            let recovery = this.encodedRecovery.get(sourceKey);
            if (!recovery) {
              const response = await fetch(request.url, { signal, ...(request.body ? { method: "POST", headers: { "content-type": "application/json" }, body: request.body } : {}) });
              if (!response.ok) { const error = await response.json().catch(() => ({})); throw new Error(error.error ?? "A stem could not be prepared for arrangement audition."); }
              if (Number(response.headers.get("content-length")) > MAX_DECODED_BYTES) { await response.body?.cancel(); throw new Error("Source exceeds the 128 MiB audition decode budget; use a shorter source range or export."); }
              recovery = await response.blob();
            }

            let audio = this.decoded.get(sourceKey);
            if (!audio) {
              audio = await context.decodeAudioData(await recovery.arrayBuffer());
              const pcmBytes = audio.length * audio.numberOfChannels * 4;
              bytes += pcmBytes;
              if (bytes > MAX_DECODED_BYTES) throw new Error("Selected source audio exceeds the 128 MiB decoded audition budget; no clips were dropped.");
              this.decoded.set(sourceKey, audio);
              if (!this.encodedRecovery.has(sourceKey) &&
                  recovery.size < pcmBytes * MAX_RECOVERY_TO_PCM_RATIO &&
                  recoveryBytes + recovery.size <= MAX_ENCODED_RECOVERY_BYTES) {
                this.encodedRecovery.set(sourceKey, recovery);
                recoveryBytes += recovery.size;
              }
            }

            signal.throwIfAborted();
            const channels = Array.from({ length: audio.numberOfChannels }, (_, channel) => audio!.getChannelData(channel).slice());
            const source: PreviewSource = { key: sourceKey, sampleRate: audio.sampleRate, channels };
            worker.postMessage({ kind: "source", source }, channels.map(channel => channel.buffer));
            this.sent.add(sourceKey);

            if (this.encodedRecovery.has(sourceKey)) {
              this.decoded.delete(sourceKey);
            }
          }
          const trackRendered = this.waitForTrack(id, trackIndex);
          worker.postMessage({ kind: "render-track", id, trackIndex });
          await trackRendered;
        }
        worker.postMessage({ kind: "finish-render", id });
      }

      signal.throwIfAborted();
      const { left, right, stats } = await rendered;
      signal.throwIfAborted();
      this.workerStats = stats;
      this.sent.clear();
      for (const sourceKey of Object.keys(stats?.sourceBytesByKey ?? {})) this.sent.add(sourceKey);
      this.workerMixKey = preMasterKey;
      if (!stats?.workerSourcesEvicted) this.scheduleSourceEviction(worker);
      const buffer = context.createBuffer(2, left.length, context.sampleRate);
      buffer.copyToChannel(left as Float32Array<ArrayBuffer>, 0); buffer.copyToChannel(right as Float32Array<ArrayBuffer>, 1);
      this.finished = { key, buffer }; return buffer;
    } catch (error) {
      // A partial upload or failed render cannot leave an orphan request or
      // trusted Worker ownership behind. Encoded copies and decoded fallbacks
      // remain available to retry without the source endpoint.
      if (this.pending?.id === id) this.pending = null;
      this.clearSourceEvictionTimer();
      this.rejectTrackAcks(id, error instanceof Error ? error : new Error("Arrangement preparation failed."));
      if (this.worker === worker) worker.terminate();
      if (this.worker === worker) this.worker = null;
      this.sent.clear(); this.workerMixKey = null; this.workerStats = undefined;
      throw error;
    }
  }
}
