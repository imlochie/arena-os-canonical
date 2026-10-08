/**
 * Stem2 adapter — routing controller tests.
 *
 * ⚠️ SIMULATED ENVIRONMENT — unit tests only, never hardware verification.
 * The AudioContext, mediaDevices, and storage objects below are explicit
 * fakes injected through the controller's dependency seam. They verify the
 * controller's logic (routing, restoration, transitions); they say NOTHING
 * about a real Stem2 device.
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  createStem2Routing,
  installRoutedAudioContext,
  type AudioContextCtor,
  type AudioContextLike,
  type MediaDevicesLike,
  type StorageLike,
} from "./routing";
import type { Stem2State } from "./types";

// ------------------------------------------------------------- fake world --

/** SIMULATED AudioContext: records setSinkId calls; "device-error" fails. */
class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  sinkCalls: string[] = [];
  state = "running";
  constructor() {
    FakeAudioContext.instances.push(this);
  }
  async setSinkId(sinkId: string): Promise<void> {
    this.sinkCalls.push(sinkId);
    if (sinkId === "device-error") throw new Error("simulated sink failure");
  }
  async close(): Promise<void> {
    this.state = "closed";
  }
}

/** SIMULATED mediaDevices with a controllable device list + devicechange. */
function fakeMediaDevices(initial: Array<{ deviceId: string; label: string; kind: string }>) {
  let devices = [...initial];
  const listeners = new Set<() => void>();
  return {
    async enumerateDevices() {
      return [...devices];
    },
    addEventListener(type: "devicechange", listener: () => void) {
      if (type === "devicechange") listeners.add(listener);
    },
    removeEventListener(_type: "devicechange", listener: () => void) {
      listeners.delete(listener);
    },
    setDevices(next: Array<{ deviceId: string; label: string; kind: string }>) {
      devices = [...next];
      for (const listener of listeners) listener();
    },
  } satisfies MediaDevicesLike & {
    setDevices(next: Array<{ deviceId: string; label: string; kind: string }>): void;
  };
}

/** SIMULATED storage (in-memory). */
function fakeStorage(): StorageLike & { dump(): Record<string, string> } {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
    dump: () => Object.fromEntries(map),
  };
}

const DEVICES = [
  { deviceId: "dev-speakers", label: "Speakers (Realtek)", kind: "audiooutput" },
  { deviceId: "dev-stem2", label: "Headphones (Stem2 Stereo)", kind: "audiooutput" },
];

type FakeStorage = StorageLike & { dump(): Record<string, string> };
type FakeMediaDevices = ReturnType<typeof fakeMediaDevices>;

interface TestWorld {
  controller: ReturnType<typeof createStem2Routing>;
  mediaDevices: FakeMediaDevices | null;
  storage: FakeStorage;
  installTarget: { AudioContext?: AudioContextCtor };
}

function freshController(overrides?: {
  devices?: Array<{ deviceId: string; label: string; kind: string }>;
  storage?: FakeStorage;
  installTarget?: { AudioContext?: AudioContextCtor };
  mediaDevices?: FakeMediaDevices | null;
}): TestWorld {
  const mediaDevices =
    overrides?.mediaDevices === undefined ? fakeMediaDevices(overrides?.devices ?? DEVICES) : overrides.mediaDevices;
  const storage = overrides?.storage ?? fakeStorage();
  // A FRESH target each time so installRoutedAudioContext patches a clean
  // constructor (the browser singleton patches window once; here we control
  // the world per test).
  const installTarget =
    overrides?.installTarget ?? { AudioContext: FakeAudioContext as unknown as AudioContextCtor };
  const controller = createStem2Routing({ mediaDevices, storage, installTarget, hasMediaSession: true });
  return { controller, mediaDevices, storage, installTarget };
}

/** Create a live SIMULATED context through the patched constructor. */
function liveContext(world: TestWorld): FakeAudioContext {
  return new world.installTarget.AudioContext!() as FakeAudioContext;
}

const state = (controller: ReturnType<typeof createStem2Routing>) => controller.getState().status.state as Stem2State;

afterEach(() => {
  FakeAudioContext.instances = [];
});

// ----------------------------------------------------------------- tests ---

