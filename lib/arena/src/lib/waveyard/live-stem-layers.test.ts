import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import {
  LIVE_STEM_MIN_DONOR_RMS_DBFS,
  LIVE_STEM_PITCH_LOCK_SESSION_BUDGET_BYTES,
  LIVE_STEM_SWITCH_TIMEOUT_MS,
  LiveStemLayers,
} from "./live-stem-layers";
import { SessionAudioAssetPool } from "./session-audio-asset-pool";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

type DecodedAudioFixture = {
  duration: number;
  length: number;
  numberOfChannels: number;
  sampleRate?: number;
  getChannelData?: (channel: number) => Float32Array;
};

function fixture(
  stretchBuffer?: ConstructorParameters<typeof LiveStemLayers>[2],
  onTiming?: ConstructorParameters<typeof LiveStemLayers>[3],
  decodedAudio:
    | DecodedAudioFixture
    | (() => DecodedAudioFixture) = {
      duration: 3,
      length: 144_000,
      numberOfChannels: 2,
    },
  channelIds = ["vocals"],
  assetPool?: SessionAudioAssetPool,
) {
  const sources: Array<{
    offset: number;
    stopped: boolean;
    loop: boolean;
    buffer: AudioBuffer | null;
    connectedTo: unknown;
    playbackRate: { value: number; setValueAtTime(value: number, time: number): void };
  }> = [];
  const gains: Array<{ automation: Array<{ type: string; value?: number; time: number }>; connectedTo: unknown }> = [];
  let decodeCount = 0;
  const context = {
    currentTime: 5,
    decodeAudioData: async () => {
      decodeCount += 1;
      return (typeof decodedAudio === "function" ? decodedAudio() : decodedAudio) as AudioBuffer;
    },
    createBufferSource() {
      const source = {
        offset: -1, stopped: false, loop: false, buffer: null, connectedTo: null as unknown,
        playbackRate: {
          value: 1,
          setValueAtTime(value: number) { this.value = value; },
        },
        connect(destination: unknown) { this.connectedTo = destination; }, disconnect() {},
        start(_when: number, offset: number) { this.offset = offset; },
        stop() { this.stopped = true; },
      };
      sources.push(source);
      return source;
    },
    createGain() {
      const automation: Array<{ type: string; value?: number; time: number }> = [];
      const node = {
        context, automation, connectedTo: null as unknown,
        connect(destination: unknown) { this.connectedTo = destination; }, disconnect() {},
        gain: {
          value: 1,
          cancelScheduledValues(time: number) { automation.push({ type: "cancel", time }); },
          cancelAndHoldAtTime(time: number) { automation.push({ type: "hold", time }); },
          setValueAtTime(value: number, time: number) {
            this.value = value;
            automation.push({ type: "set", value, time });
          },
          linearRampToValueAtTime(value: number, time: number) {
            this.value = value;
            automation.push({ type: "ramp", value, time });
          },
        },
      };
      gains.push(node);
      return node;
    },
  };
  const channels = new Map(channelIds.map(id => {
    const media = Object.assign(new EventTarget(), { currentTime: 7, paused: false, ended: false });
    return [id, {
      source: { mediaElement: media },
      inputGain: context.createGain(),
      gain: context.createGain(),
    }];
  }));
  const channel = channels.get("vocals")!;
  const layers = new LiveStemLayers(
    () => context as unknown as AudioContext,
    id => (channels.get(id) ?? null) as unknown as ReturnType<ConstructorParameters<typeof LiveStemLayers>[1]>,
    stretchBuffer,
    onTiming,
    "/test/live-stem-worklet.js",
    assetPool,
  );
  return {
    layers,
    channel,
    channels,
    media: channel.source.mediaElement,
    sources,
    gains,
    context,
    get decodeCount() { return decodeCount; },
  };
}

function response(ok = true) {
  return { ok, status: ok ? 200 : 503, arrayBuffer: async () => new ArrayBuffer(4) } as Response;
}

test("a nearly silent donor is rejected without interrupting the audible layer", async () => {
  const loudSamples = new Float32Array(144_000).fill(0.1);
  const quietSamples = new Float32Array(144_000).fill(0.0001);
  let decodeCount = 0;
  const f = fixture(undefined, undefined, () => {
    decodeCount += 1;
    const samples = decodeCount === 1 ? loudSamples : quietSamples;
    return {
      duration: 3,
      length: samples.length,
      numberOfChannels: 2,
      sampleRate: 48_000,
      getChannelData: () => samples,
    };
  });
  globalThis.fetch = async () => response();
  try {
    await f.layers.replace("vocals", "/audible-donor");
    const activeDonor = f.sources.at(-1);
    assert.ok(activeDonor);
    const sourceCount = f.sources.length;
    assert.equal(f.channel.inputGain.gain.value, 0, "the original is muted only after the audible donor takes over");

    await assert.rejects(
      f.layers.replace("vocals", "/nearly-silent-donor"),
      new RegExp(`nearly silent \\(-80\\.0 dBFS\\).*separation may have failed`),
    );

    assert.equal(LIVE_STEM_MIN_DONOR_RMS_DBFS, -55);
    assert.equal(activeDonor.stopped, false, "the previously installed donor keeps playing");
    assert.equal(f.sources.length, sourceCount, "a quiet replacement never creates or starts a new source");
    assert.equal(f.channel.inputGain.gain.value, 0, "a failed replacement does not unmute or interrupt the retained layer");
  } finally {
    f.layers.dispose();
  }
});

test("donor harmonic correction is connected before takeover, changes independently, and is released on restore", async () => {
  const globals = globalThis as unknown as { AudioWorkletNode?: unknown };
  const original = globals.AudioWorkletNode;
  const nodes: Array<{
    messages: Array<{ type: string; semitones?: number }>;
    ready(): void;
    connected: unknown;
    closed: boolean;
  }> = [];
  globals.AudioWorkletNode = class {
    messages: Array<{ type: string; semitones?: number }> = [];
    connected: unknown = null;
    closed = false;
    port = {
      onmessage: null as ((event: unknown) => void) | null,
      postMessage: (message: { type: string; semitones?: number }) => { this.messages.push(message); },
      close: () => { this.closed = true; },
    };
    constructor(_context: unknown, name: string) {
      assert.equal(name, "waveyard-key-shift");
      nodes.push(this);
    }
    ready() { this.port.onmessage?.({ data: { type: "key-ready" } }); }
    connect(destination: unknown) { this.connected = destination; }
    disconnect() { this.connected = null; }
  };
  const f = fixture();
  (f.context as unknown as { audioWorklet: unknown }).audioWorklet = { addModule: async () => {} };
  globalThis.fetch = async () => response();
  const nextNode = async (count: number) => {
    for (let i = 0; i < 30 && nodes.length < count; i++) await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(nodes.length, count);
    return nodes[count - 1];
  };
  try {
    const first = f.layers.replace("vocals", "/harmonic-donor", 1, undefined, 0, -2);
    const a = await nextNode(1);
    assert.equal(f.channel.inputGain.gain.value, 1, "preparing pitch must not mute the current stem");
    a.ready();
    await first;
    assert.equal(a.connected, f.channel.gain);
    assert.equal(f.gains.at(-1)!.connectedTo, a);
    assert.ok(a.messages.some(message => message.type === "key-shift" && message.semitones === -2));
    const changed = f.layers.replace("vocals", "/harmonic-donor", 1, undefined, 0, 3);
    const b = await nextNode(2);
    assert.equal(a.closed, false, "keep the old corrected donor until the new correction is ready");
    b.ready();
    await changed;
    assert.equal(f.decodeCount, 1, "changing key does not download or decode another full-song copy");
    await f.layers.replace("vocals", null);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(f.channel.inputGain.gain.value, 1);
    assert.equal(a.closed, true);
    assert.equal(b.closed, true);
  } finally {
    f.layers.dispose();
    if (original === undefined) delete globals.AudioWorkletNode;
    else globals.AudioWorkletNode = original;
  }
});

test("cancelling donor harmonic preparation keeps the original audible and releases its processor", async () => {
  const f = fixture();
  (f.context as unknown as { audioWorklet: unknown }).audioWorklet = { addModule: async () => {} };
  const globals = globalThis as unknown as { AudioWorkletNode?: unknown };
  const original = globals.AudioWorkletNode;
  let closed = false;
  let constructed = false;
  globals.AudioWorkletNode = class {
    constructor() { constructed = true; }
    port = { onmessage: null, postMessage() {}, close() { closed = true; } };
    disconnect() {}
  };
  globalThis.fetch = async () => response();
  try {
    const pending = f.layers.replace("vocals", "/cancelled-harmonic-donor", 1, undefined, 0, 2);
    for (let i = 0; i < 30 && !constructed; i++) await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(constructed, true);
    f.layers.cancelPending("vocals");
    assert.equal(await pending, false);
    assert.equal(closed, true);
    assert.equal(f.channel.inputGain.gain.value, 1);
    assert.equal(f.sources.length, 0);
  } finally {
    f.layers.dispose();
    if (original === undefined) delete globals.AudioWorkletNode;
    else globals.AudioWorkletNode = original;
  }
});

