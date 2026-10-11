/**
 * The native Archive Context client — the merged Archive Assistant's read
 * surface, served from Arena's own database.
 *
 * Same interface as the old HTTP bridge (`ArchiveContextClient`), same
 * generated contract types, and the SAME runtime validation: every response
 * is checked against the generated OpenAPI subset before it may influence
 * reasoning. A native bug fails closed with a contract violation, exactly
 * like an upstream drift used to.
 *
 * Honesty rules baked in:
 *  - acquisitionJobs is always 0 (that subsystem is not merged);
 *  - discovery sections are not_available with a reason (endpoints not
 *    merged) — never fabricated;
 *  - provider absence reads as never_attempted, not "empty library";
 *  - watch state only appears when a provider actually reported it.
 */

import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  archiveObservations,
  archiveReviewItems,
  mediaLibraryItems,
  mediaRefreshes,
} from "@/db/schema";
import type {
  ArchiveContextClient,
  ArchiveProvider,
} from "../archive-assistant/types";
import type {
  AssistantOverview,
  AssistantRecommendation,
  AssistantWorkload,
  AssistantWorkloadItem,
  ProviderRefresh,
  ProviderRefreshHistory,
  ProviderRefreshState,
  ReconciliationFindingLineage,
  ReconciliationSummary,
} from "../archive-assistant/generated/types";
import { validateContract } from "../archive-assistant/validate";
import { ArchiveAssistantContractError, ArchiveAssistantNotFoundError } from "../archive-assistant/errors";
import { latestReconciliationSummary } from "./reconcile";
import { listMediaProviders } from "./sync";

type RefreshRow = typeof mediaRefreshes.$inferSelect;
type ReviewRow = typeof archiveReviewItems.$inferSelect;
type LibraryRow = typeof mediaLibraryItems.$inferSelect;

const KIND_PRIORITY: Record<string, "critical" | "high" | "medium" | "low" | "info"> = {
  download: "high",
  identity: "high",
  duplicate: "medium",
  quality: "low",
  rename: "low",
};

function toProviderRefresh(row: RefreshRow, authorityId: number | null, provider: ArchiveProvider): ProviderRefresh {
  return {
    refreshId: String(row.refreshId),
    provider,
    startedAt: row.startedAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    status: row.status === "synced" || row.status === "sync_error" ? row.status : "syncing",
    snapshotCompleteness:
      row.snapshotCompleteness === "complete" || row.snapshotCompleteness === "partial" ? row.snapshotCompleteness : "unknown",
    itemCount: row.itemCount,
    authoritative: authorityId !== null && row.id === authorityId,
    reason: row.reason,
    snapshotReference: row.snapshotReference,
  };
}

async function refreshRows(provider: ArchiveProvider): Promise<RefreshRow[]> {
  return db
    .select()
    .from(mediaRefreshes)
    .where(eq(mediaRefreshes.providerKind, provider))
    .orderBy(desc(mediaRefreshes.startedAt), desc(mediaRefreshes.id));
}

function freshnessFrom(date: Date | null | undefined): "fresh" | "recent" | "stale" | "unknown" {
  if (!date) return "unknown";
  const age = Date.now() - date.getTime();
  if (age < 7 * 86_400_000) return "fresh";
  if (age < 30 * 86_400_000) return "recent";
  return "stale";
}

function recommendationFrom(row: ReviewRow): AssistantRecommendation {
  return {
    id: `review-${row.id}`,
    type: (row.kind === "download" || row.kind === "duplicate" || row.kind === "identity" || row.kind === "quality" || row.kind === "rename"
      ? row.kind
      : "identity") as AssistantRecommendation["type"],
    priority: KIND_PRIORITY[row.kind] ?? "medium",
    confidence: "provider-reconciled",
    title: row.title,
    explanation:
      (row.payload && typeof row.payload === "object" && "summary" in row.payload
        ? String((row.payload as { summary?: unknown }).summary ?? "")
        : "") || row.title,
    evidence: Array.isArray(row.evidence) ? row.evidence.filter((e): e is string => typeof e === "string") : [],
    recommendedAction:
      row.kind === "download"
        ? "Confirm whether the media should exist locally (acquisition is not merged — nothing downloads)."
        : row.kind === "duplicate"
          ? "Confirm which copy is the keeper; Arena does not delete or move files."
          : "Review the finding and approve or dismiss it.",
    state: row.state,
    reviewItemId: row.id,
    personalContext: null,
    personalAffinity: null,
  };
}

