/**
 * Provider sync — the merged Archive Assistant's refresh lifecycle.
 *
 * Every sync is an honest refresh row: status, completeness, item count,
 * reason. Authority stays pinned to the last COMPLETE snapshot (a failed or
 * partial attempt never demotes what the provider last fully reported).
 * Library items are upserted by (provider, ratingKey) with first/last-seen
 * refresh lineage, so a partial refresh only updates the libraries that
 * actually answered.
 */

import { and, desc, eq } from "drizzle-orm";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { db } from "@/db";
import { mediaLibraryItems, mediaProviders, mediaRefreshes } from "@/db/schema";
import { openSecret, sealSecret } from "../secretBox";
import { fetchJellyfinItems, fetchJellyfinUserViews, resolveJellyfinUserId } from "./jellyfin";
import { fetchPlexLibraries, fetchPlexLibraryItems } from "./plex";
import {
  MediaProviderError,
  isMediaProviderKind,
  type MediaProviderKind,
  type NormalizedMediaItem,
} from "./types";

export type MediaProviderPublic = {
  id: string;
  kind: MediaProviderKind;
  name: string;
  baseUrl: string;
  username: string;
  createdAt: string;
  lastSyncAt: string | null;
  lastError: string | null;
};

export type SyncOutcome = {
  refreshId: string;
  provider: MediaProviderKind;
  status: "synced" | "sync_error";
  snapshotCompleteness: "complete" | "partial" | "unknown";
  itemCount: number;
  libraries: number;
  failedLibraries: { library: string; reason: string }[];
  reason: string | null;
};

function toPublic(row: typeof mediaProviders.$inferSelect): MediaProviderPublic {
  return {
    id: row.id,
    kind: (isMediaProviderKind(row.kind) ? row.kind : "plex"),
    name: row.name,
    baseUrl: row.baseUrl,
    username: row.username,
    createdAt: row.createdAt.toISOString(),
    lastSyncAt: row.lastSyncAt ? row.lastSyncAt.toISOString() : null,
    lastError: row.lastError,
  };
}

export async function listMediaProviders(): Promise<MediaProviderPublic[]> {
  const rows = await db.select().from(mediaProviders).orderBy(mediaProviders.kind);
  return rows.map(toPublic);
}

export async function saveMediaProvider(input: {
  kind: MediaProviderKind;
  name?: string;
  baseUrl: string;
  token: string;
  username?: string;
}): Promise<MediaProviderPublic> {
  if (input.kind === "local") {
    // The local library's "server" is a folder on this machine — no URL,
    // no token; the folder just has to exist.
    const root = input.baseUrl.trim();
    if (!root || !isAbsolute(root)) {
      throw new MediaProviderError("bad_response", "baseUrl must be an absolute folder path for a local library.");
    }
    const info = await stat(root).catch(() => null);
    if (!info || !info.isDirectory()) throw new MediaProviderError("connect_failed", `Folder not found: ${root}`);
  }
  const baseUrl = input.kind === "local" ? input.baseUrl.trim() : input.baseUrl.trim().replace(/\/+$/, "");
  if (input.kind !== "local") {
    if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) {
      throw new MediaProviderError("bad_response", "baseUrl must be an http(s) URL.");
    }
    if (!input.token.trim()) throw new MediaProviderError("not_configured", "token is required.");
  }
  const sealed = sealSecret(input.kind === "local" ? "local" : input.token.trim());
  const existing = await db.select().from(mediaProviders).where(eq(mediaProviders.kind, input.kind)).limit(1);
  const values = {
    name: (input.name ?? "").trim(),
    baseUrl,
    tokenSealed: sealed,
    username: (input.username ?? "").trim(),
    updatedAt: new Date(),
    lastError: null,
  };
  if (existing.length) {
    const [row] = await db.update(mediaProviders).set(values).where(eq(mediaProviders.id, existing[0].id)).returning();
    return toPublic(row);
  }
  const [row] = await db
    .insert(mediaProviders)
    .values({ kind: input.kind, ...values })
    .returning();
  return toPublic(row);
}