test("live donors retain measured beat phase through replacement and seek, including negative offsets", async () => {
  globalThis.fetch = async () => response();
  const f = fixture();
  f.media.currentTime = 1;
  await f.layers.replace("vocals", "/donor", 1, undefined, 0.25);
  assert.equal(f.sources.at(-1)!.offset, 1.25);
  // A changed alignment is not mistaken for the already installed donor.
  await f.layers.replace("vocals", "/donor", 1, undefined, -1.25);
  assert.equal(f.sources.at(-1)!.offset, 2.75);
  f.media.currentTime = 2;
  f.layers.sync(["vocals"]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(f.sources.at(-1)!.offset, 0.75);
  f.layers.dispose();
});

test("a rejected pooled donor downloads fresh bytes on retry without revoking the standby deck", async () => {
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    return new Response(new Uint8Array([fetches]));
  };
  const pool = new SessionAudioAssetPool();
  const replacements: string[] = [];
  pool.subscribeToReplacement(url => replacements.push(url));
  let rejects = true;
  const f = fixture(undefined, undefined, () => {
    if (rejects) throw new Error("Corrupt donor");
    return { duration: 3, length: 144_000, numberOfChannels: 2 };
  });
  f.layers.setAssetPool(pool);
  const lease = await pool.acquireMediaUrl("/donor", new AbortController().signal);
  try {
    await assert.rejects(f.layers.replace("vocals", "/donor"), /Corrupt donor/);
    assert.equal(fetches, 1, "the standby download was reused for the initial swap");
    assert.equal((await (await originalFetch(lease.src)).arrayBuffer()).byteLength, 1,
      "invalidating donor bytes must not revoke the standby deck's existing media URL");
    rejects = false;
    await f.layers.replace("vocals", "/donor");
    assert.equal(fetches, 2, "retry fetches fresh audio instead of decoding the corrupt cached response");
    assert.deepEqual(replacements, ["/donor"], "fresh bytes notify standby decks exactly once");
    assert.equal(f.sources.length, 1);
    lease.release();
    await pool.readBytes("/donor", new AbortController().signal);
    assert.equal(fetches, 2, "releasing the retired deck lease must not remove the replacement cache entry");
  } finally {
    lease.release();
    f.layers.dispose();
    pool.dispose();
  }
});

function lifecycleState(layers: LiveStemLayers) {
  return layers as unknown as {
    layers: Map<string, unknown>;
    pending: Map<string, unknown>;
    prepared: Map<string, unknown>;
    recent: Map<string, unknown>;
    prefetchedAssets: Map<string, unknown>;
    prefetchedAssetBytes: number;
    retired: Set<unknown>;
  };
}

test("a stalled switch times out without muting or resetting the original, and a late response stays silent", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture();
  let release!: (response: Response) => void;
  let signal: AbortSignal | undefined;
  globalThis.fetch = (_url, init) => {
    signal = init?.signal as AbortSignal;
    // Deliberately ignore abort, as a decoder or a buffered response can.
    return new Promise<Response>(resolve => { release = resolve; });
  };
  try {
    const pending = f.layers.replace("vocals", "/stalled");
    const rejected = assert.rejects(pending, /timed out after 15 seconds/);
    mock.timers.tick(LIVE_STEM_SWITCH_TIMEOUT_MS);
    await rejected;
    assert.equal(signal?.aborted, true);
    assert.equal(f.channel.inputGain.gain.value, 1);
    assert.equal(f.media.paused, false);
    assert.equal(f.media.currentTime, 7);
    release(response());
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(f.sources.length, 0);
    globalThis.fetch = async () => response();
    f.media.currentTime = 11;
    await f.layers.replace("vocals", "/retry");
    assert.equal(f.sources[0]?.offset, 11 % 3, "retry aligns to the live clock, not the timed-out selection");
  } finally {
    f.layers.dispose();
    mock.timers.reset();
  }
});

test("cancelling preparation preserves an already audible donor even when its replacement ignores abort", async () => {
  const f = fixture();
  globalThis.fetch = async () => response();
  try {
    await f.layers.replace("vocals", "/audible");
    let release!: (response: Response) => void;
    globalThis.fetch = () => new Promise<Response>(resolve => { release = resolve; });
    const pending = f.layers.replace("vocals", "/stalled");
    f.layers.cancelPending("vocals");
    await pending;
    assert.equal(f.sources[0]?.stopped, false);
    assert.equal(f.channel.inputGain.gain.value, 0, "the existing donor, not the original, stays selected");
    release(response());
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(f.sources.length, 1);
  } finally { f.layers.dispose(); }
});

test("preparation leaves original audible; ready donor joins the unchanged recipient clock", async () => {
  const f = fixture();
  let ready!: (value: Response) => void;
  globalThis.fetch = () => new Promise<Response>((resolve) => { ready = resolve; });
  try {
    const preparing = f.layers.replace("vocals", "/donor");
    assert.equal(f.channel.inputGain.gain.value, 1);
    assert.equal(f.sources.length, 0);
    ready(response());
    await preparing;
    assert.equal(f.media.currentTime, 7, "never change the original clock");
    assert.equal(f.channel.inputGain.gain.value, 0);
    assert.equal(f.sources[0].offset, 1, "short donor wraps to recipient time modulo donor length");
    assert.equal(f.sources[0].loop, true);
    const originalFade = f.channel.inputGain.automation.find(event => event.type === "ramp");
    const donorFade = f.gains[2].automation.find(event => event.type === "ramp");
    assert.deepEqual(originalFade, { type: "ramp", value: 0, time: 5.04 });
    assert.deepEqual(donorFade, { type: "ramp", value: 1, time: 5.04 });
  } finally { f.layers.dispose(); }
});

test("varispeed updates an audible donor and carries into later live layers", async () => {
  const f = fixture();
  globalThis.fetch = async () => response();
  try {
    f.layers.setPlaybackRate(1.1);
    await f.layers.replace("vocals", "/first");
    assert.equal(f.sources[0]?.playbackRate.value, 1.1);

    f.layers.setPlaybackRate(0.9);
    assert.equal(f.sources[0]?.playbackRate.value, 0.9);

    await f.layers.replace("vocals", null);
    await f.layers.replace("vocals", "/second");
    assert.equal(f.sources[1]?.playbackRate.value, 0.9);
  } finally { f.layers.dispose(); }
});

test("pause/resume and seek resynchronize buffer playback without replacing the media element", async () => {
  const f = fixture();
  globalThis.fetch = async () => response();
  try {
    await f.layers.replace("vocals", "/donor");
    f.layers.pause();
    assert.equal(f.sources[0].stopped, true);
    f.media.currentTime = 11;
    f.layers.sync(["vocals"]);
    assert.equal(f.sources[1].offset, 2);
    assert.equal(f.media.currentTime, 11);
    f.media.paused = true;
    f.layers.sync(["vocals"]);
    assert.equal(f.sources[1].stopped, true);
    assert.equal(f.sources.length, 2);
  } finally { f.layers.dispose(); }
});

test("failed donor selection preserves the existing layer and reports the failure", async () => {
  const f = fixture();
  globalThis.fetch = async () => response();
  try {
    await f.layers.replace("vocals", "/good");
    const active = f.sources[0];
    globalThis.fetch = async () => response(false);
    await assert.rejects(f.layers.replace("vocals", "/missing"), /503/);
    assert.equal(active.stopped, false);
    assert.equal(f.channel.inputGain.gain.value, 0);
  } finally { f.layers.dispose(); }
});

test("a corrupt shared download is evicted so retry fetches fresh bytes without interrupting the original", async () => {
  const pool = new SessionAudioAssetPool();
  let decodeFails = true;
  let fetches = 0;
  const f = fixture(undefined, undefined, () => {
    if (decodeFails) throw new Error("Unable to decode audio data");
    return { duration: 3, length: 144_000, numberOfChannels: 2 };
  }, ["vocals"], pool);
  globalThis.fetch = async () => {
    fetches += 1;
    return new Response(new Uint8Array([fetches]), { status: 200 });
  };
  try {
    await pool.preload("/donor");
    await assert.rejects(f.layers.replace("vocals", "/donor"), /Unable to decode/);
    assert.equal(fetches, 1, "the decoder consumes the prefetched response");
    assert.equal(f.channel.inputGain.gain.value, 1);
    assert.equal(f.media.paused, false);
    assert.equal(f.media.currentTime, 7);
    decodeFails = false;
    await f.layers.replace("vocals", "/donor");
    assert.equal(fetches, 2, "retry downloads the same URL again instead of decoding cached corruption");
    assert.equal(f.sources.length, 1);
    assert.equal(f.channel.inputGain.gain.value, 0);
    assert.equal(f.media.currentTime, 7);
  } finally {
    f.layers.dispose();
    pool.dispose();
  }
});

