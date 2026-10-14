/**
 * Job-claim tests — "one ACTIVE attempt per target", proven at the
 * database, which is where the guarantee lives.
 *
 * Lifecycle on PGlite (the canonical desktop migrations, in memory):
 *   - a second claim while the first attempt is queued/running is refused
 *     and names the active holder (what the routes turn into a 409);
 *   - once that attempt is complete, failed, or cancelled, the SAME target
 *     is claimable again as a FRESH row — the old row stays as history;
 *   - the old whole-key uniqueness is gone (the migration dropped it).
 *
 * Concurrency on the real embedded PostgreSQL cluster (the same binaries
 * the desktop ships), many connections at once: a burst of simultaneous
 * claims yields exactly one new job and every loser names it; a burst
 * after the attempt is over yields exactly one fresh row; and a retry of an
 * earlier failed row racing a fresh claim can never leave two active rows.
 * Skipped visibly when the embedded binaries are not installed.
 */

import "../worker-local/_separation-test-env";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";

import { processingJobIsActive, processingJobs, projects, sourceAssets } from "@/db/waveyardSchema";
import { SEPARATION_QUEUE } from "@/lib/waveyard/queue";
import { getLocalJobBroker, resetLocalJobBrokerForTests } from "@/lib/waveyard/worker-local/broker";
import { claimProcessingJob, findActiveProcessingJob, type ClaimDb, type ProcessingJobInsert } from "./claim";
import { retrySeparationJob, type SeparationDb } from "./retry";

const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));

async function seedProjectAndSource(database: ClaimDb) {
  const [project] = await (database as SeparationDb)
    .insert(projects)
    .values({ ownerId: randomUUID(), title: "Claim" })
    .returning();
  const [source] = await (database as SeparationDb)
    .insert(sourceAssets)
    .values({
      projectId: project.id,
      originalFilename: "source.wav",
      mimeType: "audio/wav",
      storageKey: `projects/${project.id}/source/${randomUUID()}.wav`,
      checksumSha256: "0".repeat(64),
      durationSeconds: 1,
      sampleRate: 44_100,
      channels: 2,
      codec: "pcm_s16le",
      fileSizeBytes: 176_400,
    })
    .returning();
  return { project, source };
}

function deepJobValues(projectId: string, sourceAssetId: string, idempotencyKey: string): ProcessingJobInsert {
  return {
    projectId,
    sourceAssetId,
    type: "separation",
    status: "queued",
    stage: "queued",
    idempotencyKey,
    model: "deep_6s",
    requestedDevice: "auto",
    metadata: JSON.stringify({ kind: "deep-stems", deep: true }),
  };
}

async function pgliteFixture() {
  const client = new PGlite();
  const { applyMigrations } = await import("../../../../desktop/runtime/migrate");
  await applyMigrations({ client: client as unknown as import("pg").Client, migrationsDir: path.join(repoRoot, "desktop-migrations") });
  const database = drizzlePglite(client) as unknown as SeparationDb;
  const { project, source } = await seedProjectAndSource(database);
  return {
    database,
    project,
    source,
    async finish(jobId: string, status: "complete" | "failed" | "cancelled") {
      await database
        .update(processingJobs)
        .set({ status, stage: status, completedAt: new Date(), ...(status === "failed" ? { errorCode: "separation_failed" } : {}) })
        .where(eq(processingJobs.id, jobId));
    },
    async close() {
      await client.close();
    },
  };
}

test("a second claim while the first attempt is queued or running is refused and names the holder", async () => {
  const f = await pgliteFixture();
  try {
    const key = `separation-deep:${f.source.id}`;
    const first = await claimProcessingJob(f.database, deepJobValues(f.project.id, f.source.id, key));
    assert.equal(first.created, true);
    if (!first.created) return;

    for (const status of ["queued", "preparing", "processing", "finalizing"] as const) {
      await f.database.update(processingJobs).set({ status, stage: status }).where(eq(processingJobs.id, first.job.id));
      const again = await claimProcessingJob(f.database, deepJobValues(f.project.id, f.source.id, key));
      assert.equal(again.created, false, `refused while ${status}`);
      if (again.created) return;
      assert.equal(again.active?.id, first.job.id, "the refusal names the attempt that holds the target");
      assert.equal(again.active?.status, status);
    }
    const rows = await f.database.select().from(processingJobs).where(eq(processingJobs.idempotencyKey, key));
    assert.equal(rows.length, 1, "no second row was created");
    assert.equal((await findActiveProcessingJob(f.database, key))?.id, first.job.id);

    // Another target is independent — its own key, its own attempt.
    const other = await claimProcessingJob(f.database, deepJobValues(f.project.id, f.source.id, `separation-deep:${randomUUID()}`));
    assert.equal(other.created, true);
  } finally {
    await f.close();
  }
});

