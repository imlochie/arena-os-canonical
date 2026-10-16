/**
 * Arcade API security tests — real embedded PostgreSQL, real route handlers.
 *
 * What these prove (docs: the arcade surface must not allow unauthenticated
 * arbitrary-HTML insertion or cross-owner deletion):
 *   - persisting only happens for code that passed validation;
 *   - every persisted game records its owner;
 *   - DELETE is ownership-scoped (a foreign row is refused and survives);
 *   - the catalogue read path stays open (public reads are by design).
 *
 * Skips only when the platform has no embedded-postgres package.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { join } from "node:path";
import { after, test } from "node:test";
import { eq } from "drizzle-orm";

async function bootFixture() {
  const root = await mkdtemp(join(tmpdir(), "arena-arcade-test-"));
  const platformPackage = `@embedded-postgres/${process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux"}-x64`;
  const nativeDir = path.join(process.cwd(), "node_modules", platformPackage, "native");
  if (!existsSync(path.join(nativeDir, "bin"))) {
    await rm(root, { recursive: true, force: true });
    return null;
  }
  const { EmbeddedPostgres } = await import("../../../../desktop/runtime/embedded-postgres");
  const { applyMigrations } = await import("../../../../desktop/runtime/migrate");
  const { pickFreePort } = await import("../../../../desktop/runtime/config");
  const ext = process.platform === "win32" ? ".exe" : "";
  const config = {
    dirs: {
      root, data: join(root, "data"), projects: join(root, "projects"), waveyard: join(root, "waveyard"),
      cache: join(root, "cache"), logs: join(root, "logs"), models: join(root, "models"),
      runtime: join(root, "runtime"), settings: join(root, "settings"), portable: false, source: "env" as const,
    },
    host: "127.0.0.1",
    port: 0,
    database: {
      user: "arena", password: "test-password", name: "arena_arcade_test", port: 0,
      socketDir: process.platform === "win32" ? null : join(root, "runtime", "pg-sockets"),
      dataDir: join(root, "data", "postgres"),
    },
    postgres: {
      nativeDir,
      initdb: join(nativeDir, "bin", `initdb${ext}`),
      pgCtl: join(nativeDir, "bin", `pg_ctl${ext}`),
      postgres: join(nativeDir, "bin", `postgres${ext}`),
      libDir: join(nativeDir, "lib"),
      windowsPathDirs: [],
    },
    migrationsDir: path.join(process.cwd(), "desktop-migrations"),
    ffmpegPath: null, ffprobePath: null,
    storageDir: join(root, "waveyard", "storage"),
    modelsDir: join(root, "waveyard", "models"),
    server: { kind: "dev" as const, cwd: root, nodeBinary: process.execPath },
    mode: "desktop" as const,
  };
  config.port = await pickFreePort("127.0.0.1");
  config.database.port = await pickFreePort("127.0.0.1");

  const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
  const postgres = new (EmbeddedPostgres as any)(config, silent);
  await postgres.ensureStarted();
  await postgres.createDatabaseIfMissing();
  const { Client } = await import("pg");
  const client = new Client(postgres.clientConfig(config.database.name));
  await client.connect();
  await applyMigrations({ client, migrationsDir: config.migrationsDir });
  await client.end();

  // The db pool is created at module import — the URL must be in place first.
  process.env.DATABASE_URL = `postgres://arena:test-password@127.0.0.1:${config.database.port}/arena_arcade_test`;
  return {
    postgres,
    stop: async () => {
      await postgres.stop(10_000);
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** A minimal game that passes validateGameCode. */
function validGameHtml(): string {
  const core = `
<canvas id="game" width="480" height="480"></canvas>
<script>
function __hud(score){ document.title = "score " + score; }
var score = 0;
var c = document.getElementById("game");
var ctx = c.getContext("2d");
function loop(){ ctx.fillRect(0,0,10,10); score++; __hud(score); requestAnimationFrame(loop); }
requestAnimationFrame(loop);
window.addEventListener("keydown", function(e){ score += e.keyCode; });
window.addEventListener("touchstart", function(){ score += 1; });
window.addEventListener("pointerdown", function(){ score += 1; });
</script>`;
  // validateGameCode requires >= 1500 bytes — pad with an honest comment.
  return `<!DOCTYPE html><html><head><title>probe game</title></head><body>${core}\n<!-- ${"arena regression fixture padding ".repeat(40)} -->\n</body></html>`;
}

const fixture = await bootFixture();
const routes = fixture === null ? null : await import("./route");
const idRoutes = fixture === null ? null : await import("./[id]/route");
if (fixture !== null) {
  after(async () => {
    // End the app pool BEFORE the server goes away — otherwise its idle
    // clients notice the shutdown as async errors after the tests ended.
    try {
      const { pool } = await import("@/db");
      await pool.end();
    } catch {
      /* pool never created (skip path) */
    }
    await fixture.stop();
  });
}

