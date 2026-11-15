import assert from "node:assert/strict";
import { test } from "node:test";

import { MEDIA_START_TIMEOUT_MS, startMediaWithin } from "./media-play-start";

// Regression test for the WebKit live-stem session-control failure.
//
// WebKit left `element.play()` pending forever while the media was audibly
// playing: every stem was unpaused, the clock advanced past twelve seconds, no
// play() rejected, and the context was "running" -- yet
// `Promise.allSettled(elements.map((element) => element.play()))` never
// settled. play() therefore never reached `setStarting(false)`, so the control
// stayed aria-busy "Cancel playback start" with every stem already sounding.
// The fix bounds the wait and decides from the media element's own state.

function fakeElement(overrides: Partial<Record<"paused" | "error" | "readyState", unknown>> = {}) {
  return {
    paused: false,
    error: null,
    readyState: 4,
    ...overrides,
  } as unknown as HTMLMediaElement;
}

test("a play() that never settles releases playback when the media is audible", async () => {
  const element = fakeElement();
  const wedged = Object.assign(element, {
    play() { return new Promise<void>(() => { /* never settles, as WebKit does */ }); },
  });

  const startedAt = Date.now();
  const outcome = await startMediaWithin(wedged, 120);
  const elapsed = Date.now() - startedAt;

  assert.deepEqual(outcome, { status: "started" });
  assert.ok(elapsed >= 100, `the bound must actually wait: ${elapsed}ms`);
  assert.ok(elapsed < 2000, `the bound must release playback promptly: ${elapsed}ms`);
});

test("a wedged play() with no audible media is reported as stalled, not started", async () => {
  const element = fakeElement({ paused: true });
  const wedged = Object.assign(element, {
    play() { return new Promise<void>(() => { /* never settles */ }); },
  });

  assert.deepEqual(await startMediaWithin(wedged, 80), { status: "stalled" });
});

test("media that is unpaused but has no current data is not claimed as playing", async () => {
  // readyState 1 (HAVE_METADATA) means nothing is decoded to play yet.
  const element = fakeElement({ readyState: 1 });
  const wedged = Object.assign(element, {
    play() { return new Promise<void>(() => { /* never settles */ }); },
  });

  assert.deepEqual(await startMediaWithin(wedged, 80), { status: "stalled" });
});

test("a decodable error is stalled, never reported as started", async () => {
  const element = fakeElement({ error: { code: 4 } });
  const wedged = Object.assign(element, {
    play() { return new Promise<void>(() => { /* never settles */ }); },
  });

  assert.deepEqual(await startMediaWithin(wedged, 80), { status: "stalled" });
});

test("a working element does not pay the bound", async () => {
  const element = fakeElement();
  const working = Object.assign(element, { play() { return Promise.resolve(); } });

  const startedAt = Date.now();
  assert.deepEqual(await startMediaWithin(working, MEDIA_START_TIMEOUT_MS), { status: "started" });
  assert.ok(Date.now() - startedAt < 500, "a working element must resolve immediately");
});

test("a rejection is surfaced with its reason so the caller can classify it", async () => {
  const blocked = new DOMException("interrupted", "NotAllowedError");
  const element = fakeElement({ paused: true });
  const rejecting = Object.assign(element, { play() { return Promise.reject(blocked); } });

  assert.deepEqual(await startMediaWithin(rejecting, MEDIA_START_TIMEOUT_MS), {
    status: "blocked",
    reason: blocked,
  });
});

test("an engine that throws synchronously is treated as blocked", async () => {
  const element = fakeElement({ paused: true });
  const throwing = Object.assign(element, {
    play(): Promise<void> { throw new Error("legacy engine"); },
  });

  const outcome = await startMediaWithin(throwing, MEDIA_START_TIMEOUT_MS);
  assert.equal(outcome.status, "blocked");
});

test("a play() that settles after the bound fired does not resolve twice", async () => {
  let release: (() => void) | undefined;
  const element = fakeElement();
  const late = Object.assign(element, {
    play() { return new Promise<void>((resolve) => { release = resolve; }); },
  });

  assert.deepEqual(await startMediaWithin(late, 50), { status: "started" });
  release?.();
  // A double resolve or an unhandled rejection would fail the test process.
  await new Promise((resolve) => setTimeout(resolve, 20));
});
