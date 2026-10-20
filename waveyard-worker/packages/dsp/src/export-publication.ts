/** Shared desktop/server export publication boundary. A local completion flag
 * is not evidence that a COMMIT failed. Job row locks serialize publication and
 * cleanup; storage is deleted only after an authoritative unreferenced lookup. */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

type SqlExecutor = Pick<Parameters<Parameters<NodePgDatabase["transaction"]>[0]>[0], "execute">;
type Database<Tx> = { transaction<T>(body: (tx: Tx) => Promise<T>): Promise<T> };
// Root desktop and independently installed worker Drizzle packages have nominal
// private driver types. Preserve the caller's transaction type for publication;
// bridge only the identical public SQL execution API (covered with both installed).
function executor(tx: { execute: unknown }): SqlExecutor { return tx as unknown as SqlExecutor; }
export function exportAttemptKey(projectId: string, jobId: string, format: "wav" | "mid") {
  if (![projectId, jobId].every(id => /^[a-f0-9-]{36}$/i.test(id))) throw new Error("Export identity is invalid.");
  // Unknown outcomes remain discoverable under their existing durable job ID,
  // without publishing a second asset registry or leaking paths into UI errors.
  return `projects/${projectId}/export/${jobId}/${randomUUID()}.${format}`;
}
export async function publishExport<Tx extends { execute: unknown }>(database: Database<Tx>, jobId: string, publish: (tx: Tx) => Promise<void>) {
  return database.transaction(async tx => {
    const state = await executor(tx).execute(sql`select status from export_jobs where id = ${jobId} for update`);
    if (!state.rows.length) throw new Error("Export job disappeared before publication.");
    if (state.rows[0].status === "complete" || state.rows[0].status === "cancelled") return false;
    await publish(tx);
    return true;
  });
}
export async function cleanupExportAttempt<Tx extends { execute: unknown }>(database: Database<Tx>, storage: { delete(key: string): Promise<unknown> }, jobId: string, key: string): Promise<"referenced" | "deleted" | "unknown"> {
  try {
    return await database.transaction(async tx => {
      // Wait for an in-flight original COMMIT/ROLLBACK before looking for the
      // asset. Publication takes this same lock BEFORE inserting its row.
      const job = await executor(tx).execute(sql`select id, project_id from export_jobs where id = ${jobId} for update`);
      const prefix = `projects/${job.rows[0]?.project_id}/export/${jobId}/`;
      if (!job.rows.length || !key.startsWith(prefix) || !/^[a-f0-9-]{36}\.(wav|mid)$/.test(key.slice(prefix.length))) throw new Error("Cleanup ownership is not established for this export attempt.");
      const references = await executor(tx).execute(sql`select id from export_assets where storage_key = ${key} union all select id from source_assets where storage_key = ${key} union all select id from stem_assets where storage_key = ${key} limit 1`);
      if (references.rows.length) return "referenced" as const;
      await storage.delete(key);
      return "deleted" as const;
    });
  } catch {
    // Includes lookup/lock/transport/storage failures. Never infer absence.
    return "unknown";
  }
}
