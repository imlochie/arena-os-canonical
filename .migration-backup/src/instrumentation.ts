/**
 * Next.js instrumentation — desktop-mode bootstrap.
 *
 * register() runs once per server process. Whenever the runtime policy
 * (worker-local/runtime-policy.ts) says THIS process owns processing — the
 * desktop app, a local dev server, or an explicit WAVEYARD_LOCAL_WORKER=1 —
 * it starts the local worker so the in-process LocalJobBroker has its real
 * handlers registered before the first request can enqueue anything.
 * Deployments with REDIS_URL (a real Waveyard worker) and unconfigured
 * production builds are untouched: this file does nothing.
 *
 * NOTE: Next 16's production server does not set NEXT_RUNTIME at boot
 * (only 'edge' is ever distinguishable), so the guard excludes only the
 * edge runtime rather than requiring an explicit nodejs value.
 *
 * SIGTERM drains in-flight jobs before exit so the supervisor's ordered
 * shutdown cannot orphan a running render mid-write; jobs that cannot
 * finish in the bounded window keep their honest non-terminal row state
 * for retry.
 */

export async function register() {
  if (process.env.NEXT_RUNTIME === "edge") return;
  const { shouldRunLocalWorker } = await import("@/lib/waveyard/worker-local/runtime-policy");
  if (!shouldRunLocalWorker()) return;
  const { startLocalWorker } = await import("@/lib/waveyard/worker-local");
  if (startLocalWorker() === null) return;
  const { wireDesktopSignals } = await import("@/lib/waveyard/worker-local/signals");
  wireDesktopSignals();
}
