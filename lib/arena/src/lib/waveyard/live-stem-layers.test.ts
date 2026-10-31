import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { LiveStemLayers } from "./live-stem-layers";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function fixture(
  stretchBuffer?: ConstructorParameters<typeof LiveStemLayers>[2],
  onTiming?: ConstructorParameters<typeof LiveStemLayers>[3],
) {
  const sources: Array<{ offset: number; stopped: boolean; loop: boolean }> = [];
  const gains: Array<{ automation: Array<{ type: string; value?: number; time: number }> }> = [];
  let decodeCount = 0;
  const context = {
    currentTime: 5,
    decodeAudioData: async () => { decodeCount += 1; return { duration: 3 }; },
    createBufferSource() {
      const source = {
        offset: -1, stopped: false, loop: false, buffer: null,
        connect() {}, disconnect() {},
        start(_when: number, offset: number) { this.offset = offset; },
        stop() { this.stopped = true; },
      };
      sources.push(source);
      return source;
    },
    createGain() {
      const automation: Array<{ type: string; value?: number; time: number }> = [];
      const node = {
        context, automation, connect() {}, disconnect() {},
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
  const media = { currentTime: 7, paused: false, ended: false };
  const channel = { source: { mediaElement: media }, inputGain: context.createGain(), gain: context.createGain() };
  const layers = new LiveStemLayers(
    () => context as unknown as AudioContext,
    () => channel as unknown as ReturnType<ConstructorParameters<typeof LiveStemLayers>[1]>,
    stretchBuffer,
    onTiming,
  );
  return { layers, channel, media, sources, gains, context, get decodeCount() { return decodeCount; } };
}

function response(ok = true) {
  return { ok, status: ok ? 200 : 503, arrayBuffer: async () => new ArrayBuffer(4) } as Response;
}

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
    assert.ok(nativeTimings[0].selectionToAudibleMs >= nativeTimings[0].downloadMs);
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
    assert.ok(matchedTimings[0].selectionToAudibleMs >=
      matchedTimings[0].downloadMs + matchedTimings[0].decodeMs + matchedTimings[0].tempoMatchMs);
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
