import test from "node:test";
import assert from "node:assert/strict";
import { prepareArrangementPcm, type ArrangementMixCache, type ArrangementPreviewState } from "./arrangement-pcm";
import type { PreviewWork } from "./arrangement-pcm.worker";
import { ArrangementPreparation } from "./arrangement-preparation";

class FixtureAudioBuffer {
  readonly channels: Float32Array[];
  readonly length: number;
  readonly numberOfChannels: number;
  readonly sampleRate: number;
  constructor(numberOfChannels: number, length: number, sampleRate: number, value = 0) {
    this.numberOfChannels = numberOfChannels;
    this.sampleRate = sampleRate;
    this.length = length;
    this.channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length).fill(value));
  }
  getChannelData(channel: number) { return this.channels[channel]; }
  copyToChannel(source: Float32Array, channel: number) { this.channels[channel].set(source); }
}

let holdNextResponse = false;
let releaseHeldResponse: (() => void) | null = null;
let throwNextWorkerPost = false;
const workers: FixtureWorker[] = [];

class FixtureWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  terminated = false;
  readonly sources = new Map<string, { sampleRate: number; channels: Float32Array[] }>();
  private readonly mixCache: ArrangementMixCache = { revision: "" };
  constructor() { workers.push(this); }
  postMessage(work: PreviewWork) {
    if (throwNextWorkerPost) {
      throwNextWorkerPost = false;
      throw new DOMException("Fixture could not clone the render message", "DataCloneError");
    }
    for (const source of work.sources) this.sources.set(source.key, source);
    const retained = new Set(work.retain);
    for (const key of this.sources.keys()) if (!retained.has(key)) this.sources.delete(key);
    const run = () => {
      if (this.terminated) return;
      const buffers = new Map([...this.sources].map(([key, source]) => [key, {
        sampleRate: source.sampleRate,
        numberOfChannels: source.channels.length,
        length: source.channels[0].length,
        getChannelData: (channel: number) => source.channels[channel],
      }]));
      this.mixCache.revision = work.revision;
      const pcm = prepareArrangementPcm(work.state, buffers, work.sampleRate, this.mixCache);
      const frames = pcm.length / 2;
      const left = new Float32Array(frames), right = new Float32Array(frames);
      for (let frame = 0; frame < frames; frame++) {
        left[frame] = pcm[frame * 2];
        right[frame] = pcm[frame * 2 + 1];
      }
      const sourceBytesByKey = Object.fromEntries([...this.sources].map(([key, source]) => [
        key,
        source.channels.reduce((bytes, channel) => bytes + channel.byteLength, 0),
      ]));
      const stats = {
        mixCacheHit: this.mixCache.hit ?? false,
        retainedMixBytes: this.mixCache.pcm?.byteLength ?? 0,
        sourceBytesByKey,
        sourceBytes: Object.values(sourceBytesByKey).reduce((sum, bytes) => sum + bytes, 0),
      };
      this.onmessage?.({ data: { id: work.id, left, right, stats } } as MessageEvent);
    };
    if (holdNextResponse) {
      holdNextResponse = false;
      releaseHeldResponse = run;
    } else {
      queueMicrotask(run);
    }
  }
  terminate() { this.terminated = true; this.sources.clear(); }
}

function stateFor(ids: string[]): ArrangementPreviewState {
  return {
    masterVolume: 1,
    masterInserts: [],
    loopStartMs: 0,
    loopEndMs: null,
    tracks: ids.map((stemAssetId, index) => ({
      id: `track-${index}`,
      name: `Track ${index}`,
      sortOrder: index,
      stemAssetId,
      volume: 1,
      pan: 0,
      muted: false,
      solo: false,
      clips: [{
        stemAssetId,
        timelineStartMs: 0,
        durationMs: 1000,
        sourceOffsetMs: 0,
        gain: 1,
        fadeInMs: 0,
        fadeOutMs: 0,
        tempoSyncEnabled: false,
        keySyncEnabled: false,
        beatSnapEnabled: false,
      }],
    })),
  };
}

