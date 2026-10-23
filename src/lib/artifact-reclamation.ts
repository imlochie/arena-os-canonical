/** Explicit, local-only, two-grace cleanup. The ledger records intent/outcomes;
 * every decision re-reads the real graph. No startup/refresh calls this code. */
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { lstat, open, readdir, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { replaceFile } from "@/lib/fs-replace";
import { db } from "@/db";
import { objectReclamations, type ArtifactContentObject } from "@/db/schema";
import { artifactObjectKey, ArtifactObjectError, MAX_ARTIFACT_OBJECT_BYTES } from "./artifact-objects";
import { storageWriteLock } from "./artifact-storage-lock";
import { getStorage } from "./waveyard/storage";
import { isUuid } from "./api/ids";
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Mark = typeof objectReclamations.$inferSelect;
const DAY = 86400000;
const descriptor = (sha256: string, bytes = 0): ArtifactContentObject => ({ version: 1, sha256, bytes, mediaType: "application/octet-stream" });
const days = (name: string, fallback: number, minimum: number) => {
  const value = process.env[name]; if (value === undefined) return fallback;
  const number = Number(value); if (!Number.isFinite(number) || number < minimum || number > 36500) throw new ArtifactObjectError(`Invalid ${name}; reclamation refused.`, 503); return number;
};
export function reclamationPolicy() {
  return { enabled: process.env.ARENA_ENABLE_OBJECT_RECLAMATION === "1", unboundDays: days("ARENA_OBJECT_UNBOUND_DAYS", 90, 30), graceDays: days("ARENA_OBJECT_GRACE_DAYS", 7, 1), quarantineDays: days("ARENA_OBJECT_QUARANTINE_DAYS", 7, 1),
    scope: "Local generic Artifact objects only. Current/history/pins/Missions/archives are retained indefinitely. Tombstone expiry alone never releases immutable history. Partial/uncertain/recoverable work is protected. Explicit owner abandonment is required for otherwise unreferenced bytes." };
}
function filenames(owner: string, sha: string, id?: string) {
  const canonical = getStorage().getLocalPath(artifactObjectKey(owner, descriptor(sha)));
  if (!canonical) throw new ArtifactObjectError("Reclamation supports verified local storage only.", 503);
  return { canonical, quarantine: id ? `${canonical}.${id}.quarantine` : "" };
}
async function identity(filename: string) {
  if (await realpath(path.dirname(filename)) !== path.resolve(path.dirname(filename))) throw new ArtifactObjectError("Symlinked storage directories are not eligible for cleanup.");
  const info = await lstat(filename, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== BigInt(1) || info.size > BigInt(MAX_ARTIFACT_OBJECT_BYTES)) throw new ArtifactObjectError("Object is not a single regular private file; retained.");
  return { dev: String(info.dev), ino: String(info.ino), size: Number(info.size), modified: info.mtimeNs.toString(), changed: info.ctimeNs.toString() };
}
async function exists(filename: string) { try { await lstat(filename); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } }
async function verify(filename: string, mark: Pick<Mark, "sha256" | "bytes" | "identity">, renamed = false) {
  const info = await identity(filename), expected = mark.identity;
  if (info.dev !== expected.dev || info.ino !== expected.ino || info.size !== mark.bytes || info.modified !== expected.modified || (!renamed && info.changed !== expected.changed)) throw new ArtifactObjectError("Object identity changed since marking; retained.");
  const hash = createHash("sha256"); for await (const chunk of createReadStream(filename, { signal: AbortSignal.timeout(10000) })) hash.update(chunk);
  if (hash.digest("hex") !== mark.sha256 || JSON.stringify(await identity(filename)) !== JSON.stringify(info)) throw new ArtifactObjectError("Object corrupt or changed during verification; retained.");
}
// Discover the real public graph, including new room/version tables. The only
// exclusion is our own operation ledger (otherwise marking would self-pin).
// Conservative full-row matching can over-retain incidental text; it cannot
// certify absence from a guessed hand-maintained list or a bounded inventory.
const lockedTables = new WeakMap<object, string[]>();
async function lock(tx: Tx) {
  await tx.execute(sql`set local lock_timeout = '3s'`);
  await tx.execute(sql`set local statement_timeout = '5s'`);
  const guards = await tx.execute(sql`SELECT tgname FROM pg_trigger WHERE tgname IN ('guard_reclaimed_artifact','guard_reclaimed_revision') AND NOT tgisinternal AND tgenabled IN ('O','A')`);
  if (guards.rows.length !== 2) throw new ArtifactObjectError("Reclamation safety guards missing/disabled. Apply desktop-migrations/0021_object_reclamation.sql via the runtime upgrade before cleanup; no bytes changed.", 503);
  await tx.execute(storageWriteLock);
  const tables = await tx.execute<{ name: string }>(sql`SELECT tablename AS name FROM pg_tables WHERE schemaname='public' AND tablename <> 'object_reclamations' ORDER BY tablename`);
  const names = tables.rows.map(row => row.name);
  await tx.execute(sql`LOCK TABLE ${sql.join(names.map(name => sql`${sql.identifier("public")}.${sql.identifier(name)}`), sql`, `)} IN SHARE MODE`);
  lockedTables.set(tx, names);
}
async function blockers(tx: Tx, owner: string, sha: string) {
  const reasons: string[] = [];
  const receipts=await tx.select().from(objectReclamations).where(and(eq(objectReclamations.ownerId,owner),eq(objectReclamations.sha256,sha),eq(objectReclamations.state,"published")));
  // A correct filename/checksum and absent metadata alone are NOT provenance.
  // At least one committed runtime publication must identify this same inode.
  const {canonical:publishedPath}=filenames(owner,sha);
  const present=await exists(publishedPath)?await identity(publishedPath):undefined;
  const receipt=receipts.find(row=>!present || (row.identity.dev===present.dev && row.identity.ino===present.ino && row.identity.modified===present.modified && row.bytes===present.size));
  if(!receipt)reasons.push("Unknown publication provenance/identity; uncertain bytes are retained, never certified as an orphan");
  else if(Date.now()-receipt.markedAt.getTime()<reclamationPolicy().unboundDays*DAY)reasons.push("Verified publication retention period has not elapsed");
  const started = Date.now();
  const tables = lockedTables.get(tx); if (!tables) throw new ArtifactObjectError("Graph locks not held; cleanup refused.", 503);
  for (const table of tables) {
    if (Date.now() - started > 10000) throw new ArtifactObjectError("Reference graph scan exceeded the safe inspection budget; retained. Retry off-peak.", 503);
    const found = await tx.execute(sql`SELECT 1 FROM ${sql.identifier("public")}.${sql.identifier(table)} r WHERE position(${sha} in to_jsonb(r)::text) > 0 LIMIT 1`);
    if (found.rows.length) reasons.push(`Retained reference in ${table}`);
  }
  // Missing descriptors/unknown historical ownership cannot establish absence.
  const uncertain = await tx.execute(sql`SELECT 1 FROM artifacts a WHERE a.owner_id=${owner} AND a.content_object IS NOT NULL AND (a.current_revision_id IS NULL OR NOT EXISTS (SELECT 1 FROM artifact_revisions r WHERE r.id=a.current_revision_id AND r.artifact_id=a.id AND r.snapshot->'contentObject'=a.content_object AND r.snapshot->>'body'=a.body)) UNION ALL SELECT 1 FROM artifact_revisions r LEFT JOIN artifacts a ON a.id=r.artifact_id WHERE (a.owner_id=${owner} OR r.snapshot->>'ownerId'=${owner}) AND (a.owner_id IS DISTINCT FROM ${owner} OR r.snapshot->>'ownerId' IS DISTINCT FROM ${owner} OR r.body_sha256 IS NULL) UNION ALL SELECT 1 FROM artifacts a WHERE a.owner_id=${owner} AND a.revision > (SELECT count(*) FROM artifact_revisions r WHERE r.artifact_id=a.id) UNION ALL SELECT 1 FROM artifact_revisions r LEFT JOIN artifacts a ON a.id=r.artifact_id WHERE a.owner_id IS DISTINCT FROM r.snapshot->>'ownerId' OR r.snapshot->>'ownerId' IS NULL LIMIT 1`);
  if (uncertain.rows.length) reasons.push("Unresolved current/history metadata; reconcile before cleanup");
  const pending = await tx.execute(sql`SELECT 1 FROM artifacts WHERE CASE WHEN source_type='arcade-generation' THEN coalesce(body::jsonb->>'state','unknown') ELSE 'completed' END NOT IN ('completed','cancelled') UNION ALL SELECT 1 FROM space_missions WHERE status NOT IN ('done','completed','cancelled') UNION ALL SELECT 1 FROM collaborations WHERE status <> 'closed' UNION ALL SELECT 1 FROM collaboration_relays WHERE status IN ('pending','dispatching','uncertain') LIMIT 1`);
  if (pending.rows.length) reasons.push("Pending/failed/uncertain work may need unbound bytes; resolve it before cleanup");
  const { canonical } = filenames(owner, sha);
  const siblings = await readdir(path.dirname(canonical));
  if (siblings.some(name => name.startsWith(`${sha}.bin.`) && name.endsWith(".partial"))) reasons.push("Incomplete publication exists; retained");
  return reasons;
}
async function record(tx: Tx, mark: Mark, state: string, reason: string, extra: Partial<Mark> = {}) {
  const [updated] = await tx.update(objectReclamations).set({ ...extra, state, reason, audit: [...mark.audit, { at: new Date().toISOString(), event: `${state}: ${reason}` }] }).where(eq(objectReclamations.id, mark.id)).returning(); return updated;
}
async function owned(tx: Tx, owner: string, id: string) {
  if (!isUuid(id)) throw new ArtifactObjectError("Valid cleanup operation ID required.", 400);
  const [mark] = await tx.select().from(objectReclamations).where(and(eq(objectReclamations.id, id), eq(objectReclamations.ownerId, owner))).for("update");
  if (!mark || mark.state === "published") throw new ArtifactObjectError("Cleanup operation unavailable.", 404); return mark;
}
export async function reportReclamation(owner: string, sha: string) {
  reclamationPolicy(); const { canonical } = filenames(owner, sha);
  return db.transaction(async tx => {
    await lock(tx); const info = await identity(canonical), reasons = await blockers(tx, owner, sha);
    await verify(canonical, { sha256: sha, bytes: info.size, identity: info });
    if (Date.now() - Number(info.modified) / 1e6 < reclamationPolicy().unboundDays * DAY) reasons.push("Unbound retention period has not elapsed");
    return { sha256: sha, bytes: info.size, identity: info, reasons, mayMark: reasons.length === 0, classification: reasons.some(reason=>/Unknown|Unresolved|Pending|Incomplete/.test(reason)) ? "uncertain" : reasons.length ? "retained" : "explicit-owner-abandonment-required", policy: reclamationPolicy(), dryRun: true, notice: "No storage or metadata changed. Mark additionally requires explicit abandonment of pending recovery." };
  });
}
export async function markReclamation(owner: string, sha: string, id: string, abandonRecovery: boolean) {
  const policy = reclamationPolicy(); if (!isUuid(id) || !abandonRecovery) throw new ArtifactObjectError("Stable operation UUID and explicit abandonment of recovery required.", 400);
  return db.transaction(async tx => {
    await lock(tx);
    const [existing] = await tx.select().from(objectReclamations).where(eq(objectReclamations.id, id));
    if (existing) { if (existing.state === "published") throw new ArtifactObjectError("Publication receipt IDs cannot be reused for cleanup.",409); if (existing.ownerId !== owner || existing.sha256 !== sha) throw new ArtifactObjectError("Cleanup identity conflict.", 409); return existing; }
    const { canonical } = filenames(owner, sha), info = await identity(canonical), reasons = await blockers(tx, owner, sha);
    await verify(canonical, { sha256: sha, bytes: info.size, identity: info });
    if (Date.now() - Number(info.modified) / 1e6 < policy.unboundDays * DAY) reasons.push("Unbound retention period has not elapsed");
    const now = new Date(), eligible = reasons.length === 0;
    const [mark] = await tx.insert(objectReclamations).values({ id, ownerId: owner, sha256: sha, bytes: info.size, identity: info, state: eligible ? "marked" : "refused", notBefore: new Date(now.getTime() + policy.graceDays * DAY), reason: eligible ? "Owner explicitly abandoned otherwise unreferenced recovery bytes" : reasons.join("; "), audit: [{ at: now.toISOString(), event: eligible ? "marked; owner abandoned recovery" : `refused: ${reasons.join("; ")}` }] }).returning(); return mark;
  });
}
export async function listReclamations(owner: string) { return db.select().from(objectReclamations).where(and(eq(objectReclamations.ownerId, owner),sql`${objectReclamations.state} <> 'published'`)).limit(100); }
async function restore(tx: Tx, mark: Mark, reason: string) {
  const files = filenames(mark.ownerId, mark.sha256, mark.id);
  if (await exists(files.quarantine)) {
    await verify(files.quarantine, mark, true);
    if (await exists(files.canonical)) throw new ArtifactObjectError("Both canonical and quarantine bytes exist; retain both for manual reconciliation.", 409);
    await replaceFile(files.quarantine, files.canonical);
  } else if (!await exists(files.canonical)) throw new ArtifactObjectError("Bytes already absent; restore the private volume from backup before retrying.", 410);
  else await verify(files.canonical, mark, true);
  return record(tx, mark, "restored", reason);
}
export async function restoreReclamation(owner: string, id: string) {
  return db.transaction(async tx => { await lock(tx); const mark = await owned(tx, owner, id); if (mark.state === "reclaimed") throw new ArtifactObjectError("Reclaimed bytes require backup recovery.", 410); return restore(tx, mark, "Owner restored retained bytes; cleanup cancelled"); });
}
export async function sweepReclamation(owner: string, id: string, execute = false, purge = false) {
  const policy = reclamationPolicy();
  if (!execute) return db.transaction(async tx => { await lock(tx); const mark = await owned(tx, owner, id); return { ...mark, dryRun: true, blockers: await blockers(tx, owner, mark.sha256), enabled: policy.enabled }; });
  if (!policy.enabled) throw new ArtifactObjectError("Irreversible cleanup disabled. Explicit operator opt-in ARENA_ENABLE_OBJECT_RECLAMATION=1 is required, in addition to per-request execution.", 403);
  // Durable intent commits BEFORE the separate filesystem operation. A crash
  // cannot erase the fact that quarantine/delete might have happened.
  await db.transaction(async tx => {
    await lock(tx); const mark = await owned(tx, owner, id);
    if (!["marked", "quarantined"].includes(mark.state)) return;
    const reasons = await blockers(tx, owner, mark.sha256), files = filenames(owner, mark.sha256, id);
    if (reasons.length) { if (mark.state === "quarantined") await restore(tx, mark, reasons.join("; ")); else await record(tx, mark, "refused", reasons.join("; ")); return; }
    if (mark.state === "marked") {
      if (Math.max(mark.notBefore.getTime(), mark.markedAt.getTime() + policy.graceDays * DAY) > Date.now()) throw new ArtifactObjectError("Mark grace period has not elapsed.", 409);
      try { await verify(files.canonical, mark); } catch (error) { await record(tx, mark, "refused", error instanceof ArtifactObjectError ? error.message : "Object unavailable or changed; retained pending reconciliation"); return; }
      await record(tx, mark, "quarantining", "Fresh graph/identity checks passed; moving bytes is recoverable");
    } else if (purge) {
      if (!mark.purgeAfter || !mark.quarantinedAt || Math.max(mark.purgeAfter.getTime(), mark.quarantinedAt.getTime() + policy.quarantineDays * DAY) > Date.now()) throw new ArtifactObjectError("Quarantine recovery period has not elapsed.", 409);
      await verify(files.quarantine, mark, true);
      await record(tx, mark, "purging", "Fresh graph/identity checks passed; physical deletion intent recorded");
    }
  });
  return db.transaction(async tx => {
    await lock(tx); const mark = await owned(tx, owner, id), files = filenames(owner, mark.sha256, id);
    if (!["quarantining", "purging"].includes(mark.state)) return mark;
    const reasons = await blockers(tx, owner, mark.sha256);
    if (reasons.length) return restore(tx, mark, reasons.join("; "));
    if (mark.state === "quarantining") {
      if (await exists(files.quarantine)) return restore(tx, mark, "Interrupted quarantine reconciled by restoring bytes, not deleting");
      if (Math.max(mark.notBefore.getTime(), mark.markedAt.getTime() + policy.graceDays * DAY) > Date.now()) throw new ArtifactObjectError("Current mark grace period has not elapsed.", 409);
      await verify(files.canonical, mark); await replaceFile(files.canonical, files.quarantine);
      return record(tx, mark, "quarantined", "Bytes retained through recovery grace; explicit later purge required", { quarantinedAt: new Date(), purgeAfter: new Date(Date.now() + policy.quarantineDays * DAY) });
    }
    if (!purge) return { ...mark, reason: "Deletion intent unresolved; explicit purge retry or restore required. This sweep did not remove bytes." };
    if (await exists(files.canonical)) return record(tx, mark, "refused", "Canonical bytes reappeared; manual reconciliation required");
    if (await exists(files.quarantine)) {
      if (!mark.quarantinedAt || !mark.purgeAfter || Math.max(mark.purgeAfter.getTime(), mark.quarantinedAt.getTime() + policy.quarantineDays * DAY) > Date.now()) throw new ArtifactObjectError("Current quarantine recovery period has not elapsed.", 409);
      await verify(files.quarantine, mark, true); await unlink(files.quarantine);
    }
    return record(tx, mark, "reclaimed", "Physical bytes absent after durable purge intent; completion reconciled safely");
  });
}

/** Inspect retained quarantine bytes during recovery grace, never a public key. */
export async function downloadReclamation(owner: string, id: string) {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    return await db.transaction(async tx => {
      await lock(tx); const mark = await owned(tx, owner, id), files = filenames(owner, mark.sha256, id);
      const filename = await exists(files.quarantine) ? files.quarantine : files.canonical;
      await verify(filename, mark, true);
      handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat({ bigint: true });
      if (String(info.ino) !== mark.identity.ino || String(info.dev) !== mark.identity.dev || Number(info.size) !== mark.bytes || info.mtimeNs.toString() !== mark.identity.modified) throw new ArtifactObjectError("Quarantine changed while opening; download refused.");
      // Hold the verified inode, not a lazy path re-open after the transaction:
      // an explicit concurrent purge cannot truncate an already-open download.
      return new Response(Readable.toWeb(handle.createReadStream()) as ReadableStream, { headers: { "content-type": "application/octet-stream", "content-length": String(mark.bytes), "content-disposition": `attachment; filename="retained-${id}.bin"`, "cache-control": "private, no-store" } });
    });
  } catch (error) { await handle?.close(); throw error; }
}
