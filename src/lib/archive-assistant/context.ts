/**
 * Archive context normalizer.
 *
 * Raw Archive Assistant endpoints are never passed to prompts or UI
 * components. This module reduces them to:
 *   1. the bounded ArchiveContext (spec shape), and
 *   2. a derived list of ArchiveContextFact statements carrying evidence
 *      handles (observationId / refreshId / evidenceKey / observedAt).
 *
 * The rules here encode the semantics Arena must never blur:
 *
 *   - lastAttemptedRefresh != lastSuccessfulRefresh is normal: a failed or
 *     partial attempt does not move authority.
 *   - currentAuthoritativeRefresh is the ONLY snapshot treated as
 *     authoritative truth, and only while it is a complete synced snapshot.
 *   - sync_error + partial  → the observation is INCOMPLETE, never "empty".
 *   - sync_error + unknown  → the observation FAILED, provider contents are
 *     UNKNOWN — never "absent".
 */

import type {
  ArchiveContext,
  ArchiveContextClient,
  ArchiveContextFact,
  ArchiveProvider,
  FindingLineage,
  ProviderRefresh,
  ProviderRefreshState,
  RefreshObservationClass,
  RefreshSemantics,
  ReconciliationSummary,
} from "./types";
import { ARCHIVE_PROVIDERS } from "./types";

/** Facts are a bounded view of the archive, not a dump of it. */
const MAX_FACTS = 50;

/* --------------------------- refresh semantics --------------------------- */

export function classifyRefreshAttempt(refresh: ProviderRefresh | null): RefreshObservationClass {
  if (!refresh) return "never_attempted";
  if (refresh.status === "syncing") return "in_progress";
  if (refresh.status === "synced" && refresh.snapshotCompleteness === "complete") return "complete";
  if (refresh.status === "sync_error" && refresh.snapshotCompleteness === "partial") return "incomplete";
  return "failed"; // sync_error + unknown, or any inconsistent remainder
}

export function summarizeRefresh(state: ProviderRefreshState): RefreshSemantics {
  const lastAttempt = classifyRefreshAttempt(state.lastAttemptedRefresh);
  const authority = state.currentAuthoritativeRefresh;
  const authoritativeComplete =
    authority !== null &&
    authority.authoritative === true &&
    authority.status === "synced" &&
    authority.snapshotCompleteness === "complete";

  const label = state.provider;
  const authorityId = authority?.refreshId ?? null;

  let interpretation: string;
  switch (lastAttempt) {
    case "never_attempted":
      interpretation = `No ${label} refresh has ever been recorded; nothing is known about the ${label} provider contents.`;
      break;
    case "in_progress":
      interpretation = authorityId
        ? `A ${label} refresh is currently running; authority remains refresh ${authorityId} until it completes.`
        : `A ${label} refresh is currently running; no authoritative ${label} snapshot exists yet.`;
      break;
    case "complete":
      interpretation =
        authoritativeComplete && authorityId === state.lastAttemptedRefresh?.refreshId
          ? `${capitalize(label)} refresh ${authorityId} is authoritative and complete.`
          : `The latest ${label} refresh completed, but authority remains refresh ${authorityId ?? "unset"}.`;
      break;
    case "incomplete":
      interpretation = authorityId
        ? `The latest ${label} refresh attempt ended with a partial snapshot; the ${label} view is incomplete, not empty. Authority remains refresh ${authorityId}.`
        : `The latest ${label} refresh attempt ended with a partial snapshot; the ${label} view is incomplete, not empty.`;
      break;
    case "failed":
      interpretation = authorityId
        ? `The latest ${label} refresh attempt failed; ${label} contents are unknown, not absent. Authority remains refresh ${authorityId}.`
        : `The latest ${label} refresh attempt failed; ${label} contents are unknown, not absent.`;
      break;
  }

  return {
    provider: state.provider,
    lastAttempt,
    authorityRefreshId: authorityId,
    authoritativeComplete,
    attemptedRefreshId: state.lastAttemptedRefresh?.refreshId ?? null,
    lastSuccessfulRefreshId: state.lastSuccessfulRefresh?.refreshId ?? null,
    interpretation,
  };
}