test("invalidating rejected bytes preserves media leases and late failures cannot evict a newer download", async () => {
  const pool = new SessionAudioAssetPool();
  const signal = new AbortController().signal;
  let fetches = 0;
  globalThis.fetch = async () => new Response(new Uint8Array([++fetches]), { status: 200 });
  try {
    const lease = await pool.acquireMediaUrl("/donor", signal);
    const oldBytes = await pool.readBytes("/donor", signal);
    pool.invalidateBytes("/donor", oldBytes);
    assert.deepEqual([...new Uint8Array(await (await originalFetch(lease.src)).arrayBuffer())], [1],
      "existing playback retains its object URL until its lease is released");
    const newBytes = await pool.readBytes("/donor", signal);
    assert.deepEqual([...new Uint8Array(newBytes)], [2]);
    pool.invalidateBytes("/donor", oldBytes);
    assert.deepEqual([...new Uint8Array(await pool.readBytes("/donor", signal))], [2]);
    assert.equal(fetches, 2, "late rejection of the first response leaves the new cache intact");
    lease.release();
    await assert.rejects(originalFetch(lease.src), /fetch failed/);
  } finally { pool.dispose(); }
});

test("a late download cannot override a newer selection", async () => {
  const f = fixture();
  let first!: (value: Response) => void;
  globalThis.fetch = async (url) => url === "/late"
    ? new Promise<Response>((resolve) => { first = resolve; })
    : response();
  try {
    const late = f.layers.replace("vocals", "/late");
    await f.layers.replace("vocals", "/latest");
    first(response());
    await late;
    assert.equal(f.sources.length, 1);
    assert.equal(f.sources[0].stopped, false);
  } finally { f.layers.dispose(); }
});

test("duplicate in-flight selections share the same download and playback", async () => {
  const f = fixture();
  let responseDonor!: (value: Response) => void;
  let fetchCount = 0;
  globalThis.fetch = () => {
    fetchCount += 1;
    return new Promise<Response>(resolve => { responseDonor = resolve; });
  };
  try {
    const first = f.layers.replace("vocals", "/same-donor");
    const duplicate = f.layers.replace("vocals", "/same-donor");
    assert.equal(fetchCount, 1, "a rerendered selection does not start another donor download");
    responseDonor(response());
    await Promise.all([first, duplicate]);
    assert.equal(f.sources.length, 1, "only one audible layer is installed for the shared selection");
  } finally {
    f.layers.dispose();
  }
});

for (const [firstId, secondId] of [["vocals", "drums"], ["drums", "vocals"]] as const) {
  test(`pending ${firstId} and ${secondId} donors finish independently in reverse selection order`, async () => {
    const firstBuffer = { duration: 17, length: 816_000, numberOfChannels: 2 } as AudioBuffer;
    const secondBuffer = { duration: 11, length: 528_000, numberOfChannels: 2 } as AudioBuffer;
    // Decodes occur in completion order, not selection order.
    const buffers = [secondBuffer, firstBuffer];
    const f = fixture(undefined, undefined, () => buffers.shift()!, ["vocals", "drums"]);
    const downloads = new Map<string, { resolve: (value: Response) => void; signal: AbortSignal | undefined }>();
    globalThis.fetch = (url, init) => new Promise<Response>(resolve => {
      downloads.set(String(url), { resolve, signal: init?.signal ?? undefined });
    });
    try {
      const firstChannel = f.channels.get(firstId)!;
      const secondChannel = f.channels.get(secondId)!;
      firstChannel.source.mediaElement.currentTime = 8.75;
      secondChannel.source.mediaElement.currentTime = 23.5;
      const first = f.layers.replace(firstId, "/first-channel-donor");
      const second = f.layers.replace(secondId, "/second-channel-donor");
      assert.equal(downloads.size, 2, "both channels start their own pending download");
      assert.equal(downloads.get("/first-channel-donor")!.signal?.aborted, false,
        "selecting a donor for another channel does not cancel the earlier request");
      assert.equal(firstChannel.inputGain.gain.value, 1);
      assert.equal(secondChannel.inputGain.gain.value, 1);
      assert.equal(f.sources.length, 0, "originals remain audible while both donors load");

      downloads.get("/second-channel-donor")!.resolve(response());
      await second;
      assert.equal(f.sources.length, 1);
      const secondSource = f.sources[0];
      const secondInput = f.gains.at(-1)!;
      assert.equal(secondSource.buffer, secondBuffer, "the later selection uses its own decoded donor");
      assert.equal(secondSource.connectedTo, secondInput);
      assert.equal(secondInput.connectedTo, secondChannel.gain, "the donor routes to its selected channel");
      assert.equal(secondSource.offset, 1.5, "the donor aligns to its channel's unchanged clock");
      assert.equal(secondChannel.inputGain.gain.value, 0);
      assert.equal(firstChannel.inputGain.gain.value, 1, "the other original stays audible while waiting");
      assert.equal(downloads.get("/first-channel-donor")!.signal?.aborted, false,
        "finishing one channel does not cancel the other pending operation");

      downloads.get("/first-channel-donor")!.resolve(response());
      await first;
      assert.equal(f.sources.length, 2, "both selected donors install exactly once");
      const firstSource = f.sources[1];
      const firstInput = f.gains.at(-1)!;
      assert.equal(firstSource.buffer, firstBuffer, "the slow selection retains its own donor identity");
      assert.equal(firstSource.connectedTo, firstInput);
      assert.equal(firstInput.connectedTo, firstChannel.gain);
      assert.equal(firstSource.offset, 8.75);
      assert.equal(firstChannel.inputGain.gain.value, 0);
      assert.equal(secondChannel.inputGain.gain.value, 0);
      assert.equal(firstSource.stopped, false);
      assert.equal(secondSource.stopped, false, "the slow completion does not retire the other donor");
      assert.equal(firstChannel.source.mediaElement.currentTime, 8.75);
      assert.equal(secondChannel.source.mediaElement.currentTime, 23.5);
      assert.equal(firstChannel.source.mediaElement.paused, false);
      assert.equal(secondChannel.source.mediaElement.paused, false);
      assert.equal(f.decodeCount, 2);
    } finally { f.layers.dispose(); }
  });
}

const allStemIds = ["vocals", "drums", "bass", "other"] as const;
const stemPairs = allStemIds.flatMap(failedId =>
  allStemIds.filter(successId => successId !== failedId).map(successId => [failedId, successId] as const),
);