export async function deleteMediaProvider(kind: MediaProviderKind): Promise<boolean> {
  const rows = await db.delete(mediaProviders).where(eq(mediaProviders.kind, kind)).returning();
  return rows.length > 0;
}

/** Connection test: list libraries only — no refresh row, no item writes. */
export async function testMediaProviderConnection(input: {
  kind: MediaProviderKind;
  baseUrl: string;
  token: string;
  username?: string;
}): Promise<{ ok: true; libraries: string[] } | { ok: false; code: string; detail: string }> {
  try {
    if (input.kind === "local") {
      const { testLocalLibraryRoot } = await import("./local");
      return await testLocalLibraryRoot(input.baseUrl.trim());
    }
    const base = input.baseUrl.trim().replace(/\/+$/, "");
    if (input.kind === "plex") {
      const libraries = await fetchPlexLibraries(base, input.token.trim());
      return { ok: true, libraries: libraries.map((l) => `${l.title} (${l.key})`) };
    }
    const userId = input.username?.trim() || (await resolveJellyfinUserId(base, input.token.trim()));
    const views = await fetchJellyfinUserViews(base, input.token.trim(), userId);
    return { ok: true, libraries: views.map((v) => v.title) };
  } catch (error) {
    return {
      ok: false,
      code: error instanceof MediaProviderError ? error.code : "connect_failed",
      detail: String((error as Error)?.message ?? error),
    };
  }
}

async function getProviderRow(kind: MediaProviderKind): Promise<typeof mediaProviders.$inferSelect> {
  const rows = await db.select().from(mediaProviders).where(eq(mediaProviders.kind, kind)).limit(1);
  if (!rows.length) throw new MediaProviderError("not_configured", `No ${kind} provider is configured.`);
  return rows[0];
}