export function buildRefreshFacts(state: ProviderRefreshState): ArchiveContextFact[] {
  const semantics = summarizeRefresh(state);
  const facts: ArchiveContextFact[] = [];

  facts.push({
    source: "provider_refresh",
    subjectId: state.provider,
    classification: semantics.lastAttempt,
    statement: semantics.interpretation,
    evidence: {
      ...(semantics.authorityRefreshId ? { refreshId: semantics.authorityRefreshId } : {}),
      ...(state.lastAttemptedRefresh?.completedAt ?? state.lastAttemptedRefresh?.startedAt
        ? {
            observedAt:
              state.lastAttemptedRefresh?.completedAt ?? state.lastAttemptedRefresh?.startedAt,
          }
        : {}),
    },
  });

  // When the latest attempt diverged from authority, state the attempt as its
  // own fact so reasoning can cite it without conflating it with authority.
  const attempt = state.lastAttemptedRefresh;
  if (
    attempt &&
    (semantics.lastAttempt === "incomplete" ||
      semantics.lastAttempt === "failed" ||
      semantics.lastAttempt === "in_progress")
  ) {
    facts.push({
      source: "provider_refresh",
      subjectId: `${state.provider}:${attempt.refreshId}`,
      classification: semantics.lastAttempt,
      statement: `${capitalize(state.provider)} refresh attempt ${attempt.refreshId} has status ${attempt.status} with ${attempt.snapshotCompleteness} snapshot completeness and is not authoritative.`,
      evidence: {
        refreshId: attempt.refreshId,
        observedAt: attempt.completedAt ?? attempt.startedAt,
      },
    });
  }

  return facts;
}

/* --------------------------- workload + summary -------------------------- */

const WORKLOAD_STATE_PRIORITY: Record<string, number> = {
  needs_you: 0,
  blocked: 1,
  uncertain: 2,
  waiting: 3,
  being_handled: 4,
  interesting: 5,
  completed: 6,
  dismissed: 7,
};

export function buildWorkloadFacts(workload: ArchiveContext["workload"]): {
  facts: ArchiveContextFact[];
  truncated: boolean;
} {
  const ordered = [...workload.items].sort(
    (a, b) => (WORKLOAD_STATE_PRIORITY[a.state] ?? 9) - (WORKLOAD_STATE_PRIORITY[b.state] ?? 9),
  );

  const facts: ArchiveContextFact[] = ordered.slice(0, MAX_FACTS).map((item) => {
    const evidence: ArchiveContextFact["evidence"] = {};
    if (item.currentObservationId != null) evidence.observationId = item.currentObservationId;
    if (item.refreshId != null) evidence.refreshId = item.refreshId;
    if (item.evidenceKey != null) evidence.evidenceKey = item.evidenceKey;
    if (item.observedAt != null) evidence.observedAt = item.observedAt;

    const prior = item.changeContext
      ? ` The prior observation ${item.changeContext.previousObservationId} was superseded.`
      : "";
    const step = /[.!?]$/.test(item.nextStep.trim()) ? item.nextStep.trim() : `${item.nextStep.trim()}.`;
    return {
      source: "workload",
      subjectId: item.id,
      ...(item.findingClassification != null ? { classification: item.findingClassification } : {}),
      statement: `[${item.state}] ${item.title}: ${item.summary} Next step: ${step}${prior}`,
      evidence,
    };
  });

  return { facts, truncated: ordered.length > MAX_FACTS };
}

export function buildReconciliationFact(summary: ReconciliationSummary): ArchiveContextFact {
  return {
    source: "reconciliation",
    subjectId: "archive-vs-provider",
    classification: "reconciliation_summary",
    statement:
      `Reconciliation across the owner archive: ${summary.matchedCount} matched, ` +
      `${summary.localOnlyCount} local-only, ${summary.plexOnlyCount} provider-only, ` +
      `${summary.uncertainCount} uncertain, ${summary.duplicateCount} duplicates, ` +
      `${summary.qualityConflictCount} quality conflicts ` +
      `(local ${summary.localCount} / provider ${summary.plexCount} items).`,
    evidence: {},
  };
}

/* ------------------------------ finding lineage -------------------------- */

