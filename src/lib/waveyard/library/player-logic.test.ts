/**
 * Player-logic tests — the P2 control contract: queue advancement under
 * repeat/shuffle, previous-track semantics, play-count gating, keyboard
 * routing, and meter mapping. Pure logic; no browser audio is fabricated.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  SEEK_STEP_SECONDS,
  isTextEntryTarget,
  meterDb,
  meterLevel,
  nextTrackFromQueue,
  previousTrackFromQueue,
  shouldRecordPlay,
  type QueueEntry,
} from "./player-logic";

const q = (...trackIds: string[]): QueueEntry[] => trackIds.map((trackId, index) => ({ id: `item-${index}`, trackId }));
const A = "track-a";
const B = "track-b";
const C = "track-c";

test("advance: empty queue stops", () => {
  assert.deepEqual(nextTrackFromQueue([], A, "off", false), { action: "stop", reason: "empty-queue" });
});

test("advance: sequential order, repeat off stops at the end", () => {
  assert.deepEqual(nextTrackFromQueue(q(A, B, C), A, "off", false), { action: "play", trackId: B, reason: "next" });
  assert.deepEqual(nextTrackFromQueue(q(A, B, C), B, "off", false), { action: "play", trackId: C, reason: "next" });
  assert.deepEqual(nextTrackFromQueue(q(A, B, C), C, "off", false), { action: "stop", reason: "end-of-queue" });
});

test("advance: repeat all wraps at the end", () => {
  assert.deepEqual(nextTrackFromQueue(q(A, B, C), C, "all", false), { action: "play", trackId: A, reason: "wrap" });
  assert.deepEqual(nextTrackFromQueue(q(A, B, C), B, "all", false), { action: "play", trackId: C, reason: "next" });
});

test("advance: repeat one is handled by the engine loop, not by advancement", () => {
  // The component never consults nextTrackFromQueue for repeat "one" — but
  // if it did, the answer must not skip forward past the loop.
  const decision = nextTrackFromQueue(q(A, B, C), A, "one", false);
  assert.equal(decision.action, "play");
  if (decision.action === "play") assert.equal(decision.trackId, B);
});

test("advance: current track not in the queue starts the queue head", () => {
  assert.deepEqual(nextTrackFromQueue(q(B, C), A, "off", false), { action: "play", trackId: B, reason: "next" });
  // Unless that head IS the current track with repeat off (single-entry queue).
  assert.deepEqual(nextTrackFromQueue(q(A), A, "off", false), { action: "stop", reason: "end-of-queue" });
  // A single-entry queue under repeat-all wraps onto itself.
  assert.deepEqual(nextTrackFromQueue(q(A), A, "all", false), { action: "play", trackId: A, reason: "wrap" });
});

test("advance: no current track plays the queue head", () => {
  assert.deepEqual(nextTrackFromQueue(q(B, C), null, "off", false), { action: "play", trackId: B, reason: "next" });
});

test("advance: shuffle picks another track, deterministically testable", () => {
  const alwaysFirst = () => 0.999; // floor(0.999 * 2) % 2 = 1 → the second "other"
  const decision = nextTrackFromQueue(q(A, B, C), A, "off", true, alwaysFirst);
  assert.equal(decision.action, "play");
  if (decision.action === "play") {
    assert.notEqual(decision.trackId, A, "shuffle never re-picks the current track");
    assert.equal(decision.reason, "shuffle");
  }
  // Every deterministic random index yields a valid non-current track.
  for (const r of [0, 0.25, 0.5, 0.75, 0.99]) {
    const pick = nextTrackFromQueue(q(A, B, C), A, "off", true, () => r);
    if (pick.action === "play") assert.notEqual(pick.trackId, A);
  }
});

test("advance: shuffle with one track repeats only under repeat-all", () => {
  assert.deepEqual(nextTrackFromQueue(q(A), A, "all", true), { action: "play", trackId: A, reason: "only" });
  assert.deepEqual(nextTrackFromQueue(q(A), A, "off", true), { action: "stop", reason: "single-repeat-off" });
});

test("previous: walks backwards, null at the head and outside the queue", () => {
  assert.equal(previousTrackFromQueue(q(A, B, C), C), B);
  assert.equal(previousTrackFromQueue(q(A, B, C), B), A);
  assert.equal(previousTrackFromQueue(q(A, B, C), A), null, "prev never wraps");
  assert.equal(previousTrackFromQueue(q(A, B), "zzz"), null);
  assert.equal(previousTrackFromQueue([], A), null);
  assert.equal(previousTrackFromQueue(q(A, B), null), null);
});

test("play count: once per visit, only after the listening threshold", () => {
  assert.equal(shouldRecordPlay(false, 0, 240), false, "opening never counts");
  assert.equal(shouldRecordPlay(false, 10, 240), false);
  assert.equal(shouldRecordPlay(false, 31, 240), true);
  assert.equal(shouldRecordPlay(true, 31, 240), false, "never twice in one visit");
  assert.equal(shouldRecordPlay(true, 240, 240), false, "track end does not double-count");
  assert.equal(shouldRecordPlay(false, 8, 12), true, "half of a short clip qualifies");
});

test("keyboard: shortcuts never steal typing from text fields", () => {
  const el = (tag: string, extra: Record<string, unknown> = {}) => ({ tagName: tag, ...extra }) as HTMLElement;
  assert.equal(isTextEntryTarget(el("INPUT")), true);
  assert.equal(isTextEntryTarget(el("TEXTAREA")), true);
  assert.equal(isTextEntryTarget(el("SELECT")), true);
  assert.equal(isTextEntryTarget(el("DIV", { isContentEditable: true })), true);
  assert.equal(isTextEntryTarget(el("BUTTON")), false);
  assert.equal(isTextEntryTarget(el("DIV")), false);
  assert.equal(isTextEntryTarget(null), false);
});

test("seek step is a sane constant", () => {
  assert.equal(typeof SEEK_STEP_SECONDS, "number");
  assert.ok(SEEK_STEP_SECONDS > 0 && SEEK_STEP_SECONDS <= 30);
});

test("meter mapping: clamps real peaks, honest zeros and −∞", () => {
  assert.equal(meterLevel(undefined), 0);
  assert.equal(meterLevel(null), 0);
  assert.equal(meterLevel({ peak: 0, rms: 0 }), 0);
  assert.equal(meterLevel({ peak: 0.42, rms: 0.1 }), 0.42);
  assert.equal(meterLevel({ peak: 1.7, rms: 0.2 }), 1, "over-unity clamps to the top of the bar");
  assert.equal(meterLevel({ peak: Number.NaN, rms: 0 }), 0);
  assert.equal(meterDb({ peak: 0, rms: 0 }), "−∞");
  assert.equal(meterDb(undefined), "−∞");
  assert.equal(meterDb({ peak: 0.5, rms: 0.1 }), `${(20 * Math.log10(0.5)).toFixed(1)} dB`);
  assert.equal(meterDb({ peak: 1, rms: 0.1 }), "0.0 dB");
});