describe("installRoutedAudioContext (context interception)", () => {
  it("registers every context created through the patched constructor", () => {
    const registered: AudioContextLike[] = [];
    const target: { AudioContext?: AudioContextCtor } = { AudioContext: FakeAudioContext as unknown as AudioContextCtor };
    assert.equal(installRoutedAudioContext(target, (ctx) => registered.push(ctx)), true);
    const created = new target.AudioContext!();
    assert.equal(registered.length, 1);
    assert.equal(registered[0], created);
  });

  it("is idempotent — a second install does not double-wrap", () => {
    const target: { AudioContext?: AudioContextCtor } = { AudioContext: FakeAudioContext as unknown as AudioContextCtor };
    installRoutedAudioContext(target, () => undefined);
    const once = target.AudioContext;
    installRoutedAudioContext(target, () => undefined);
    assert.equal(target.AudioContext, once);
  });

  it("reports failure when there is no AudioContext constructor", () => {
    const registered: AudioContextLike[] = [];
    assert.equal(installRoutedAudioContext({}, (ctx) => registered.push(ctx)), false);
    assert.equal(registered.length, 0);
  });
});

describe("routing controller — selection and routing", () => {
  it("starts AVAILABLE (no designation; follows the system default)", async () => {
    const { controller } = freshController();
    await controller.refresh();
    assert.equal(state(controller), "AVAILABLE");
    assert.equal(controller.getState().endpoints.length, 2);
    assert.equal(controller.getState().designatedDeviceId, null);
    // The capability matrix ships with the state — media keys reported via
    // the injected environment fact, never assumed.
    const mediaKeys = controller.getState().capabilities.find((row) => row.key === "hardware-media-keys");
    assert.equal(mediaKeys?.state, "AVAILABLE");
    assert.equal(mediaKeys?.verification, "hardware-pending");
  });

  it("select routes every live context and reports AUDIO_ONLY", async () => {
    const world = freshController();
    const ctx = liveContext(world);
    await world.controller.refresh();
    await world.controller.select("dev-stem2");
    assert.equal(state(world.controller), "AUDIO_ONLY");
    assert.deepEqual(ctx.sinkCalls, ["dev-stem2"]);
    assert.equal(world.controller.getState().status.designatedLabel, "Headphones (Stem2 Stereo)");
  });

  it("contexts created AFTER selection get the route applied on construction", async () => {
    const world = freshController();
    await world.controller.select("dev-stem2");
    const late = liveContext(world);
    assert.deepEqual(late.sinkCalls, ["dev-stem2"]);
  });

  it("persists the designation and restores it in a fresh controller", async () => {
    const { controller, storage } = freshController();
    await controller.select("dev-stem2");
    assert.ok(Object.keys(storage.dump()).length > 0, "designation persisted");

    const second = freshController({ storage });
    await second.controller.refresh();
    assert.equal(state(second.controller), "AUDIO_ONLY");
  });

  it("restores by LABEL when the device id changed (same physical device)", async () => {
    const storage = fakeStorage();
    const first = freshController({ storage });
    await first.controller.select("dev-stem2");

    // Same label, different id (e.g. re-paired at OS level).
    const redevices = [
      { deviceId: "dev-speakers", label: "Speakers (Realtek)", kind: "audiooutput" },
      { deviceId: "dev-new-id", label: "Headphones (Stem2 Stereo)", kind: "audiooutput" },
    ];
    const second = freshController({ storage, devices: redevices });
    await second.controller.refresh();
    assert.equal(state(second.controller), "AUDIO_ONLY");
    assert.equal(second.controller.getState().status.designatedLabel, "Headphones (Stem2 Stereo)");
  });

  it("reports REQUIRES_DEVICE_CONNECTION when nothing matches, and never crashes", async () => {
    const storage = fakeStorage();
    const first = freshController({ storage });
    await first.controller.select("dev-stem2");

    const second = freshController({ storage, devices: [{ deviceId: "dev-other", label: "Speakers", kind: "audiooutput" }] });
    await second.controller.refresh();
    assert.equal(state(second.controller), "REQUIRES_DEVICE_CONNECTION");
  });

  it("clear returns contexts to the system default and forgets the designation", async () => {
    const world = freshController();
    const ctx = liveContext(world);
    await world.controller.select("dev-stem2");
    await world.controller.clear();
    assert.equal(state(world.controller), "AVAILABLE");
    assert.deepEqual(ctx.sinkCalls, ["dev-stem2", ""]);
    assert.equal(Object.keys(world.storage.dump()).length, 0);
  });

  it("selecting a device that is not listed reports an honest error", async () => {
    const { controller } = freshController();
    await controller.refresh();
    await controller.select("dev-ghost");
    assert.equal(state(controller), "ERROR");
    assert.match(controller.getState().status.reason, /no longer listed/i);
  });

  it("a failing setSinkId surfaces as ERROR with the real cause", async () => {
    const failing = [
      { deviceId: "dev-speakers", label: "Speakers (Realtek)", kind: "audiooutput" },
      { deviceId: "device-error", label: "Stem2 Stereo", kind: "audiooutput" },
    ];
    const world = freshController({ devices: failing });
    liveContext(world); // music is playing
    await world.controller.refresh();
    await world.controller.select("device-error");
    assert.equal(state(world.controller), "ERROR");
    assert.match(world.controller.getState().status.reason, /simulated sink failure/);
  });

  it("a sink failure when a LATE context registers also surfaces as ERROR", async () => {
    const failing = [
      { deviceId: "dev-speakers", label: "Speakers (Realtek)", kind: "audiooutput" },
      { deviceId: "device-error", label: "Stem2 Stereo", kind: "audiooutput" },
    ];
    const world = freshController({ devices: failing });
    await world.controller.select("device-error"); // no live graphs yet
    const late = liveContext(world); // play starts now, sink fails
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(state(world.controller), "ERROR");
    assert.deepEqual(late.sinkCalls, ["device-error"]);
  });
});

