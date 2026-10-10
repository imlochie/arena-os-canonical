import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";

// Merged Archive Assistant — integration suite (PG-gated). The sync engine
// runs against REAL fixture HTTP servers (our fetch code really executes;
// only the provider's answers are fixtures — a real Plex/Jellyfin is
// owner-side hardware). Reconciliation, review decisions, the native
// six-op client, and bridge status run against the real database.

function resolveDatabaseUrl(): string {
  const envUrl = process.env.DATABASE_URL ?? "";
  if (envUrl && !envUrl.includes("arena-test-no-connect")) return envUrl;
  try {
    const env = readFileSync(new URL("../../../.env", import.meta.url), "utf8");
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

/* ---------------------------- fixture server ----------------------------- */

type Route = { status?: number; body: unknown };

async function startFixtureServer(routes: Record<string, Route>): Promise<{ port: number; stop: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    const route = routes[path];
    res.setHeader("content-type", "application/json");
    if (!route) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "no route" }));
      return;
    }
    res.statusCode = route.status ?? 200;
    res.end(JSON.stringify(route.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const stop = async () => {
    (server as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return { port, stop };
}

function plexAll(items: unknown[]) {
  return { MediaContainer: { Metadata: items } };
}

const PLEX_LIBRARIES = {
  "/library/sections": {
    body: {
      MediaContainer: {
        Directory: [
          { key: "1", title: "Movies", type: "movie" },
          { key: "2", title: "Movies 2", type: "movie" },
        ],
      },
    },
  },
};

/* ------------------------------- cleanup --------------------------------- */

async function clearMediaArchiveDomain(): Promise<void> {
  const { db } = await import("@/db");
  const {
    archiveObservations,
    archiveReviewItems,
    mediaLibraryItems,
    mediaProviders,
    mediaRefreshes,
    reconciliationRuns,
  } = await import("@/db/schema");
  await db.delete(archiveObservations);
  await db.delete(archiveReviewItems);
  await db.delete(mediaLibraryItems);
  await db.delete(mediaRefreshes);
  await db.delete(mediaProviders);
  await db.delete(reconciliationRuns);
}

/* --------------------------------- sync ---------------------------------- */

test("sync: plex refresh upserts items, records a complete snapshot, seals the token", async () => {
  if (!pgUp) return assert.fail("PG required for sync tests");
  await clearMediaArchiveDomain();
  const server = await startFixtureServer({
    ...PLEX_LIBRARIES,
    "/library/sections/1/all": {
      body: plexAll([
        { ratingKey: "m1", title: "Arrival", year: 2016, type: "1", viewCount: 1, lastViewedAt: 1790200000, duration: 6900000, librarySectionTitle: "Movies" },
        { ratingKey: "m2", title: "Heat", year: 1995, type: "1" },
      ]),
    },
    "/library/sections/2/all": {
      body: plexAll([{ ratingKey: "m3", title: "Dune", year: 2021, type: "1" }]),
    },
  });
  try {
    const { saveMediaProvider, runProviderSync, listMediaProviders } = await import("./sync");
    const provider = await saveMediaProvider({
      kind: "plex",
      name: "Test Plex",
      baseUrl: `http://127.0.0.1:${server.port}`,
      token: "plex-token-1",
    });
    // Token never appears in public shapes.
    const publicJson = JSON.stringify(await listMediaProviders());
    assert.ok(!publicJson.includes("plex-token-1"));

    const outcome = await runProviderSync("plex");
    assert.equal(outcome.status, "synced");
    assert.equal(outcome.snapshotCompleteness, "complete");
    assert.equal(outcome.itemCount, 3);
    assert.equal(outcome.failedLibraries.length, 0);
    assert.ok(outcome.refreshId);

    const { db } = await import("@/db");
    const { mediaLibraryItems, mediaRefreshes } = await import("@/db/schema");
    const items = await db.select().from(mediaLibraryItems);
    assert.equal(items.length, 3);
    const arrival = items.find((i) => i.ratingKey === "m1");
    assert.ok(arrival);
    assert.equal(arrival.viewCount, 1);
    assert.equal(arrival.itemType, "movie");
    assert.ok(arrival.lastViewedAt);
    const refreshes = await db.select().from(mediaRefreshes);
    assert.equal(refreshes.length, 1);
    assert.equal(refreshes[0].status, "synced");
    assert.equal(refreshes[0].snapshotCompleteness, "complete");
    assert.equal(refreshes[0].itemCount, 3);

    // Re-sync: same items upsert (no duplicates), refresh history grows.
    const second = await runProviderSync("plex");
    assert.equal(second.itemCount, 3);
    const itemsAfter = await db.select().from(mediaLibraryItems);
    assert.equal(itemsAfter.length, 3);
    const refreshesAfter = await db.select().from(mediaRefreshes);
    assert.equal(refreshesAfter.length, 2);
    void provider;
  } finally {
    await server.stop();
    await clearMediaArchiveDomain();
  }
});

test("sync: a failing library makes the snapshot partial, an unreachable provider errors without demoting authority", async () => {
  if (!pgUp) return assert.fail("PG required");
  await clearMediaArchiveDomain();
  // First: a good complete sync.
  const good = await startFixtureServer({
    ...PLEX_LIBRARIES,
    "/library/sections/1/all": { body: plexAll([{ ratingKey: "m1", title: "Arrival", year: 2016, type: "1" }]) },
    "/library/sections/2/all": { body: plexAll([]) },
  });
  const { saveMediaProvider, runProviderSync, latestAuthoritativeRefresh } = await import("./sync");
  await saveMediaProvider({
    kind: "plex",
    baseUrl: `http://127.0.0.1:${good.port}`,
    token: "plex-token-1",
  });
  await runProviderSync("plex");
  const authority = await latestAuthoritativeRefresh("plex");
  assert.ok(authority, "complete sync is the authority");
  await good.stop();

  // Second: one library 500s → partial snapshot, authority unchanged.
  // (Re-point the provider at this server first — save upserts by kind.)
  const partial = await startFixtureServer({
    ...PLEX_LIBRARIES,
    "/library/sections/1/all": { body: plexAll([{ ratingKey: "m1", title: "Arrival", year: 2016, type: "1" }]) },
    "/library/sections/2/all": { status: 500, body: { error: "boom" } },
  });
  try {
    await saveMediaProvider({
      kind: "plex",
      baseUrl: `http://127.0.0.1:${partial.port}`,
      token: "plex-token-1",
    });
    const partialOutcome = await runProviderSync("plex");
    assert.equal(partialOutcome.status, "synced");
    assert.equal(partialOutcome.snapshotCompleteness, "partial");
    assert.equal(partialOutcome.failedLibraries.length, 1);
    assert.equal(partialOutcome.failedLibraries[0].library, "Movies 2");
    const authorityAfterPartial = await latestAuthoritativeRefresh("plex");
    assert.ok(authorityAfterPartial);
    assert.equal(authorityAfterPartial.id, authority!.id, "partial attempt does not demote authority");
  } finally {
    await partial.stop();
  }

  // Third: provider fully unreachable → sync_error, authority STILL unchanged.
  const unreachableOutcome = await runProviderSync("plex");
  assert.equal(unreachableOutcome.status, "sync_error");
  assert.equal(unreachableOutcome.snapshotCompleteness, "unknown");
  const authorityAfterFailure = await latestAuthoritativeRefresh("plex");
  assert.ok(authorityAfterFailure);
  assert.equal(authorityAfterFailure.id, authority!.id, "failed attempt does not demote authority");
  await clearMediaArchiveDomain();
});

/* ----------------------------- reconciliation ---------------------------- */

test("reconcile: classifies matches, local-only, provider-only and duplicates with lineage", async () => {
  if (!pgUp) return assert.fail("PG required for reconciliation tests");
  await clearMediaArchiveDomain();
  const { db } = await import("@/db");
  const { archiveItems, mediaLibraryItems, mediaRefreshes } = await import("@/db/schema");
  const { runReconciliation, latestReconciliationSummary, parseLocalIdentity } = await import("./reconcile");

  // Identity parsing sanity.
  assert.deepEqual(parseLocalIdentity("Arrival (2016)"), { title: "Arrival", year: 2016 });
  assert.deepEqual(parseLocalIdentity("Movie.Title.2019.mkv"), { title: "Movie Title", year: 2019 });
  assert.deepEqual(parseLocalIdentity("Plain Name"), { title: "Plain Name", year: null });

  // Local archive: Arrival (matched), Blade Runner (local_only), two copies of Heat (duplicate).
  const localRows = await db
    .insert(archiveItems)
    .values([
      { name: "Arrival (2016)", kind: "video", path: "/media/arrival.mkv" },
      { name: "Blade Runner 2049 (2017)", kind: "video", path: "/media/br2049.mkv" },
      { name: "Heat (1995)", kind: "video", path: "/media/heat.mkv" },
      { name: "Heat (1995) copy", kind: "video", path: "/media/heat-2.mkv" },
    ])
    .returning();
  // Provider: Arrival + Heat (matched), Dune (provider_only), Blade Runner in another year (no match).
  await db.insert(mediaRefreshes).values({
    providerKind: "plex",
    status: "synced",
    snapshotCompleteness: "complete",
    itemCount: 3,
  });
  await db.insert(mediaLibraryItems).values([
    { providerKind: "plex", ratingKey: "p1", libraryName: "Movies", title: "Arrival", year: 2016, itemType: "movie" },
    { providerKind: "plex", ratingKey: "p2", libraryName: "Movies", title: "Heat", year: 1995, itemType: "movie" },
    { providerKind: "plex", ratingKey: "p3", libraryName: "Movies", title: "Dune", year: 2021, itemType: "movie" },
  ]);

  try {
    const summary = await runReconciliation();
    assert.equal(summary.localCount, 3); // arrival, blade runner, heat identity
    assert.equal(summary.providerCount, 3);
    assert.equal(summary.matchedCount, 2); // arrival + heat
    assert.equal(summary.localOnlyCount, 1); // blade runner
    assert.equal(summary.providerOnlyCount, 1); // dune
    assert.equal(summary.duplicateCount, 1); // two local Heats, one provider entry

    const { archiveObservations, archiveReviewItems } = await import("@/db/schema");
    const reviews = await db.select().from(archiveReviewItems);
    assert.ok(reviews.some((r) => r.classification === "local_only" && r.kind === "identity"));
    assert.ok(reviews.some((r) => r.classification === "plex_only" && r.kind === "download"));
    assert.ok(reviews.some((r) => r.classification === "duplicate" && r.kind === "duplicate"));
    const withObservations = await db.select().from(archiveObservations);
    assert.equal(withObservations.length, reviews.length, "every review item has an observation");

    // A second run supersedes nothing that still exists, but creates new
    // observations and links the previous one as superseded.
    await runReconciliation();
    const reviewsAfter = await db.select().from(archiveReviewItems);
    const observationsAfter = await db.select().from(archiveObservations);
    assert.equal(reviewsAfter.length, reviews.length, "same findings, no duplicates");
    assert.equal(observationsAfter.length, reviews.length * 2, "one new observation per finding");
    const supersededCount = observationsAfter.filter((o) => o.supersededById !== null).length;
    assert.equal(supersededCount, reviews.length, "each prior observation is superseded exactly once");

    // Healing: remove the local-only file → its finding is superseded.
    await db.delete(archiveItems).where(
      (await import("drizzle-orm")).eq(archiveItems.id, localRows.find((r) => r.name.startsWith("Blade Runner"))!.id),
    );
    await runReconciliation();
    const healed = await db.select().from(archiveReviewItems);
    const bladeRunner = healed.find((r) => r.title.startsWith("Blade Runner"));
    assert.ok(bladeRunner);
    assert.equal(bladeRunner.state, "superseded");

    const latest = await latestReconciliationSummary();
    assert.equal(latest.everRun, true);
    assert.ok(latest.generatedAt);
    assert.equal(latest.summary.localOnlyCount, 0);
  } finally {
    for (const row of localRows) {
      await db.delete(archiveItems).where((await import("drizzle-orm")).eq(archiveItems.id, row.id));
    }
    await clearMediaArchiveDomain();
  }
});

/* -------------------------------- review --------------------------------- */

test("review: approve/reject/reopen record decisions without executing anything", async () => {
  if (!pgUp) return assert.fail("PG required for review tests");
  await clearMediaArchiveDomain();
  const { db } = await import("@/db");
  const { archiveReviewItems } = await import("@/db/schema");
  const { decideReviewItem, listReviewItems } = await import("./review");
  const [item] = await db
    .insert(archiveReviewItems)
    .values({
      subjectKey: "movie|dune|2021",
      title: "Dune (2021)",
      kind: "download",
      state: "needs_you",
      classification: "plex_only",
      payload: { summary: "Listed by plex, no local file." },
      evidence: ["plex library"],
    })
    .returning();
  try {
    const approved = await decideReviewItem(item.id, "approve");
    assert.ok(approved);
    assert.equal(approved.state, "completed");
    assert.equal(approved.decision, "approved");
    assert.ok(approved.decidedAt);

    const dismissed = await decideReviewItem(item.id, "reject");
    assert.equal(dismissed?.state, "dismissed");
    assert.equal(dismissed?.decision, "rejected");

    const reopened = await decideReviewItem(item.id, "reopen");
    assert.equal(reopened?.state, "needs_you");
    assert.equal(reopened?.decision, null);
    assert.equal(reopened?.decidedAt, null);

    assert.equal(await decideReviewItem(999999, "approve"), null);
    const listed = await listReviewItems();
    assert.ok(listed.some((r) => r.id === item.id));
  } finally {
    await clearMediaArchiveDomain();
  }
});

/* ----------------------------- native client ----------------------------- */

test("native client: six operations from the merged tables, contract-validated", async () => {
  if (!pgUp) return assert.fail("PG required for native client tests");
  await clearMediaArchiveDomain();
  const { db } = await import("@/db");
  const {
    archiveObservations,
    archiveReviewItems,
    mediaProviders,
    mediaRefreshes,
    reconciliationRuns,
  } = await import("@/db/schema");
  const { sealSecret } = await import("../secretBox");
  const { createNativeArchiveContextClient } = await import("./contextClient");
  const { validateContract } = await import("../archive-assistant/validate");

  await db.insert(mediaProviders).values({
    kind: "plex",
    baseUrl: "http://127.0.0.1:32400",
    tokenSealed: sealSecret("tok"),
    lastSyncAt: new Date(),
  });
  await db.insert(mediaRefreshes).values([
    {
      refreshId: "aaaaaaaa-0000-4000-8000-000000000001",
      providerKind: "plex",
      status: "synced",
      snapshotCompleteness: "complete",
      itemCount: 10,
      snapshotReference: "snap-a",
      startedAt: new Date(Date.now() - 7_200_000),
      completedAt: new Date(Date.now() - 7_140_000),
    },
    {
      refreshId: "aaaaaaaa-0000-4000-8000-000000000002",
      providerKind: "plex",
      status: "sync_error",
      snapshotCompleteness: "partial",
      reason: "connection lost mid-fetch",
      startedAt: new Date(Date.now() - 600_000),
      completedAt: new Date(Date.now() - 540_000),
    },
  ]);
  const [review] = await db
    .insert(archiveReviewItems)
    .values({
      subjectKey: "movie|heat|1995",
      title: "Heat (1995)",
      kind: "identity",
      state: "needs_you",
      classification: "local_only",
      payload: { summary: "Not indexed by any library." },
      evidence: ["archive index"],
    })
    .returning();
  await db.insert(archiveObservations).values({
    reviewItemId: review.id,
    evidenceKey: "ek-1",
    payload: { summary: "observed" },
  });
  await db.insert(reconciliationRuns).values({
    summary: { localCount: 1, providerCount: 10, matchedCount: 0, localOnlyCount: 1, providerOnlyCount: 10, uncertainCount: 0, duplicateCount: 0, qualityConflictCount: 0 },
  });

  try {
    const client = createNativeArchiveContextClient();

    const overview = await client.getOverview();
    validateContract("AssistantOverview", overview);
    assert.equal(overview.summary.attentionCount, 1);
    assert.equal(overview.summary.counts.high, 1);
    assert.ok(overview.informational.some((line) => line.includes("plex connected")));
    assert.equal(overview.activeWork.acquisitionJobs, 0); // honest: not merged
    assert.equal(overview.discovery.upcoming.status, "not_available"); // honest

    const workload = await client.getWorkload();
    validateContract("AssistantWorkload", workload);
    assert.equal(workload.counts.needs_you, 1);
    assert.equal(workload.items[0].reviewItemId, review.id);
    assert.equal(workload.items[0].findingClassification, "local_only");
    assert.equal(workload.items[0].needsUserAction, true);
    assert.ok(workload.items[0].currentObservationId);

    const reconciliation = await client.getReconciliationSummary();
    validateContract("ReconciliationSummary", reconciliation);
    assert.equal(reconciliation.localCount, 1);
    assert.equal(reconciliation.plexCount, 10);

    const state = await client.getProviderRefreshState("plex");
    validateContract("ProviderRefreshState", state);
    assert.equal(state.lastAttemptedRefresh!.status, "sync_error");
    assert.equal(state.currentAuthoritativeRefresh!.refreshId, "aaaaaaaa-0000-4000-8000-000000000001");
    assert.equal(state.currentAuthoritativeRefresh!.authoritative, true);
    assert.equal(state.lastAttemptedRefresh!.authoritative, false);
    const jellyfinState = await client.getProviderRefreshState("jellyfin");
    assert.equal(jellyfinState.lastAttemptedRefresh, null); // never attempted, honestly

    const history = await client.getProviderRefreshHistory("plex", { page: 1, pageSize: 10 });
    validateContract("ProviderRefreshHistory", history);
    assert.equal(history.results.length, 2);
    assert.equal(history.pagination.total, 2);
    const pageTwo = await client.getProviderRefreshHistory("plex", { page: 2, pageSize: 1 });
    assert.equal(pageTwo.results.length, 1);

    const lineage = await client.getFindingLineage(review.id);
    validateContract("ReconciliationFindingLineage", lineage);
    assert.equal(lineage.finding.reviewItemId, review.id);
    assert.equal(lineage.currentObservation!.evidenceKey, "ek-1");
  } finally {
    await clearMediaArchiveDomain();
  }
});

/* ----------------------------- bridge status ----------------------------- */

test("bridge status: native states — no providers, ready, degraded", async () => {
  if (!pgUp) return assert.fail("PG required for bridge status tests");
  await clearMediaArchiveDomain();
  const { getArchiveBridgeStatus } = await import("../archive-assistant/bridge-status");
  const { db } = await import("@/db");
  const { mediaProviders, mediaRefreshes } = await import("@/db/schema");
  const { sealSecret } = await import("../secretBox");

  const empty = await getArchiveBridgeStatus();
  assert.equal(empty.state, "no_providers");

  await db.insert(mediaProviders).values({
    kind: "plex",
    baseUrl: "http://127.0.0.1:32400",
    tokenSealed: sealSecret("tok"),
    lastSyncAt: new Date(),
  });
  const ready = await getArchiveBridgeStatus();
  assert.ok(ready.state === "ready");
  assert.equal(ready.providers, 1);

  await db.insert(mediaRefreshes).values({ providerKind: "plex", status: "syncing" });
  const syncing = await getArchiveBridgeStatus();
  assert.equal(syncing.state, "syncing");

  await db.delete(mediaRefreshes);
  await db.update(mediaProviders).set({ lastError: "boom" });
  const degraded = await getArchiveBridgeStatus();
  assert.ok(degraded.state === "degraded");
  await clearMediaArchiveDomain();
});

// One shared pool lifecycle for the whole file.
after(async () => {
  if (pgUp) {
    const { pool } = await import("@/db");
    await pool.end().catch(() => {});
  }
});