test("once the attempt is complete, failed, or cancelled the same target is claimable again — as a fresh row, history kept", async () => {
  const f = await pgliteFixture();
  try {
    const key = `separation-deep:${f.source.id}`;
    const seen: string[] = [];
    for (const terminal of ["complete", "failed", "cancelled"] as const) {
      const claim = await claimProcessingJob(f.database, deepJobValues(f.project.id, f.source.id, key));
      assert.equal(claim.created, true, `claimable after ${seen.join(", ") || "nothing"}`);
      if (!claim.created) return;
      assert.ok(!seen.includes(claim.job.id), "a FRESH row, not the old one resurrected");
      assert.equal(claim.job.status, "queued");
      assert.equal(claim.job.errorCode, null);
      seen.push(claim.job.id);
      await f.finish(claim.job.id, terminal);
      assert.equal(await findActiveProcessingJob(f.database, key), null, `nothing active after ${terminal}`);
    }
    const rows = await f.database.select().from(processingJobs).where(eq(processingJobs.idempotencyKey, key));
    assert.deepEqual(
      rows.map((row) => row.status).sort(),
      ["cancelled", "complete", "failed"],
      "every earlier attempt stays as history under the same key",
    );
  } finally {
    await f.close();
  }
});

test("the database itself refuses two active rows for one target — no application check involved", async () => {
  const f = await pgliteFixture();
  try {
    const key = `separation-layer:${randomUUID()}:guitar`;
    await f.database.insert(processingJobs).values({ ...deepJobValues(f.project.id, f.source.id, key), status: "processing", stage: "processing" });
    await assert.rejects(
      () => f.database.insert(processingJobs).values(deepJobValues(f.project.id, f.source.id, key)),
      (error: unknown) => {
        const text = (error instanceof Error ? error.message : "") + String((error as { cause?: unknown })?.cause ?? "");
        assert.match(text, /processing_jobs_active_idempotency_unique/);
        return true;
      },
    );
    // …while a terminal row never blocks (the whole-key constraint is gone).
    await f.finish((await findActiveProcessingJob(f.database, key))!.id, "complete");
    await f.database.insert(processingJobs).values({ ...deepJobValues(f.project.id, f.source.id, key), status: "complete", stage: "complete" });
    await f.database.insert(processingJobs).values(deepJobValues(f.project.id, f.source.id, key));
    const active = await f.database
      .select()
      .from(processingJobs)
      .where(and(eq(processingJobs.idempotencyKey, key), processingJobIsActive(processingJobs.status)));
    assert.equal(active.length, 1);
  } finally {
    await f.close();
  }
});

// ---------------------------------------------------------------------------
// Real concurrency: embedded PostgreSQL, many connections.
// ---------------------------------------------------------------------------

