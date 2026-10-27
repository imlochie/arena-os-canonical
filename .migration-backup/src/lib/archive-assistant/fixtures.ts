/**
 * Contract-shaped fixture payloads for the Archive Assistant compatibility
 * tests. Every fixture satisfies the generated OpenAPI subset validators —
 * the same ones the client enforces on real upstream responses.
 * Test-only; never imported by app code.
 */

import type {
  AssistantOverview,
  AssistantWorkload,
  ProviderRefresh,
  ProviderRefreshHistory,
  ProviderRefreshState,
  ReconciliationFindingLineage,
  ReconciliationReport,
} from "./generated/types";

/* ------------------------------ refreshes ------------------------------- */

export const PLEX_AUTHORITY: ProviderRefresh = {
  refreshId: "plex-r17",
  provider: "plex",
  startedAt: "2026-09-17T10:00:00.000Z",
  completedAt: "2026-09-17T10:01:00.000Z",
  status: "synced",
  snapshotCompleteness: "complete",
  itemCount: 35890,
  authoritative: true,
  reason: null,
  snapshotReference: "snap-plex-17",
};

export const PLEX_FAILED_PARTIAL_ATTEMPT: ProviderRefresh = {
  refreshId: "plex-r18",
  provider: "plex",
  startedAt: "2026-09-18T09:00:00.000Z",
  completedAt: "2026-09-18T09:00:40.000Z",
  status: "sync_error",
  snapshotCompleteness: "partial",
  itemCount: null,
  authoritative: false,
  reason: "connection lost mid-fetch",
  snapshotReference: null,
};

export const JELLYFIN_FAILED_UNKNOWN_ATTEMPT: ProviderRefresh = {
  refreshId: "jf-r09",
  provider: "jellyfin",
  startedAt: "2026-09-18T08:00:00.000Z",
  completedAt: "2026-09-18T08:00:05.000Z",
  status: "sync_error",
  snapshotCompleteness: "unknown",
  itemCount: null,
  authoritative: false,
  reason: "provider unreachable",
  snapshotReference: null,
};

export const JELLYFIN_AUTHORITY: ProviderRefresh = {
  refreshId: "jf-r08",
  provider: "jellyfin",
  startedAt: "2026-09-16T07:00:00.000Z",
  completedAt: "2026-09-16T07:00:33.000Z",
  status: "synced",
  snapshotCompleteness: "complete",
  itemCount: 410,
  authoritative: true,
  reason: null,
  snapshotReference: "snap-jf-08",
};

/** The canonical "attempted diverged from authority" state: the latest
 *  attempt failed partial, the last success AND the authority stay r17. */
export const PLEX_STATE_PARTIAL_FAILURE: ProviderRefreshState = {
  provider: "plex",
  lastAttemptedRefresh: PLEX_FAILED_PARTIAL_ATTEMPT,
  lastSuccessfulRefresh: PLEX_AUTHORITY,
  currentAuthoritativeRefresh: PLEX_AUTHORITY,
};

/** Run-B ("ordinary") state: a complete authoritative refresh r19 has
 *  legitimately replaced r17 as authority — and observes FEWER items
 *  (35,802 vs 35,890). Absence here is current authoritative truth: the
 *  exact contrast to the r18 trap. */
export const PLEX_ORDINARY_AUTHORITY: ProviderRefresh = {
  refreshId: "plex-r19",
  provider: "plex",
  startedAt: "2026-09-18T11:00:00.000Z",
  completedAt: "2026-09-18T11:05:00.000Z",
  status: "synced",
  snapshotCompleteness: "complete",
  itemCount: 35802,
  authoritative: true,
  reason: null,
  snapshotReference: "snap-plex-19",
};

export const PLEX_STATE_ORDINARY_AUTHORITY: ProviderRefreshState = {
  provider: "plex",
  lastAttemptedRefresh: PLEX_ORDINARY_AUTHORITY,
  lastSuccessfulRefresh: PLEX_ORDINARY_AUTHORITY,
  currentAuthoritativeRefresh: PLEX_ORDINARY_AUTHORITY,
};