/** The current authoritative refresh = the latest complete synced snapshot. */
export async function latestAuthoritativeRefresh(
  kind: MediaProviderKind,
): Promise<typeof mediaRefreshes.$inferSelect | null> {
  const rows = await db
    .select()
    .from(mediaRefreshes)
    .where(and(eq(mediaRefreshes.providerKind, kind), eq(mediaRefreshes.status, "synced"), eq(mediaRefreshes.snapshotCompleteness, "complete")))
    .orderBy(desc(mediaRefreshes.startedAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function runProviderSync(
  kind: MediaProviderKind,
  options: { timeoutMs?: number } = {},
): Promise<SyncOutcome> {
  const provider = await getProviderRow(kind);
  const token = openSecret(provider.tokenSealed);
  const base = provider.baseUrl.replace(/\/+$/, "");

  const [refresh] = await db
    .insert(mediaRefreshes)
    .values({ providerKind: kind, status: "syncing", snapshotCompleteness: "unknown" })
    .returning();

  const failedLibraries: { library: string; reason: string }[] = [];
  const libraries: { key: string; title: string }[] = [];
  const items: NormalizedMediaItem[] = [];

  try {
    if (kind === "local") {
      // The local library: scan the folder with the real ffprobe — no
      // third-party server involved at any point.
      const { scanLocalLibrary } = await import("./local");
      const scan = await scanLocalLibrary(provider.baseUrl);
      const topFolders = new Set(scan.items.map((item) => item.libraryName));
      for (const folder of topFolders) libraries.push({ key: folder, title: folder });
      items.push(...scan.items);
      for (const skip of scan.skipped) {
        failedLibraries.push({ library: skip.file, reason: `ffprobe could not read it: ${skip.reason}` });
      }
    } else if (kind === "plex") {
      libraries.push(...(await fetchPlexLibraries(base, token)));
      for (const library of libraries) {
        try {
          const libraryItems = await fetchPlexLibraryItems(base, token, library.key);
          for (const item of libraryItems) if (!item.libraryName) item.libraryName = library.title;
          items.push(...libraryItems);
        } catch (error) {
          failedLibraries.push({ library: library.title, reason: String((error as Error)?.message ?? error) });
        }
      }
    } else {
      const userId = provider.username || (await resolveJellyfinUserId(base, token));
      const views = await fetchJellyfinUserViews(base, token, userId);
      libraries.push(...views);
      for (const view of views) {
        try {
          const viewItems = await fetchJellyfinItems(base, token, userId, view.key);
          for (const item of viewItems) if (!item.libraryName) item.libraryName = view.title;
          items.push(...viewItems);
        } catch (error) {
          failedLibraries.push({ library: view.title, reason: String((error as Error)?.message ?? error) });
        }
      }
    }
  } catch (error) {
    // Whole-provider failure: nothing was learned; authority stays with the
    // previous complete snapshot (if any).
    const reason = String((error as Error)?.message ?? error);
    await db
      .update(mediaRefreshes)
      .set({
        status: "sync_error",
        snapshotCompleteness: "unknown",
        reason: reason.slice(0, 400),
        completedAt: new Date(),
      })
      .where(eq(mediaRefreshes.id, refresh.id));
    await db
      .update(mediaProviders)
      .set({ lastError: reason.slice(0, 400), updatedAt: new Date() })
      .where(eq(mediaProviders.id, provider.id));
    return {
      refreshId: String(refresh.refreshId),
      provider: kind,
      status: "sync_error",
      snapshotCompleteness: "unknown",
      itemCount: 0,
      libraries: libraries.length,
      failedLibraries: [{ library: "(provider)", reason }],
      reason: reason.slice(0, 200),
    };
  }

  // Upsert items (only the libraries that answered).
  for (const item of items) {
    await db
      .insert(mediaLibraryItems)
      .values({
        providerKind: kind,
        ratingKey: item.ratingKey,
        libraryName: item.libraryName,
        title: item.title,
        year: item.year,
        itemType: item.itemType,
        viewCount: item.viewCount,
        viewOffsetMs: item.viewOffsetMs,
        durationMs: item.durationMs,
        lastViewedAt: item.lastViewedAt,
        raw: item.raw,
        firstSeenRefreshId: refresh.refreshId,
        lastSeenRefreshId: refresh.refreshId,
      })
      .onConflictDoUpdate({
        target: [mediaLibraryItems.providerKind, mediaLibraryItems.ratingKey],
        set: {
          libraryName: item.libraryName,
          title: item.title,
          year: item.year,
          itemType: item.itemType,
          viewCount: item.viewCount,
          viewOffsetMs: item.viewOffsetMs,
          durationMs: item.durationMs,
          lastViewedAt: item.lastViewedAt,
          raw: item.raw,
          lastSeenRefreshId: refresh.refreshId,
          updatedAt: new Date(),
        },
      });
  }

  const allLibrariesFailed = libraries.length > 0 && failedLibraries.length === libraries.length;
  const status: SyncOutcome["status"] = allLibrariesFailed ? "sync_error" : "synced";
  const completeness: SyncOutcome["snapshotCompleteness"] =
    status === "sync_error" ? "unknown" : failedLibraries.length > 0 ? "partial" : "complete";
  const reason = failedLibraries.length
    ? `failed libraries: ${failedLibraries.map((f) => f.library).join(", ")}`.slice(0, 400)
    : null;

  await db
    .update(mediaRefreshes)
    .set({
      status,
      snapshotCompleteness: completeness,
      itemCount: items.length,
      reason,
      snapshotReference: `${kind}-${refresh.id}`,
      completedAt: new Date(),
    })
    .where(eq(mediaRefreshes.id, refresh.id));
  await db
    .update(mediaProviders)
    .set({
      lastSyncAt: new Date(),
      lastError: status === "sync_error" ? (reason ?? "sync failed") : null,
      updatedAt: new Date(),
    })
    .where(eq(mediaProviders.id, provider.id));

  return {
    refreshId: String(refresh.refreshId),
    provider: kind,
    status,
    snapshotCompleteness: completeness,
    itemCount: items.length,
    libraries: libraries.length,
    failedLibraries,
    reason,
  };
}
