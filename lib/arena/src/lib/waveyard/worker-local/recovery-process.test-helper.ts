import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { waveformJobs } from "@workspace/db/waveyardSchema";
import { recoverPendingLocalWaveformJobs } from "./recovery";

const jobId = process.env.WAVEFORM_RECOVERY_TEST_JOB_ID;
const mode = process.env.WAVEFORM_RECOVERY_TEST_MODE;
const databaseUrl = process.env.DATABASE_URL;

function send(message: Record<string, unknown>): void {
  process.send?.(message);
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
  if (!jobId || !databaseUrl || !["hold", "complete", "claim-only"].includes(mode ?? "")) {
    throw new Error("Recovery process test configuration is incomplete.");
  }

  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const db = drizzle(pool);
  try {
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
    process.disconnect?.();
  }
}

main().catch((error: unknown) => {
  send({ type: "error", message: error instanceof Error ? error.stack ?? error.message : String(error) });
  process.disconnect?.();
  process.exitCode = 1;
});