export const PLEX_HISTORY_ORDINARY: ProviderRefreshHistory = {
  results: [PLEX_ORDINARY_AUTHORITY, PLEX_FAILED_PARTIAL_ATTEMPT, PLEX_AUTHORITY],
  pagination: { page: 1, pageSize: 10, total: 3, totalPages: 1 },
};

export const JELLYFIN_STATE_FAILED_UNKNOWN: ProviderRefreshState = {
  provider: "jellyfin",
  lastAttemptedRefresh: JELLYFIN_FAILED_UNKNOWN_ATTEMPT,
  lastSuccessfulRefresh: JELLYFIN_AUTHORITY,
  currentAuthoritativeRefresh: JELLYFIN_AUTHORITY,
};

export const PLEX_HISTORY: ProviderRefreshHistory = {
  results: [PLEX_FAILED_PARTIAL_ATTEMPT, PLEX_AUTHORITY],
  pagination: { page: 1, pageSize: 10, total: 2, totalPages: 1 },
};

export const JELLYFIN_HISTORY: ProviderRefreshHistory = {
  results: [JELLYFIN_FAILED_UNKNOWN_ATTEMPT, JELLYFIN_AUTHORITY],
  pagination: { page: 1, pageSize: 10, total: 2, totalPages: 1 },
};

/* ------------------------------ overview -------------------------------- */

export const OVERVIEW: AssistantOverview = {
  summary: {
    health: "attention_required",
    attentionCount: 1,
    counts: { critical: 0, high: 1, medium: 0, low: 0, info: 2 },
    blockedCount: 0,
    uncertainCount: 1,
    lastScan: "2026-09-18T06:00:00.000Z",
    freshness: "recent",
  },
  attention: [],
  recommendations: [],
  groups: [],
  blocked: [],
  uncertain: [],
  informational: ["2 informational notes"],
  activeWork: { scanStatus: "idle", acquisitionJobs: 0 },
  mediaExperience: {
    sourceStatus: "provider_metadata",
    items: [],
    completed: [],
    inProgress: [],
    summary: { completedCount: 0, inProgressCount: 0, watchedMinutes: 0, watchedHours: 0 },
    currentViewingMomentum: { activeSeriesCount: 0, recentlyWatchedCount: 0, windowDays: 30 },
    watchlist: { status: "not_available", items: [] },
  },
  discovery: {
    upcoming: { status: "not_available", reason: "no provider metadata", items: [] },
    recentlyReleased: { status: "not_available", reason: null, items: [] },
    trending: { status: "not_available", reason: null, items: [] },
    suggestedForYou: { status: "not_available", reason: null, items: [] },
  },
  personalizedBriefing: [],
};

/* ------------------------------ workload -------------------------------- */

export const WORKLOAD: AssistantWorkload = {
  items: [
    {
      id: "wl-101",
      title: "Show.S01E04 quality conflict",
      reviewItemId: 42,
      findingClassification: "quality_conflict",
      currentObservationId: 9001,
      provider: "plex",
      refreshId: "plex-r17",
      evidenceKey: "ek-abc-1",
      observedAt: "2026-09-17T10:01:00.000Z",
      changeContext: {
        previousObservationId: 8800,
        previousEvidenceKey: "ek-old-9",
        previousObservedAt: "2026-09-10T10:01:00.000Z",
      },
      summary: "Local 1080p copy conflicts with provider 720p metadata.",
      state: "needs_you",
      needsUserAction: true,
      nextStep: "Review the conflict in Archive Assistant.",
      destination: "assistant",
      source: "review",
      sourceId: "review-42",
      evidence: ["provider metadata", "local probe"],
      confidence: "high",
      lastConfirmedAt: "2026-09-17T10:02:00.000Z",
      freshness: "fresh",
    },
    {
      id: "wl-102",
      title: "Movie (2020) waiting on download",
      reviewItemId: null,
      findingClassification: null,
      currentObservationId: null,
      provider: null,
      refreshId: null,
      evidenceKey: null,
      observedAt: null,
      changeContext: null,
      summary: "Download job is queued in D:\\media\\incoming\\Movie (2020).",
      state: "waiting",
      needsUserAction: false,
      nextStep: "Nothing needed; being handled.",
      destination: "queue",
      source: "download",
      sourceId: "dl-7",
      evidence: [],
      confidence: null,
      lastConfirmedAt: null,
      freshness: "recent",
    },
  ],
  counts: {
    needs_you: 1,
    being_handled: 0,
    waiting: 1,
    interesting: 0,
    completed: 0,
    dismissed: 0,
    superseded: 0,
    blocked: 0,
    uncertain: 0,
  },
  generatedAt: "2026-09-18T09:30:00.000Z",
};

