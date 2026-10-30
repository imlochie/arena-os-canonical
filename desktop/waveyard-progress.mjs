import { performance } from "node:perf_hooks";

function progressFor(job) {
  let metadata = job?.metadata ?? {};
  if (typeof metadata === "string") {
    try {
      metadata = JSON.parse(metadata);
    } catch {
      return null;
    }
  }
  return metadata?.progress ?? null;
}

/** Records approximate model-pass durations from polled durable job updates. */
export function createModelPassObserver({ now = () => performance.now() } = {}) {
  let active = null;
  let finished = false;
  const passes = [];

  function finishActive(observedAt = now()) {
    if (!active) return;
    passes.push({
      phase: active.phase,
      model: active.model,
      observedDurationSeconds: Number(((observedAt - active.startedAt) / 1000).toFixed(2)),
    });
    active = null;
  }

  return {
    observe(job) {
      if (finished) throw new Error("The model-pass observer has already been finished.");
      const progress = progressFor(job);
      const next = typeof progress?.phase === "string" && typeof progress?.model === "string"
        ? { phase: progress.phase, model: progress.model }
        : null;
      if (active && (next?.phase !== active.phase || next?.model !== active.model)) {
        finishActive();
      }
      if (next && !active) {
        active = { ...next, startedAt: now() };
      }
    },
    finish() {
      if (finished) return passes.map((pass) => ({ ...pass }));
      finishActive();
      finished = true;
      return passes.map((pass) => ({ ...pass }));
    },
  };
}
