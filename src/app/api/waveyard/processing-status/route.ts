/**
 * GET /api/waveyard/processing-status — the honest answer to "will anything
 * actually process my audio?" (vision Principle 3: unavailable = an
 * actionable state, never an infinite spinner).
 *
 * Reports the deliberate runtime policy's mode, whether the in-process
 * worker actually started (real handler registration, not config), live
 * broker stats when it runs, and the human explanation. The UI shows this
 * whenever jobs are waiting — a queued job must never look like progress
 * when no process can complete it.
 */

import { NextResponse } from "next/server";

import { requireUser } from "@/lib/waveyard/local-context";
import { localWorkerStats } from "@/lib/waveyard/worker-local";
import { processingModeExplanation, resolveProcessingMode } from "@/lib/waveyard/worker-local/runtime-policy";
import { queueConfigured } from "@/lib/waveyard/queue";

export const dynamic = "force-dynamic";

export async function GET() {
  await requireUser(); // same guard as every other waveyard route
  const mode = resolveProcessingMode();
  const localStats = localWorkerStats(); // null when not running (or no handlers)
  return NextResponse.json({
    mode,
    explanation: processingModeExplanation(mode),
    queueConfigured: queueConfigured(),
    // Honest distinction: the policy may say in-process, but if the worker
    // has not actually registered handlers, nothing is executing yet.
    localWorker: localStats === null
      ? null
      : {
          queues: localStats.queues,
          pending: localStats.pending,
          running: localStats.running,
          startedAt: localStats.startedAt,
          counts: {
            submitted: localStats.submitted,
            succeeded: localStats.succeeded,
            failed: localStats.failed,
            rejected: localStats.rejected,
          },
        },
  });
}