async function buildOverview(): Promise<AssistantOverview> {
  const [reviews, providers, recency] = await Promise.all([
    db.select().from(archiveReviewItems),
    listMediaProviders(),
    db.select().from(mediaRefreshes).orderBy(desc(mediaRefreshes.startedAt)).limit(1),
  ]);
  const open = reviews.filter((r) => r.state === "needs_you" || r.state === "uncertain");
  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const row of open) counts[KIND_PRIORITY[row.kind] ?? "medium"] += 1;
  const anyHigh = counts.critical + counts.high > 0;

  const lastScan = providers
    .map((p) => p.lastSyncAt)
    .filter((d): d is string => Boolean(d))
    .sort()
    .at(-1);
  const syncing = recency[0]?.status === "syncing";

  const watched = await db
    .select()
    .from(mediaLibraryItems)
    .where(eq(mediaLibraryItems.itemType, "movie"))
    .orderBy(desc(mediaLibraryItems.lastViewedAt))
    .limit(200);
  const completedItems = watched.filter((w) => w.viewCount > 0);
  const inProgressItems = await db
    .select()
    .from(mediaLibraryItems)
    .where(and(eq(mediaLibraryItems.itemType, "movie")))
    .limit(500)
    .then((rows) => rows.filter((r) => r.viewCount === 0 && r.viewOffsetMs > 0));

  const toExperience = (row: LibraryRow) => ({
    key: `${row.providerKind}:${row.ratingKey}`,
    provider: (row.providerKind === "jellyfin" ? "jellyfin" : "plex") as "plex" | "jellyfin",
    title: row.title,
    itemType: (row.itemType === "movie" || row.itemType === "show" || row.itemType === "episode"
      ? row.itemType
      : "unknown") as "movie" | "show" | "episode" | "unknown",
    year: row.year,
    releaseDate: null,
    durationMinutes: row.durationMs ? Math.round(row.durationMs / 60_000) : null,
    status: (row.viewCount > 0 ? "completed" : row.viewOffsetMs > 0 ? "in_progress" : "unwatched") as
      | "completed"
      | "in_progress"
      | "unwatched"
      | "unknown",
    progressPercent: row.viewOffsetMs > 0 && row.durationMs ? Math.min(100, Math.round((row.viewOffsetMs / row.durationMs) * 100)) : null,
    playCount: row.viewCount,
    lastWatchedAt: row.lastViewedAt ? row.lastViewedAt.toISOString() : null,
    watchedMinutes: row.viewCount > 0 && row.durationMs ? Math.round(row.durationMs / 60_000) : 0,
    seriesTitle: null,
    seasonNumber: null,
    episodeNumber: null,
    seriesProgress: null,
    isNextEpisode: false,
    evidence: [`${row.providerKind} library "${row.libraryName}"`],
  });

  const thirtyDaysAgo = Date.now() - 30 * 86_400_000;
  const recentlyWatched = completedItems.filter((c) => c.lastViewedAt && c.lastViewedAt.getTime() > thirtyDaysAgo);
  const activeShows = await db
    .select()
    .from(mediaLibraryItems)
    .where(eq(mediaLibraryItems.itemType, "show"))
    .limit(2000)
    .then((rows) => rows.filter((r) => r.lastViewedAt && r.lastViewedAt.getTime() > thirtyDaysAgo));

  const watchedMinutes = completedItems.reduce(
    (total, row) => total + (row.durationMs ? Math.round(row.durationMs / 60_000) : 0),
    0,
  );

  const informational: string[] = [];
  for (const provider of providers) {
    informational.push(
      `${provider.kind} connected (${provider.baseUrl})${provider.lastSyncAt ? `, last sync ${provider.lastSyncAt}` : ", never synced"}.`,
    );
  }
  const { everRun } = await latestReconciliationSummary();
  if (!everRun) informational.push("Reconciliation has never been run — run it from the Archive Assistant room.");

  const overview: AssistantOverview = {
    summary: {
      health: open.length === 0 ? "healthy" : anyHigh ? "attention_required" : "mostly_healthy",
      attentionCount: open.length,
      counts,
      blockedCount: 0,
      uncertainCount: reviews.filter((r) => r.state === "uncertain").length,
      lastScan: lastScan ?? null,
      freshness: freshnessFrom(lastScan ? new Date(lastScan) : null),
    },
    attention: open
      .filter((r) => (KIND_PRIORITY[r.kind] ?? "medium") === "high" || (KIND_PRIORITY[r.kind] ?? "medium") === "critical")
      .map(recommendationFrom),
    recommendations: open
      .filter((r) => !["high", "critical"].includes(KIND_PRIORITY[r.kind] ?? "medium"))
      .map(recommendationFrom),
    groups: [],
    blocked: [],
    uncertain: reviews.filter((r) => r.state === "uncertain").map(recommendationFrom),
    informational,
    activeWork: {
      scanStatus: syncing ? "syncing" : "idle",
      acquisitionJobs: 0, // honest: the acquisition subsystem is not merged
    },
    mediaExperience: {
      sourceStatus: providers.some((p) => p.lastSyncAt) ? "provider_metadata" : "no_synced_provider_data",
      items: watched.slice(0, 100).map(toExperience),
      completed: completedItems.slice(0, 50).map(toExperience),
      inProgress: inProgressItems.slice(0, 50).map(toExperience),
      summary: {
        completedCount: completedItems.length,
        inProgressCount: inProgressItems.length,
        watchedMinutes,
        watchedHours: Math.round((watchedMinutes / 60) * 10) / 10,
      },
      currentViewingMomentum: {
        activeSeriesCount: activeShows.length,
        recentlyWatchedCount: recentlyWatched.length,
        windowDays: 30,
      },
      watchlist: { status: "not_available", items: [] },
    },
    discovery: {
      upcoming: { status: "not_available", reason: "provider discovery endpoints are not merged yet", items: [] },
      recentlyReleased: { status: "not_available", reason: "provider discovery endpoints are not merged yet", items: [] },
      trending: { status: "not_available", reason: "provider discovery endpoints are not merged yet", items: [] },
      suggestedForYou: { status: "not_available", reason: "provider discovery endpoints are not merged yet", items: [] },
    },
    personalizedBriefing: [],
  };
  return overview;
}

