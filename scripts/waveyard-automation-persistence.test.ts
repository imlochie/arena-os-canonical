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
import { randomUUID } from "node:crypto";

const root = fileURLToPath(new URL("../", import.meta.url));
const platformPackage = `@embedded-postgres/${process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux"}-x64`;
const nativeDir = path.join(root, "node_modules", platformPackage, "native");

function postgresBinary(name: string): string | undefined {
  const extension = process.platform === "win32" ? ".exe" : "";
  const bundled = path.join(nativeDir, "bin", `${name}${extension}`);
  if (existsSync(bundled)) return bundled;
  const result = spawnSync(process.platform === "win32" ? "where.exe" : "which", [`${name}${extension}`], { encoding: "utf8" });
  const found = result.stdout?.trim().split(/\r?\n/)[0];
  return found && existsSync(found) ? found : undefined;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function makePcmWav(): Buffer {
  const sampleRate = 16_000;
  const sampleCount = sampleRate * 8;
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
  return wav;
}

test("Studio automation survives real route saves, undo/redo, and reopening", async (t) => {
  const binaries = ["initdb", "postgres"].map((name) => [name, postgresBinary(name)] as const);
  if (binaries.some(([, binary]) => !binary)) {
    t.skip("PostgreSQL binaries are unavailable");
    return;
  }

  const fixtureRoot = await mkdtemp(join(tmpdir(), "waveyard-automation-persistence-"));
  const dataDir = join(fixtureRoot, "data", "postgres");
  const databaseName = `arena_automation_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const password = "automation-route-test";
  const port = await freePort();
  let postgres: ReturnType<typeof spawn> | undefined;
  let databaseModule: { pool: { end: () => Promise<void> } } | undefined;
  let verificationClient: { end: () => Promise<void>; query: (sql: string, values: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> } | undefined;
  const previousEnv = {
    databaseUrl: process.env.DATABASE_URL,
    nodeEnv: process.env.NODE_ENV,
    storageDir: process.env.WAVEYARD_STORAGE_DIR,
  };

  try {
    await mkdir(dataDir, { recursive: true });
    const passwordFile = join(fixtureRoot, ".postgres-password");
    await writeFile(passwordFile, password, { mode: 0o600 });
    const initdb = spawnSync(binaries.find(([name]) => name === "initdb")![1]!, [
      "-D", dataDir, "-U", "arena", "--pwfile", passwordFile, "-E", "UTF8", "--locale", "C", "-A", "scram-sha-256",
    ], { encoding: "utf8", timeout: 120_000 });
    await rm(passwordFile, { force: true });
    assert.equal(initdb.status, 0, `initdb failed: ${(initdb.stdout ?? "") + (initdb.stderr ?? "")}`.slice(0, 2000));

    const postgresPath = binaries.find(([name]) => name === "postgres")![1]!;
    postgres = spawn(postgresPath, [
      "-D", dataDir, "-p", String(port), "-h", "127.0.0.1", "-F", "-c", "unix_socket_directories=",
    ], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let postgresOutput = "";
    postgres.stderr?.on("data", (chunk: Buffer) => { postgresOutput = (postgresOutput + chunk.toString()).slice(-4000); });

    const pgRequire = createRequire(join(root, "lib/db/package.json"));
    const { Client } = pgRequire("pg") as any;
    const adminUrl = `postgres://arena:${password}@127.0.0.1:${port}/postgres`;
    const deadline = Date.now() + 30_000;
    let lastConnectionError: unknown;
    let created = false;
    while (Date.now() < deadline && !created) {
      const client = new Client({ connectionString: adminUrl });
      try {
        await client.connect();
        await client.query(`CREATE DATABASE ${databaseName}`);
        created = true;
      } catch (error) {
        lastConnectionError = error;
        await client.end().catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 150));
      } finally {
        if (created) await client.end();
      }
    }
    assert.ok(created, `PostgreSQL did not become ready: ${String(lastConnectionError)} ${postgresOutput}`);

    const databaseUrl = `postgres://arena:${password}@127.0.0.1:${port}/${databaseName}`;
    const migrationClient = new Client({ connectionString: databaseUrl });
    await migrationClient.connect();
    const { migrate } = await import("../desktop/database.mjs");
    await migrate(migrationClient, join(root, "lib/arena/desktop-migrations"));
    await migrationClient.end();

    process.env.DATABASE_URL = databaseUrl;
    process.env.NODE_ENV = "test";
    process.env.WAVEYARD_STORAGE_DIR = join(fixtureRoot, "waveyard", "storage");
    verificationClient = new Client({ connectionString: databaseUrl });
    await verificationClient.connect();

    const [{ db, pool }, schema, arenaSchema, remixRoutes, automationRoute] = await Promise.all([
      import("../lib/db/src/index"),
      import("../lib/db/src/schema/waveyardSchema"),
      import("../lib/db/src/schema/index"),
      import("../artifacts/api-server/src/imported/remixes/[id]/route"),
      import("../artifacts/api-server/src/imported/remixes/[id]/automation/route"),
    ]);
    databaseModule = { pool };

    const [project] = await db.insert(schema.projects).values({
      ownerId: arenaSchema.LOCAL_OWNER_ID,
      title: "Automation persistence check",
      kind: "studio",
    }).returning();
    const [source] = await db.insert(schema.sourceAssets).values({
      projectId: project.id,
      originalFilename: "automation-fixture.wav",
      mimeType: "audio/wav",
      storageKey: `automation-test/${randomUUID()}/source.wav`,
      checksumSha256: "a".repeat(64),
      durationSeconds: 8,
      sampleRate: 16_000,
      channels: 1,
      codec: "pcm_s16le",
      fileSizeBytes: 256_044,
    }).returning();
    const [job] = await db.insert(schema.processingJobs).values({
      projectId: project.id,
      sourceAssetId: source.id,
      type: "separation",
      status: "complete",
      stage: "complete",
      idempotencyKey: `automation-test-${randomUUID()}`,
      model: "fixture",
      requestedDevice: "cpu",
      resolvedDevice: "cpu",
    }).returning();
    const [stem] = await db.insert(schema.stemAssets).values({
      projectId: project.id,
      sourceAssetId: source.id,
      separationJobId: job.id,
      stemType: "vocals",
      engine: "fixture",
      model: "fixture",
      modelVersion: "1",
      storageKey: `automation-test/${randomUUID()}/vocals.wav`,
      checksumSha256: "b".repeat(64),
      durationSeconds: 8,
      sampleRate: 16_000,
      channels: 1,
      codec: "pcm_s16le",
      format: "wav",
      fileSizeBytes: 256_044,
    }).returning();
    const [session] = await db.insert(schema.remixSessions).values({
      projectId: project.id,
      ownerId: arenaSchema.LOCAL_OWNER_ID,
      name: "Automation persistence check",
    }).returning();
    await db.insert(schema.remixTracks).values({
      remixSessionId: session.id,
      stemAssetId: stem.id,
      name: "Vocals",
      sortOrder: 0,
    }).returning();

    const actualStem = {
      id: stem.id, sourceAssetId: source.id, stemType: stem.stemType, durationSeconds: stem.durationSeconds,
      sampleRate: stem.sampleRate, channels: stem.channels, codec: stem.codec, format: stem.format,
      fileSizeBytes: stem.fileSizeBytes, checksumSha256: stem.checksumSha256, model: stem.model, modelVersion: stem.modelVersion,
    };
    const actualSource = {
      id: source.id, originalFilename: source.originalFilename, durationSeconds: source.durationSeconds, linkedFromLibrary: true,
    };
    const apiRequire = createRequire(new URL("../artifacts/api-server/package.json", import.meta.url));
    const { chromium } = apiRequire("playwright-core") as { chromium: { launch: (options: unknown) => Promise<any> } };
    const browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || "/repl/tools/bin/chromium",
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    try {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
      await context.addInitScript(() => {
        localStorage.setItem("af_local_mode", "1");
        localStorage.setItem("af_ephemeral", "0");
      });
      const page = await context.newPage();
      const browserErrors: string[] = [];
      const routeTrace: string[] = [];
      page.on("pageerror", (error) => browserErrors.push(error.message));
      const routeBase = process.env.TEST_BASE_URL || "http://localhost:80";
      const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
      const dispatch = async (route: any, handler: (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>, id: string) => {
        const playwrightRequest = route.request();
        const body = playwrightRequest.postData();
        const request = new Request(`http://127.0.0.1${new URL(playwrightRequest.url()).pathname}`, {
          method: playwrightRequest.method(),
          headers: { host: "127.0.0.1", ...(body ? { "content-type": "application/json" } : {}) },
          ...(body ? { body } : {}),
        });
        const response = await handler(request, { params: Promise.resolve({ id }) });
        const responseBody = await response.text();
        routeTrace.push(`${playwrightRequest.method()} ${new URL(playwrightRequest.url()).pathname} -> ${response.status} ${responseBody.slice(0, 300)}`);
        return route.fulfill({
          status: response.status,
          contentType: response.headers.get("content-type") ?? "application/json",
          body: responseBody,
        });
      };
      await page.route("**/api/**", async (route: any) => {
        const request = route.request();
        const pathname = new URL(request.url()).pathname;
        if (pathname === `/api/remixes/${session.id}` && request.method() === "GET")
          return dispatch(route, remixRoutes.GET, session.id);
        if (pathname === `/api/remixes/${session.id}` && request.method() === "PUT")
          return dispatch(route, remixRoutes.PUT, session.id);
        if (pathname === `/api/remixes/${session.id}/automation` && request.method() === "POST")
          return dispatch(route, automationRoute.POST, session.id);
        if (pathname === `/api/waveyard/projects/${project.id}`) return route.fulfill(json({
          project: { id: project.id, title: project.title, licenseCode: "private", visibility: "private", publicationStatus: "draft" },
          role: "owner", build: null, sources: [], studioSources: [actualSource], stems: [actualStem],
          waveforms: [], waveformJobs: [], jobs: [],
        }));
        if (pathname === `/api/waveyard/projects/${project.id}/remixes`)
          return route.fulfill(json({ remixes: [{ id: session.id }] }));
        if (pathname.endsWith("/waveform")) return route.fulfill(json({ peaks: [], durationSeconds: 8 }));
        if (pathname === `/api/assets/${stem.id}`)
          return route.fulfill({ status: 200, contentType: "audio/wav", body: makePcmWav() });
        return route.fulfill(json({ error: `Unexpected API request: ${request.method()} ${pathname}` }, 404));
      });

      await page.goto(`${routeBase}/waveyard/projects/${project.id}?view=studio`);
      const editor = page.getByRole("form", { name: "Automation point editor" });
      await editor.waitFor({ timeout: 15_000 });
      const point = editor.getByLabel("Automation point", { exact: true });
      const time = editor.getByLabel("Automation time in milliseconds");
      const value = editor.getByLabel("Automation value");
      const parameter = editor.getByLabel("Automation parameter");
      const typeNumber = async (input: any, text: string) => {
        await input.focus();
        await page.keyboard.press("ControlOrMeta+A");
        await page.keyboard.type(text);
      };
      const activate = async (name: "Create point" | "Save point" | "Delete point") => {
        const button = editor.getByRole("button", { name, exact: true });
        await button.focus();
        await page.keyboard.press("Enter");
      };
      const waitForStatus = async (text: string) => {
        try {
          await page.waitForFunction(
            ({ text }) => document.querySelector(".automation-editor [role=status]")?.textContent.includes(text),
            { text },
            { timeout: 8_000 },
          );
        } catch (error) {
          console.error("Automation UI status:", await editor.getByRole("status").textContent().catch(() => "missing"));
          console.error("Automation inputs:", await parameter.inputValue(), await time.inputValue(), await value.inputValue());
          console.error("Real route trace:", routeTrace);
          throw error;
        }
      };
      const persistedPoints = async () => {
        const result = await verificationClient!.query(
          `SELECT id, parameter, timeline_ms AS "timelineMs", value
           FROM remix_automation_points WHERE remix_session_id = $1 ORDER BY timeline_ms`,
          [session.id],
        );
        return result.rows as Array<{ id: string; parameter: string; timelineMs: number; value: number }>;
      };

      await typeNumber(time, "1200");
      await typeNumber(value, "1.5");
      await activate("Create point");
      await waitForStatus("saved at 1200");
      let savedPoints = await persistedPoints();
      assert.equal(savedPoints.length, 1);
      const volumePointId = savedPoints[0].id;
      assert.deepEqual({ parameter: savedPoints[0].parameter, timelineMs: savedPoints[0].timelineMs, value: savedPoints[0].value },
        { parameter: "volume", timelineMs: 1200, value: 1.5 });

      await parameter.focus();
      await page.keyboard.press("p");
      assert.equal(await parameter.inputValue(), "pan");
      await typeNumber(time, "1800");
      await typeNumber(value, "0.25");
      await activate("Create point");
      await waitForStatus("saved at 1800");
      savedPoints = await persistedPoints();
      assert.equal(savedPoints.length, 2, "volume and pan points must both be written through the real route");
      const panPointId = savedPoints.find((saved) => saved.parameter === "pan")!.id;

      await page.getByRole("button", { name: /volume point at 1200 milliseconds$/ }).focus();
      await page.keyboard.press("Space");
      await typeNumber(time, "2400");
      await typeNumber(value, "1.25");
      await activate("Save point");
      await waitForStatus("saved at 2400");
      savedPoints = await persistedPoints();
      assert.deepEqual(savedPoints.find((saved) => saved.parameter === "volume"), {
        id: volumePointId, parameter: "volume", timelineMs: 2400, value: 1.25,
      }, "moving an automation point must update its database row rather than duplicate it");

      await page.getByRole("button", { name: /pan point at 1800 milliseconds$/ }).focus();
      await page.keyboard.press("Space");
      await typeNumber(time, "2100");
      await typeNumber(value, "0.5");
      await activate("Save point");
      await waitForStatus("saved at 2100");
      savedPoints = await persistedPoints();
      assert.deepEqual(savedPoints.find((saved) => saved.parameter === "pan"), {
        id: panPointId, parameter: "pan", timelineMs: 2100, value: 0.5,
      }, "moving a pan point must update its database row rather than duplicate it");

      await page.getByRole("button", { name: /volume point at 2400 milliseconds$/ }).focus();
      await page.keyboard.press("Space");
      await activate("Delete point");
      await waitForStatus("deleted");
      assert.deepEqual((await persistedPoints()).map((saved) => saved.parameter), ["pan"]);

      const waitForRemixSave = () => page.waitForResponse((response) => {
        const request = response.request();
        return request.method() === "PUT" && new URL(response.url()).pathname === `/api/remixes/${session.id}`;
      });
      const dispatchUndo = (shiftKey = false) => page.evaluate((shiftKey) => window.dispatchEvent(new KeyboardEvent("keydown", {
        key: "z", code: "KeyZ", ctrlKey: true, shiftKey, bubbles: true, cancelable: true,
      })), shiftKey);
      let savedResponse = waitForRemixSave();
      await dispatchUndo();
      assert.equal((await savedResponse).status(), 200);
      assert.deepEqual((await persistedPoints()).map((saved) => saved.parameter).sort(), ["pan", "volume"],
        "Undo must restore the deleted volume point in the database");

      savedResponse = waitForRemixSave();
      await dispatchUndo(true);
      assert.equal((await savedResponse).status(), 200);
      assert.deepEqual((await persistedPoints()).map((saved) => saved.parameter), ["pan"],
        "Redo must remove the volume point in the database");

      await page.getByRole("button", { name: /pan point at 2100 milliseconds$/ }).focus();
      await page.keyboard.press("Space");
      await activate("Delete point");
      await waitForStatus("deleted");
      assert.deepEqual(await persistedPoints(), [], "Deleting a pan point must persist to the real route");

      savedResponse = waitForRemixSave();
      await dispatchUndo();
      assert.equal((await savedResponse).status(), 200);
      assert.deepEqual((await persistedPoints()).map((saved) => saved.parameter), ["pan"],
        "Undo must restore a deleted pan point in the database");

      savedResponse = waitForRemixSave();
      await dispatchUndo(true);
      assert.equal((await savedResponse).status(), 200);
      assert.deepEqual(await persistedPoints(), [], "Redo must persist the pan deletion");

      await page.reload();
      await editor.waitFor({ timeout: 15_000 });
      assert.equal(await page.locator(".automation-point").count(), 0);
      assert.deepEqual(await persistedPoints(), [],
        "reopening Studio must reflect the saved database state, not the prior browser's in-memory arrangement");
      assert.deepEqual(browserErrors, [], "Real-route persistence flow must not raise browser errors");
      console.log("AUTOMATION_PERSISTENCE_COMPLETE: real route creation, move, deletion, undo/redo, and saved remix reopening.");
      await context.close();
    } finally {
      await browser.close();
    }
  } finally {
    await verificationClient?.end().catch(() => undefined);
    if (databaseModule) await databaseModule.pool.end().catch(() => undefined);
    if (postgres && postgres.exitCode === null) {
      postgres.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => { postgres?.kill("SIGKILL"); resolve(); }, 5000);
        postgres?.once("exit", () => { clearTimeout(timeout); resolve(); });
      });
    }
    if (previousEnv.databaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousEnv.databaseUrl;
    if (previousEnv.nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnv.nodeEnv;
    if (previousEnv.storageDir === undefined) delete process.env.WAVEYARD_STORAGE_DIR;
    else process.env.WAVEYARD_STORAGE_DIR = previousEnv.storageDir;
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