test("parallel donor failures preserve every other stem across cancel, reject, and timeout", async t => {
  for (const failure of ["cancel", "reject", "timeout"] as const) {
    for (const [failedId, successId] of stemPairs) {
      for (const retainedMode of ["original", "donor"] as const) {
        await t.test(`${failure} ${failedId} while ${successId} succeeds, retaining ${retainedMode}`, async () => {
          const retainedBuffer = { duration: 17, length: 816_000, numberOfChannels: 2 } as AudioBuffer;
          const successBuffer = { duration: 11, length: 528_000, numberOfChannels: 2 } as AudioBuffer;
          const buffers = retainedMode === "donor" ? [retainedBuffer, successBuffer] : [successBuffer];
          const f = fixture(undefined, undefined, () => buffers.shift()!, allStemIds);
          const failedChannel = f.channels.get(failedId)!;
          const successChannel = f.channels.get(successId)!;
          failedChannel.source.mediaElement.currentTime = 8.75;
          successChannel.source.mediaElement.currentTime = 23.5;

          let retainedLayer: unknown;
          let retainedSource: (typeof f.sources)[number] | undefined;
          if (retainedMode === "donor") {
            globalThis.fetch = async () => response();
            await f.layers.replace(failedId, "/retained-failed-channel-donor");
            retainedLayer = lifecycleState(f.layers).layers.get(failedId);
            retainedSource = f.sources.at(-1);
            assert.ok(retainedLayer && retainedSource);
          }

          const failedUrl = "/pending-failed-channel-donor";
          const successUrl = "/pending-success-channel-donor";
          const downloads = new Map<string, {
            resolve: (value: Response) => void;
            reject: (reason: Error) => void;
            signal: AbortSignal | undefined;
          }>();
          globalThis.fetch = (url, init) => new Promise<Response>((resolve, reject) => {
            downloads.set(String(url), { resolve, reject, signal: init?.signal ?? undefined });
          });
          if (failure === "timeout") mock.timers.enable({ apis: ["setTimeout"] });

          try {
            const sourceCountBefore = f.sources.length;
            const failing = f.layers.replace(failedId, failedUrl);
            // Give this operation a one-second head start so the second
            // channel is still pending when only the first deadline expires.
            if (failure === "timeout") mock.timers.tick(LIVE_STEM_SWITCH_TIMEOUT_MS - 1_000);
            const succeeding = f.layers.replace(successId, successUrl);
            assert.equal(downloads.size, 2, "both independent stem IDs are preparing");
            assert.equal(lifecycleState(f.layers).pending.size, 2);

            if (failure === "cancel") {
              f.layers.cancelPending(failedId);
              assert.equal(await failing, false);
              assert.equal(downloads.get(failedUrl)!.signal?.aborted, true);
            } else if (failure === "reject") {
              downloads.get(failedUrl)!.reject(new Error("Donor network reset."));
              await assert.rejects(failing, /Donor network reset/);
              assert.equal(downloads.get(failedUrl)!.signal?.aborted, false,
                "a rejected download is distinct from an operation cancelled by its peer");
            } else {
              const timedOut = assert.rejects(failing, /timed out after 15 seconds/);
              mock.timers.tick(1_000);
              await timedOut;
              assert.equal(downloads.get(failedUrl)!.signal?.aborted, true);
            }

            assert.equal(lifecycleState(f.layers).pending.has(failedId), false,
              "the failed channel clears only its own operation identity");
            assert.equal(lifecycleState(f.layers).pending.has(successId), true,
              "the successful channel remains pending and independently owned");
            assert.equal(downloads.get(successUrl)!.signal?.aborted, false,
              "failure on one stem never aborts the other download");

            downloads.get(successUrl)!.resolve(response());
            await succeeding;
            assert.equal(lifecycleState(f.layers).pending.size, 0,
              "both per-channel operation identities are cleared after their independent outcomes settle");
            const successSource = f.sources.at(-1)!;
            const successInput = f.gains.at(-1)!;
            assert.equal(f.sources.length, sourceCountBefore + 1,
              "only the successful donor installs; a failed donor never creates a source");
            assert.equal(successSource.buffer, successBuffer,
              "the successful channel installs its own decoded donor");
            assert.equal(successSource.connectedTo, successInput);
            assert.equal(successInput.connectedTo, successChannel.gain,
              "the surviving donor routes only to its own stem ID");
            assert.equal(successSource.offset, 23.5 % successBuffer.duration,
              "the successful donor follows its peer channel's independent clock");
            assert.equal(successChannel.inputGain.gain.value, 0);
            assert.equal(successSource.stopped, false,
              "the successful donor stays installed after the other channel fails");
            assert.equal(downloads.get(successUrl)!.signal?.aborted, false);
            assert.equal(successChannel.source.mediaElement.currentTime, 23.5);
            assert.equal(successChannel.source.mediaElement.paused, false);

            assert.equal(lifecycleState(f.layers).layers.get(failedId), retainedLayer,
              "the failed operation preserves the exact previously audible layer identity");
            assert.equal(failedChannel.source.mediaElement.currentTime, 8.75);
            assert.equal(failedChannel.source.mediaElement.paused, false);
            if (retainedMode === "original") {
              assert.equal(failedChannel.inputGain.gain.value, 1,
                "the still-audible original retains its gain while its replacement fails");
            } else {
              assert.equal(retainedSource?.stopped, false,
                "the prior donor is not retired when its replacement on this channel fails");
              assert.equal(retainedSource?.buffer, retainedBuffer,
                "the exact previously audible donor identity remains selected");
              assert.equal(retainedSource?.offset, 8.75 % retainedBuffer.duration,
                "the retained donor keeps its own channel's clock alignment");
              assert.equal(failedChannel.inputGain.gain.value, 0,
                "the previous donor remains selected instead of falling back to the original");
            }

            if (failure !== "reject") {
              const sourcesBeforeLateResponse = f.sources.length;
              downloads.get(failedUrl)!.resolve(response());
              await new Promise<void>(resolve => setImmediate(resolve));
              assert.equal(f.sources.length, sourcesBeforeLateResponse,
                "a response that ignores abort cannot install on the failed channel");
              assert.equal(lifecycleState(f.layers).layers.get(failedId), retainedLayer);
              assert.equal(successSource.stopped, false,
                "the late stale response cannot retire or replace the successful peer");
            }
          } finally {
            f.layers.dispose();
            if (failure === "timeout") mock.timers.reset();
          }
        });
      }
    }
  }
});

test("tempo-matched donor audio is prepared before the original layer fades out", async () => {
  const ratios: number[] = [];
  const f = fixture(async (_context, _buffer, ratio, signal) => {
    ratios.push(ratio);
    assert.equal(signal.aborted, false);
    return { duration: 6 } as AudioBuffer;
  });
  globalThis.fetch = async () => response();
  try {
    await f.layers.replace("vocals", "/donor", 0.8);
    assert.deepEqual(ratios, [0.8]);
    assert.equal(f.sources[0].offset, 1, "the stretched donor follows the recipient clock modulo its new duration");
    assert.equal(f.channel.inputGain.gain.value, 0, "the original fades only after matching finishes");
  } finally { f.layers.dispose(); }
});

test("preloading decodes and tempo-matches a chosen donor before replacement without making it audible", async () => {
  const ratios: number[] = [];
  const f = fixture(async (_context, _buffer, ratio) => {
    ratios.push(ratio);
    return { duration: 6 } as AudioBuffer;
  });
  let fetchCount = 0;
  globalThis.fetch = async () => { fetchCount += 1; return response(); };
  try {
    await f.layers.preload("/donor", 0.8);
    assert.equal(fetchCount, 1);
    assert.equal(f.decodeCount, 1);
    assert.deepEqual(ratios, [0.8]);
    assert.equal(f.sources.length, 0, "preparing a donor never starts playback");
    assert.equal(f.channel.inputGain.gain.value, 1, "preparing a donor never changes the current layer");

    await f.layers.replace("vocals", "/donor", 0.8);
    assert.equal(fetchCount, 1, "the live swap consumes the warmed donor instead of downloading it again");
    assert.equal(f.decodeCount, 1, "the warmed donor is not decoded a second time");
    assert.equal(f.sources.length, 1);
    assert.equal(f.channel.inputGain.gain.value, 0, "the original fades only when the warmed donor is ready");
  } finally { f.layers.dispose(); }
});

test("overlapping live and compressed requests share one transfer and a cancelled swap can retry from it", async () => {
  const f = fixture();
  let fetchCount = 0;
  let fetchSignal: AbortSignal | undefined;
  let releaseResponse!: (value: Response) => void;
  globalThis.fetch = (_url, init) => {
    fetchCount += 1;
    fetchSignal = init?.signal as AbortSignal;
    return new Promise<Response>((resolve) => { releaseResponse = resolve; });
  };
  try {
    const cancelledSwap = f.layers.replace("vocals", "/shared-donor");
    const prefetch = f.layers.preloadAsset("/shared-donor");
    assert.equal(fetchCount, 1, "the compressed prefetch joins the live transfer already in progress");

    f.layers.cancelPending("vocals");
    assert.equal(fetchSignal?.aborted, false,
      "cancelling the live swap does not abort a transfer still needed by the prefetch");
    releaseResponse(response());
    assert.equal(await cancelledSwap, false, "the cancelled selection never becomes audible");
    await prefetch;

    await f.layers.replace("vocals", "/shared-donor");
    assert.equal(fetchCount, 1, "retry consumes the cached bytes instead of transferring the stem again");
    assert.equal(f.sources.length, 1, "the retry installs the selected donor");
    assert.equal(f.channel.inputGain.gain.value, 0, "the donor is audible after it is ready");
  } finally {
    f.layers.dispose();
  }
});

test("coalesced decoding cannot detach the bytes retained for another stem channel", async () => {
  const f = fixture(undefined, undefined, undefined, ["vocals", "drums"]);
  const decodedByteLengths: number[] = [];
  f.context.decodeAudioData = async (input: ArrayBuffer) => {
    decodedByteLengths.push(input.byteLength);
    structuredClone(input, { transfer: [input] });
    return { duration: 3, length: 144_000, numberOfChannels: 2 } as AudioBuffer;
  };
  let fetchCount = 0;
  let releaseResponse!: (value: Response) => void;
  globalThis.fetch = async () => {
    fetchCount += 1;
    return new Promise<Response>((resolve) => { releaseResponse = resolve; });
  };
  try {
    const vocals = f.layers.replace("vocals", "/shared-donor");
    const prefetch = f.layers.preloadAsset("/shared-donor");
    assert.equal(fetchCount, 1, "the prefetch and live replacement share the transfer");
    releaseResponse(response());
    await Promise.all([vocals, prefetch]);

    await f.layers.replace("drums", "/shared-donor");
    assert.deepEqual(decodedByteLengths, [4, 4],
      "each decoder receives intact bytes despite detaching its private input");
    assert.equal(fetchCount, 1, "the second channel reuses the retained compressed asset");
    assert.equal(f.sources.length, 2, "both channels install the shared donor independently");
  } finally {
    f.layers.dispose();
  }
});

