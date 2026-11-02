import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import path from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";

const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const pgPackage = `@embedded-postgres/${process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux"}-x64`;
const nativeDir = path.join(root, "node_modules", pgPackage, "native");

function findPostgresBinary(name: string): string | undefined {
  const extension = process.platform === "win32" ? ".exe" : "";
  const bundled = path.join(nativeDir, "bin", `${name}${extension}`);
  if (existsSync(bundled)) return bundled;
  const located = spawnSync(process.platform === "win32" ? "where.exe" : "which", [`${name}${extension}`], { encoding: "utf8" })
    .stdout?.trim().split(/\r?\n/)[0];
  return located && existsSync(located) ? located : undefined;
}

const postgresBinaries = {
  initdb: findPostgresBinary("initdb"),
  postgres: findPostgresBinary("postgres"),
  pgCtl: findPostgresBinary("pg_ctl"),
};

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

function makeWav(): Uint8Array {
  const sampleRate = 16_000;
  const sampleCount = sampleRate * 2;
  const dataBytes = sampleCount * 2;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(dataBytes, 40);
  for (let index = 0; index < sampleCount; index += 1) {
    wav.writeInt16LE(Math.round(12_000 * Math.sin((2 * Math.PI * 440 * index) / sampleRate)), 44 + index * 2);
  }
  return wav;
}

function uploadRequest(bytes: Uint8Array): Request {
  const form = new FormData();
  form.set("file", new File([bytes], "Concurrent upload.wav", { type: "audio/wav" }));
  form.set("title", "Concurrent upload");
  return new Request("http://127.0.0.1/api/library/tracks", {
    method: "POST",
    headers: { host: "127.0.0.1" },
    body: form,
  });
}

test("concurrent multipart uploads return one library track and queue one separation", async (t) => {
  if (!postgresBinaries.initdb || !postgresBinaries.postgres || !postgresBinaries.pgCtl) {
    t.skip("PostgreSQL binaries are unavailable");
    return;
  }

  const fixtureRoot = await mkdtemp(join(tmpdir(), "waveyard-library-route-test-"));
  const dataDir = join(fixtureRoot, "data", "postgres");
  const databaseName = "arena_library_route_test";
  const databasePassword = "route-test-password";
  const port = await freePort();
  let postgresProcess: ReturnType<typeof spawn> | undefined;
  let dbModule: typeof import("@workspace/db") | undefined;
  try {
    await mkdir(dataDir, { recursive: true });
    const passwordFile = join(fixtureRoot, ".postgres-password");
    await writeFile(passwordFile, databasePassword, { mode: 0o600 });
    const init = spawnSync(postgresBinaries.initdb, [
      "-D", dataDir, "-U", "arena", "--pwfile", passwordFile, "-E", "UTF8", "--locale", "C", "-A", "scram-sha-256",
    ], { encoding: "utf8", timeout: 120_000 });
    await rm(passwordFile, { force: true });
    if (init.status !== 0) throw new Error(`initdb failed (${init.status}): ${(init.stdout ?? "") + (init.stderr ?? "")}`.slice(0, 2000));
    postgresProcess = spawn(postgresBinaries.postgres, [
      "-D", dataDir, "-p", String(port), "-h", "127.0.0.1", "-F", "-c", "unix_socket_directories=",
    ], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let postgresOutput = "";
    postgresProcess.stderr?.on("data", (chunk: Buffer) => { postgresOutput = (postgresOutput + chunk.toString()).slice(-4000); });

    const { Client } = createRequire(join(root, "lib/db/package.json"))("pg");
    const adminUrl = `postgres://arena:${databasePassword}@127.0.0.1:${port}/postgres`;
    const deadline = Date.now() + 30_000;
    let lastConnectionError: unknown;
    let databaseCreated = false;
    while (Date.now() < deadline && !databaseCreated) {
      const client = new Client({ connectionString: adminUrl });
      try {
        await client.connect();
        await client.query(`CREATE DATABASE ${databaseName}`);
        databaseCreated = true;
      } catch (error) {
        lastConnectionError = error;
        await client.end().catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 150));
      } finally {
        if (databaseCreated) await client.end();
      }
    }
    if (!databaseCreated) throw new Error(`PostgreSQL did not become ready: ${String(lastConnectionError)} ${postgresOutput}`);

    const client = new Client({ connectionString: `postgres://arena:${databasePassword}@127.0.0.1:${port}/${databaseName}` });
    await client.connect();
    const { migrate } = await import("../../../../../../desktop/database.mjs");
    await migrate(client, join(root, "lib/arena/desktop-migrations"));
    await client.end();

    process.env.DATABASE_URL = `postgres://arena:${databasePassword}@127.0.0.1:${port}/${databaseName}`;
    process.env.WAVEYARD_STORAGE_DIR = join(fixtureRoot, "waveyard", "storage");
    process.env.NODE_ENV = "test";

    const routes = await import("./route");
    dbModule = await import("@workspace/db");
    const schema = await import("@workspace/db/waveyardSchema");
    const { LOCAL_OWNER_ID } = await import("@workspace/db/schema");
    const bytes = makeWav();
    const responses = await Promise.all([
      routes.POST(uploadRequest(bytes)),
      routes.POST(uploadRequest(bytes)),
    ]);

    assert.deepEqual(
      responses.map((response) => response.status).sort((a, b) => a - b),
      [200, 201],
      "exactly one request creates the track and the retry reuses it",
    );
    const bodies = await Promise.all(responses.map((response) => response.json())) as Array<{
      track: { id: string; sourceAssetId: string };
      created: boolean;
    }>;
    assert.equal(bodies[0].track.id, bodies[1].track.id);
    assert.equal(bodies.filter((body) => body.created).length, 1);

    const ownerTracks = await dbModule.db.select().from(schema.tracks)
      .where(eq(schema.tracks.ownerId, LOCAL_OWNER_ID));
    assert.equal(ownerTracks.length, 1);

    const ownerSources = await dbModule.db.select({ id: schema.sourceAssets.id })
      .from(schema.sourceAssets)
      .innerJoin(schema.projects, eq(schema.projects.id, schema.sourceAssets.projectId))
      .where(and(
        eq(schema.projects.ownerId, LOCAL_OWNER_ID),
        eq(schema.projects.kind, "library"),
      ));
    assert.equal(ownerSources.length, 1);
    assert.equal(ownerTracks[0].sourceAssetId, ownerSources[0].id);

    const separationJobs = await dbModule.db.select()
      .from(schema.processingJobs)
      .where(and(
        eq(schema.processingJobs.sourceAssetId, ownerSources[0].id),
        eq(schema.processingJobs.type, "separation"),
      ));
    assert.equal(separationJobs.length, 1);
  } finally {
    try {
      await dbModule?.pool.end();
    } finally {
      if (postgresProcess && postgresProcess.exitCode === null) {
        spawnSync(postgresBinaries.pgCtl, ["-D", dataDir, "-m", "fast", "-w", "-t", "20", "stop"], { timeout: 30_000 });
        postgresProcess.kill();
      }
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  }
});
