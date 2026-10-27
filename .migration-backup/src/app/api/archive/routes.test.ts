/**
 * Compatibility tests: the Arena-side read-only routes — NATIVE since the
 * Archive Assistant merge.
 *   GET /api/archive/context
 *   GET /api/archive/findings/:reviewItemId/lineage
 *
 * Covers: native context assembly from the merged tables, refresh
 * semantics (attempted diverged from authority) surfaced through the API,
 * explicit bounded lineage lookup, honest status codes (400/404), and the
 * contract-validity of everything the route returns. PG-gated.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import net from "node:net";

function resolveDatabaseUrl(): string {
  const envUrl = process.env.DATABASE_URL ?? "";
  if (envUrl && !envUrl.includes("arena-test-no-connect")) return envUrl;
  try {
    const env = readFileSync(new URL("../../../../.env", import.meta.url), "utf8");
    const match = env.match(/^DATABASE_URL=(.+)$/m);
    if (match) return match[1].trim();
  } catch {
    /* fall through */
  }
  return "postgresql://postgres:postgres@127.0.0.1:5432/app_db";
}

async function localPostgresUp(url: string): Promise<boolean> {
  try {
    const parsed = new URL(url);
    return await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host: parsed.hostname, port: Number(parsed.port || 5432), timeout: 800 });
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => resolve(false));
      socket.once("timeout", () => { socket.destroy(); resolve(false); });
    });
  } catch {
    return false;
  }
}

const databaseUrl = resolveDatabaseUrl();
const pgUp = await localPostgresUp(databaseUrl);
process.env.DATABASE_URL = databaseUrl;

// Route modules are imported AFTER the real DATABASE_URL is in place: they
// build the pg pool at import time, and the test loader's placeholder URL
// must never be captured.
const { GET: getContext } = await import("./context/route");
const { GET: getLineage } = await import("./findings/[reviewItemId]/lineage/route");

/* --------------------------------- seed ---------------------------------- */

async function seedNativeArchive() {
  const { db } = await import("@/db");
  const { archiveObservations, archiveReviewItems, mediaProviders, mediaRefreshes, reconciliationRuns } = await import("@/db/schema");
  const { sealSecret } = await import("@/lib/secretBox");
  const { eq } = await import("drizzle-orm");

  // Clean slate (test-owned tables only).
  await db.delete(archiveObservations);
  await db.delete(archiveReviewItems);
  await db.delete(mediaRefreshes);
  await db.delete(mediaProviders);
  await db.delete(reconciliationRuns);

  const [provider] = await db
    .insert(mediaProviders)
    .values({
      kind: "plex",
      name: "Home Plex",
      baseUrl: "http://127.0.0.1:32400",
      tokenSealed: sealSecret("plex-token-test"),
      lastSyncAt: new Date(),
    })
    .returning();

  // Authority: complete snapshot r1.
  await db.insert(mediaRefreshes).values({
    refreshId: "11111111-1111-4111-8111-111111111111",
    providerKind: "plex",
    status: "synced",
    snapshotCompleteness: "complete",
    itemCount: 120,
    snapshotReference: "snap-test-1",
    startedAt: new Date(Date.now() - 3_600_000),
    completedAt: new Date(Date.now() - 3_540_000),
  });
  // Failed partial attempt r2 AFTER the authority: must not demote r1.
  await db.insert(mediaRefreshes).values({
    refreshId: "22222222-2222-4222-8222-222222222222",
    providerKind: "plex",
    status: "sync_error",
    snapshotCompleteness: "partial",
    reason: "connection lost mid-fetch",
    startedAt: new Date(Date.now() - 1_800_000),
    completedAt: new Date(Date.now() - 1_740_000),
  });

  const [review] = await db
    .insert(archiveReviewItems)
    .values({
      subjectKey: "movie|arrival|2016",
      title: "Arrival (2016) local_only",
      kind: "identity",
      state: "needs_you",
      classification: "local_only",
      providerKind: null,
      payload: { summary: "Local archive file is not indexed by any synced provider library." },
      evidence: ["archive index"],
    })
    .returning();
  const previous = await db
    .insert(archiveObservations)
    .values({
      reviewItemId: review.id,
      evidenceKey: "obs-old",
      payload: { summary: "first observation" },
      observedAt: new Date(Date.now() - 86_400_000),
    })
    .returning();
  const current = await db
    .insert(archiveObservations)
    .values({
      reviewItemId: review.id,
      evidenceKey: "obs-new",
      payload: { summary: "still local_only" },
      observedAt: new Date(Date.now() - 600_000),
    })
    .returning();
  await db
    .update(archiveObservations)
    .set({ supersededById: current[0].id })
    .where(eq(archiveObservations.id, previous[0].id));

  await db.insert(reconciliationRuns).values({
    summary: {
      localCount: 12,
      providerCount: 120,
      matchedCount: 10,
      localOnlyCount: 2,
      providerOnlyCount: 110,
      uncertainCount: 0,
      duplicateCount: 0,
      qualityConflictCount: 0,
    },
    generatedAt: new Date(Date.now() - 300_000),
  });

  return { reviewId: review.id };
}