describe("routing controller — device changes", () => {
  it("disappearance → REQUIRES_DEVICE_CONNECTION; reappearance → auto-restore", async () => {
    const world = freshController();
    await world.controller.select("dev-stem2");
    assert.equal(state(world.controller), "AUDIO_ONLY");

    // Device unplugged/powered off: the endpoint vanishes (devicechange).
    world.mediaDevices?.setDevices([{ deviceId: "dev-speakers", label: "Speakers (Realtek)", kind: "audiooutput" }]);
    await world.controller.refresh();
    assert.equal(state(world.controller), "REQUIRES_DEVICE_CONNECTION");

    // Device back: the route is restored automatically.
    world.mediaDevices?.setDevices(DEVICES);
    await world.controller.refresh();
    assert.equal(state(world.controller), "AUDIO_ONLY");
  });

  it("ignores non-audiooutput devices during enumeration", async () => {
    const withInputs = [
      { deviceId: "dev-mic", label: "Microphone", kind: "audioinput" },
      { deviceId: "dev-stem2", label: "Stem2 Stereo", kind: "audiooutput" },
    ];
    const { controller } = freshController({ devices: withInputs });
    await controller.refresh();
    assert.equal(controller.getState().endpoints.length, 1);
    assert.equal(controller.getState().endpoints[0]?.deviceId, "dev-stem2");
  });
});

describe("routing controller — degraded runtimes", () => {
  it("UNSUPPORTED when mediaDevices is unavailable", async () => {
    const { controller } = freshController({ mediaDevices: null });
    await controller.refresh();
    assert.equal(state(controller), "UNSUPPORTED");
  });

  it("CONTROL_UNAVAILABLE when setSinkId does not exist (audio follows the OS default)", async () => {
    // SIMULATED sink-less runtime: a context class without setSinkId.
    class SinklessContext {
      static instances = 0;
      constructor() {
        SinklessContext.instances += 1;
      }
    }
    const { controller } = freshController({
      installTarget: { AudioContext: SinklessContext as unknown as AudioContextCtor },
    });
    await controller.refresh();
    assert.equal(state(controller), "CONTROL_UNAVAILABLE");
    await controller.select("dev-stem2");
    assert.equal(state(controller), "CONTROL_UNAVAILABLE");
    assert.match(controller.getState().status.reason, /system default/);
  });
});