test("idle compressed donor bytes expire after reuse without affecting another active stem", async () => {
  const f = fixture(async (_context, buffer) => buffer, undefined, undefined, ["vocals", "drums"]);
  const fetches: string[] = [];
  globalThis.fetch = async url => {
    fetches.push(String(url));
    return new Response(new Uint8Array([1, 2, 3, 4, 5, 6]));
  };
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    await f.layers.preloadAsset("/compressed-donor");
    assert.equal(lifecycleState(f.layers).prefetchedAssetBytes, 6);

    await f.layers.preload("/compressed-donor", 0.8);
    await f.layers.preload("/compressed-donor", 1.2);
    await f.layers.replace("vocals", "/active-stem");
    const activeStem = f.sources[0];

    mock.timers.tick(20_000);
    await f.layers.preloadAsset("/compressed-donor");
    await f.layers.preload("/compressed-donor", 1.1);
    assert.equal(
      fetches.filter(url => url === "/compressed-donor").length,
      1,
      "compressed bytes are reused by repeated reads before the original expiry",
    );
    assert.equal(lifecycleState(f.layers).prefetchedAssetBytes, 6,
      "re-reading the asset does not double-count its bytes");

    mock.timers.tick(10_000);
    assert.equal(lifecycleState(f.layers).prefetchedAssets.has("/compressed-donor"), false,
      "the compressed entry is released at its original expiry");
    assert.equal(lifecycleState(f.layers).prefetchedAssetBytes, 0,
      "expiry returns the compressed bytes to the cache budget");
    assert.equal(activeStem.stopped, false, "expiring an idle prefetch does not stop another active stem");

    await f.layers.preloadAsset("/compressed-donor");
    assert.equal(fetches.filter(url => url === "/compressed-donor").length, 2,
      "a later preload fetches fresh bytes after expiry");
    assert.equal(activeStem.stopped, false, "refetching the expired asset leaves playback running");
  } finally {
    f.layers.dispose();
    mock.timers.reset();
  }
});

test("a warmed donor's audible timing starts when the user selects it, not when warming began", async () => {
  const f = fixture(undefined, timing => timings.push(timing));
  const timings: Array<{ selectionToAudibleMs: number }> = [];
  globalThis.fetch = async () => response();
  try {
    await f.layers.preload("/donor");
    await new Promise(resolve => setTimeout(resolve, 40));
    const selectedAt = performance.now();
    await f.layers.replace("vocals", "/donor", 1, selectedAt);
    assert.equal(timings.length, 1);
    assert.ok(
      timings[0].selectionToAudibleMs <= performance.now() - selectedAt + 10,
      "pre-selection warm time must not inflate the selection-to-audible measurement",
    );
  } finally { f.layers.dispose(); }
});

test("live swap timings separate download, decode, and tempo matching for native and matched donors", async () => {
  const wait = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
  const nativeTimings: Array<{ selectionToAudibleMs: number; downloadMs: number; decodeMs: number; tempoMatchMs: number; tempoStretchRatio: number; transferBytes: number }> = [];
  const native = fixture(undefined, timing => nativeTimings.push(timing));
  native.context.decodeAudioData = async () => {
    await wait(8);
    return { duration: 3 } as AudioBuffer;
  };
  globalThis.fetch = async () => {
    await wait(8);
    return response();
  };
  try {
    const selectedAt = performance.now();
    await native.layers.preload("/native", 1, selectedAt);
    await native.layers.replace("vocals", "/native", 1);
    assert.equal(nativeTimings.length, 1);
    assert.equal(nativeTimings[0].tempoStretchRatio, 1);
    assert.equal(nativeTimings[0].tempoMatchMs, 0, "native-tempo donors skip the tempo-matching stage");
    assert.ok(nativeTimings[0].downloadMs >= 0);
    assert.ok(nativeTimings[0].decodeMs >= 0);
    assert.ok(nativeTimings[0].selectionToAudibleMs >= 0,
      "selection-to-audible is measured from replacement, independently of work completed during prewarming");
    assert.equal(nativeTimings[0].transferBytes, 4);
  } finally {
    native.layers.dispose();
  }

  const matchedTimings: Array<{ selectionToAudibleMs: number; downloadMs: number; decodeMs: number; tempoMatchMs: number; tempoStretchRatio: number; transferBytes: number }> = [];
  const matched = fixture(async (_context, _buffer, _ratio) => {
    await wait(8);
    return { duration: 6 } as AudioBuffer;
  }, timing => matchedTimings.push(timing));
  matched.context.decodeAudioData = async () => {
    await wait(8);
    return { duration: 3 } as AudioBuffer;
  };
  try {
    const selectedAt = performance.now();
    await matched.layers.preload("/matched", 0.8, selectedAt);
    await matched.layers.replace("vocals", "/matched", 0.8);
    assert.equal(matchedTimings.length, 1);
    assert.equal(matchedTimings[0].tempoStretchRatio, 0.8);
    assert.ok(matchedTimings[0].downloadMs >= 0);
    assert.ok(matchedTimings[0].decodeMs >= 0);
    assert.ok(matchedTimings[0].tempoMatchMs > 0);
    assert.ok(matchedTimings[0].selectionToAudibleMs >= 0,
      "completed tempo preparation is not counted again as post-selection latency");
  } finally {
    matched.layers.dispose();
  }
});

test("a failed warm-up is discarded so the real swap can retry the donor request", async () => {
  const f = fixture();
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    return response(fetchCount > 1);
  };
  try {
    await assert.rejects(f.layers.preload("/donor"), /503/);
    await f.layers.replace("vocals", "/donor");
    assert.equal(fetchCount, 2, "a rejected prefetch is not retained as a poisoned cache entry");
    assert.equal(f.sources.length, 1);
  } finally { f.layers.dispose(); }
});

test("a newer donor cancels stale tempo preparation before it can take over", async () => {
  let started!: () => void;
  let firstSignal: AbortSignal | null = null;
  const workerStarted = new Promise<void>((resolve) => { started = resolve; });
  const f = fixture((_context, _buffer, ratio, signal) => {
    if (ratio !== 0.8) return Promise.resolve({ duration: 3 } as AudioBuffer);
    firstSignal = signal;
    started();
    return new Promise<AudioBuffer>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("Preparation cancelled.")), { once: true });
    });
  });
  globalThis.fetch = async () => response();
  try {
    const stale = f.layers.replace("vocals", "/slow-donor", 0.8);
    await workerStarted;
    await f.layers.replace("vocals", "/latest-donor");
    await stale;
    assert.equal(firstSignal?.aborted, true);
    assert.equal(f.sources.length, 1, "only the latest selection starts audio");
    assert.equal(f.channel.inputGain.gain.value, 0, "the original fades only for the latest ready donor");
  } finally { f.layers.dispose(); }
});

test("a rapid donor change holds the in-progress crossfade before starting the next one", async () => {
  const f = fixture();
  globalThis.fetch = async () => response();
  try {
    await f.layers.replace("vocals", "/first");
    f.context.currentTime = 5.02;
    await f.layers.replace("vocals", "/second");

    const firstDonorAutomation = f.gains[2].automation;
    assert.deepEqual(firstDonorAutomation.slice(-2), [
      { type: "hold", time: 5.02 },
      { type: "ramp", value: 0, time: 5.06 },
    ]);
    assert.deepEqual(f.gains[3].automation.slice(-2), [
      { type: "hold", time: 5.02 },
      { type: "ramp", value: 1, time: 5.06 },
    ]);
  } finally { f.layers.dispose(); }
});

test("switching A to B and back reuses A's prepared audio", async () => {
  const f = fixture();
  const fetches: string[] = [];
  globalThis.fetch = async (url) => {
    fetches.push(String(url));
    return response();
  };
  try {
    await f.layers.replace("vocals", "/donor-a");
    const firstDonorBuffer = f.sources[0].buffer;
    await f.layers.replace("vocals", "/donor-b");
    await f.layers.replace("vocals", "/donor-a");

    assert.deepEqual(fetches, ["/donor-a", "/donor-b"], "returning to A does not download it again");
    assert.equal(f.decodeCount, 2, "returning to A does not decode it again");
    assert.equal(f.sources[2].buffer, firstDonorBuffer, "the new playback source uses A's retained buffer");
    assert.equal(f.sources[2].stopped, false);
  } finally { f.layers.dispose(); }
});

test("recent donor eviction leaves playback running and evicted donors prepare again", async () => {
  const f = fixture();
  const fetches: string[] = [];
  globalThis.fetch = async (url) => {
    fetches.push(String(url));
    return response();
  };
  try {
    await f.layers.replace("vocals", "/donor-a");
    await f.layers.replace("vocals", "/donor-b");
    await f.layers.replace("vocals", "/donor-c");
    await f.layers.replace("vocals", "/donor-d");

    const activeDonor = f.sources[3];
    assert.equal(activeDonor.stopped, false, "evicting A does not stop the currently audible donor");
    assert.deepEqual(fetches, ["/donor-a", "/donor-b", "/donor-c", "/donor-d"]);

    await f.layers.replace("vocals", "/donor-a");
    assert.equal(fetches.at(-1), "/donor-a", "an evicted donor is downloaded again");
    assert.equal(f.sources.length, 5);
    assert.equal(activeDonor.stopped, false, "the active donor continues through preparation and crossfade start");
  } finally { f.layers.dispose(); }
});