function installWorkerAndFetch() {
  const originalWorker = globalThis.Worker;
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  const sourceValues = new Map<string, number>();
  Object.defineProperty(globalThis, "Worker", { configurable: true, writable: true, value: FixtureWorker });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: async (input: string | URL | Request) => {
      fetches++;
      const url = String(input);
      const sourceId = url.slice(url.lastIndexOf("/") + 1);
      return new Response(new Uint8Array([sourceValues.get(sourceId) ?? sourceId.charCodeAt(0)]), {
        headers: { "content-length": "1" },
      });
    },
  });
  return {
    fetchCount: () => fetches,
    setSourceValue: (sourceId: string, value: number) => sourceValues.set(sourceId, value),
    restore: () => {
      Object.defineProperty(globalThis, "Worker", { configurable: true, writable: true, value: originalWorker });
      Object.defineProperty(globalThis, "fetch", { configurable: true, writable: true, value: originalFetch });
    },
  };
}

function fixtureContext() {
  let decodeCalls = 0;
  const context = {
    sampleRate: 44_100,
    async decodeAudioData(data: ArrayBuffer) {
      decodeCalls++;
      const value = new Uint8Array(data)[0] / 255;
      return new FixtureAudioBuffer(2, 44_100, 44_100, value) as unknown as AudioBuffer;
    },
    createBuffer(channels: number, length: number, sampleRate: number) {
      return new FixtureAudioBuffer(channels, length, sampleRate) as unknown as AudioBuffer;
    },
  };
  return { context: context as unknown as AudioContext, decodeCount: () => decodeCalls };
}

test("successful preparation releases main-thread sources while warm edits reuse Worker-owned buffers", async () => {
  const globals = installWorkerAndFetch();
  const { context, decodeCount } = fixtureContext();
  const preparation = new ArrangementPreparation();
  workers.length = 0;
  try {
    const initial = stateFor(["a", "b"]);
    const revisions = new Map([["a", "sha-a-v1"], ["b", "sha-b-v1"]]);
    const first = await preparation.prepare(initial, context, "source-set-v1", revisions);
    assert.equal(first.length, 44_100);
    assert.equal(globals.fetchCount(), 2);
    assert.equal(decodeCount(), 2);
    assert.equal(preparation.diagnostics.decodedBytes, 0, "successful worker ownership releases decoded AudioBuffers");
    assert.equal(preparation.diagnostics.sourceBytes, 2 * 2 * 44_100 * Float32Array.BYTES_PER_ELEMENT);

    const masterEdit = structuredClone(initial);
    masterEdit.masterVolume = 0.5;
    await preparation.prepare(masterEdit, context, "source-set-v1", revisions);
    assert.equal(globals.fetchCount(), 2, "master edit does not fetch sources again");
    assert.equal(decodeCount(), 2, "master edit does not decode sources again");
    assert.equal(preparation.diagnostics.decodedBytes, 0);
    assert.equal(preparation.diagnostics.mixCacheHit, true, "the existing pre-master cache remains reusable");

    const replacement = structuredClone(initial);
    replacement.tracks[1].stemAssetId = "c";
    replacement.tracks[1].clips[0].stemAssetId = "c";
    const replacementRevisions = new Map([["a", "sha-a-v1"], ["c", "sha-c-v1"]]);
    const replacementBuffer = await preparation.prepare(replacement, context, "source-set-v1", replacementRevisions);
    assert.equal(globals.fetchCount(), 3, "only the replaced track is fetched");
    assert.equal(decodeCount(), 3, "unaffected track audio remains worker-owned");
    assert.deepEqual([...workers[0].sources.keys()].sort(), [
      JSON.stringify(["a", "sha-a-v1"]),
      JSON.stringify(["c", "sha-c-v1"]),
    ].sort());
    assert.equal(preparation.diagnostics.decodedBytes, 0);
    assert.equal(preparation.diagnostics.sourceBytes, 2 * 2 * 44_100 * Float32Array.BYTES_PER_ELEMENT);

    globals.setSourceValue("a", 240);
    const updatedRevisions = new Map([["a", "sha-a-v2"], ["c", "sha-c-v1"]]);
    const updatedBuffer = await preparation.prepare(replacement, context, "source-set-v2", updatedRevisions);
    assert.equal(globals.fetchCount(), 4, "a changed source checksum fetches only that asset again");
    assert.equal(decodeCount(), 4);
    assert.notEqual(updatedBuffer.getChannelData(0)[0], replacementBuffer.getChannelData(0)[0],
      "the new source revision is rendered instead of reusing stale worker PCM");
    assert.deepEqual([...workers[0].sources.keys()].sort(), [
      JSON.stringify(["a", "sha-a-v2"]),
      JSON.stringify(["c", "sha-c-v1"]),
    ].sort());
    assert.equal(preparation.diagnostics.decodedBytes, 0);
  } finally {
    preparation.dispose();
    globals.restore();
  }
});

