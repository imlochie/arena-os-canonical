import app from "./app";
import { logger } from "./lib/logger";
import { startLocalWorker, drainLocalWorker } from "@workspace/arena/lib/waveyard/worker-local";
import { db, pool } from "@workspace/db";
import { processingJobs } from "@workspace/db/waveyardSchema";
import { and, eq, inArray } from "drizzle-orm";
import { closeAllBrowserSessions } from "@workspace/arena/lib/spaces/browser";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// The Express runtime must register the same real processors as the desktop
// runtime before accepting uploads. Policy keeps hosted Redis deployments out.
const worker = startLocalWorker();
if (worker) {
  // This policy exclusively owns the local queue (never used with Redis).
  // The in-memory broker cannot still own jobs from a previous process.
  // Make interrupted separation retryable instead of leaving it stuck forever.
  const interrupted = await db.update(processingJobs).set({
    status: "failed",
    stage: "interrupted",
    errorCode: "processor_interrupted",
    errorMessage: "The local processor stopped before this job finished. Retry separation to continue.",
    completedAt: new Date(),
    updatedAt: new Date(),
  }).where(and(
    eq(processingJobs.type, "separation"),
    inArray(processingJobs.status, ["queued", "preparing", "processing", "finalizing"]),
  )).returning({ id: processingJobs.id });
  logger.info({ queues: worker.registeredQueues(), interrupted: interrupted.length }, "Waveyard local processors ready");
}


if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

if (process.env.ARENA_DESKTOP_MODE === "1") {
  // The old process is gone. Preserve its journal and make interrupted tasks
  // resumable; never silently rerun an in-flight interaction.
  await pool.query("update space_missions set status='checkpointed', status_detail='The desktop app restarted. Review the saved journal, then resume.', updated_at=now() where status='running'");
}

const server = app.listen(port, process.env.ARENA_DESKTOP_MODE === "1" ? "127.0.0.1" : "0.0.0.0", () => {
  logger.info({ port }, "Server listening");
});
server.on("error", (err) => {
  logger.error({ err }, "Error listening on port");
  process.exit(1);
});

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close();
  const deadline = setTimeout(() => process.exit(1), 20_000);
  deadline.unref();
  try {
    await drainLocalWorker();
    await closeAllBrowserSessions();
    await pool.end();
  } catch (err) {
    logger.error({ err }, "Error during graceful shutdown");
    process.exitCode = 1;
  } finally {
    clearTimeout(deadline);
  }
  process.exit(process.exitCode ?? 0);
}
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
// Electron on Windows cannot deliver POSIX SIGTERM gracefully. Use IPC first.
process.on("message", (message) => { if (message === "shutdown") void shutdown(); });