async function buildWorkload(): Promise<AssistantWorkload> {
  const reviews = await db.select().from(archiveReviewItems).orderBy(desc(archiveReviewItems.updatedAt)).limit(200);
  const counts = {
    needs_you: 0,
    being_handled: 0,
    waiting: 0,
    interesting: 0,
    completed: 0,
    dismissed: 0,
    superseded: 0,
    blocked: 0,
    uncertain: 0,
  };
  const items: AssistantWorkloadItem[] = [];
  for (const row of reviews) {
    const state = row.state as keyof typeof counts;
    if (state in counts) counts[state] += 1;
    const observations = await db
      .select()
      .from(archiveObservations)
      .where(eq(archiveObservations.reviewItemId, row.id))
      .orderBy(desc(archiveObservations.observedAt))
      .limit(2);
    const current = observations[0];
    const previous = observations[1];
    items.push({
      id: `review-${row.id}`,
      title: row.title,
      reviewItemId: row.id,
      findingClassification: row.classification,
      currentObservationId: current?.id ?? null,
      provider: row.providerKind,
      refreshId: row.refreshId ? String(row.refreshId) : null,
      evidenceKey: current?.evidenceKey ?? null,
      observedAt: current?.observedAt.toISOString() ?? null,
      changeContext: previous
        ? {
            previousObservationId: previous.id,
            previousEvidenceKey: previous.evidenceKey,
            previousObservedAt: previous.observedAt.toISOString(),
          }
        : null,
      summary:
        (row.payload && typeof row.payload === "object" && "summary" in row.payload
          ? String((row.payload as { summary?: unknown }).summary ?? "")
          : "") || row.title,
      state: (["needs_you", "completed", "dismissed", "superseded", "uncertain"].includes(row.state)
        ? row.state
        : "uncertain") as AssistantWorkloadItem["state"],
      needsUserAction: row.state === "needs_you",
      nextStep:
        row.state === "needs_you"
          ? "Review the finding and approve or dismiss it — nothing is executed automatically."
          : "No action needed.",
      destination: "assistant",
      source: "review",
      sourceId: `review-${row.id}`,
      evidence: Array.isArray(row.evidence) ? row.evidence.filter((e): e is string => typeof e === "string") : [],
      confidence: "provider-reconciled",
      lastConfirmedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
      freshness: freshnessFrom(row.updatedAt),
    });
  }
  return { items, counts, generatedAt: new Date().toISOString() };
}

function zeroSummary(): ReconciliationSummary {
  return {
    localCount: 0,
    plexCount: 0,
    matchedCount: 0,
    localOnlyCount: 0,
    plexOnlyCount: 0,
    uncertainCount: 0,
    duplicateCount: 0,
    qualityConflictCount: 0,
  };
}