test("cancelling an in-flight render keeps decoded recovery data for a successful retry", async () => {
  const globals = installWorkerAndFetch();
  const { context, decodeCount } = fixtureContext();
  const preparation = new ArrangementPreparation();
  workers.length = 0;
  holdNextResponse = true;
  releaseHeldResponse = null;
  try {
    const state = stateFor(["x"]);
    const pending = preparation.prepare(state, context, "source-set-v1", new Map([["x", "sha-x-v1"]]));
    for (let attempts = 0; !releaseHeldResponse && attempts < 20; attempts++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert.ok(releaseHeldResponse, "fixture worker received the render");
    preparation.cancel();
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(preparation.diagnostics.decodedBytes, 2 * 44_100 * Float32Array.BYTES_PER_ELEMENT,
      "main copy remains available because the Worker did not complete");

    const retried = await preparation.prepare(state, context, "source-set-v1", new Map([["x", "sha-x-v1"]]));
    assert.equal(retried.length, 44_100);
    assert.equal(globals.fetchCount(), 1, "retry reuses the valid decoded recovery copy");
    assert.equal(decodeCount(), 1);
    assert.equal(preparation.diagnostics.decodedBytes, 0, "successful retry transfers cache ownership");
    assert.equal(preparation.diagnostics.sourceBytes, 2 * 44_100 * Float32Array.BYTES_PER_ELEMENT);
  } finally {
    releaseHeldResponse = null;
    holdNextResponse = false;
    preparation.dispose();
    globals.restore();
  }
});

test("a synchronous Worker post failure keeps decoded sources for retry", async () => {
  const globals = installWorkerAndFetch();
  const { context, decodeCount } = fixtureContext();
  const preparation = new ArrangementPreparation();
  workers.length = 0;
  throwNextWorkerPost = true;
  try {
    const state = stateFor(["retry"]);
    const revisions = new Map([["retry", "sha-retry-v1"]]);
    await assert.rejects(preparation.prepare(state, context, "source-set-v1", revisions), { name: "DataCloneError" });
    assert.equal(preparation.diagnostics.decodedBytes, 2 * 44_100 * Float32Array.BYTES_PER_ELEMENT);

    const retried = await preparation.prepare(state, context, "source-set-v1", revisions);
    assert.equal(retried.length, 44_100);
    assert.equal(globals.fetchCount(), 1);
    assert.equal(decodeCount(), 1);
    assert.equal(workers.length, 2, "failed Worker is replaced before retry");
    assert.equal(preparation.diagnostics.decodedBytes, 0);
  } finally {
    throwNextWorkerPost = false;
    preparation.dispose();
    globals.restore();
  }
});
