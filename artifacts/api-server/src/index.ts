import app from "./app";
import { logger } from "./lib/logger";
import { startLocalWorker, drainLocalWorker } from "@workspace/arena/lib/waveyard/worker-local";
import { db } from "@workspace/db";
import { processingJobs } from "@workspace/db/waveyardSchema";
import { and, eq, inArray } from "drizzle-orm";

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

const server = app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    server.close(() => {
      void drainLocalWorker().finally(() => process.exit(0));
    });
    // Do not leave a hung connection or model blocking managed restarts.
    setTimeout(() => process.exit(1), 20_000).unref();
  });
}
