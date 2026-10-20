/** Native cancellation is a request until the executor has stopped and cleaned
 * partial objects. Keep the active target locked during that acknowledgement. */
import { randomUUID } from "node:crypto";
import { and, eq, notInArray } from "drizzle-orm";
import { processingJobs } from "@/db/waveyardSchema";
import { startSeparationJob, type ClaimDb, type ProcessingJobRow, type StartSeparationDeps } from "./claim";
import { parentStemAssetIdOf } from "./retry";

export async function requestSeparationCancellation(db: ClaimDb, id: string) {
  // A queued attempt has not acquired inputs/resources, so it can be terminal
  // immediately. The handler must claim queued → preparing atomically (below).
  const now = new Date();
  await db.update(processingJobs).set({ status: "cancelled", stage: "cancelled", errorCode: "cancelled", errorMessage: "Cancelled before separation started.", completedAt: now, updatedAt: now })
    .where(and(eq(processingJobs.id, id), eq(processingJobs.type, "separation"), eq(processingJobs.status, "queued")));
  await db.update(processingJobs).set({ status: "cancelling", stage: "cancelling", errorCode: "cancelled", errorMessage: "Cancellation requested; waiting for the native executor to stop and remove partial output.", updatedAt: now })
    .where(and(eq(processingJobs.id, id), eq(processingJobs.type, "separation"), notInArray(processingJobs.status, ["queued", "complete", "failed", "cancelled", "cancelling"])));
  const [job] = await db.select().from(processingJobs).where(eq(processingJobs.id, id)).limit(1);
  return job ?? null;
}

/** A fresh durable attempt avoids racing an old broker task's final cleanup;
 * the cancelled attempt, its errors and original source identity stay intact. */
export async function restartCancelledSeparation(db: ClaimDb, job: ProcessingJobRow, deps: StartSeparationDeps = {}) {
  if ((job.status !== "cancelled" && !(job.status === "failed" && job.errorCode === "execution_interrupted")) || job.type !== "separation" || !job.sourceAssetId) throw new Error("Only a stopped separation can be restarted.");
  const sourceAssetId = job.sourceAssetId;
  const id = randomUUID();
  const parentStemAssetId = parentStemAssetIdOf(job);
  return startSeparationJob(db, {
    ...job, id, status: "queued", stage: "queued", attempts: 0,
    errorCode: null, errorMessage: null, startedAt: null, completedAt: null,
    createdAt: new Date(), updatedAt: new Date(), metadata: JSON.stringify({ retryOf: job.id, ...(parentStemAssetId ? { parentStemAssetId } : {}) }),
  }, () => ({ processingJobId: id, projectId: job.projectId, sourceAssetId, model: job.model, requestedDevice: job.requestedDevice === "cuda" ? "cuda" : job.requestedDevice === "cpu" ? "cpu" : "auto", ...(parentStemAssetId ? { parentStemAssetId } : {}) }), deps);
}
