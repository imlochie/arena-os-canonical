import test from "node:test";
import assert from "node:assert/strict";

import { hasReliableSessionBeatEvidence, nextSessionBeatLoop } from "./session-dj-controls";

test("beat loop enters on the next analyzed beat and spans exact grid beats", () => {
  const range = nextSessionBeatLoop([0, 500, 1000, 1500, 2000, 2500, 3000], 0.72, 4, 0.9);
  assert.deepEqual(range, { start: 1, end: 3 });
});

test("beat loop preserves non-uniform analyzed beat timing", () => {
  const range = nextSessionBeatLoop([0, 490, 1005, 1490, 2010, 2500], 0.99, 2, 0.8);
  assert.deepEqual(range, { start: 1.005, end: 2.01 });
});

test("beat loop refuses missing, invalid, or insufficient grid data", () => {
  assert.equal(nextSessionBeatLoop(null, 0, 4, 0.9), null);
  assert.equal(nextSessionBeatLoop([0, 500, 1000], 0, 4, 0.9), null);
  assert.equal(nextSessionBeatLoop([0, 500, 1000], 1.1, 1, 0.9), null);
  assert.equal(nextSessionBeatLoop([0, 500], Number.NaN, 1, 0.9), null);
  assert.equal(nextSessionBeatLoop([0, 500], 0, 0, 0.9), null);
  assert.equal(nextSessionBeatLoop([0, 500, 1000], 0, 1, 0.49), null);
  assert.equal(nextSessionBeatLoop([0, 500, 1000], 0, 1, null), null);
  assert.equal(hasReliableSessionBeatEvidence(0.5), true);
  assert.equal(hasReliableSessionBeatEvidence(0.49), false);
  assert.equal(hasReliableSessionBeatEvidence(1.01), false);
});
