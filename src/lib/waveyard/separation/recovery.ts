/** Durable native separation journal, on the existing processing_jobs row.
 * A lease/time/PID alone never authorizes takeover. Unsupported owner probes
 * fail closed. Files are planned before writing and revalidated before recovery.
 */
import { readFile, readlink, rm } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { tmpdir } from "node:os";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { processingJobs, sourceAssets, stemAssets, waveformJobs } from "@/db/waveyardSchema";
import type { SeparationDb } from "./retry";
import { checksumFile } from "../audio";
import { decodeWav16 } from "../mixer/synth";
import { getStorage } from "../storage";

type Job = typeof processingJobs.$inferSelect;
export type Output = typeof stemAssets.$inferInsert;
export type Owner = { host: string; boot: string; namespace: string; pid: number; start: string };
export type Execution = { id: string; owner: Owner | null; child?: Owner | null; phase: string; expected: number; frames?: number; input?: { key: string; checksum: string; sourceChecksum: string }; workDirectory?: string; cleanupPending?: boolean; outputs: Output[]; provenance: Record<string, unknown>; history?: string[] };
export function metadata(raw: string): Record<string, unknown> { try { const value = JSON.parse(raw); return value && typeof value === "object" && !Array.isArray(value) ? value : {}; } catch { return {}; } }
export async function ownerIdentity(pid = process.pid): Promise<Owner | null> {
  if (process.platform !== "linux") return null;
  const stat = await readFile(`/proc/${pid}/stat`, "utf8");
  return { host: hostname(), boot: (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(), namespace: await readlink("/proc/self/ns/pid"), pid, start: stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] };
}
export async function ownerState(owner: Owner | null | undefined): Promise<"live" | "dead" | "unknown"> {
  if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || !/^\d+$/.test(owner.start)) return "unknown";
  const self = await ownerIdentity().catch(() => null);
  if (!self || self.host !== owner.host || self.boot !== owner.boot || self.namespace !== owner.namespace) return "unknown";
  try {
    const stat = await readFile(`/proc/${owner.pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[19] !== owner.start || fields[0] === "Z" ? "dead" : "live";
  } catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? "dead" : "unknown"; }
}
export function executionHistory(job: Pick<Job, "metadata" | "status" | "errorCode" | "errorMessage">): unknown[] {
  const base = metadata(job.metadata);
  const history = Array.isArray(base.executionHistory) ? base.executionHistory : [];
  if (!base.execution) return history;
  const last = history.at(-1) as { execution?: Execution } | undefined;
  if (last?.execution?.id === (base.execution as Execution).id) return history;
  return [...history, { execution: base.execution, status: job.status, errorCode: job.errorCode, errorMessage: job.errorMessage }];
}
export async function newExecution(expected: number): Promise<Execution> {
  return { id: randomUUID(), owner: await ownerIdentity(), phase: "claimed", expected, outputs: [], provenance: {} };
}
export async function saveExecution(db: SeparationDb, id: string, execution: Execution) {
  const [saved] = await db.update(processingJobs).set({ metadata: sql`(${processingJobs.metadata}::jsonb || ${JSON.stringify({ execution })}::jsonb)::text`, updatedAt: new Date() })
    .where(and(eq(processingJobs.id, id), sql`${processingJobs.metadata}::jsonb->'execution'->>'id' = ${execution.id}`)).returning({ id: processingJobs.id });
  if (!saved) throw new Error("Separation execution ownership changed.");
}
/** Caller holds the job row lock. Shared by normal completion and restart. */
export async function publishBank(tx: Parameters<Parameters<SeparationDb["transaction"]>[0]>[0], job: Job, outputs: Output[], provenance: Record<string, unknown>) {
  const previous = await tx.select({ id: stemAssets.id }).from(stemAssets).where(eq(stemAssets.separationJobId, job.id));
  if (previous.length) throw new Error("This run already has published assets; preserved immutable bank.");
  const stems = await tx.insert(stemAssets).values(outputs).returning({ id: stemAssets.id });
  const work = await tx.insert(waveformJobs).values(stems.map(stem => ({ projectId: job.projectId, stemAssetId: stem.id, status: "queued", stage: "queued", idempotencyKey: `waveform:stem:${stem.id}` }))).returning({ id: waveformJobs.id, stemAssetId: waveformJobs.stemAssetId });
  const base = metadata(job.metadata);
  if (base.execution) base.execution = { ...(base.execution as Execution), phase: "committed" };
  await tx.update(processingJobs).set({ status: "complete", stage: "complete", completedAt: new Date(), updatedAt: new Date(), metadata: JSON.stringify({ ...base, ...provenance }) }).where(eq(processingJobs.id, job.id));
  return work;
}
export async function validateExecutionOutputs(job: Job, e: Execution) {
  if (!e.frames || e.outputs.length !== e.expected || !e.expected || new Set(e.outputs.map(o => o.stemType)).size !== e.expected) return false;
  for (const o of e.outputs) {
    if (o.separationJobId !== job.id || o.projectId !== job.projectId || o.sourceAssetId !== job.sourceAssetId || !/^projects\/[\w-]+\/stem\/[\w-]+\.wav$/.test(o.storageKey)) return false;
    const file = getStorage().getLocalPath(o.storageKey);
    try {
      if (!file || await checksumFile(file) !== o.checksumSha256) return false;
      const wav = decodeWav16(new Uint8Array(await readFile(file)));
      if (!wav || wav.frames !== e.frames || wav.frames !== Math.round(o.durationSeconds * 44100) || wav.channels !== 2 || wav.sampleRate !== 44100) return false;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  }
  return true;
}
async function cleanupWork(e: Execution) {
  if (!e.workDirectory) return;
  if (dirname(e.workDirectory) !== tmpdir() || !basename(e.workDirectory).startsWith(`arena-separation-${e.id}-`) || !/^[a-f0-9-]{36}$/.test(e.id)) throw new Error("Unsafe recovery temporary directory.");
  await rm(e.workDirectory, { recursive: true, force: true });
  e.cleanupPending = false;
}
/** No timeout-based reclamation. A locked row fences retry, cancel and concurrent
 * recovery. A crash rolls back this transaction; planned keys remain journaled. */
export async function reconcileSeparation(db: SeparationDb, id: string, boundary?: (phase: string) => Promise<void>) {
  return db.transaction(async tx => {
    const [job] = await tx.select().from(processingJobs).where(eq(processingJobs.id, id)).for("update");
    if (!job || job.type !== "separation") return "not-found";
    const e = metadata(job.metadata).execution as Execution | undefined;
    if (!e) return job.status === "queued" ? "queued" : "legacy-unknown-owner";
    if (e.phase === "retired") return "already-retired";
    if (await ownerState(e.owner) !== "dead" || (e.child && await ownerState(e.child) !== "dead")) return "owner-not-proven-dead";
    if (e.outputs.length) {
      const [source] = await tx.select().from(sourceAssets).where(eq(sourceAssets.id, job.sourceAssetId!));
      const input = e.input && getStorage().getLocalPath(e.input.key);
      if (!source || source.projectId !== job.projectId || source.checksumSha256 !== e.input?.sourceChecksum || !input || await checksumFile(input) !== e.input?.checksum) throw new Error("Recovery source identity cannot be verified; staged audio retained.");
    }
    const published = await tx.select().from(stemAssets).where(eq(stemAssets.separationJobId, job.id));
    if (published.length) {
      // Existing referenced audio is never deleted, including inconsistent banks.
      if (published.length !== e.expected || !published.every(row => e.outputs.some(o => o.storageKey === row.storageKey && o.checksumSha256 === row.checksumSha256)) || !await validateExecutionOutputs(job, e)) return "inconsistent-bank-preserved";
      await cleanupWork(e);
      await tx.update(processingJobs).set({ status: "complete", stage: "complete", completedAt: job.completedAt ?? new Date(), updatedAt: new Date(), metadata: JSON.stringify({ ...metadata(job.metadata), execution: { ...e, phase: "committed" } }) }).where(eq(processingJobs.id, id));
      return "committed";
    }
    if (job.status === "complete") return "inconsistent-bank-preserved";
    await boundary?.("reconciling");
    if (job.status !== "cancelling" && job.status !== "cancelled" && ["validated", "staging"].includes(e.phase) && await validateExecutionOutputs(job, e)) {
      await boundary?.("recovery-publication");
      await publishBank(tx, job, e.outputs, e.provenance);
      await boundary?.("recovery-committed-before-ack");
      await cleanupWork(e);
      await tx.update(processingJobs).set({ metadata: JSON.stringify({ ...metadata(job.metadata), ...e.provenance, execution: { ...e, phase: "committed" } }) }).where(eq(processingJobs.id, id));
      return "recovered-bank";
    }
    // No committed bank. Delete only this journal's planned, private keys;
    // reference lookup is global rather than limited to this job.
    for (const o of e.outputs) {
      if (o.projectId !== job.projectId || o.separationJobId !== id || !o.storageKey.startsWith(`projects/${job.projectId}/stem/`) || !/^projects\/[\w-]+\/stem\/[\w-]+\.wav$/.test(o.storageKey)) throw new Error("Unsafe recovery object ownership.");
      const refs = await tx.select({ id: stemAssets.id }).from(stemAssets).where(eq(stemAssets.storageKey, o.storageKey));
      const active = await tx.select({ id: processingJobs.id }).from(processingJobs).where(sql`${processingJobs.id} <> ${id} and ${processingJobs.status} not in ('complete','failed','cancelled') and ${processingJobs.metadata}::jsonb->'execution'->'outputs' @> ${JSON.stringify([{ storageKey: o.storageKey }])}::jsonb`);
      if (active.length) throw new Error("Output retained: another active operation references this planned key.");
      if (!refs.length) { await boundary?.("cleanup"); await getStorage().delete(o.storageKey); await boundary?.("cleanup-written"); }
    }
    await cleanupWork(e);
    const cancelled = ["cancelling", "cancelled"].includes(job.status);
    e.history = [...(e.history ?? []), `${new Date().toISOString()}: interrupted ${e.phase}; outputs retired`];
    e.phase = "retired";
    await tx.update(processingJobs).set({ status: cancelled ? "cancelled" : "failed", stage: cancelled ? "cancelled" : "interrupted", errorCode: job.status === "failed" ? job.errorCode : cancelled ? "cancelled" : "execution_interrupted", errorMessage: job.status === "failed" ? job.errorMessage : "Executor death verified by process incarnation; unpublished output retired. A fresh separation can now be requested.", completedAt: new Date(), updatedAt: new Date(), metadata: JSON.stringify({ ...metadata(job.metadata), execution: e }) }).where(eq(processingJobs.id, id));
    return cancelled ? "cancelled" : "interrupted";
  });
}
export async function reconcileNativeSeparations(db: SeparationDb, queued: (job: Job) => Promise<unknown>) {
  const jobs = await db.select().from(processingJobs).where(eq(processingJobs.type, "separation"));
  const results: Record<string, string> = {};
  for (const job of jobs) {
    const base = metadata(job.metadata), execution = base.execution as Execution | undefined;
    if (["failed", "cancelled"].includes(job.status) && !base.cleanupFailedKeys && !execution?.cleanupPending) continue;
    if (job.status === "complete" && !execution?.cleanupPending) continue;
    try { const result = await reconcileSeparation(db, job.id); results[job.id] = result; if (result === "queued") await queued(job); }
    catch (error) { results[job.id] = `recovery-pending: ${error instanceof Error ? error.message : String(error)}`; }
  }
  const work = await db.select({ id: waveformJobs.id, projectId: waveformJobs.projectId, stemAssetId: waveformJobs.stemAssetId }).from(waveformJobs).innerJoin(stemAssets, eq(stemAssets.id, waveformJobs.stemAssetId)).innerJoin(processingJobs, eq(processingJobs.id, stemAssets.separationJobId)).where(and(eq(waveformJobs.status, "queued"), eq(processingJobs.status, "complete")));
  if (work.length) {
    const { enqueueWaveform } = await import("../queue");
    for (const item of work) {
      try { await enqueueWaveform({ waveformJobId: item.id, projectId: item.projectId, stemAssetId: item.stemAssetId! }); }
      catch { results[`waveform:${item.id}`] = "reporting-pending"; }
    }
  }
  return results;
}
