import assert from "node:assert/strict";
import test from "node:test";
import { createModelPassObserver } from "./waveyard-progress.mjs";

test("records each distinct model phase once and closes it when the next phase begins", () => {
  let currentTime = 100;
  const observer = createModelPassObserver({ now: () => currentTime });

  observer.observe({ metadata: { progress: { phase: "1/4", model: "vocals" } } });
  currentTime = 1_100;
  observer.observe({ metadata: { progress: { phase: "1/4", model: "vocals", percent: 12 } } });
  currentTime = 3_100;
  observer.observe({ metadata: { progress: { phase: "2/4", model: "drums" } } });
  currentTime = 5_600;

  assert.deepEqual(observer.finish(), [
    { phase: "1/4", model: "vocals", observedDurationSeconds: 3 },
    { phase: "2/4", model: "drums", observedDurationSeconds: 2.5 },
  ]);
  assert.deepEqual(observer.finish(), [
    { phase: "1/4", model: "vocals", observedDurationSeconds: 3 },
    { phase: "2/4", model: "drums", observedDurationSeconds: 2.5 },
  ]);
  assert.throws(
    () => observer.observe({ metadata: { progress: { phase: "3/4", model: "bass" } } }),
    /already been finished/,
  );
});

test("accepts serialized progress and closes the final pass when job progress clears", () => {
  let currentTime = 0;
  const observer = createModelPassObserver({ now: () => currentTime });

  observer.observe({
    metadata: JSON.stringify({ progress: { phase: "4/4", model: "other" } }),
  });
  currentTime = 4_250;
  observer.observe({ metadata: { progress: null } });
  currentTime = 9_000;

  assert.deepEqual(observer.finish(), [
    { phase: "4/4", model: "other", observedDurationSeconds: 4.25 },
  ]);
});

test("malformed progress metadata closes a pass without crashing the acceptance run", () => {
  let currentTime = 500;
  const observer = createModelPassObserver({ now: () => currentTime });
  observer.observe({ metadata: { progress: { phase: "1/4", model: "vocals" } } });
  currentTime = 1_500;
  observer.observe({ metadata: "{bad json" });

  assert.deepEqual(observer.finish(), [
    { phase: "1/4", model: "vocals", observedDurationSeconds: 1 },
  ]);
});