test("expired recent donors are fetched again instead of served from cache", async () => {
  const f = fixture();
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    return response();
  };
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    await f.layers.replace("vocals", "/expired-donor");
    await f.layers.replace("vocals", "/current-donor");
    assert.equal(fetchCount, 2);

    mock.timers.tick(30_000);
    await f.layers.replace("vocals", "/expired-donor");

    assert.equal(fetchCount, 3, "the expired donor must be downloaded and decoded again");
  } finally {
    f.layers.dispose();
    mock.timers.reset();
  }
});

test("idle tempo-matched donors expire without interrupting a different active replacement", async () => {
  let stretchCount = 0;
  const f = fixture(async (_context, buffer) => {
    stretchCount += 1;
    return buffer;
  });
  const fetches: string[] = [];
  globalThis.fetch = async url => {
    fetches.push(String(url));
    return response();
  };
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    await f.layers.replace("vocals", "/tempo-donor", 0.8);
    const firstBuffer = f.sources[0].buffer;
    await f.layers.replace("vocals", "/active-replacement");

    await f.layers.replace("vocals", "/tempo-donor", 0.8);
    assert.equal(fetches.filter(url => url === "/tempo-donor").length, 1,
      "a tempo-matched donor is initially reused from the recent cache");
    assert.equal(stretchCount, 1, "reusing the cached donor skips tempo preparation");
    assert.equal(f.sources[2].buffer, firstBuffer);

    await f.layers.replace("vocals", "/active-replacement");
    const activeReplacement = f.sources.at(-1)!;
    mock.timers.tick(30_000);

    assert.equal(activeReplacement.stopped, false, "cache expiry does not stop another active layer");
    await f.layers.replace("vocals", "/tempo-donor", 0.8);
    assert.equal(fetches.filter(url => url === "/tempo-donor").length, 2,
      "the expired tempo-matched donor is downloaded again");
    assert.equal(stretchCount, 2, "the expired donor is tempo-matched again");
    assert.equal(activeReplacement.stopped, false, "preparing the expired donor leaves playback running");
  } finally {
    f.layers.dispose();
    mock.timers.reset();
  }
});

test("an older donor expiry does not remove a newer copy before its own expiry", async () => {
  const f = fixture(undefined, undefined, undefined, ["vocals", "drums"]);
  const fetches: string[] = [];
  globalThis.fetch = async url => {
    fetches.push(String(url));
    return response();
  };
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    await f.layers.replace("vocals", "/same-donor");
    await f.layers.replace("vocals", "/first-replacement");
    mock.timers.tick(15_000);

    await f.layers.replace("vocals", "/same-donor");
    await f.layers.replace("vocals", "/second-replacement");
    mock.timers.tick(15_000);

    await f.layers.replace("drums", "/same-donor");
    assert.equal(fetches.filter(url => url === "/same-donor").length, 1,
      "the renewed entry remains reusable after the original entry's expiry deadline");
    const activeSecondReplacement = f.sources[3];
    assert.equal(activeSecondReplacement.stopped, false);

    mock.timers.tick(15_000);
    await f.layers.replace("vocals", "/same-donor");
    assert.equal(fetches.filter(url => url === "/same-donor").length, 2,
      "the newer retained copy is prepared again after its own expiry");
    assert.equal(f.sources[4].stopped, false, "expiry and re-preparation do not stop the other channel");
  } finally {
    f.layers.dispose();
    mock.timers.reset();
  }
});

test("disposing a live layer owner releases retained donors and stops playback immediately", async () => {
  const f = fixture();
  globalThis.fetch = async () => response();
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    await f.layers.replace("vocals", "/retained-donor");
    await f.layers.replace("vocals", "/active-donor");
    mock.timers.tick(80);
    const activeSource = f.sources[1];
    const recent = (f.layers as unknown as { recent: Map<string, unknown> }).recent;
    assert.equal(recent.size, 1, "the replaced donor is retained before session close");
    assert.equal(activeSource.stopped, false);

    f.layers.dispose();

    assert.equal(recent.size, 0, "disposal releases retained donor buffers immediately");
    assert.equal(activeSource.stopped, true, "disposal stops the active playback source");
    mock.timers.tick(30_000);
    assert.equal(recent.size, 0, "advancing beyond the former expiry does not restore retained audio");
  } finally {
    f.layers.dispose();
    mock.timers.reset();
  }
});

test("disposal during a donor crossfade stops both the active and retiring layers", async () => {
  const f = fixture();
  globalThis.fetch = async () => response();
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    await f.layers.replace("vocals", "/first-donor");
    await f.layers.replace("vocals", "/crossfading-donor");
    const retiring = f.sources[0];
    const active = f.sources[1];
    const state = lifecycleState(f.layers);
    assert.equal(state.retired.size, 1, "the old source remains owned during the crossfade");
    assert.equal(retiring.stopped, false);
    assert.equal(active.stopped, false);

    f.layers.dispose();
    assert.equal(retiring.stopped, true, "session close stops the source whose fade timer was pending");
    assert.equal(active.stopped, true, "session close also stops the current donor");
    assert.equal(state.retired.size, 0);
    mock.timers.tick(80);
    assert.equal(retiring.stopped, true, "cleared fade timers cannot resurrect retired audio");
  } finally {
    f.layers.dispose();
    mock.timers.reset();
  }
});

test("disposal aborts donor and compressed preloads, and ignored late downloads cannot be retained", async () => {
  const f = fixture();
  const requests = new Map<string, { signal: AbortSignal; resolve(response: Response): void }>();
  globalThis.fetch = (url, init) => new Promise<Response>(resolve => {
    requests.set(String(url), { signal: init?.signal as AbortSignal, resolve });
  });
  try {
    const replacement = f.layers.replace("vocals", "/pending-donor");
    const preload = f.layers.preloadAsset("/pending-prefetch");
    const rejectedPreload = assert.rejects(preload, { name: "AbortError" });
    assert.equal(requests.size, 2, "the live donor and the compressed preload both started");

    f.layers.dispose();
    assert.equal(requests.get("/pending-donor")?.signal.aborted, true,
      "closing the session aborts the active donor download");
    assert.equal(requests.get("/pending-prefetch")?.signal.aborted, true,
      "closing the session aborts the compressed preload");
    assert.equal(await replacement, false, "a closed session does not install the pending selection");

    requests.get("/pending-donor")!.resolve(response());
    requests.get("/pending-prefetch")!.resolve(response());
    await rejectedPreload;
    await Promise.resolve();
    await Promise.resolve();

    const state = lifecycleState(f.layers);
    assert.equal(state.layers.size, 0);
    assert.equal(state.pending.size, 0);
    assert.equal(state.prepared.size, 0);
    assert.equal(state.recent.size, 0);
    assert.equal(state.prefetchedAssets.size, 0, "late response bytes do not repopulate the prefetch cache");
    assert.equal(state.prefetchedAssetBytes, 0);
    assert.equal(f.sources.length, 0, "late donor bytes never become audible");

    assert.equal(await f.layers.replace("vocals", "/after-close"), false);
    await f.layers.preload("/after-close");
    await f.layers.preloadAsset("/after-close");
    assert.equal(requests.size, 2, "a disposed layer owner cannot start new network work");
  } finally { f.layers.dispose(); }
});

test("a decoder that finishes after disposal cannot install or retain its donor", async () => {
  const f = fixture();
  let releaseDecode!: (buffer: AudioBuffer) => void;
  let markDecodeStarted!: () => void;
  const decodeStarted = new Promise<void>(resolve => { markDecodeStarted = resolve; });
  f.context.decodeAudioData = () => {
    markDecodeStarted();
    return new Promise<AudioBuffer>(resolve => { releaseDecode = resolve; });
  };
  globalThis.fetch = async () => response();
  try {
    const replacement = f.layers.replace("vocals", "/late-decoder");
    await decodeStarted;
    f.layers.dispose();
    assert.equal(await replacement, false, "the session close settles the pending swap without waiting for decoding");

    releaseDecode({ duration: 3, length: 144_000, numberOfChannels: 2 } as AudioBuffer);
    await new Promise<void>(resolve => setImmediate(resolve));
    const state = lifecycleState(f.layers);
    assert.equal(f.sources.length, 0, "a decoder result arriving after close never starts playback");
    assert.equal(state.layers.size, 0);
    assert.equal(state.prepared.size, 0);
    assert.equal(state.recent.size, 0);
  } finally { f.layers.dispose(); }
});

test("disposal aborts pending tempo preparation when the worker honors its signal", async () => {
  let signal: AbortSignal | undefined;
  let markStarted!: () => void;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const f = fixture((_context, _buffer, _ratio, abortSignal) => new Promise<AudioBuffer>((_resolve, reject) => {
    signal = abortSignal;
    markStarted();
    abortSignal.addEventListener("abort", () => reject(new DOMException("Cancelled.", "AbortError")), { once: true });
  }));
  globalThis.fetch = async () => response();
  try {
    const replacement = f.layers.replace("vocals", "/tempo-worker", 0.8);
    await started;
    f.layers.dispose();
    assert.equal(signal?.aborted, true, "session disposal reaches the tempo worker's cancellation signal");
    assert.equal(await replacement, false);
    assert.equal(f.sources.length, 0);
    assert.equal(lifecycleState(f.layers).layers.size, 0);
  } finally { f.layers.dispose(); }
});

