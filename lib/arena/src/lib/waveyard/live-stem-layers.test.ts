import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { LiveStemLayers } from "./live-stem-layers";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function fixture() {
  const sources: Array<{ offset: number; stopped: boolean; loop: boolean }> = [];
  const gains: Array<{ automation: Array<{ type: string; value?: number; time: number }> }> = [];
  const context = {
    currentTime: 5,
    decodeAudioData: async () => ({ duration: 3 }),
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
  );
  return { layers, channel, media, sources, gains };
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