export function buildFindingLineageFacts(lineage: FindingLineage): ArchiveContextFact[] {
  const facts: ArchiveContextFact[] = [];
  const finding = lineage.finding;

  if (lineage.currentObservation) {
    const current = lineage.currentObservation;
    facts.push({
      source: "finding_lineage",
      subjectId: String(finding.reviewItemId),
      ...(finding.classification != null ? { classification: finding.classification } : {}),
      statement:
        `The current finding is ${finding.classification ?? "unclassified"} ` +
        `(state ${finding.state}) for ${finding.title}, from observation ${current.observationId}.`,
      evidence: {
        observationId: current.observationId,
        evidenceKey: current.evidenceKey,
        observedAt: current.observedAt,
      },
    });
  } else {
    facts.push({
      source: "finding_lineage",
      subjectId: String(finding.reviewItemId),
      ...(finding.classification != null ? { classification: finding.classification } : {}),
      statement: `Finding ${finding.reviewItemId} (${finding.title}) has no active observation recorded.`,
      evidence: {},
    });
  }

  if (lineage.previousObservation) {
    const previous = lineage.previousObservation;
    facts.push({
      source: "finding_lineage",
      subjectId: String(finding.reviewItemId),
      classification: "superseded_observation",
      statement: `The prior observation ${previous.observationId} was superseded; it is historical evidence, not current truth.`,
      evidence: {
        observationId: previous.observationId,
        evidenceKey: previous.evidenceKey,
        observedAt: previous.observedAt,
      },
    });
  }

  if (lineage.provider?.refreshId) {
    const provider = lineage.provider;
    facts.push({
      source: "finding_lineage",
      subjectId: String(finding.reviewItemId),
      classification: "provider_evidence",
      statement:
        `Finding ${finding.reviewItemId} is tied to ${provider.provider ?? "a provider"} ` +
        `refresh ${provider.refreshId}${provider.snapshotReference ? ` (snapshot ${provider.snapshotReference})` : ""}.`,
      evidence: {
        ...(provider.refreshId ? { refreshId: provider.refreshId } : {}),
        ...(provider.capturedAt ? { observedAt: provider.capturedAt } : {}),
      },
    });
  }

  return facts;
}

/* ------------------------------ context assembly ------------------------- */

export type BuildArchiveContextOptions = {
  /** Also fetch one bounded page of refresh history per provider. */
  includeHistory?: boolean;
  historyPageSize?: number;
};

export type BuiltArchiveContext = {
  context: ArchiveContext;
  facts: ArchiveContextFact[];
  factsTruncated: boolean;
  refreshHistory?: {
    plex: Awaited<ReturnType<ArchiveContextClient["getProviderRefreshHistory"]>> | null;
    jellyfin: Awaited<ReturnType<ArchiveContextClient["getProviderRefreshHistory"]>> | null;
  };
};

/**
 * Assemble the bounded six-part context by calling the read-only client.
 * The five core reads are independent and run concurrently; refresh history
 * is opt-in because it is only needed for "what changed lately" questions.
 */
export async function buildArchiveContext(
  client: ArchiveContextClient,
  options: BuildArchiveContextOptions = {},
): Promise<BuiltArchiveContext> {
  const [overview, workload, reconciliation, plex, jellyfin] = await Promise.all([
    client.getOverview(),
    client.getWorkload(),
    client.getReconciliationSummary(),
    client.getProviderRefreshState("plex"),
    client.getProviderRefreshState("jellyfin"),
  ]);

  const context: ArchiveContext = {
    generatedAt: new Date().toISOString(),
    overview,
    workload,
    reconciliation,
    refresh: { plex, jellyfin },
  };

  const { facts: workloadFacts, truncated } = buildWorkloadFacts(workload);
  const facts: ArchiveContextFact[] = [
    ...workloadFacts,
    buildReconciliationFact(reconciliation),
    ...ARCHIVE_PROVIDERS.flatMap((provider: ArchiveProvider) =>
      buildRefreshFacts(context.refresh[provider]),
    ),
  ];

  let refreshHistory: BuiltArchiveContext["refreshHistory"];
  if (options.includeHistory) {
    const pageSize = Math.max(1, Math.floor(options.historyPageSize ?? 10));
    const [plexHistory, jellyfinHistory] = await Promise.all([
      client.getProviderRefreshHistory("plex", { page: 1, pageSize }),
      client.getProviderRefreshHistory("jellyfin", { page: 1, pageSize }),
    ]);
    refreshHistory = { plex: plexHistory, jellyfin: jellyfinHistory };
  }

  return { context, facts, factsTruncated: truncated, ...(refreshHistory ? { refreshHistory } : {}) };
}

function capitalize(value: string): string {
  return value.length ? value[0].toUpperCase() + value.slice(1) : value;
}