test("an uncancellable late tempo result cannot repopulate the prepared cache", async () => {
  let releaseStretch!: (buffer: AudioBuffer) => void;
  let signal: AbortSignal | undefined;
  let markStarted!: () => void;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const f = fixture((_context, _buffer, _ratio, abortSignal) => {
    signal = abortSignal;
    markStarted();
    return new Promise<AudioBuffer>(resolve => { releaseStretch = resolve; });
  });
  globalThis.fetch = async () => response();
  try {
    const warmup = f.layers.preload("/late-tempo", 0.8);
    const rejectedWarmup = assert.rejects(warmup, { name: "AbortError" });
    await started;
    f.layers.dispose();
    assert.equal(signal?.aborted, true, "disposal signals cancellation even to a worker that cannot stop immediately");
    releaseStretch({ duration: 6, length: 288_000, numberOfChannels: 2 } as AudioBuffer);
    await rejectedWarmup;
    const state = lifecycleState(f.layers);
    assert.equal(state.prepared.size, 0);
    assert.equal(state.recent.size, 0, "a late tempo result is not promoted to retained audio");
    assert.equal(state.layers.size, 0);
  } finally { f.layers.dispose(); }
});

test("a late worklet-module completion cannot start a donor after session disposal", async () => {
  const f = fixture();
  const globals = globalThis as unknown as { AudioWorkletNode?: unknown };
  const originalAudioWorkletNode = globals.AudioWorkletNode;
  let workletNodeCount = 0;
  globals.AudioWorkletNode = class {
    readonly port = {
      onmessage: null as ((event: MessageEvent<{ type?: string }>) => void) | null,
      postMessage: (message: { type?: string }) => {
        if (message.type === "load") {
          queueMicrotask(() => this.port.onmessage?.({ data: { type: "ready" } } as MessageEvent<{ type?: string }>));
        }
      },
      close() {},
    };
    constructor() { workletNodeCount += 1; }
    connect(_destination: unknown) {}
    disconnect() {}
  };
  let releaseModule!: () => void;
  let markModuleStarted!: () => void;
  const moduleStarted = new Promise<void>(resolve => { markModuleStarted = resolve; });
  (f.context as unknown as { audioWorklet: { addModule(url: string): Promise<void> } }).audioWorklet = {
    addModule: async () => {
      markModuleStarted();
      await new Promise<void>(resolve => { releaseModule = resolve; });
    },
  };
  await f.layers.setPitchPreserving(true);
  globalThis.fetch = async () => response();
  try {
    const replacement = f.layers.replace("vocals", "/late-worklet");
    await moduleStarted;
    f.layers.dispose();
    releaseModule();
    assert.equal(await replacement, false);
    assert.equal(f.sources.length, 0);
    assert.equal(workletNodeCount, 0, "the completed module load cannot create a processor after disposal");
    assert.equal(lifecycleState(f.layers).layers.size, 0);
  } finally {
    f.layers.dispose();
    if (originalAudioWorkletNode === undefined) delete globals.AudioWorkletNode;
    else globals.AudioWorkletNode = originalAudioWorkletNode;
  }
});

test("disposal during pitch-lock migration releases the worklet when it becomes ready", async () => {
  const workletBuffer = {
    duration: 3,
    length: 144_000,
    numberOfChannels: 2,
    getChannelData: () => new Float32Array(144_000).fill(0.1),
  } as unknown as AudioBuffer;
  const f = fixture(undefined, undefined, workletBuffer);
  const globals = globalThis as unknown as { AudioWorkletNode?: unknown };
  const originalAudioWorkletNode = globals.AudioWorkletNode;
  const messages: string[] = [];
  let workletPortClosed = false;
  let releaseReady!: () => void;
  let markLoadStarted!: () => void;
  let markPlaying!: () => void;
  const loadStarted = new Promise<void>(resolve => { markLoadStarted = resolve; });
  const playingStarted = new Promise<void>(resolve => { markPlaying = resolve; });
  (f.context as unknown as { audioWorklet: { addModule(url: string): Promise<void> } }).audioWorklet = {
    addModule: async () => undefined,
  };
  globals.AudioWorkletNode = class {
    readonly port = {
      onmessage: null as ((event: MessageEvent<{ type?: string }>) => void) | null,
      postMessage: (message: { type?: string }) => {
        messages.push(message.type ?? "");
        if (message.type === "play") markPlaying();
        if (message.type === "load") {
          markLoadStarted();
          releaseReady = () => this.port.onmessage?.({ data: { type: "ready" } } as MessageEvent<{ type?: string }>);
        }
      },
      close: () => { workletPortClosed = true; },
    };
    connect(_destination: unknown) {}
    disconnect() {}
  };
  globalThis.fetch = async () => response();
  try {
    await f.layers.replace("vocals", "/before-migration");
    const activeSource = f.sources[0];
    const migration = f.layers.setPitchPreserving(true);
    await loadStarted;
    releaseReady();
    await playingStarted;
    f.layers.dispose();
    assert.equal(activeSource.stopped, true, "closing the session stops its original live layer");
    await migration;
    assert.equal(messages.includes("dispose"), true, "the late worklet is disposed rather than installed");
    assert.equal(workletPortClosed, true);
    assert.equal(lifecycleState(f.layers).layers.size, 0);
  } finally {
    f.layers.dispose();
    if (originalAudioWorkletNode === undefined) delete globals.AudioWorkletNode;
    else globals.AudioWorkletNode = originalAudioWorkletNode;
  }
});

test("an over-budget pitch-lock request leaves all four live donors audible", async () => {
  const donorIds = ["vocals", "drums", "bass", "other"];
  const fourMinuteStereoBuffer = {
    duration: 240,
    length: 48_000 * 240,
    numberOfChannels: 2,
    sampleRate: 48_000,
  };
  const f = fixture(undefined, undefined, fourMinuteStereoBuffer, donorIds);
  globalThis.fetch = async () => response();
  try {
    for (const id of donorIds) await f.layers.replace(id, `/over-budget-${id}`);
    const originalSources = [...f.sources];
    assert.equal(originalSources.length, donorIds.length);
    assert.ok(originalSources.every(source => !source.stopped && source.buffer === fourMinuteStereoBuffer));

    await assert.rejects(f.layers.setPitchPreserving(true), error => {
      assert.equal((error as Error).name, "LiveStemPitchMemoryBudgetError");
      assert.match((error as Error).message, /above the 512 MiB session limit/);
      assert.match((error as Error).message, /current mix is unchanged/);
      return true;
    });

    assert.ok(
      originalSources.every(source => !source.stopped && source.buffer === fourMinuteStereoBuffer),
      "the existing audio-buffer sources stay active and retain their audio",
    );
    assert.equal(
      (f.context as unknown as { audioWorklet?: unknown }).audioWorklet,
      undefined,
      "the budget rejection happens before worklet migration begins",
    );
    assert.ok(
      6 * 240 * 48_000 * 2 * Float32Array.BYTES_PER_ELEMENT
        > LIVE_STEM_PITCH_LOCK_SESSION_BUDGET_BYTES,
      "four four-minute stereo donors plus migration overlap exceed the configured cap",
    );
  } finally {
    f.layers.dispose();
  }
});

test("a live pitch-locked session rejects a donor that would exceed its aggregate cap", async () => {
  const f = fixture(undefined, undefined, {
    duration: 600,
    length: 48_000 * 600,
    numberOfChannels: 2,
    sampleRate: 48_000,
  });
  globalThis.fetch = async () => response();
  try {
    await f.layers.setPitchPreserving(true);
    await assert.rejects(f.layers.replace("vocals", "/too-large-for-pitch-lock"), error => {
      assert.equal((error as Error).name, "LiveStemPitchMemoryBudgetError");
      assert.match((error as Error).message, /above the 512 MiB session limit/);
      return true;
    });
    assert.equal(f.sources.length, 0, "an over-budget donor never replaces the active original audio");
    assert.equal(f.channel.inputGain.gain.value, 1, "the current original mix remains unmuted");
  } finally {
    f.layers.dispose();
  }
});

