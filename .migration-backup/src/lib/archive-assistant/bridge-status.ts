/**
 * Server-side live status probe for the Archive Assistant room.
 *
 * NATIVE since the Archive Assistant merge: there is no external app to
 * reach any more. The rooms map stays static; this helper answers the only
 * question that changes at runtime — what does the merged, in-process
 * Archive Assistant currently look like? One bounded read per provider row
 * plus open-review counts; no writes, ever.
 *
 * Outcomes:
 *   no_providers     no media provider is configured yet (fresh install)
 *   syncing          a provider refresh is currently running
 *   ready            providers configured; counts + last sync reported
 *   degraded         providers exist but the last sync errored / never ran
 */

import { db } from "@/db";
import { archiveReviewItems, mediaRefreshes } from "@/db/schema";
import { desc, eq } from "drizzle-orm";
import { listMediaProviders } from "../mediaArchive/sync";

export type ArchiveBridgeStatus =
  | { state: "no_providers" }
  | { state: "syncing"; providers: number }
  | {
      state: "ready" | "degraded";
      providers: number;
      attentionCount: number;
      scanStatus: string;
      lastSync: string | null;
      lastErrors: string[];
      informational: string[];
    };

export async function getArchiveBridgeStatus(): Promise<ArchiveBridgeStatus> {
  try {
    const providers = await listMediaProviders();
    if (providers.length === 0) return { state: "no_providers" };

    const latestRefresh = await db
      .select()
      .from(mediaRefreshes)
      .orderBy(desc(mediaRefreshes.startedAt))
      .limit(1);
    if (latestRefresh[0]?.status === "syncing") {
      return { state: "syncing", providers: providers.length };
    }

    const open = await db
      .select()
      .from(archiveReviewItems)
      .where(eq(archiveReviewItems.state, "needs_you"));

    const lastErrors = providers.map((p) => p.lastError).filter((e): e is string => Boolean(e));
    const lastSync = providers
      .map((p) => p.lastSyncAt)
      .filter((d): d is string => Boolean(d))
      .sort()
      .at(-1) ?? null;

    const informational: string[] = [];
    for (const provider of providers) {
      informational.push(
        `${provider.kind} connected (${provider.baseUrl})${provider.lastSyncAt ? `, last sync ${provider.lastSyncAt}` : ", never synced"}.`,
      );
    }

    return {
      state: lastErrors.length > 0 || !lastSync ? "degraded" : "ready",
      providers: providers.length,
      attentionCount: open.length,
      scanStatus: "idle",
      lastSync,
      lastErrors,
      informational,
    };
  } catch (error) {
    return {
      state: "degraded",
      providers: 0,
      attentionCount: 0,
      scanStatus: "unavailable",
      lastSync: null,
      lastErrors: [String((error as Error)?.message ?? error).slice(0, 160)],
      informational: [],
    };
  }
}
