// Only instrumentation; all loading, caching, transformation and DSP are the
// same controller used by StudioCore. Never a replacement transport/processor.
import { ArrangementPreparation } from "../../src/lib/waveyard/arrangement-preparation";
import type { ArrangementPreviewState } from "../../src/lib/waveyard/arrangement-pcm";
Object.assign(window, { async measurePreparation(state: ArrangementPreviewState) {
  const context = new AudioContext({ sampleRate: 44100 }), engine = new ArrangementPreparation();
  let last = performance.now(), maximumGapMs = 0, ticks = 0;
  const timer = setInterval(() => { const now = performance.now(); maximumGapMs = Math.max(maximumGapMs, now - last); last = now; ticks++; }, 5);
  try {
    const started = performance.now();
    const buffer = await engine.prepare(state, context); const readyMs = performance.now() - started;
    await new Promise(resolve => setTimeout(resolve, 15));
    const cached = performance.now(); const replay = await engine.prepare(state, context); const replayMs = performance.now() - cached;
    if (replay !== buffer) throw new Error("Replay did not retain the actual finished musical buffer.");
    const edited = structuredClone(state); edited.masterVolume *= 0.5;
    const editStart = performance.now(); const changed = await engine.prepare(edited, context); const editMs = performance.now() - editStart;
    let error = 0; for (let frame = 0; frame < buffer.length; frame++) error = Math.max(error, Math.abs(changed.getChannelData(0)[frame] - buffer.getChannelData(0)[frame] * 0.5));
    await new Promise(resolve => setTimeout(resolve, 15));
    return { readyMs, replayMs, editMs, maximumGapMs, ticks, frames: buffer.length, latestEditError: error, outputPlanarBytes: buffer.length * 2 * 4, diagnostics: engine.diagnostics };
  } finally { clearInterval(timer); engine.dispose(); await context.close(); }
} });

Object.assign(window, { async verifyPreparationLifecycle(state: ArrangementPreviewState) {
  const context = new AudioContext({ sampleRate: 44100 }), engine = new ArrangementPreparation();
  const originalFetch = window.fetch, NativeWorker = window.Worker;
  let fetches = 0, created = 0, terminated = 0;
  let onWork: (() => void) | undefined;
  window.fetch = (...args) => { fetches++; return originalFetch(...args); };
  window.Worker = class extends NativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) { super(url, options); created++; }
    postMessage(message: unknown, options?: Transferable[] | StructuredSerializeOptions) { if (Array.isArray(options)) super.postMessage(message, options); else super.postMessage(message, options); onWork?.(); }
    terminate() { terminated++; super.terminate(); }
  } as typeof Worker;
  try {
    const first = await engine.prepare(state, context);
    const coldFetches = fetches;
    const edit = structuredClone(state); edit.masterVolume *= 0.25;
    const workPosted = new Promise<void>(resolve => { onWork = resolve; });
    const pending = engine.prepare(edit, context).then(() => "unexpected success", error => error.name);
    await workPosted; onWork = undefined;
    engine.cancel();
    const cancelled = await pending;
    const latest = structuredClone(state); latest.masterVolume *= 0.5;
    const result = await engine.prepare(latest, context);
    let error = 0;
    for (let frame = 0; frame < first.length; frame++) error = Math.max(error, Math.abs(result.getChannelData(0)[frame] - first.getChannelData(0)[frame] * 0.5));
    const afterEditFetches = fetches;
    const cached = await engine.prepare(latest, context);
    engine.dispose();
    const disposedWorkers = { created, terminated };
    await engine.prepare(state, context, "reopened-source-revision");
    return { coldFetches, afterEditFetches, reopenedFetches: fetches, cancelled, latestError: error, replaySame: cached === result, disposedWorkers };
  } finally { engine.dispose(); window.fetch = originalFetch; window.Worker = NativeWorker; await context.close(); }
} });
