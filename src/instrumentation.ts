/**
 * Next.js instrumentation — desktop-mode bootstrap.
 *
 * register() runs once per server process. In desktop mode
 * (ARENA_DESKTOP_MODE=1 without REDIS_URL) it starts the local worker so
 * the in-process LocalJobBroker has its real handlers registered before
 * the first request can enqueue anything. Browser/server/cloud/dev mode
 * is untouched: without the flag this file does nothing.
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
  if (process.env.ARENA_DESKTOP_MODE !== "1" || process.env.REDIS_URL) return;
  const { startLocalWorker } = await import("@/lib/waveyard/worker-local");
  if (startLocalWorker() === null) return;
  const { wireDesktopSignals } = await import("@/lib/waveyard/worker-local/signals");
  wireDesktopSignals();
}