async function clearNativeArchive() {
  const { db } = await import("@/db");
  const { archiveObservations, archiveReviewItems, mediaRefreshes, mediaProviders, reconciliationRuns } = await import("@/db/schema");
  await db.delete(archiveObservations);
  await db.delete(archiveReviewItems);
  await db.delete(mediaRefreshes);
  await db.delete(mediaProviders);
  await db.delete(reconciliationRuns);
}

/* ------------------------------ context route ---------------------------- */

test("context: assembles the six-part native context with normalized facts", async () => {
  if (!pgUp) return assert.fail("PG required for native context route tests");
  const { reviewId } = await seedNativeArchive();
  try {
    const res = await getContext(new Request("http://arena.test/api/archive/context"));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.meta.authMode, "native");
    assert.equal(body.meta.upstreamHost, "arena-native");
    assert.ok(Date.parse(body.meta.generatedAt) > 0);

    // Refresh semantics: attempted (failed partial) diverged from authority
    // (complete r1) — authority intact, honest incomplete reading.
    const plex = body.context.refresh.plex;
    assert.equal(plex.lastAttemptedRefresh.refreshId, "22222222-2222-4222-8222-222222222222");
    assert.equal(plex.lastAttemptedRefresh.status, "sync_error");
    assert.equal(plex.currentAuthoritativeRefresh.refreshId, "11111111-1111-4111-8111-111111111111");
    assert.equal(plex.currentAuthoritativeRefresh.authoritative, true);
    assert.equal(plex.lastAttemptedRefresh.authoritative, false);
    assert.equal(plex.lastSuccessfulRefresh.refreshId, "11111111-1111-4111-8111-111111111111");

    // Workload fact carries the observation + review handles.
    const workloadFact = body.facts.find((f: { subjectId: string }) => f.subjectId === `review-${reviewId}`);
    assert.ok(workloadFact, "workload fact for the seeded review item exists");
    assert.equal(workloadFact.evidence.observationId, body.context.workload.items[0].currentObservationId);

    // Reconciliation summary from the persisted run.
    assert.equal(body.context.reconciliation.localCount, 12);
    assert.equal(body.context.reconciliation.plexCount, 120);
    assert.equal(body.context.reconciliation.providerOnlyCount ?? body.context.reconciliation.plexOnlyCount, 110);

    // Jellyfin honestly never-attempted (no rows).
    assert.equal(body.context.refresh.jellyfin.lastAttemptedRefresh, null);
    assert.equal(body.context.refresh.jellyfin.currentAuthoritativeRefresh, null);

    // Contract-valid shapes (same generated validators the old bridge ran).
    const { validateContract } = await import("@/lib/archive-assistant/validate");
    validateContract("AssistantOverview", body.context.overview);
    validateContract("AssistantWorkload", body.context.workload);
    validateContract("ReconciliationSummary", body.context.reconciliation);
    validateContract("ProviderRefreshState", body.context.refresh.plex);
  } finally {
    await clearNativeArchive();
  }
});

