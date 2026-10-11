/**
 * Stem2 adapter — capability truth tests (PURE: no environment, no browser).
 * These verify the honest state machine: which state each observed-fact
 * combination produces, and that CONNECTED (verified hardware control) is
 * never fabricated.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  describeStem2State,
  resolveOutputStatus,
  stem2CapabilityMatrix,
  stem2NameHeuristic,
} from "./capability";
import { STEM2_STATES, type Stem2Endpoint, type Stem2State } from "./types";

const endpoint = (deviceId: string, label: string): Stem2Endpoint => ({
  deviceId,
  label,
  groupId: null,
});

describe("stem2NameHeuristic", () => {
  it("matches Stem2 and Stem 2 spellings in real endpoint labels", () => {
    assert.equal(stem2NameHeuristic("Stem2"), true);
    assert.equal(stem2NameHeuristic("Stem 2"), true);
    assert.equal(stem2NameHeuristic("Headphones (Stem2 Stereo)"), true);
    assert.equal(stem2NameHeuristic("STEM2"), true);
  });

  it("does not match other devices", () => {
    assert.equal(stem2NameHeuristic("Stem1"), false);
    assert.equal(stem2NameHeuristic("Stem Player"), false);
    assert.equal(stem2NameHeuristic("Speakers (Realtek Audio)"), false);
    assert.equal(stem2NameHeuristic(""), false);
  });
});

describe("resolveOutputStatus", () => {
  const base = {
    hasEnumerateDevices: true,
    hasContextSink: true,
    endpoints: [endpoint("dev-a", "Speakers"), endpoint("dev-b", "Stem2 Stereo")],
    designated: null,
    routedToDeviceId: null,
    lastError: null,
  };

  it("UNSUPPORTED when the runtime cannot even enumerate outputs", () => {
    const status = resolveOutputStatus({ ...base, hasEnumerateDevices: false });
    assert.equal(status.state, "UNSUPPORTED");
  });

  it("AVAILABLE with no designation (follows the system default)", () => {
    const status = resolveOutputStatus({ ...base });
    assert.equal(status.state, "AVAILABLE");
    assert.match(status.reason, /system default/i);
  });

  it("AVAILABLE with zero endpoints is still honest about it", () => {
    const status = resolveOutputStatus({ ...base, endpoints: [] });
    assert.equal(status.state, "AVAILABLE");
    assert.match(status.reason, /no audio output devices/i);
  });

  it("CONTROL_UNAVAILABLE without a designation when routing is impossible", () => {
    const status = resolveOutputStatus({ ...base, hasContextSink: false });
    assert.equal(status.state, "CONTROL_UNAVAILABLE");
    assert.match(status.reason, /system default/);
  });

  it("AUDIO_ONLY when routed — and the reason claims no control", () => {
    const status = resolveOutputStatus({
      ...base,
      designated: { deviceId: "dev-b", label: "Stem2 Stereo" },
      routedToDeviceId: "dev-b",
    });
    assert.equal(status.state, "AUDIO_ONLY");
    assert.match(status.reason, /audio-only route/i);
    assert.match(status.reason, /no hardware control/i);
  });

  it("REQUIRES_DEVICE_CONNECTION when the designated endpoint disappears", () => {
    const status = resolveOutputStatus({
      ...base,
      designated: { deviceId: "dev-gone", label: "Stem2 Stereo" },
      routedToDeviceId: null,
    });
    assert.equal(status.state, "REQUIRES_DEVICE_CONNECTION");
    assert.match(status.reason, /not currently available/i);
    assert.match(status.reason, /automatically/i);
  });

  it("ERROR surfaces the real routing failure", () => {
    const status = resolveOutputStatus({
      ...base,
      designated: { deviceId: "dev-b", label: "Stem2 Stereo" },
      routedToDeviceId: null,
      lastError: "NotAllowedError: sink blocked",
    });
    assert.equal(status.state, "ERROR");
    assert.match(status.reason, /sink blocked/);
  });

  it("CONTROL_UNAVAILABLE for a designated device when routing is impossible", () => {
    const status = resolveOutputStatus({
      ...base,
      hasContextSink: false,
      designated: { deviceId: "dev-b", label: "Stem2 Stereo" },
    });
    assert.equal(status.state, "CONTROL_UNAVAILABLE");
  });

  it("AVAILABLE for a present, designated, not-yet-routed device", () => {
    const status = resolveOutputStatus({
      ...base,
      designated: { deviceId: "dev-b", label: "Stem2 Stereo" },
    });
    assert.equal(status.state, "AVAILABLE");
    assert.match(status.reason, /selecting it routes/i);
  });
});

describe("stem2CapabilityMatrix", () => {
  const fullEnv = {
    hasEnumerateDevices: true,
    hasDeviceChangeEvents: true,
    hasContextSink: true,
    hasMediaSession: true,
  };

  it("never fabricates CONNECTED (no verified hardware control exists in v1)", () => {
    for (const report of stem2CapabilityMatrix(fullEnv)) {
      assert.notEqual(report.state, "CONNECTED");
    }
  });

  it("covers exactly the mandated capability keys", () => {
    const keys = stem2CapabilityMatrix(fullEnv).map((report) => report.key);
    assert.deepEqual(keys, [
      "audio-output",
      "hardware-media-keys",
      "device-volume",
      "stem-controls",
      "device-status",
      "session-sync",
    ]);
  });

  it("audio output: AVAILABLE with routing primitives, CONTROL_UNAVAILABLE without setSinkId", () => {
    const available = stem2CapabilityMatrix(fullEnv).find((r) => r.key === "audio-output");
    assert.equal(available?.state, "AVAILABLE");
    assert.equal(available?.verification, "verified-locally");
    const sinkless = stem2CapabilityMatrix({ ...fullEnv, hasContextSink: false }).find((r) => r.key === "audio-output");
    assert.equal(sinkless?.state, "CONTROL_UNAVAILABLE");
    const blind = stem2CapabilityMatrix({ ...fullEnv, hasEnumerateDevices: false }).find((r) => r.key === "audio-output");
    assert.equal(blind?.state, "UNSUPPORTED");
  });

  it("hardware media keys: AVAILABLE but explicitly hardware-pending, never claimed", () => {
    const report = stem2CapabilityMatrix(fullEnv).find((r) => r.key === "hardware-media-keys");
    assert.equal(report?.state, "AVAILABLE");
    assert.equal(report?.verification, "hardware-pending");
    assert.match(report?.reason ?? "", /on-device verification/i);
    const without = stem2CapabilityMatrix({ ...fullEnv, hasMediaSession: false }).find((r) => r.key === "hardware-media-keys");
    assert.equal(without?.state, "UNSUPPORTED");
  });

  it("stem controls, volume, device status, and sync are UNSUPPORTED with documented-absent evidence", () => {
    const matrix = stem2CapabilityMatrix(fullEnv);
    for (const key of ["device-volume", "stem-controls", "device-status", "session-sync"] as const) {
      const report = matrix.find((r) => r.key === key);
      assert.equal(report?.state, "UNSUPPORTED", key);
      assert.equal(report?.verification, "documented-absent", key);
    }
  });
});

describe("describeStem2State", () => {
  it("labels every mandated state", () => {
    for (const state of STEM2_STATES) {
      const label = describeStem2State(state as Stem2State);
      assert.equal(typeof label, "string");
      assert.ok(label.length > 0);
    }
  });
});
