import { eq } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/node-postgres";

import { db } from "@workspace/db";
import { sourceAssets } from "@workspace/db/waveyardSchema";
import { getStorage, type StorageProvider } from "@workspace/arena/lib/waveyard/storage";

export const ORPHAN_SOURCE_GRACE_PERIOD_MS = 24 * 60 * 60 * 1000;
const GENERATED_SOURCE_KEY =
  /^projects\/[^/]+\/source\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[a-z0-9]+$/i;

/**
 * Delete only old source objects in the generated key format that have no
 * canonical source row. Tracks and all other Waveyard records are untouched.
 */
export async function cleanupOrphanedSourceObjects(
  dependencies: {
    db?: ReturnType<typeof drizzle>;
    storage?: StorageProvider;
    now?: Date;
    gracePeriodMs?: number;
  } = {},
): Promise<string[]> {
  const database = dependencies.db ?? db;
  const storage = dependencies.storage ?? getStorage();
  const now = dependencies.now ?? new Date();
  const gracePeriodMs = dependencies.gracePeriodMs ?? ORPHAN_SOURCE_GRACE_PERIOD_MS;
  if (!Number.isFinite(now.getTime()) || !Number.isSafeInteger(gracePeriodMs) || gracePeriodMs < 1) {
    throw new Error("A valid cleanup time and positive grace period are required.");
  }

  const cutoff = now.getTime() - gracePeriodMs;
  const [objects, assets] = await Promise.all([
    storage.listObjects("projects"),
    database.select({ storageKey: sourceAssets.storageKey }).from(sourceAssets),
  ]);
  const referencedKeys = new Set(assets.map((asset) => asset.storageKey));
  const removed: string[] = [];
  for (const object of objects) {
    if (
      !GENERATED_SOURCE_KEY.test(object.key) ||
      !Number.isFinite(object.lastModified.getTime()) ||
      object.lastModified.getTime() > cutoff ||
      referencedKeys.has(object.key)
    ) {
      continue;
    }
    await storage.delete(object.key);
    removed.push(object.key);
  }
  return removed;
}