test("context: ?history=1 attaches one bounded history page per provider", async () => {
  if (!pgUp) return assert.fail("PG required");
  await seedNativeArchive();
  try {
    const res = await getContext(new Request("http://arena.test/api/archive/context?history=1"));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.meta.refreshHistoryIncluded, true);
    assert.ok(body.refreshHistory);
    assert.equal(body.refreshHistory.plex.results.length, 2);
    assert.equal(body.refreshHistory.plex.pagination.total, 2);
    assert.equal(body.refreshHistory.jellyfin.results.length, 0);
    // Most recent first; the authority flag marks r1 even though r2 is newer.
    assert.equal(body.refreshHistory.plex.results[0].status, "sync_error");
    assert.equal(body.refreshHistory.plex.results[1].authoritative, true);
    const { validateContract } = await import("@/lib/archive-assistant/validate");
    validateContract("ProviderRefreshHistory", body.refreshHistory.plex);
  } finally {
    await clearNativeArchive();
  }
});

test("context: fresh install (no providers) answers honestly, never guesses", async () => {
  if (!pgUp) return assert.fail("PG required");
  await clearNativeArchive();
  try {
    const res = await getContext(new Request("http://arena.test/api/archive/context"));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.context.overview.summary.attentionCount, 0);
    assert.equal(body.context.overview.summary.lastScan, null);
    assert.equal(body.context.overview.activeWork.acquisitionJobs, 0);
    assert.equal(body.context.overview.mediaExperience.sourceStatus, "no_synced_provider_data");
    assert.equal(body.context.refresh.plex.lastAttemptedRefresh, null);
  } finally {
    await clearNativeArchive();
  }
});

/* ------------------------------ lineage route ---------------------------- */

test("lineage: explicit lookup returns current + superseded observation", async () => {
  if (!pgUp) return assert.fail("PG required");
  const { reviewId } = await seedNativeArchive();
  try {
    const res = await getLineage(
      new Request(`http://arena.test/api/archive/findings/${reviewId}/lineage`),
      { params: Promise.resolve({ reviewItemId: String(reviewId) }) },
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.lineage.finding.reviewItemId, reviewId);
    assert.equal(body.lineage.finding.classification, "local_only");
    assert.equal(body.lineage.currentObservation.evidenceKey, "obs-new");
    assert.equal(body.lineage.previousObservation.evidenceKey, "obs-old");
    assert.ok(body.facts.length >= 1);
    const { validateContract } = await import("@/lib/archive-assistant/validate");
    validateContract("ReconciliationFindingLineage", body.lineage);
  } finally {
    await clearNativeArchive();
  }
});

test("lineage: non-positive or non-integer ids are 400", async () => {
  for (const bad of ["0", "-3", "abc"]) {
    const res = await getLineage(
      new Request(`http://arena.test/api/archive/findings/${bad}/lineage`),
      { params: Promise.resolve({ reviewItemId: bad }) },
    );
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, "invalid_review_item_id");
  }
});

test("lineage: unknown id stays a 404 (no fabricated lineage)", async () => {
  if (!pgUp) return assert.fail("PG required");
  await clearNativeArchive();
  const res = await getLineage(
    new Request("http://arena.test/api/archive/findings/999999/lineage"),
    { params: Promise.resolve({ reviewItemId: "999999" }) },
  );
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error, "archive_assistant_not_found");
});

// One shared pool lifecycle for the whole file.
after(async () => {
  if (pgUp) {
    const { pool } = await import("@/db");
    await pool.end().catch(() => {});
  }
});
