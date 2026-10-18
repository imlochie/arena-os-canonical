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
const artifactRoutes = fixture === null ? null : await import("../artifacts/route");
const artifactIdRoutes = fixture === null ? null : await import("../artifacts/[id]/route");
const projectArtifactRoutes = fixture === null ? null : await import("../projects/[id]/artifacts/route");
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
  const created = await routes.POST(arcadeRequest("/api/arcade", { prompt: "a calm asteroid drifter", gameType: "arena" }));
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

test("artifact reads are owner-private: no cross-owner or anonymous access", async (t) => {
  if (fixture === null || artifactRoutes === null || artifactIdRoutes === null || projectArtifactRoutes === null) {
    return t.skip("embedded postgres platform package unavailable");
  }

  const { db } = await import("@/db");
  const { projects } = await import("@/db/schema");
  const { insertArtifact, deleteArtifact } = await import("@/lib/arcadeStore");
  const owner = "00000000-0000-4000-8000-000000000001";
  const other = "99999999-9999-4000-8000-000000000009";

  const [project] = await db.insert(projects).values({ name: "artifact read fixture" }).returning();
  const mine = await insertArtifact(db, { projectId: project.id, kind: "brief", title: "mine", body: "private brief", sourceType: "manual", ownerId: owner });
  const foreign = await insertArtifact(db, { projectId: project.id, kind: "brief", title: "foreign", body: "another owner's brief", sourceType: "manual", ownerId: other });

  const get = (path: string, host = "127.0.0.1") =>
    new Request(`http://127.0.0.1${path}`, { headers: { host } });
  const byId = (id: string) => ({ params: Promise.resolve({ id }) });
  let createdArtifact: { id: string; ownerId: string } | undefined;

  try {
    // 1. The library lists only the caller's artifacts.
    const list = await artifactRoutes.GET(get("/api/artifacts"));
    assert.equal(list.status, 200);
    const listed = ((await list.json()) as { artifacts: Array<{ id: string }> }).artifacts.map((a) => a.id);
    assert.ok(listed.includes(mine.id), "own artifact is listed");
    assert.ok(!listed.includes(foreign.id), "a foreign artifact must never be listed");

    // 2. The project-scoped route is the same table, so it must enforce the
    //    same boundary (otherwise it would be a trivial bypass).
    const projectList = await projectArtifactRoutes.GET(get(`/api/projects/${project.id}/artifacts`), byId(project.id));
    assert.equal(projectList.status, 200);
    const projectListed = ((await projectList.json()) as { artifacts: Array<{ id: string }> }).artifacts.map((a) => a.id);
    assert.deepEqual(projectListed, [mine.id]);

    // 2b. Creating through the project route records the caller as owner.
    const createdResponse = await projectArtifactRoutes.POST(
      new Request(`http://127.0.0.1/api/projects/${project.id}/artifacts`, {
        method: "POST",
        headers: { "content-type": "application/json", host: "127.0.0.1" },
        body: JSON.stringify({ kind: "brief", title: "new", body: "created through the project route" }),
      }),
      byId(project.id),
    );
    assert.equal(createdResponse.status, 201);
    createdArtifact = ((await createdResponse.json()) as { artifact: { id: string; ownerId: string } }).artifact;
    assert.equal(createdArtifact.ownerId, owner);

    // 3. Own id resolves; a foreign id answers 404 (existence is not leaked);
    //    a malformed id is a clean 404 rather than a database error.
    const own = await artifactIdRoutes.GET(get(`/api/artifacts/${mine.id}`), byId(mine.id));
    assert.equal(own.status, 200);
    const foreignRead = await artifactIdRoutes.GET(get(`/api/artifacts/${foreign.id}`), byId(foreign.id));
    assert.equal(foreignRead.status, 404);
    const junk = await artifactIdRoutes.GET(get("/api/artifacts/junk"), byId("junk"));
    assert.equal(junk.status, 404);

    // 4. In production web mode (no local trust, no session) every artifact
    //    read fails closed — this is the anonymous-exposure regression.
    const env = process.env as Record<string, string | undefined>;
    const previousEnv = { NODE_ENV: env.NODE_ENV, ARENA_DESKTOP_MODE: env.ARENA_DESKTOP_MODE };
    env.NODE_ENV = "production";
    delete env.ARENA_DESKTOP_MODE;
    try {
      const anonymousList = await artifactRoutes.GET(get("/api/artifacts", "arena.example"));
      assert.equal(anonymousList.status, 401);
      const anonymousById = await artifactIdRoutes.GET(get(`/api/artifacts/${mine.id}`, "arena.example"), byId(mine.id));
      assert.equal(anonymousById.status, 401);
      const anonymousProject = await projectArtifactRoutes.GET(get(`/api/projects/${project.id}/artifacts`, "arena.example"), byId(project.id));
      assert.equal(anonymousProject.status, 401);
    } finally {
      if (previousEnv.NODE_ENV === undefined) delete env.NODE_ENV;
      else env.NODE_ENV = previousEnv.NODE_ENV;
      if (previousEnv.ARENA_DESKTOP_MODE === undefined) delete env.ARENA_DESKTOP_MODE;
      else env.ARENA_DESKTOP_MODE = previousEnv.ARENA_DESKTOP_MODE;
    }
  } finally {
    await deleteArtifact(db, mine.id, owner);
    await deleteArtifact(db, foreign.id, other);
    if (createdArtifact) await deleteArtifact(db, createdArtifact.id, owner);
    await db.delete(projects).where(eq(projects.id, project.id));
  }
});


