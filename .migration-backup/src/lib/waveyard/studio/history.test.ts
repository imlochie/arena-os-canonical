/**
 * Undo/redo core tests — coalescing semantics, caps, and boundary honesty
 * (nothing to undo → no-op, never an error).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { commit, createHistory, redo, undo, HISTORY_LIMIT } from "./history";

test("commit pushes history; undo/redo round-trips exactly", () => {
  let state = createHistory("a");
  state = commit(state, "b", 1000);
  state = commit(state, "c", 10_000);
  assert.equal(state.present, "c");
  assert.deepEqual(state.past, ["a", "b"]);

  state = undo(state);
  assert.equal(state.present, "b");
  state = undo(state);
  assert.equal(state.present, "a");
  state = undo(state); // nothing left — honest no-op
  assert.equal(state.present, "a");
  assert.deepEqual(state.past, []);

  state = redo(state);
  assert.equal(state.present, "b");
  state = redo(state);
  assert.equal(state.present, "c");
  state = redo(state); // nothing left — honest no-op
  assert.equal(state.present, "c");
});

test("rapid commits coalesce into one undo step (a drag = a step)", () => {
  let state = createHistory(0);
  state = commit(state, 1, 1000);
  state = commit(state, 2, 1200); // 200ms later → same step
  state = commit(state, 3, 1500); // 300ms later → still same step
  assert.deepEqual(state.past, [0], "the whole burst is ONE entry");
  assert.equal(state.present, 3);

  state = commit(state, 4, 5000); // 3.5s later → new step
  assert.deepEqual(state.past, [0, 3]);

  state = undo(state); // back to the burst's final value
  assert.equal(state.present, 3);
  state = undo(state); // back to before the burst
  assert.equal(state.present, 0);
});

test("undo breaks the coalescing chain — a redo-then-edit is a fresh step", () => {
  let state = createHistory("a");
  state = commit(state, "b", 1000);
  state = undo(state);
  assert.equal(state.present, "a");
  state = commit(state, "z", 1100); // 100ms after the undone commit — still fresh
  assert.deepEqual(state.past, ["a"]);
  assert.equal(state.present, "z");
  assert.deepEqual(state.future, []);
});

test("identical commits are no-ops", () => {
  let state = createHistory("a");
  state = commit(state, "a", 1000);
  assert.deepEqual(state, { ...state, present: "a", past: [] });
});

test("history is capped at the limit; the oldest step falls off", () => {
  let state = createHistory(0);
  for (let index = 1; index <= HISTORY_LIMIT + 25; index += 1) {
    state = commit(state, index, index * 10_000); // spaced out: one step each
  }
  assert.equal(state.past.length, HISTORY_LIMIT);
  assert.equal(state.past[0], 25, "the first 25 steps fell off");
  assert.equal(state.present, HISTORY_LIMIT + 25);
  for (let index = 0; index < HISTORY_LIMIT; index += 1) state = undo(state);
  assert.equal(state.present, 25);
});