function arcadeRequest(pathname: string, body: unknown) {
  return new Request(`http://127.0.0.1${pathname}`, {
    method: "POST",
    // Explicit Host: undici's Request() carries none (fetch adds it at send
    // time) and the access guard correctly fails closed on a missing Host.
    headers: { "content-type": "application/json", host: "127.0.0.1" },
    body: JSON.stringify(body),
  });
}

test("arcade security: validation gate, owner scoping, ownership-checked delete", async (t) => {
  if (fixture === null || routes === null || idRoutes === null) {
    return t.skip("embedded postgres platform package unavailable");
  }

  // 1. Valid generated game is persisted and records its owner.
  const created = await routes.POST(arcadeRequest("/api/arcade", { prompt: "a calm asteroid drifter" }));
  assert.equal(created.status, 201);
  const createdBody = (await created.json()) as { game: { id: string; ownerId: string }; validation: { ok: boolean } };
  assert.equal(createdBody.validation.ok, true);
  assert.equal(createdBody.game.ownerId, "00000000-0000-4000-8000-000000000001");

  // 2. Unvalidated client code (too short, no canvas) is refused and NOT stored.
  const junk = await routes.POST(arcadeRequest("/api/arcade", { prompt: "junk", clientCode: "<html><script>evil()</script></html>" }));
  assert.equal(junk.status, 400);

  // 3. Valid client code persists with the caller as owner.
  const clientGame = await routes.POST(arcadeRequest("/api/arcade", { prompt: "client game", clientCode: validGameHtml() }));
  assert.equal(clientGame.status, 201);
  const clientBody = (await clientGame.json()) as { game: { id: string; ownerId: string } };
  assert.equal(clientBody.game.ownerId, "00000000-0000-4000-8000-000000000001");

  // 4. Cross-owner delete is refused and the record survives.
  const { db } = await import("@/db");
  const { arcadeGames } = await import("@/db/schema");
  const [foreign] = await db
    .insert(arcadeGames)
    .values({ prompt: "foreign", gameType: "arena", engine: "verified", code: validGameHtml(), ownerId: "99999999-9999-4000-8000-000000000009" })
    .returning();
  const forbidden = await idRoutes.DELETE(new Request(`http://127.0.0.1/api/arcade/${foreign.id}`, { method: "DELETE", headers: { host: "127.0.0.1" } }), {
    params: Promise.resolve({ id: foreign.id }),
  });
  assert.equal(forbidden.status, 403);
  const [stillThere] = await db.select().from(arcadeGames).where(eq(arcadeGames.id, foreign.id)).limit(1);
  assert.ok(stillThere, "foreign record must survive a refused delete");

  // 5. Own delete works; unknown id is a clean 404.
  const ok = await idRoutes.DELETE(new Request(`http://127.0.0.1/api/arcade/${createdBody.game.id}`, { method: "DELETE", headers: { host: "127.0.0.1" } }), {
    params: Promise.resolve({ id: createdBody.game.id }),
  });
  assert.equal(ok.status, 200);
  const missing = await idRoutes.DELETE(new Request("http://127.0.0.1/api/arcade/11111111-1111-4111-8111-111111111111", { method: "DELETE", headers: { host: "127.0.0.1" } }), {
    params: Promise.resolve({ id: "11111111-1111-4111-8111-111111111111" }),
  });
  assert.equal(missing.status, 404);

  // 6. The catalogue read path stays open (public reads are by design).
  const listing = await routes.GET(new Request("http://127.0.0.1/api/arcade", { headers: { host: "127.0.0.1" } }));
  assert.equal(listing.status, 200);
  const listBody = (await listing.json()) as { games: unknown[] };
  assert.ok(Array.isArray(listBody.games));
});

test("artifact mutations are ownership-scoped the same way", async (t) => {
  if (fixture === null) return t.skip("embedded postgres platform package unavailable");

  const { db } = await import("@/db");
  const { insertArtifact, updateArtifact, deleteArtifact } = await import("@/lib/arcadeStore");
  const owner = "00000000-0000-4000-8000-000000000001";
  const other = "99999999-9999-4000-8000-000000000009";

  const artifact = await insertArtifact(db, { kind: "brief", title: "t", body: "b", sourceType: "manual", ownerId: owner });
  assert.equal(artifact.ownerId, owner);

  assert.equal((await deleteArtifact(db, artifact.id, other)).toString(), "forbidden");
  const kept = await updateArtifact(db, artifact.id, other, { title: "hijacked" });
  assert.equal(kept.outcome, "forbidden");
  assert.equal(kept.row, undefined);

  const mine = await updateArtifact(db, artifact.id, owner, { title: "renamed" });
  assert.equal(mine.outcome, "ok");
  assert.equal(mine.row?.title, "renamed");
  assert.equal(await deleteArtifact(db, artifact.id, owner), "ok");
  assert.equal(await deleteArtifact(db, artifact.id, owner), "not_found");
});
