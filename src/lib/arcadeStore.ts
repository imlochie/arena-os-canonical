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

import { and, desc, eq } from "drizzle-orm";

import type { db as appDb } from "@/db";
import { arcadeGames, artifacts } from "@/db/schema";

export type StoreDb = Pick<typeof appDb, "insert" | "update" | "delete" | "select">;

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
  projectId?: string | null;
  kind: string;
  title: string;
  body: string;
  sourceType: string;
  sourceId?: string | null;
  ownerId: string;
}

export async function insertArtifact(database: StoreDb, input: ArtifactInput) {
  const [row] = await database
    .insert(artifacts)
    .values({
      projectId: input.projectId ?? null,
      kind: input.kind,
      title: input.title,
      body: input.body,
      sourceType: input.sourceType,
      sourceId: input.sourceId ?? null,
      ownerId: input.ownerId,
    })
    .returning();
  return row;
}

/**
 * Artifact reads are owner-scoped, exactly like the mutations below. The
 * owner is part of the WHERE clause (never a post-fetch filter), so a
 * foreign row cannot be listed even if the caller guessed its id.
 */
export async function listArtifacts(database: StoreDb, ownerId: string, limit = 200) {
  return database
    .select()
    .from(artifacts)
    .where(eq(artifacts.ownerId, ownerId))
    .orderBy(desc(artifacts.createdAt))
    .limit(limit);
}

/** Returns the artifact only when it belongs to `ownerId`; null otherwise
 *  (so a route can answer 404 without leaking a foreign row's existence). */
export async function getArtifact(database: StoreDb, id: string, ownerId: string) {
  const [row] = await database
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.id, id), eq(artifacts.ownerId, ownerId)))
    .limit(1);
  return row ?? null;
}

export async function updateArtifact(
  database: StoreDb,
  id: string,
  ownerId: string,
  patch: Partial<Pick<typeof artifacts.$inferInsert, "title" | "body" | "kind" | "projectId">>,
): Promise<{ outcome: MutationOutcome; row?: typeof artifacts.$inferSelect }> {
  const [existing] = await database.select({ id: artifacts.id, ownerId: artifacts.ownerId }).from(artifacts).where(eq(artifacts.id, id)).limit(1);
  if (!existing) return { outcome: "not_found" };
  if (existing.ownerId !== ownerId) return { outcome: "forbidden" };
  const [row] = await database
    .update(artifacts)
    .set(patch)
    .where(and(eq(artifacts.id, id), eq(artifacts.ownerId, ownerId)))
    .returning();
  return { outcome: "ok", row };
}

export async function deleteArtifact(database: StoreDb, id: string, ownerId: string): Promise<MutationOutcome> {
  const [existing] = await database.select({ id: artifacts.id, ownerId: artifacts.ownerId }).from(artifacts).where(eq(artifacts.id, id)).limit(1);
  if (!existing) return "not_found";
  if (existing.ownerId !== ownerId) return "forbidden";
  await database.delete(artifacts).where(and(eq(artifacts.id, id), eq(artifacts.ownerId, ownerId)));
  return "ok";
}
