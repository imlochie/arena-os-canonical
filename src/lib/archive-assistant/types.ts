/**
 * Public types for Arena's Archive Assistant read-only bridge.
 *
 * Layering rule (see docs/archive-assistant-integration.md):
 *
 *   Archive Assistant OpenAPI
 *     → generated contract types (./generated, AUTO-GENERATED)
 *     → this module's bounded, Arena-facing model
 *     → facts with evidence citations
 *     → Arena reasoning
 *
 * Raw Archive Assistant rows, database concepts, provider credentials, and
 * control-plane operations never cross this boundary.
 */

import type {
  AssistantOverview,
  AssistantWorkload,
  ProviderRefreshHistory,
  ProviderRefreshState,
  ReconciliationFindingLineage,
  ReconciliationSummary,
} from "./generated/types";

/* ---- Contract type aliases (generated types under Arena-facing names) ---- */

export type ArchiveOverview = AssistantOverview;
export type ArchiveWorkload = AssistantWorkload;
export type FindingLineage = ReconciliationFindingLineage;
export type {
  ProviderRefresh,
  ProviderRefreshHistory,
  ProviderRefreshState,
  ReconciliationSummary,
} from "./generated/types";

export type ArchiveProvider = "plex" | "jellyfin";

export const ARCHIVE_PROVIDERS: readonly ArchiveProvider[] = ["plex", "jellyfin"];

/* ------------------------------ Client seam ------------------------------ */

export type ProviderRefreshHistoryOptions = {
  page?: number;
  pageSize?: number;
};

/**
 * The complete Archive Assistant capability surface available to Arena.
 *
 * It is READ-ONLY by construction: six GET operations, no others. Approval,
 * rejection, reopening, execution, renaming, moving, downloading, syncing and
 * every other mutation stays inside Archive Assistant's control plane with
 * its own approval gates. There is deliberately no method here that could
 * mutate either system.
 */
export type ArchiveContextClient = {
  getOverview(): Promise<ArchiveOverview>;
  getWorkload(): Promise<ArchiveWorkload>;
  getReconciliationSummary(): Promise<ReconciliationSummary>;
  getFindingLineage(reviewItemId: number): Promise<FindingLineage>;
  getProviderRefreshState(provider: ArchiveProvider): Promise<ProviderRefreshState>;
  getProviderRefreshHistory(
    provider: ArchiveProvider,
    options?: ProviderRefreshHistoryOptions,
  ): Promise<ProviderRefreshHistory>;
};

/* ------------------------- Normalized context model ----------------------- */

/**
 * The bounded six-part archive context Arena assembles server-side. Raw
 * endpoints are never handed to prompts or UI components directly; they are
 * normalized into this shape plus a derived fact list (context.ts).
 */
export type ArchiveContext = {
  generatedAt: string;
  overview: ArchiveOverview;
  workload: ArchiveWorkload;
  reconciliation: ReconciliationSummary;
  refresh: {
    plex: ProviderRefreshState;
    jellyfin: ProviderRefreshState;
  };
};

/**
 * Interpretation of a provider refresh state — the distinction Arena must
 * never blur (see prompt.ts for the matching reasoning rules):
 *
 *   complete      last attempt synced a complete snapshot
 *   in_progress   a sync is currently running; authority is unchanged
 *   incomplete    sync_error + partial snapshot: the provider view is
 *                 incomplete — it must NOT be read as "items are absent"
 *   failed        sync_error + unknown completeness: observation failed —
 *                 provider contents are unknown, NOT empty
 *   never_attempted  no refresh has ever been recorded for the provider
 */
export type RefreshObservationClass =
  | "complete"
  | "in_progress"
  | "incomplete"
  | "failed"
  | "never_attempted";

export type RefreshSemantics = {
  provider: ArchiveProvider;
  /** Classification of the MOST RECENT ATTEMPT (not the authority). */
  lastAttempt: RefreshObservationClass;
  /** refreshId of the current authoritative snapshot, if one exists. */
  authorityRefreshId: string | null;
  /** True when the current authority is a complete, synced snapshot. */
  authoritativeComplete: boolean;
  /** lastAttemptedRefresh != lastSuccessfulRefresh is normal and expected
   *  after a failed or partial attempt; authority stays pinned to the last
   *  complete snapshot. */
  attemptedRefreshId: string | null;
  lastSuccessfulRefreshId: string | null;
  /** One-sentence, plain-language reading safe to show users and models. */
  interpretation: string;
};

/**
 * A single normalized fact Arena may reason over, with its evidence handles.
 * Facts are the ONLY archive-derived statements that enter prompts.
 */
export type ArchiveContextFact = {
  source: "workload" | "reconciliation" | "provider_refresh" | "finding_lineage";
  subjectId: string;
  classification?: string;
  statement: string;
  evidence: {
    observationId?: number;
    refreshId?: string;
    evidenceKey?: string;
    observedAt?: string;
  };
};

/* ------------------------------ Route envelope --------------------------- */

/** What GET /api/archive/context returns. `context` stays spec-pure;
 *  provenance about how it was assembled lives in `meta`. */
export type ArchiveContextResponse = {
  context: ArchiveContext;
  facts: ArchiveContextFact[];
  meta: {
    generatedAt: string;
    authMode: ArchiveAssistantAuthModeSafe;
    upstreamHost: string;
    latencyMs: number;
    factsTruncated: boolean;
    refreshHistoryIncluded: boolean;
  };
  refreshHistory?: {
    plex: ProviderRefreshHistory | null;
    jellyfin: ProviderRefreshHistory | null;
  };
};

export type ArchiveAssistantAuthModeSafe = "bearer" | "local";

export type FindingLineageResponse = {
  lineage: FindingLineage;
  facts: ArchiveContextFact[];
  meta: {
    generatedAt: string;
    reviewItemId: number;
    upstreamHost: string;
  };
};