test("both decks sharing a session audio context share one pitch-lock memory cap", async () => {
  const donorIds = ["vocals", "drums", "bass", "other"];
  const threeMinuteStereoBuffer = {
    duration: 180,
    length: 48_000 * 180,
    numberOfChannels: 2,
    sampleRate: 48_000,
  };
  const f = fixture(undefined, undefined, threeMinuteStereoBuffer, donorIds);
  const nextDeck = new LiveStemLayers(
    () => f.context as unknown as AudioContext,
    id => (f.channels.get(id) ?? null) as unknown as ReturnType<ConstructorParameters<typeof LiveStemLayers>[1]>,
    undefined,
    undefined,
    "/test/live-stem-worklet.js",
  );
  globalThis.fetch = async () => response();
  try {
    for (const id of donorIds) {
      await f.layers.replace(id, `/current-${id}`);
      await nextDeck.replace(id, `/next-${id}`);
    }
    const originalSources = [...f.sources];
    assert.equal(originalSources.length, donorIds.length * 2);

    await assert.rejects(f.layers.setPitchPreserving(true), error => {
      assert.equal((error as Error).name, "LiveStemPitchMemoryBudgetError");
      assert.match((error as Error).message, /above the 512 MiB session limit/);
      return true;
    });

    assert.ok(
      originalSources.every(source => !source.stopped && source.buffer === threeMinuteStereoBuffer),
      "the current and next deck layers remain audible when their combined donors exceed the cap",
    );
  } finally {
    f.layers.dispose();
    nextDeck.dispose();
  }
});

test("expiration releases byte accounting so later donors within budget remain reusable", async () => {
  const decodedBuffers = [
    { duration: 4_194_304 / 48_000, length: 4_194_304, numberOfChannels: 2 }, // 32 MiB
    { duration: 5_242_880 / 48_000, length: 5_242_880, numberOfChannels: 2 }, // 40 MiB
    { duration: 3_145_728 / 48_000, length: 3_145_728, numberOfChannels: 2 }, // 24 MiB
    { duration: 1 / 48_000, length: 1, numberOfChannels: 1 },
  ];
  const f = fixture(undefined, undefined, () => decodedBuffers.shift() ?? {
    duration: 1 / 48_000,
    length: 1,
    numberOfChannels: 1,
  });
  const fetches: string[] = [];
  globalThis.fetch = async url => {
    fetches.push(String(url));
    return response();
  };
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    await f.layers.replace("vocals", "/expiring-32-mib");
    await f.layers.replace("vocals", "/retained-40-mib");
    mock.timers.tick(30_000);

    await f.layers.replace("vocals", "/later-24-mib");
    await f.layers.replace("vocals", "/small-donor");
    await f.layers.replace("vocals", "/retained-40-mib");

    assert.equal(
      fetches.filter(url => url === "/retained-40-mib").length,
      1,
      "the 40 MiB donor remains reusable beside the 24 MiB donor after the expired 32 MiB is released",
    );
  } finally {
    f.layers.dispose();
    mock.timers.reset();
  }
});

test("recent-cache pressure across stem channels preserves playback and each channel's retained donor", async () => {
  const f = fixture(undefined, undefined, undefined, ["vocals", "drums"]);
  const fetches: string[] = [];
  globalThis.fetch = async (url) => {
    fetches.push(String(url));
    return response();
  };
  try {
    await f.layers.replace("vocals", "/vocal-a");
    await f.layers.replace("drums", "/drum-a");
    await f.layers.replace("vocals", "/vocal-b");
    await f.layers.replace("drums", "/drum-b");
    await f.layers.replace("vocals", "/vocal-c");
    await f.layers.replace("drums", "/drum-c");

    const activeVocals = f.sources[4];
    const activeDrums = f.sources[5];
    assert.equal(activeVocals.stopped, false);
    assert.equal(activeDrums.stopped, false, "vocal cache pressure cannot stop the active drum layer");

    await f.layers.replace("vocals", "/vocal-a");
    assert.equal(fetches.filter(url => url === "/vocal-a").length, 2, "the oldest donor was evicted and must be prepared again");
    const drumsAfterVocalSwap = f.sources[5];
    assert.equal(drumsAfterVocalSwap.stopped, false, "reloading an evicted vocal donor leaves drums playing");

    const fetchCountBeforeVocalReturn = fetches.length;
    await f.layers.replace("vocals", "/vocal-c");
    assert.equal(fetches.length, fetchCountBeforeVocalReturn, "vocals can return to their own retained recent donor");
    const activeVocalsAfterReturn = f.sources.at(-1)!;
    assert.equal(activeVocalsAfterReturn.stopped, false);
    assert.equal(drumsAfterVocalSwap.stopped, false, "the vocal return does not interrupt drums");

    await f.layers.replace("drums", "/drum-d");
    await f.layers.replace("drums", "/drum-e");
    const fetchCountBeforeDrumReturn = fetches.length;
    await f.layers.replace("drums", "/drum-d");
    assert.equal(fetches.length, fetchCountBeforeDrumReturn, "drums can return to their own retained recent donor");
    assert.equal(f.sources.at(-1)!.stopped, false);
    assert.equal(activeVocalsAfterReturn.stopped, false, "drum swaps and cache eviction leave vocals playing");
  } finally { f.layers.dispose(); }
});

test("a donor larger than the recent-cache budget is not retained or interrupted", async () => {
  const f = fixture(undefined, undefined, {
    duration: 8_500_000 / 48_000,
    length: 8_500_000,
    numberOfChannels: 2,
  });
  const fetches: string[] = [];
  globalThis.fetch = async (url) => {
    fetches.push(String(url));
    return response();
  };
  try {
    await f.layers.replace("vocals", "/oversized");
    await f.layers.replace("vocals", "/other");
    const activeDonor = f.sources[1];

    await f.layers.replace("vocals", "/oversized");

    assert.deepEqual(fetches, ["/oversized", "/other", "/oversized"]);
    assert.equal(activeDonor.stopped, false, "skipping an oversized cached copy does not stop active playback");
    assert.equal(f.sources[2].stopped, false);
  } finally { f.layers.dispose(); }
});

test("an expanded tempo-matched output is sized by its samples and does not stop the active replacement", async () => {
  const outputSamples = 8_500_000;
  const f = fixture(async (_context, input) => {
    assert.equal(input.length, 144_000, "the decoded input is much smaller than the tempo output");
    return {
      duration: outputSamples / 48_000,
      length: outputSamples,
      numberOfChannels: 2,
    } as AudioBuffer;
  }, undefined, {
    duration: 3,
    length: 144_000,
    numberOfChannels: 2,
  });
  const fetches: string[] = [];
  globalThis.fetch = async url => {
    fetches.push(String(url));
    return response();
  };
  try {
    await f.layers.replace("vocals", "/expanded", 0.8);
    await f.layers.replace("vocals", "/replacement");
    const activeReplacement = f.sources[1];

    await f.layers.replace("vocals", "/expanded", 0.8);

    assert.deepEqual(fetches, ["/expanded", "/replacement", "/expanded"],
      "the 8.5-million-sample stereo output exceeds the 64 MiB cache and must be prepared again");
    assert.equal(activeReplacement.stopped, false,
      "skipping the oversized tempo-matched cache entry does not stop active playback");
    assert.equal(f.sources[2].stopped, false, "the new tempo-matched replacement starts playing");
  } finally { f.layers.dispose(); }
});

test("the aggregate recent-cache budget counts samples across every channel", async () => {
  const decodedBuffers = [
    { duration: 9_000_000 / 48_000, length: 9_000_000, numberOfChannels: 1 },
    { duration: 4_500_000 / 48_000, length: 4_500_000, numberOfChannels: 2 },
    { duration: 1_000 / 48_000, length: 1_000, numberOfChannels: 1 },
    { duration: 9_000_000 / 48_000, length: 9_000_000, numberOfChannels: 1 },
  ];
  const f = fixture(undefined, undefined, () => decodedBuffers.shift() ?? {
    duration: 1_000 / 48_000,
    length: 1_000,
    numberOfChannels: 1,
  });
  const fetches: string[] = [];
  globalThis.fetch = async (url) => {
    fetches.push(String(url));
    return response();
  };
  try {
    await f.layers.replace("vocals", "/mono");
    await f.layers.replace("vocals", "/stereo");
    await f.layers.replace("vocals", "/small");

    const activeDonor = f.sources[2];
    await f.layers.replace("vocals", "/mono");

    assert.deepEqual(fetches, ["/mono", "/stereo", "/small", "/mono"]);
    assert.equal(activeDonor.stopped, false, "eviction of retained buffers leaves live playback running");
  } finally { f.layers.dispose(); }
});

test("Original crossfades back and releases donor playback", async () => {
  const f = fixture();
  globalThis.fetch = async () => response();
  try {
    await f.layers.replace("vocals", "/donor");
    await f.layers.replace("vocals", null);
    assert.equal(f.channel.inputGain.gain.value, 1);
    const originalFadeBack = f.channel.inputGain.automation.filter(event => event.type === "ramp").at(-1);
    const donorFadeOut = f.gains[2].automation.filter(event => event.type === "ramp").at(-1);
    assert.deepEqual(originalFadeBack, { type: "ramp", value: 1, time: 5.04 });
    assert.deepEqual(donorFadeOut, { type: "ramp", value: 0, time: 5.04 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(f.sources[0].stopped, true);
    f.layers.sync(["vocals"]);
    assert.equal(f.sources.length, 1, "restoring Original must not restart a donor");
  } finally { f.layers.dispose(); }
});