function embeddedBinary(name: string): string {
  const pkg = process.platform === "win32" ? "windows-x64" : "linux-x64";
  const exe = process.platform === "win32" ? `${name}.exe` : name;
  return path.join(repoRoot, "node_modules", "@embedded-postgres", pkg, "native", "bin", exe);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function embeddedPostgres(t: TestContext) {
  if (!existsSync(embeddedBinary("initdb")) || !existsSync(embeddedBinary("postgres"))) {
    t.skip("embedded PostgreSQL binaries are not installed here — the concurrency proof needs a real multi-connection server");
    return null;
  }
  const root = mkdtempSync(path.join(tmpdir(), "wy-claim-pg-"));
  const dataDir = path.join(root, "pgdata");
  const port = await freePort();
  const pwFile = path.join(root, ".pw");
  writeFileSync(pwFile, "arena-test", { mode: 0o600 });
  const init = spawnSync(
    embeddedBinary("initdb"),
    ["-D", dataDir, "-U", "arena", "--pwfile", pwFile, "-E", "UTF8", "--locale", "C", "-A", "scram-sha-256"],
    { encoding: "utf8", timeout: 120_000 },
  );
  rmSync(pwFile, { force: true });
  if (init.status !== 0) throw new Error(`initdb failed (${init.status}): ${(init.stdout ?? "") + (init.stderr ?? "")}`.slice(0, 2000));
  const postgresProcess: ChildProcess = spawn(
    embeddedBinary("postgres"),
    ["-D", dataDir, "-p", String(port), "-h", "127.0.0.1", "-F", "-c", "max_connections=50"],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  const { Client, Pool } = await import("pg");
  const { waitForPostgresReady } = await import("../library/pg-readiness");
  await waitForPostgresReady({
    createClient: () => new Client({ connectionString: `postgresql://arena:arena-test@127.0.0.1:${port}/postgres` }),
    useConnectedClient: async (admin) => {
      await admin.query("create database arena_claim_test");
    },
  });
  const connectionString = `postgresql://arena:arena-test@127.0.0.1:${port}/arena_claim_test`;
  const migrator = new Client({ connectionString });
  await migrator.connect();
  const { applyMigrations } = await import("../../../../desktop/runtime/migrate");
  await applyMigrations({ client: migrator, migrationsDir: path.join(repoRoot, "desktop-migrations") });
  await migrator.end();

  const pool = new Pool({ connectionString, max: 24 });
  const database = drizzlePg(pool) as unknown as SeparationDb;
  return {
    database,
    async close() {
      await pool.end().catch(() => undefined);
      spawnSync(embeddedBinary("pg_ctl"), ["-D", dataDir, "-m", "fast", "-w", "-t", "20", "stop"], { timeout: 30_000 });
      if (postgresProcess.exitCode === null) postgresProcess.kill();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("concurrent requests on real PostgreSQL never create two active attempts for one target", async (t) => {
  const pg = await embeddedPostgres(t);
  if (pg === null) return;
  try {
    const { project, source } = await seedProjectAndSource(pg.database);
    const key = `separation-deep:${source.id}`;
    const burst = 16;

    // 1. Sixteen simultaneous first requests → exactly one job; every other
    //    caller is refused and told which job holds the target.
    const outcomes = await Promise.all(
      Array.from({ length: burst }, () => claimProcessingJob(pg.database, deepJobValues(project.id, source.id, key))),
    );
    const created = outcomes.filter((outcome) => outcome.created);
    assert.equal(created.length, 1, `exactly one created, got ${created.length}`);
    const winner = created[0].created ? created[0].job : null;
    for (const outcome of outcomes) {
      if (outcome.created) continue;
      assert.equal(outcome.active?.id, winner?.id, "every refusal names the winning attempt");
    }
    const activeRows = async () =>
      pg.database
        .select()
        .from(processingJobs)
        .where(and(eq(processingJobs.idempotencyKey, key), processingJobIsActive(processingJobs.status)));
    assert.equal((await activeRows()).length, 1);

    // 2. The attempt fails. Sixteen simultaneous retries-by-request → exactly
    //    one FRESH row; the failed one stays as history.
    await pg.database
      .update(processingJobs)
      .set({ status: "failed", stage: "failed", errorCode: "separation_failed", completedAt: new Date() })
      .where(eq(processingJobs.id, winner!.id));
    const second = await Promise.all(
      Array.from({ length: burst }, () => claimProcessingJob(pg.database, deepJobValues(project.id, source.id, key))),
    );
    const fresh = second.filter((outcome) => outcome.created);
    assert.equal(fresh.length, 1);
    const freshJob = fresh[0].created ? fresh[0].job : null;
    assert.notEqual(freshJob?.id, winner?.id, "a new attempt, not the failed row");
    assert.equal((await activeRows()).length, 1);
    const all = await pg.database.select().from(processingJobs).where(eq(processingJobs.idempotencyKey, key));
    assert.deepEqual(all.map((row) => row.status).sort(), ["failed", "queued"]);

    // 3. The fresh attempt completes; now a retry of the OLD failed row races
    //    a brand-new claim for the same target. Whichever wins, there is
    //    never more than one active row — the index arbitrates the UPDATE
    //    (unique_violation → honest reason) exactly as it does the INSERT.
    await pg.database
      .update(processingJobs)
      .set({ status: "complete", stage: "complete", completedAt: new Date() })
      .where(eq(processingJobs.id, freshJob!.id));
    process.env.ARENA_DESKTOP_MODE = "1";
    resetLocalJobBrokerForTests();
    getLocalJobBroker().register(SEPARATION_QUEUE, async () => undefined);
    try {
      for (let round = 0; round < 6; round += 1) {
        const [retried, claimed]: [Awaited<ReturnType<typeof retrySeparationJob>>, Awaited<ReturnType<typeof claimProcessingJob>>] =
          await Promise.all([
            retrySeparationJob(pg.database, winner!.id),
            claimProcessingJob(pg.database, deepJobValues(project.id, source.id, key)),
          ]);
        const active = await activeRows();
        assert.equal(active.length, 1, `round ${round}: one active row (retry ${retried.queued}, claim ${claimed.created})`);
        assert.equal(
          [retried.queued, claimed.created].filter(Boolean).length,
          1,
          `round ${round}: exactly one of them won — retry: ${JSON.stringify(retried)}, claim: ${claimed.created}`,
        );
        if (!retried.queued) assert.match(retried.reason, /newer attempt/);
        // Settle for the next round: the active row (whichever it is) fails.
        await pg.database
          .update(processingJobs)
          .set({ status: "failed", stage: "failed", errorCode: "separation_failed", completedAt: new Date() })
          .where(inArray(processingJobs.id, active.map((row) => row.id)));
      }
    } finally {
      resetLocalJobBrokerForTests();
      delete process.env.ARENA_DESKTOP_MODE;
    }
  } finally {
    await pg.close();
  }
});