/* ---------------------------- reconciliation ---------------------------- */

export const RECONCILIATION_REPORT: ReconciliationReport = {
  summary: {
    localCount: 900,
    plexCount: 1000,
    matchedCount: 880,
    localOnlyCount: 20,
    plexOnlyCount: 120,
    uncertainCount: 3,
    duplicateCount: 2,
    qualityConflictCount: 5,
  },
  pagination: { page: 1, pageSize: 1, total: 1005, totalPages: 1005 },
  results: [],
};

/* ------------------------------- lineage -------------------------------- */

export const LINEAGE: ReconciliationFindingLineage = {
  finding: {
    reviewItemId: 42,
    subjectKey: "show:s01:e04",
    state: "open",
    classification: "quality_conflict",
    title: "Show.S01E04 quality conflict",
    evidenceKey: "ek-abc-1",
  },
  currentObservation: {
    observationId: 9001,
    evidenceKey: "ek-abc-1",
    observedAt: "2026-09-17T10:01:00.000Z",
  },
  provider: {
    provider: "plex",
    refreshId: "plex-r17",
    capturedAt: "2026-09-17T10:01:00.000Z",
    snapshotReference: "snap-plex-17",
  },
  previousObservation: {
    observationId: 8800,
    evidenceKey: "ek-old-9",
    observedAt: "2026-09-10T10:01:00.000Z",
  },
};

/* ---------------------------- fetch stub helper -------------------------- */

export type RecordedCall = { url: string; method: string; headers: Record<string, string> };

/** Build a fetch stub that serves the six read-only endpoints from the
 *  fixtures (with optional per-path overrides) and records every call. */
export function makeArchiveFetchStub(overrides: Record<string, unknown> = {}) {
  const calls: RecordedCall[] = [];
  const routes: Record<string, unknown> = {
    "/assistant/overview": OVERVIEW,
    "/assistant/workload": WORKLOAD,
    "/archive/reconciliation": RECONCILIATION_REPORT,
    "/provider/refresh": PLEX_STATE_PARTIAL_FAILURE,
    "/provider/refresh/history": PLEX_HISTORY,
    "/archive/reconciliation/findings/42/lineage": LINEAGE,
    ...overrides,
  };

  const stub = async (input: unknown, init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal }) => {
    const url = String(input);
    const parsed = new URL(url);
    const headers: Record<string, string> = {};
    const rawHeaders = init?.headers ?? {};
    for (const [k, v] of Object.entries(rawHeaders)) headers[k.toLowerCase()] = String(v);
    calls.push({ url, method: init?.method ?? "GET", headers });

    // Routes are matched by path suffix so the stub works with any API base
    // prefix (e.g. https://host/api → /api/assistant/overview).
    const matchKey = Object.keys(routes).find((key) => parsed.pathname.endsWith(key));
    let payload: unknown = matchKey ? routes[matchKey] : undefined;
    // Provider refresh endpoints are provider-scoped.
    if (matchKey === "/provider/refresh" && parsed.searchParams.get("provider") === "jellyfin") {
      payload = overrides["/provider/refresh?jellyfin"] ?? JELLYFIN_STATE_FAILED_UNKNOWN;
    }
    if (matchKey === "/provider/refresh/history" && parsed.searchParams.get("provider") === "jellyfin") {
      payload = JELLYFIN_HISTORY;
    }
    if (payload === undefined) {
      return new Response("not found", { status: 404 });
    }
    return Response.json(payload);
  };

  return { stub: stub as unknown as typeof fetch, calls };
}
