import assert from "node:assert/strict";
import { test } from "node:test";

import { RESUME_TIMEOUT_MS, resumeWithin } from "./audio-context-resume";

// Regression test for the Firefox live-stem timing failure.
//
// A suspended AudioContext may return a resume() promise that never settles --
// a machine with no audio output does exactly that, and Firefox does it while
// Chromium and WebKit quietly run the graph anyway. play() awaited that promise
// directly, so Play stopped at the await: no playback, no error, and the Playing
// control never engaged. The observable symptom was a 30 s timeout waiting for
// aria-pressed to become true, with an empty error surface.

test("a resume that never settles cannot park playback forever", async () => {
  let resumeCalled = 0;
  const wedged = {
    state: "suspended",
    resume() {
      resumeCalled += 1;
      return new Promise<void>(() => { /* never settles, as Firefox does */ });
    },
  } as unknown as AudioContext;

  const startedAt = Date.now();
  await resumeWithin(wedged, 120);
  const elapsed = Date.now() - startedAt;

  assert.equal(resumeCalled, 1, "resume must still be attempted");
  assert.ok(elapsed >= 100, `the bound must actually wait for the context: ${elapsed}ms`);
  assert.ok(elapsed < 2000, `the bound must release playback promptly: ${elapsed}ms`);
});

test("a resume that succeeds releases playback immediately, not after the bound", async () => {
  const working = {
    state: "running",
    resume() {
      return Promise.resolve();
    },
  } as unknown as AudioContext;

  const startedAt = Date.now();
  await resumeWithin(working, RESUME_TIMEOUT_MS);
  assert.ok(Date.now() - startedAt < 500, "a working context must not pay the timeout");
});

test("a rejected resume is not fatal: the caller decides from the context state", async () => {
  // resume() rejects with InvalidStateError when the context is closed. Throwing
  // here would surface as a generic playback failure; the caller checks `state`
  // and can say something accurate instead.
  const closed = {
    state: "closed",
    resume() {
      return Promise.reject(new Error("Closed before resume completed"));
    },
  } as unknown as AudioContext;

  await resumeWithin(closed, RESUME_TIMEOUT_MS);
});

test("resume is called exactly once even when it settles after the bound fired", async () => {
  // Late resolution must not resolve the outer promise twice or re-run cleanup,
  // which is what happens when the device wakes up just after the timeout.
  let release: (() => void) | undefined;
  let resumeCalled = 0;
  const slow = {
    state: "suspended",
    resume() {
      resumeCalled += 1;
      return new Promise<void>((resolve) => { release = resolve; });
    },
  } as unknown as AudioContext;

  await resumeWithin(slow, 50);
  assert.equal(resumeCalled, 1);
  release?.();
  // Allow the late resolution to run its handler; an unhandled rejection or a
  // double-resolve here would fail the test process.
  await new Promise((resolve) => setTimeout(resolve, 20));
});

test("a cold start slower than the old 1500 ms bound still counts as running", async () => {
  let state = "suspended";
  const slow = {
    get state() { return state; },
    resume() {
      return new Promise<void>((resolve) => setTimeout(() => { state = "running"; resolve(); }, 1800));
    },
  } as unknown as AudioContext;

  await resumeWithin(slow, RESUME_TIMEOUT_MS);
  assert.equal(slow.state, "running");
});
