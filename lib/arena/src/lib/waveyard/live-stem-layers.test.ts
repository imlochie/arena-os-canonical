import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { LIVE_STEM_SWITCH_TIMEOUT_MS, LiveStemLayers } from "./live-stem-layers";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function fixture(
  stretchBuffer?: ConstructorParameters<typeof LiveStemLayers>[2],
  onTiming?: ConstructorParameters<typeof LiveStemLayers>[3],
  decodedAudio:
    | { duration: number; length: number; numberOfChannels: number }
    | (() => { duration: number; length: number; numberOfChannels: number }) = {
      duration: 3,
      length: 144_000,
      numberOfChannels: 2,
    },
  channelIds = ["vocals"],
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
    const media = { currentTime: 7, paused: false, ended: false };
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
