import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { createServer, type Server } from "node:http";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const apiRequire = createRequire(new URL("../artifacts/api-server/package.json", import.meta.url));
const { chromium } = apiRequire("playwright-core");
const { Client } = apiRequire("pg");
const base = process.env.TEST_BASE_URL || "http://localhost:80";

let root: string | null = null;
let pgDataDir: string | null = null;
let postgresProcess: ReturnType<typeof spawn> | null = null;
let pgPool: { end: () => Promise<void> } | null = null;
let migrationClient: { end: () => Promise<void> } | null = null;
let routeServer: Server | null = null;
let apiBase = "";
let storageDirectory = "";
let restoreRoute: { POST: (request: Request) => Promise<Response> };
let tracksRoute: { GET: (request: Request) => Promise<Response> };
let assetRoute: { GET: (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response> };
let sessionsRoute: { POST: (request: Request) => Promise<Response> };
let sessionRoute: { GET: (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response> };
let sessionTracksRoute: { POST: (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response> };
let sessionStateRoute: { PUT: (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response> };
let trackPlayedRoute: { POST: (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response> };
let localOwnerId = "";
const apiRequests: Array<{ method: string; path: string }> = [];
const servedAssets: string[] = [];

function embeddedBinary(name: string) {
  const platform = process.platform === "win32" ? "windows-x64" : "linux-x64";
  const executable = process.platform === "win32" ? `${name}.exe` : name;
  const bundled = path.join(repoRoot, "node_modules", "@embedded-postgres", platform, "native", "bin", executable);
  if (existsSync(bundled)) return bundled;
  const locator = process.platform === "win32" ? "where.exe" : "which";
  const located = spawnSync(locator, [executable], { encoding: "utf8" }).stdout?.trim().split(/\r?\n/)[0];
  return located && existsSync(located) ? located : bundled;
}

function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function makeWav(filePath: string, seconds = 6, frequency = 440) {
  const sampleRate = 44_100;
  const frames = Math.floor(seconds * sampleRate);
  const dataBytes = frames * 2;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(dataBytes, 40);
  for (let frame = 0; frame < frames; frame += 1) {
    wav.writeInt16LE(
      Math.round(12_000 * Math.sin((2 * Math.PI * frequency * frame) / sampleRate)),
      44 + frame * 2,
    );
  }
  writeFileSync(filePath, wav);
  return wav;
}

async function collectBody(request: import("node:http").IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function dispatchApiRequest(request: Request) {
  const url = new URL(request.url);
  const pathname = url.pathname.replace(/^\/api/, "");
  const method = request.method.toUpperCase();
  apiRequests.push({ method, path: url.pathname });

  if (pathname === "/library/audio-backup/restore" && method === "POST") {
    return restoreRoute.POST(request);
  }
  if (pathname === "/library/tracks" && method === "GET") {
    return tracksRoute.GET(request);
  }
  if (pathname === "/library/sessions" && method === "POST") {
    return sessionsRoute.POST(request);
  }
  const sessionTracks = pathname.match(/^\/library\/sessions\/([0-9a-f-]+)\/tracks$/i);
  if (sessionTracks && method === "POST") {
    return sessionTracksRoute.POST(request, { params: Promise.resolve({ id: sessionTracks[1] }) });
  }
  const sessionState = pathname.match(/^\/library\/sessions\/([0-9a-f-]+)\/state$/i);
  if (sessionState && method === "PUT") {
    return sessionStateRoute.PUT(request, { params: Promise.resolve({ id: sessionState[1] }) });
  }
  const sessionDetail = pathname.match(/^\/library\/sessions\/([0-9a-f-]+)$/i);
  if (sessionDetail && method === "GET") {
    return sessionRoute.GET(request, { params: Promise.resolve({ id: sessionDetail[1] }) });
  }
  const played = pathname.match(/^\/library\/tracks\/([0-9a-f-]+)\/played$/i);
  if (played && method === "POST") {
    return trackPlayedRoute.POST(request, { params: Promise.resolve({ id: played[1] }) });
  }
  const asset = pathname.match(/^\/assets\/([0-9a-f-]+)$/i);
  if (asset && method === "GET") {
    const response = await assetRoute.GET(request, { params: Promise.resolve({ id: asset[1] }) });
    if (response.ok) servedAssets.push(asset[1]);
    return response;
  }

  // The Waveyard page also asks for unrelated library panels. Return isolated
  // empty values for those reads; never forward an unhandled request elsewhere.
  if (method === "GET" && pathname === "/library/playback-state") {
    return Response.json({ playbackState: null });
  }
  if (method === "GET" && pathname === "/library/playlists") {
    return Response.json({ playlists: [] });
  }
  if (method === "GET" && pathname === "/library/queue") {
    return Response.json({ queue: [] });
  }
  return Response.json({ error: "Not provided by the isolated restore acceptance server." }, { status: 404 });
}

async function setupIsolatedEnvironment() {
  root = mkdtempSync(path.join(tmpdir(), "waveyard-audio-restore-e2e-"));
  pgDataDir = path.join(root, "pgdata");
  storageDirectory = path.join(root, "objects");
  mkdirSync(storageDirectory, { recursive: true });
  const databasePort = await freePort();
  const databaseUrl = `postgresql://arena:arena-test@127.0.0.1:${databasePort}/waveyard_restore_e2e`;

  const passwordFile = path.join(root, ".pw");
  writeFileSync(passwordFile, "arena-test", { mode: 0o600 });
  const initialized = spawnSync(embeddedBinary("initdb"), [
    "-D", pgDataDir, "-U", "arena", "--pwfile", passwordFile, "-E", "UTF8", "--locale", "C", "-A", "scram-sha-256",
  ], { encoding: "utf8", timeout: 120_000 });
  rmSync(passwordFile, { force: true });
  if (initialized.status !== 0) {
    throw new Error(`Isolated PostgreSQL initialization failed: ${`${initialized.stdout ?? ""}${initialized.stderr ?? ""}`.slice(0, 2000)}`);
  }
  postgresProcess = spawn(embeddedBinary("postgres"), [
    "-D", pgDataDir, "-p", String(databasePort), "-h", "127.0.0.1", "-F",
    "-c", "unix_socket_directories=",
  ], { stdio: "ignore", windowsHide: true });
  const { waitForPostgresReady } = await import("../lib/arena/src/lib/waveyard/library/pg-readiness.ts");
  await waitForPostgresReady({
    createClient: () => new Client({ connectionString: `postgresql://arena:arena-test@127.0.0.1:${databasePort}/postgres` }),
    useConnectedClient: async (admin) => { await admin.query("create database waveyard_restore_e2e"); },
  });

  // These are the only database and object paths visible to app modules below.
  process.env.NODE_ENV = "test";
  process.env.DATABASE_URL = databaseUrl;
  process.env.WAVEYARD_STORAGE_DIR = storageDirectory;
  migrationClient = new Client({ connectionString: databaseUrl });
  await migrationClient.connect();
  const { migrate } = await import("../desktop/database.mjs");
  try {
    await migrate(migrationClient, path.join(repoRoot, "lib/arena/desktop-migrations"));
  } finally {
    await migrationClient.end();
  }

  const [localContext, restore, tracks, assets, sessions, session, sessionTracks, sessionState, trackPlayed] = await Promise.all([
    import("../lib/arena/src/lib/waveyard/local-context.ts"),
    import("../artifacts/api-server/src/imported/library/audio-backup/restore/route.ts"),
    import("../artifacts/api-server/src/imported/library/tracks/route.ts"),
    import("../artifacts/api-server/src/imported/assets/[id]/route.ts"),
    import("../artifacts/api-server/src/imported/library/sessions/route.ts"),
    import("../artifacts/api-server/src/imported/library/sessions/[id]/route.ts"),
    import("../artifacts/api-server/src/imported/library/sessions/[id]/tracks/route.ts"),
    import("../artifacts/api-server/src/imported/library/sessions/[id]/state/route.ts"),
    import("../artifacts/api-server/src/imported/library/tracks/[id]/played/route.ts"),
  ]);
  localOwnerId = localContext.LOCAL_OWNER_ID;
  restoreRoute = restore;
  tracksRoute = tracks;
  assetRoute = assets;
  sessionsRoute = sessions;
  sessionRoute = session;
  sessionTracksRoute = sessionTracks;
  sessionStateRoute = sessionState;
  trackPlayedRoute = trackPlayed;
  pgPool = (await import("../lib/db/src/index.ts")).pool;

  routeServer = createServer(async (incoming, outgoing) => {
    try {
      const body = await collectBody(incoming);
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (value === undefined || ["connection", "host", "transfer-encoding", "upgrade"].includes(name)) continue;
        headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      const request = new Request(`http://127.0.0.1${incoming.url ?? "/"}`, {
        method: incoming.method ?? "GET",
        headers,
        ...((incoming.method === "GET" || incoming.method === "HEAD" || body.length === 0) ? {} : { body }),
      });
      const response = await dispatchApiRequest(request);
      const responseBody = Buffer.from(await response.arrayBuffer());
      outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      outgoing.end(responseBody);
    } catch (error) {
      outgoing.writeHead(500, { "Content-Type": "application/json" });
      outgoing.end(JSON.stringify({ error: error instanceof Error ? error.message : "Isolated route failed." }));
    }
  });
  const apiPort = await freePort();
  await new Promise<void>((resolve) => routeServer!.listen(apiPort, "127.0.0.1", resolve));
  apiBase = `http://127.0.0.1:${apiPort}`;

  assert.ok(root.startsWith(tmpdir()), "the acceptance database is temporary");
  assert.equal(process.env.DATABASE_URL, databaseUrl, "all imported app routes use only the isolated database");
  assert.equal(process.env.WAVEYARD_STORAGE_DIR, storageDirectory, "all imported app routes use only temporary object storage");
  const initial = await fetch(`${apiBase}/api/library/tracks`).then((response) => response.json());
  assert.deepEqual(initial.tracks, [], "the isolated test library starts empty");
}

before(async () => {
  await setupIsolatedEnvironment();
});

after(async () => {
  await new Promise<void>((resolve) => routeServer ? routeServer.close(() => resolve()) : resolve());
  await pgPool?.end();
  await migrationClient?.end().catch(() => undefined);
  if (pgDataDir && postgresProcess && postgresProcess.exitCode === null) {
    spawnSync(embeddedBinary("pg_ctl"), ["-D", pgDataDir, "-m", "fast", "-w", "-t", "20", "stop"], { timeout: 30_000 });
    if (postgresProcess.exitCode === null) postgresProcess.kill();
  }
  if (root) rmSync(root, { recursive: true, force: true });
});

test("a real restore route populates Waveyard and the player advances on the restored WAV", { timeout: 120_000 }, async () => {
  assert.ok(root);
  const fixturePath = path.join(root, "restored-audio.wav");
  const wavBytes = makeWav(fixturePath);
  const checksum = createHash("sha256").update(wavBytes).digest("hex");
  const trackId = randomUUID();
  const archivePath = `audio/Restore Artist/Restore Album/${trackId} - Restored Audio.wav`;
  const audioManifest = {
    trackId,
    title: "Restored Audio",
    artist: "Restore Artist",
    album: "Restore Album",
    durationSeconds: 6,
    codec: "pcm_s16le",
    originalFilename: "restored-audio.wav",
    archivePath,
    fileSizeBytes: wavBytes.length,
    checksumSha256: checksum,
  };
  const { createAudioBackupCsv, createVerifiedAudioBackupZip } = await import(
    "../lib/arena/src/lib/waveyard/library/audio-backup.ts"
  );
  const csv = Buffer.from(createAudioBackupCsv([audioManifest]));
  const archive = await createVerifiedAudioBackupZip([
    {
      name: archivePath,
      bytes: wavBytes.length,
      sha256: checksum,
      open: async () => createReadStream(fixturePath),
    },
    {
      name: "manifest.csv",
      bytes: csv.length,
      sha256: createHash("sha256").update(csv).digest("hex"),
      open: async () => Readable.from([csv]),
    },
  ]);

  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/repl/tools/bin/chromium",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const pageErrors: string[] = [];
  const browserApiRequests: string[] = [];
  try {
    const browserContext = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      serviceWorkers: "block",
    });
    await browserContext.addInitScript(() => {
      if (window === window.top && localStorage.getItem("af_local_mode") === null) {
        localStorage.setItem("af_local_mode", "1");
      }
    });
    await browserContext.route("**/api/**", async (route) => {
      const browserRequest = route.request();
      const requestUrl = new URL(browserRequest.url());
      browserApiRequests.push(`${browserRequest.method()} ${requestUrl.pathname}`);
      const headers = browserRequest.headers();
      delete headers.host;
      delete headers["content-length"];
      const method = browserRequest.method();
      const body = method === "GET" || method === "HEAD" ? undefined : browserRequest.postDataBuffer() ?? undefined;
      const response = await fetch(`${apiBase}${requestUrl.pathname}${requestUrl.search}`, { method, headers, body });
      const responseHeaders: Record<string, string> = {};
      for (const name of ["content-type", "content-length", "cache-control", "accept-ranges", "content-range", "content-disposition"]) {
        const value = response.headers.get(name);
        if (value !== null) responseHeaders[name] = value;
      }
      await route.fulfill({
        status: response.status,
        headers: responseHeaders,
        body: Buffer.from(await response.arrayBuffer()),
      });
    });
    const page = await browserContext.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(`${base}/waveyard`, { waitUntil: "domcontentloaded" });

    await page.getByRole("button", { name: "Apple Music catalog backup" }).click();
    await page.getByText(/exports retain playlist order and available track details and listening stats/i).waitFor({ timeout: 10_000 });
    const restoreButton = page.getByRole("button", { name: "Restore originals" });
    await restoreButton.waitFor({ state: "visible", timeout: 15_000 });
    assert.equal(await restoreButton.isDisabled(), true, "restore cannot start until the ZIP and disk-space confirmation are provided");
    await page.getByLabel("Choose Waveyard audio backup ZIP").setInputFiles({
      name: "waveyard-audio-restore-e2e.zip",
      mimeType: "application/zip",
      buffer: readFileSync(archive.path),
    });
    assert.equal(await restoreButton.isDisabled(), true, "file selection alone does not bypass the disk-space confirmation");
    await page.getByRole("checkbox", { name: /enough disk space/i }).check();

    const restoreResponsePromise = page.waitForResponse((response) =>
      new URL(response.url()).pathname === "/api/library/audio-backup/restore",
    );
    await restoreButton.click();
    const restoreResponse = await restoreResponsePromise;
    assert.equal(restoreResponse.status(), 200, "the browser posted the archive through the real restore handler");
    const restored = await restoreResponse.json();
    assert.deepEqual(
      { totalTracks: restored.totalTracks, restored: restored.restored, duplicates: restored.duplicates, failed: restored.failed },
      { totalTracks: 1, restored: 1, duplicates: 0, failed: 0 },
    );
    const restoredTrackId = restored.results[0].trackId as string;
    assert.match(restoredTrackId, /^[0-9a-f-]{36}$/i);
    await page.getByRole("status").filter({ hasText: "Restored 1 original" }).waitFor({ timeout: 10_000 });

    // The card comes from the real library GET route backed by the isolated DB.
    const playRestoredTrack = page.getByTestId(`button-play-${restoredTrackId}`);
    await playRestoredTrack.waitFor({ state: "visible", timeout: 10_000 });
    await playRestoredTrack.click();
    const playButton = page.getByTestId("session-play");
    await playButton.waitFor({ state: "visible", timeout: 15_000 });
    await page.waitForFunction(() => {
      const button = document.querySelector('[data-testid="session-play"]');
      const audio = document.querySelector('audio[aria-label="source audio"]') as HTMLAudioElement | null;
      return button?.getAttribute("aria-pressed") === "true"
        && audio !== null
        && !audio.paused
        && audio.currentTime > 0.25;
    }, null, { timeout: 20_000 });
    const startingPosition = await page.locator('audio[aria-label="source audio"]').evaluate((audio) =>
      (audio as HTMLAudioElement).currentTime,
    );
    await page.waitForFunction((start) => {
      const audio = document.querySelector('audio[aria-label="source audio"]') as HTMLAudioElement | null;
      return audio !== null && !audio.paused && audio.currentTime > start + 0.25;
    }, startingPosition, { timeout: 10_000 });

    assert.ok(servedAssets.length > 0, "the browser fetched audio from the real asset route backed by temporary storage");
    assert.ok(browserApiRequests.some((entry) => entry === "POST /api/library/audio-backup/restore"));
    assert.ok(browserApiRequests.some((entry) => entry === `GET /api/assets/${servedAssets.at(-1)}`));
    assert.deepEqual(pageErrors, [], "the real restore-and-play flow has no browser exceptions");

    const [finalLibrary, ownerTracks] = await Promise.all([
      fetch(`${apiBase}/api/library/tracks`).then((response) => response.json()),
      (await import("../lib/arena/src/lib/waveyard/library/service.ts")).listTracks({ ownerId: localOwnerId }),
    ]);
    assert.deepEqual(finalLibrary.tracks.map((track: { id: string }) => track.id), [restoredTrackId]);
    assert.equal(ownerTracks.length, 1, "only the generated restore fixture exists in the isolated library");
    assert.equal(ownerTracks[0].title, "Restored Audio");
    assert.ok(servedAssets.includes(ownerTracks[0].sourceAssetId), "the fetched file is the restored track's source asset");
    assert.equal(ownerTracks[0].durationSeconds, 6);
    assert.ok(apiRequests.some((request) => request.path === "/api/library/audio-backup/restore"));
    assert.ok(apiRequests.some((request) => request.path === "/api/library/tracks"));
    assert.ok(apiRequests.some((request) => request.path.startsWith("/api/library/sessions/")));
    assert.ok(apiRequests.some((request) => request.path.startsWith("/api/assets/")));
    assert.equal(browserApiRequests.some((entry) => entry.includes("/api/library/audio-backup/restore") && !entry.startsWith("POST ")), false);
    for (const entry of browserApiRequests) {
      const [method, requestPath] = entry.split(" ");
      assert.ok(apiRequests.some((request) => request.method === method && request.path === requestPath),
        `browser API request ${entry} was served by the isolated route harness`);
    }
    await browserContext.close();
  } finally {
    await browser.close();
    await archive.dispose();
  }
});

