import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { WAVEFORM_RESOLUTIONS, type WaveformDocument } from "@workspace/arena/lib/waveyard/types";
import { getStorage } from "@workspace/arena/lib/waveyard/storage";
import { waveformJobs } from "@workspace/db/waveyardSchema";
import { recoverPendingLocalWaveformJobs } from "./recovery";
import { handleWaveformJob } from "./waveform";

const jobId = process.env.WAVEFORM_RECOVERY_TEST_JOB_ID;
const mode = process.env.WAVEFORM_RECOVERY_TEST_MODE;
const databaseUrl = process.env.DATABASE_URL;

function send(message: Record<string, unknown>): void {
  if (!process.send || !process.connected) return;
  process.send(message, (error) => {
    if (error) console.error("Recovery process test message failed:", error);
  });
}

async function waitForMessage(type: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.on("message", (message: unknown) => {
      if (message && typeof message === "object" && (message as { type?: unknown }).type === type) {
        resolve();
      }
    });
    process.once("disconnect", () => reject(new Error("Parent disconnected before releasing recovery process.")));
  });
}

async function main(): Promise<void> {
  if (!jobId || !databaseUrl || !["hold", "complete", "claim-only", "upload-before-commit"].includes(mode ?? "")) {
    throw new Error("Recovery process test configuration is incomplete.");
  }

  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const db = drizzle(pool);
  try {
    if (mode === "upload-before-commit") {
      const baseStorage = getStorage();
      const blockingStorage = Object.create(baseStorage) as typeof baseStorage;
      blockingStorage.putFile = async (key, localPath, contentType) => {
        await baseStorage.putFile(key, localPath, contentType);
        send({ type: "uploaded", key });
        // Keep the real handler suspended after the durable object write and
        // before it can open the asset/job completion transaction.
        await new Promise<void>(() => {});
      };
      const waveform: WaveformDocument = {
        format: "waveyard-peaks-v1",
        durationSeconds: 1,
        sampleRate: 44_100,
        channels: 1,
        resolutions: Object.fromEntries(WAVEFORM_RESOLUTIONS.map((resolution) => [
          String(resolution),
          {
            min: new Array<number>(resolution).fill(-0.25),
            max: new Array<number>(resolution).fill(0.25),
          },
        ])) as WaveformDocument["resolutions"],
      };
      const [job] = await db.select().from(waveformJobs).where(eq(waveformJobs.id, jobId)).limit(1);
      if (!job) throw new Error(`Waveform job ${jobId} was not found.`);
      await handleWaveformJob(
        {
          waveformJobId: job.id,
          projectId: job.projectId,
          ...(job.sourceAssetId ? { sourceAssetId: job.sourceAssetId } : {}),
          ...(job.stemAssetId ? { stemAssetId: job.stemAssetId } : {}),
        },
        { db, storage: blockingStorage, generateWaveform: async () => waveform },
      );
      return;
    }

    if (mode === "claim-only") {
      const claimStage = `recovery-submitting:${process.pid}:stopped-owner`;
      const [claimed] = await db
        .update(waveformJobs)
        .set({ status: "queued", stage: claimStage, updatedAt: new Date() })
        .where(eq(waveformJobs.id, jobId))
        .returning({ id: waveformJobs.id });
      if (!claimed) throw new Error(`Unable to seed the active claim for waveform job ${jobId}.`);
      send({ type: "claimed", pid: process.pid, stage: claimStage });
      await waitForMessage("stop");
      return;
    }

    const recovery = await recoverPendingLocalWaveformJobs(db, async (payload) => {
      if (payload.waveformJobId !== jobId) throw new Error(`Unexpected waveform job ${payload.waveformJobId}.`);
      send({ type: "submitted", jobId: payload.waveformJobId, pid: process.pid });

      if (mode === "hold") await waitForMessage("release");

      await db
        .update(waveformJobs)
        .set({
          status: "complete",
          stage: "complete",
          errorCode: "waveform_ready",
          errorMessage: null,
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(waveformJobs.id, payload.waveformJobId));
    });
    send({ type: "done", recovery });
  } finally {
    await pool.end();
    if (process.connected) process.disconnect();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  send({ type: "error", message });
  if (process.connected) process.disconnect();
  process.exitCode = 1;
});