async function buildProviderRefreshState(provider: ArchiveProvider): Promise<ProviderRefreshState> {
  const rows = await refreshRows(provider);
  const authority = rows.find((r) => r.status === "synced" && r.snapshotCompleteness === "complete") ?? null;
  const lastSuccessful = authority;
  return {
    provider,
    lastAttemptedRefresh: rows[0] ? toProviderRefresh(rows[0], authority?.id ?? null, provider) : null,
    lastSuccessfulRefresh: lastSuccessful ? toProviderRefresh(lastSuccessful, authority?.id ?? null, provider) : null,
    currentAuthoritativeRefresh: authority ? toProviderRefresh(authority, authority.id, provider) : null,
  };
}

async function buildProviderRefreshHistory(
  provider: ArchiveProvider,
  options: { page?: number; pageSize?: number } = {},
): Promise<ProviderRefreshHistory> {
  const rows = await refreshRows(provider);
  const pageSize = Math.min(Math.max(Math.floor(options.pageSize ?? 10), 1), 25);
  const page = Math.max(1, Math.floor(options.page ?? 1));
  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const slice = rows.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize);
  const authority = rows.find((r) => r.status === "synced" && r.snapshotCompleteness === "complete") ?? null;
  return {
    results: slice.map((row) => toProviderRefresh(row, authority?.id ?? null, provider)),
    pagination: { page, pageSize, total, totalPages },
  };
}

async function buildFindingLineage(reviewItemId: number): Promise<ReconciliationFindingLineage> {
  const rows = await db.select().from(archiveReviewItems).where(eq(archiveReviewItems.id, reviewItemId)).limit(1);
  const row = rows[0];
  if (!row) {
    throw new ArchiveAssistantNotFoundError(`finding lineage for review item ${reviewItemId}`);
  }
  const observations = await db
    .select()
    .from(archiveObservations)
    .where(eq(archiveObservations.reviewItemId, reviewItemId))
    .orderBy(desc(archiveObservations.observedAt));
  const current = observations[0] ?? null;
  const previous = current ? (observations.find((o) => o.supersededById === current.id) ?? null) : null;
  let snapshotReference: string | null = null;
  if (row.refreshId) {
    const refreshRows = await db.select().from(mediaRefreshes).where(eq(mediaRefreshes.refreshId, row.refreshId)).limit(1);
    snapshotReference = refreshRows[0]?.snapshotReference ?? null;
  }
  return {
    finding: {
      reviewItemId: row.id,
      subjectKey: row.subjectKey,
      state: row.state,
      classification: row.classification,
      title: row.title,
      evidenceKey: current?.evidenceKey ?? null,
    },
    currentObservation: current
      ? { observationId: current.id, evidenceKey: current.evidenceKey, observedAt: current.observedAt.toISOString() }
      : null,
    provider: {
      provider: row.providerKind,
      refreshId: row.refreshId ? String(row.refreshId) : null,
      capturedAt: current ? current.observedAt.toISOString() : null,
      snapshotReference,
    },
    previousObservation: previous
      ? { observationId: previous.id, evidenceKey: previous.evidenceKey, observedAt: previous.observedAt.toISOString() }
      : null,
  };
}

/** The native client: same interface as the retired HTTP bridge, frozen. */
export function createNativeArchiveContextClient(): ArchiveContextClient {
  const client: ArchiveContextClient = {
    async getOverview() {
      const overview = await buildOverview();
      validateContract("AssistantOverview", overview);
      return overview;
    },
    async getWorkload() {
      const workload = await buildWorkload();
      validateContract("AssistantWorkload", workload);
      return workload;
    },
    async getReconciliationSummary() {
      const { summary, everRun } = await latestReconciliationSummary();
      const mapped: ReconciliationSummary = everRun
        ? {
            localCount: summary.localCount,
            plexCount: summary.providerCount, // provider-agnostic count, contract keeps the plex-era name
            matchedCount: summary.matchedCount,
            localOnlyCount: summary.localOnlyCount,
            plexOnlyCount: summary.providerOnlyCount,
            uncertainCount: summary.uncertainCount,
            duplicateCount: summary.duplicateCount,
            qualityConflictCount: summary.qualityConflictCount,
          }
        : zeroSummary();
      validateContract("ReconciliationSummary", mapped);
      return mapped;
    },
    async getFindingLineage(reviewItemId: number) {
      const lineage = await buildFindingLineage(reviewItemId);
      validateContract("ReconciliationFindingLineage", lineage);
      return lineage;
    },
    async getProviderRefreshState(provider: ArchiveProvider) {
      const state = await buildProviderRefreshState(provider);
      validateContract("ProviderRefreshState", state);
      return state;
    },
    async getProviderRefreshHistory(provider: ArchiveProvider, options = {}) {
      const history = await buildProviderRefreshHistory(provider, options);
      validateContract("ProviderRefreshHistory", history);
      return history;
    },
  };
  return Object.freeze(client);
}