test("arcade rejects unsupported offline mechanics and persists verified provenance", async (t) => {
  if (!fixture || !routes) return t.skip("embedded postgres platform package unavailable");
  const unsupported = await routes.POST(arcadeRequest("/api/arcade", { prompt: "a railway logistics puzzle with cargo contracts" }));
  assert.equal(unsupported.status, 422);
  assert.match((await unsupported.json()).error, /No offline template/);
  const { generateGameOffline } = await import("@/lib/games");
  const core = generateGameOffline("snake");
  const saved = await routes.POST(arcadeRequest("/api/arcade", {
    prompt: "snake", clientCode: core.code, gameType: core.gameType, engine: core.engine,
  }));
  assert.equal(saved.status, 201);
  const { game } = await saved.json();
  assert.equal(game.engine, "verified");
  const reopened = await idRoutes!.GET(new Request(`http://127.0.0.1/api/arcade/${game.id}`), { params: Promise.resolve({ id: game.id }) });
  const persisted = (await reopened.json()).game;
  assert.equal(persisted.code, core.code);
  assert.equal(persisted.engine, "verified");
});

test("generative route rejects invalid iteration context and unavailable model honestly", async (t) => {
  if (!fixture) return t.skip("embedded postgres platform package unavailable");
  const forge = await import("./forge/route");
  const invalid = await forge.POST(arcadeRequest("/api/arcade/forge", { prompt: "add cargo", priorCode: "broken" }));
  assert.equal(invalid.status, 400);
  const unavailable = await forge.POST(arcadeRequest("/api/arcade/forge", { prompt: "railway logistics puzzle", localOnly: true }));
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).code, undefined);
});

test("artifact storage outage is an actionable 503; recovery returns the saved work", async (t) => {
  if (!fixture || !artifactRoutes || !projectArtifactRoutes) return t.skip("embedded postgres platform package unavailable");
  const { pool } = await import("@/db");
  const projectId = "11111111-1111-4111-8111-111111111111";
  const saved = await artifactRoutes.POST(arcadeRequest("/api/artifacts", { title: "Storage recovery probe", body: "Persisted evidence survives unavailable reads", kind: "research" }));
  assert.equal(saved.status, 201);
  const { artifact } = await saved.json();
  const request = () => new Request("http://127.0.0.1/api/artifacts", { headers: { host: "127.0.0.1" } });
  // Real PostgreSQL schema fault, not a mocked successful database response.
  await pool.query("alter table artifacts rename to artifacts_outage_probe");
  try {
    const unavailable = await artifactRoutes.GET(request());
    assert.equal(unavailable.status, 503);
    const body = await unavailable.json(); assert.match(body.error, /storage unavailable/i); assert.equal(body.artifacts, undefined);
    assert.equal((await projectArtifactRoutes.GET(request(), { params: Promise.resolve({ id: projectId }) })).status, 503);
  } finally { await pool.query("alter table artifacts_outage_probe rename to artifacts"); }
  const recovered = await artifactRoutes.GET(request()); assert.equal(recovered.status, 200);
  assert.ok((await recovered.json()).artifacts.some((row: { id: string }) => row.id === artifact.id));
});
