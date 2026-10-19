/**
 * Arcade + artifact store — ownership-scoped persistence.
 *
 * The security boundary for these tables lives HERE, not in scattered route
 * handlers: create records an owner, every mutating operation is scoped to
 * the caller's owner id in the SQL itself (`where id = ? and owner_id = ?`),
 * and reads are scoped the same way — an artifact is private working data
 * (briefs, research, prompts), so listing it or opening it by id must not
 * cross the owner boundary. The `db` parameter is injected so the same code
 * is exercised against a real database in tests.
 */

import { and, desc, eq, isNull, lt } from "drizzle-orm";

import type { db as appDb } from "@/db";
import { arcadeGames, artifacts, artifactRevisions, type ArtifactRevisionSnapshot } from "@/db/schema";

export type StoreDb = Pick<typeof appDb, "insert" | "update" | "delete" | "select" | "transaction">;

export type MutationOutcome = "ok" | "not_found" | "forbidden";

export interface ArcadeGameInput {
  prompt: string;
  gameType: string;
  engine: string;
  code: string;
  parentId?: string | null;
  projectId?: string | null;
  ownerId: string;
}

export async function insertArcadeGame(database: StoreDb, input: ArcadeGameInput) {
  const [row] = await database
    .insert(arcadeGames)
    .values({
      prompt: input.prompt,
      gameType: input.gameType,
      engine: input.engine,
      code: input.code,
      parentId: input.parentId ?? null,
      projectId: input.projectId ?? null,
      ownerId: input.ownerId,
    })
    .returning();
  return row;
}

/**
 * Delete a game only when it belongs to `ownerId`.
 * "not_found" and "forbidden" stay distinguishable for callers that want to
 * answer 404 vs 403 honestly.
 */
export async function deleteArcadeGame(database: StoreDb, id: string, ownerId: string): Promise<MutationOutcome> {
  const [existing] = await database.select({ id: arcadeGames.id, ownerId: arcadeGames.ownerId }).from(arcadeGames).where(eq(arcadeGames.id, id)).limit(1);
  if (!existing) return "not_found";
  if (existing.ownerId !== ownerId) return "forbidden";
  await database.delete(arcadeGames).where(and(eq(arcadeGames.id, id), eq(arcadeGames.ownerId, ownerId)));
  return "ok";
}

export interface ArtifactInput {
  /** Server-supplied stable identity for idempotent mission output capture. */
  id?: string;
  projectId?: string | null;
  kind: string;
  title: string;
  body: string;
  sourceType: string;
  sourceId?: string | null;
  ownerId: string;
}

