import assert from "node:assert/strict";
import test from "node:test";
import { parseCaptureOptions } from "./audio-capture-options";

// Regression test for the browser-timing failure: /api/library/audio-capture
// answered 200 with something that was not capture options (an HTML shell, in
// the observed case), the body was cast straight to CaptureOptions, and
// `next.devices.find(...)` threw "can't access property \"find\", next.devices
// is undefined" out of a refresh effect. The component must report a bad
// payload instead of crashing, and must never present an unusable room.

test("a well-formed payload is accepted and its devices preserved", () => {
  const parsed = parseCaptureOptions({
    available: true,
    devices: [
      { id: "speakers", name: "Speakers", isDefault: true },
      { id: "headphones", name: "Headphones" },
    ],
    applications: [{ processId: 42, processStartTime: "2026-01-01T00:00:00Z", name: "Player" }],
  });
  assert.ok(parsed, "a valid payload must parse");
  assert.deepEqual(parsed.devices.map((device) => device.id), ["speakers", "headphones"]);
  assert.equal(parsed.applications?.[0]?.processId, 42);
});

test("an unavailable machine is still a valid payload, with an empty device list", () => {
  const parsed = parseCaptureOptions({ available: false, devices: [], reason: "Not Windows." });
  assert.ok(parsed, "an unavailable machine is a normal answer, not a malformed one");
  assert.equal(parsed.available, false);
  assert.deepEqual(parsed.devices, []);
  assert.equal(parsed.reason, "Not Windows.");
});

test("the crash that started this: a body with no devices is rejected, not dereferenced", () => {
  // The SPA shell, an empty object and an error envelope all reach this code
  // when the API route is not the thing answering.
  for (const payload of [{}, { available: true }, { available: true, devices: null },
    { available: true, devices: "speakers" }, { error: "not found" }]) {
    assert.equal(parseCaptureOptions(payload), null,
      `expected rejection for ${JSON.stringify(payload)}`);
  }
});

test("non-object bodies are rejected rather than treated as options", () => {
  for (const payload of [null, undefined, "text", 7, true, [], ["devices"]]) {
    assert.equal(parseCaptureOptions(payload as unknown as Record<string, unknown>), null,
      `expected rejection for ${JSON.stringify(payload)}`);
  }
});

test("`available` must be a real boolean, so an unrelated object cannot look usable", () => {
  assert.equal(parseCaptureOptions({ available: "true", devices: [] }), null);
  assert.equal(parseCaptureOptions({ devices: [] }), null);
});

test("a partly malformed device list is rejected instead of silently reduced", () => {
  // Dropping bad entries would report fewer devices than the machine has,
  // which is indistinguishable from hardware the user should be told about.
  const parsed = parseCaptureOptions({
    available: true,
    devices: [{ id: "speakers", name: "Speakers" }, { id: 3, name: "Broken" }],
  });
  assert.equal(parsed, null);
  assert.equal(parseCaptureOptions({ available: true, devices: [{ name: "no id" }] }), null);
});