type ArtifactRow = typeof artifacts.$inferSelect;
function revisionSnapshot(row: ArtifactRow): ArtifactRevisionSnapshot {
  return { title: row.title, body: row.body, kind: row.kind, projectId: row.projectId, sourceType: row.sourceType, sourceId: row.sourceId, ownerId: row.ownerId, deletedAt: row.deletedAt?.toISOString() ?? null, createdAt: row.createdAt?.toISOString() ?? null };
}
type Transaction = Parameters<Parameters<StoreDb["transaction"]>[0]>[0];
async function baseline(tx: Transaction, row: ArtifactRow) {
  if (row.currentRevisionId) return row;
  const [revision] = await tx.insert(artifactRevisions).values({ artifactId: row.id, revision: row.revision, snapshot: revisionSnapshot(row) }).onConflictDoNothing().returning();
  const existing = revision ?? (await tx.select().from(artifactRevisions).where(and(eq(artifactRevisions.artifactId, row.id), eq(artifactRevisions.revision, row.revision))).limit(1))[0];
  const [updated] = await tx.update(artifacts).set({ currentRevisionId: existing.id }).where(eq(artifacts.id, row.id)).returning();
  return updated;
}
export async function insertArtifact(database: StoreDb, input: ArtifactInput) {
  if (input.body.length > 20000) throw new Error("Artifact body exceeds the 20,000-character limit; nothing was saved.");
  return database.transaction(async (tx) => {
    const [inserted] = await tx.insert(artifacts).values({ ...input, projectId: input.projectId ?? null, sourceId: input.sourceId ?? null }).onConflictDoNothing({ target: artifacts.id }).returning();
    const row = inserted ?? (input.id ? (await tx.select().from(artifacts).where(and(eq(artifacts.id, input.id), eq(artifacts.ownerId, input.ownerId))).limit(1))[0] : undefined);
    if (!row || row.sourceId !== (input.sourceId ?? null)) throw new Error("Artifact identity conflict; no existing content was overwritten.");
    return baseline(tx, row);
  });
}
export async function listArtifacts(database: StoreDb, ownerId: string, limit = 200, trash = false) {
  return database.select().from(artifacts).where(and(eq(artifacts.ownerId, ownerId), ...(trash ? [] : [isNull(artifacts.deletedAt)]))).orderBy(desc(artifacts.createdAt)).limit(limit);
}
export async function getArtifact(database: StoreDb, id: string, ownerId: string, includeDeleted = false) {
  const [row] = await database.select().from(artifacts).where(and(eq(artifacts.id, id), eq(artifacts.ownerId, ownerId), ...(includeDeleted ? [] : [isNull(artifacts.deletedAt)]))).limit(1);
  return row ?? null;
}
export async function listArtifactRevisions(database: StoreDb, id: string, ownerId: string, before?: number) {
  return database.transaction(async (tx) => {
    const [row] = await tx.select().from(artifacts).where(and(eq(artifacts.id, id), eq(artifacts.ownerId, ownerId))).for("update");
    if (!row) return null;
    await baseline(tx, row);
    return tx.select().from(artifactRevisions).where(and(eq(artifactRevisions.artifactId, id), ...(before ? [lt(artifactRevisions.revision, before)] : []))).orderBy(desc(artifactRevisions.revision)).limit(50);
  });
}
export async function getArtifactRevision(database: StoreDb, id: string, revisionId: string, ownerId: string) {
  const row = await getArtifact(database, id, ownerId, true); if (!row) return null;
  const [revision] = await database.select().from(artifactRevisions).where(and(eq(artifactRevisions.artifactId, id), eq(artifactRevisions.id, revisionId))).limit(1);
  return revision ?? null;
}
async function revise(database: StoreDb, id: string, ownerId: string, patch: Partial<Pick<ArtifactRow, "title" | "body" | "kind" | "projectId" | "deletedAt">>, expectedRevision?: number, restoreId?: string): Promise<{ outcome: MutationOutcome | "conflict"; row?: ArtifactRow }> {
  if (patch.body && patch.body.length > 20000) throw new Error("Artifact body exceeds the 20,000-character limit; nothing was saved.");
  return database.transaction(async (tx) => {
    const [found] = await tx.select().from(artifacts).where(eq(artifacts.id, id)).for("update");
    if (!found || (found.deletedAt && !restoreId)) return { outcome: "not_found" };
    if (found.ownerId !== ownerId) return { outcome: "forbidden" };
    if (expectedRevision !== undefined && found.revision !== expectedRevision) return { outcome: "conflict", row: found };
    const current = await baseline(tx, found);
    let proposed = { ...current, ...patch };
    if (restoreId) {
      const [old] = await tx.select().from(artifactRevisions).where(and(eq(artifactRevisions.id, restoreId), eq(artifactRevisions.artifactId, id))).limit(1);
      if (!old) return { outcome: "not_found" };
      // Provenance and owner remain bound; restoring never creates foreign ownership.
      proposed = { ...current, title: old.snapshot.title, body: old.snapshot.body, kind: old.snapshot.kind, projectId: old.snapshot.projectId, deletedAt: null };
    }
    if (!restoreId && JSON.stringify(revisionSnapshot(current)) === JSON.stringify(revisionSnapshot(proposed))) return { outcome: "ok", row: current };
    const next = current.revision + 1;
    const [revision] = await tx.insert(artifactRevisions).values({ artifactId: id, revision: next, snapshot: revisionSnapshot(proposed), restoredFromRevisionId: restoreId ?? null }).returning();
    const [row] = await tx.update(artifacts).set({ title: proposed.title, body: proposed.body, kind: proposed.kind, projectId: proposed.projectId, deletedAt: proposed.deletedAt, revision: next, currentRevisionId: revision.id }).where(and(eq(artifacts.id, id), eq(artifacts.ownerId, ownerId))).returning();
    return { outcome: "ok", row };
  });
}
export async function updateArtifact(database: StoreDb, id: string, ownerId: string, patch: Partial<Pick<ArtifactRow, "title" | "body" | "kind" | "projectId">>, expectedRevision?: number) { return revise(database, id, ownerId, patch, expectedRevision); }
export async function restoreArtifact(database: StoreDb, id: string, ownerId: string, revisionId: string, expectedRevision: number) { return revise(database, id, ownerId, {}, expectedRevision, revisionId); }
export async function deleteArtifact(database: StoreDb, id: string, ownerId: string): Promise<MutationOutcome> {
  const result = await revise(database, id, ownerId, { deletedAt: new Date() });
  return result.outcome === "conflict" ? "not_found" : result.outcome;
}
