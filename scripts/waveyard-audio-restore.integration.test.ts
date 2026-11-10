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
const servedAssetResponses = new Map<string, { status: number; contentType: string | null }>();

function embeddedBinary(name: string) {
  const platform = process.platform === "win32" ? "windows-x64" : "linux-x64";
  const executable = process.platform === "win32" ? `${name}.exe` : name;
  const bundledCandidates = [
    path.join(repoRoot, "node_modules", "@embedded-postgres", platform, "native", "bin", executable),
    path.join(repoRoot, "desktop", "node_modules", "@embedded-postgres", platform, "native", "bin", executable),
  ];
  const bundled = bundledCandidates.find(existsSync);
  if (bundled) return bundled;
  const locator = process.platform === "win32" ? "where.exe" : "which";
  const located = spawnSync(locator, [executable], { encoding: "utf8" }).stdout?.trim().split(/\r?\n/)[0];
  return located && existsSync(located) ? located : bundledCandidates[0];
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

async function makeCompressedFixture(filePath: string, encoderArgs: string[]) {
  const { execTool } = await import("../lib/arena/src/lib/waveyard/ffmpeg.ts");
  await execTool("ffmpeg", [
    "-hide_banner",
    "-loglevel", "error",
    "-y",
    "-f", "lavfi",
    "-i", "sine=frequency=523:sample_rate=44100:duration=3.5",
    "-vn",
    "-ar", "44100",
    "-ac", "1",
    ...encoderArgs,
    filePath,
  ], { timeoutMs: 30_000 });
  const bytes = readFileSync(filePath);
  assert.ok(bytes.length > 1_000, `FFmpeg produced a non-empty fixture at ${filePath}`);
  return bytes;
}

type RestoreAudioFixture = {
  extension: string;
  codec: string;
  mimeType: string;
  encoderArgs: readonly string[];
  trackId: string;
  title: string;
  originalFilename: string;
  fixturePath: string;
  bytes: Buffer;
  checksumSha256: string;
  archivePath: string;
  manifest: {
    trackId: string;
    title: string;
    artist: string;
    album: string;
    durationSeconds: number;
    codec: string;
    originalFilename: string;
    archivePath: string;
    fileSizeBytes: number;
    checksumSha256: string;
  };
};

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
    if (response.ok) {
      servedAssets.push(asset[1]);
      servedAssetResponses.set(asset[1], {
        status: response.status,
        contentType: response.headers.get("content-type"),
      });
    }
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

  const browserOrigin = new URL(base).origin;
  routeServer = createServer(async (incoming, outgoing) => {
    const incomingPath = new URL(incoming.url ?? "/", "http://127.0.0.1").pathname;
    const origin = incoming.headers.origin;
    const corsHeaders = origin === browserOrigin
      ? {
          "Access-Control-Allow-Origin": browserOrigin,
          "Access-Control-Allow-Credentials": "true",
          "Vary": "Origin",
          ...(incoming.headers["access-control-request-private-network"] === "true"
            ? { "Access-Control-Allow-Private-Network": "true" }
            : {}),
        }
      : {};
    if (incoming.method === "OPTIONS") {
      apiRequests.push({ method: "OPTIONS", path: incomingPath });
      outgoing.writeHead(204, {
        ...corsHeaders,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": incoming.headers["access-control-request-headers"] ?? "content-type",
        "Access-Control-Max-Age": "0",
      });
      outgoing.end();
      return;
    }
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
      outgoing.writeHead(response.status, { ...Object.fromEntries(response.headers.entries()), ...corsHeaders });
      outgoing.flushHeaders();
      if (response.body === null) {
        outgoing.end();
        return;
      }
      const reader = response.body.getReader();
      const cancelResponse = () => {
        if (!outgoing.writableEnded) void reader.cancel(new Error("Browser closed the isolated response.")).catch(() => undefined);
      };
      outgoing.once("close", cancelResponse);
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          if (!outgoing.write(Buffer.from(next.value))) {
            await new Promise<void>((resolve) => outgoing.once("drain", resolve));
          }
          // Keep streamed restore events distinct so the browser acceptance
          // can observe intermediate file counts, not only the terminal result.
          if (incomingPath === "/api/library/audio-backup/restore") {
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
        }
        outgoing.end();
      } finally {
        outgoing.off("close", cancelResponse);
        reader.releaseLock();
      }
    } catch (error) {
      if (outgoing.headersSent) {
        outgoing.destroy(error instanceof Error ? error : undefined);
      } else {
        outgoing.writeHead(500, { "Content-Type": "application/json", ...corsHeaders });
        outgoing.end(JSON.stringify({ error: error instanceof Error ? error.message : "Isolated route failed." }));
      }
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

test("a real restore route serves playable MP3, FLAC, and M4A files in an isolated Waveyard library", { timeout: 180_000 }, async () => {
  assert.ok(root);
  const audioFormats = [
    { extension: "mp3", codec: "mp3", mimeType: "audio/mpeg", encoderArgs: ["-c:a", "libmp3lame", "-b:a", "96k"] },
    { extension: "flac", codec: "flac", mimeType: "audio/flac", encoderArgs: ["-c:a", "flac", "-compression_level", "0"] },
    { extension: "m4a", codec: "aac", mimeType: "audio/mp4", encoderArgs: ["-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart"] },
  ] as const;
  const audioFixtures: RestoreAudioFixture[] = [];
  for (const format of audioFormats) {
    const trackId = randomUUID();
    const title = `Restored ${format.extension.toUpperCase()}`;
    const originalFilename = `restored-${format.extension}.${format.extension}`;
    const fixturePath = path.join(root, originalFilename);
    const bytes = await makeCompressedFixture(fixturePath, [...format.encoderArgs]);
    const checksumSha256 = createHash("sha256").update(bytes).digest("hex");
    const archivePath = `audio/Restore Artist/Restore Album/${trackId} - ${title}.${format.extension}`;
    audioFixtures.push({
      ...format,
      trackId,
      title,
      originalFilename,
      fixturePath,
      bytes,
      checksumSha256,
      archivePath,
      manifest: {
        trackId,
        title,
        artist: "Restore Artist",
        album: "Restore Album",
        durationSeconds: 3.5,
        codec: format.codec,
        originalFilename,
        archivePath,
        fileSizeBytes: bytes.length,
        checksumSha256,
      },
    });
  }
  const { createAudioBackupCsv, createVerifiedAudioBackupZip } = await import(
    "../lib/arena/src/lib/waveyard/library/audio-backup.ts"
  );
  const csv = Buffer.from(createAudioBackupCsv(audioFixtures.map((fixture) => fixture.manifest)));
  const archive = await createVerifiedAudioBackupZip([
    ...audioFixtures.map((fixture) => ({
      name: fixture.archivePath,
      bytes: fixture.bytes.length,
      sha256: fixture.checksumSha256,
      open: async () => createReadStream(fixture.fixturePath),
    })),
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
  const browserApiRequests: Array<{ origin: string; method: string; path: string }> = [];
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
      browserApiRequests.push({
        origin: requestUrl.origin,
        method: browserRequest.method(),
        path: requestUrl.pathname,
      });
      if (
        requestUrl.pathname === "/api/library/audio-backup/restore" &&
        (browserRequest.method() === "POST" || browserRequest.method() === "OPTIONS")
      ) {
        await route.continue({ url: `${apiBase}${requestUrl.pathname}${requestUrl.search}` });
        return;
      }
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
    await page.locator(".library-audio-restore").evaluate((container) => {
      const progressWindow = window as unknown as { __restoreProgressHistory: string[] };
      progressWindow.__restoreProgressHistory = [];
      const observer = new MutationObserver(() => {
        const text = container.querySelector('[data-testid="audio-restore-phase"]')?.textContent?.trim();
        if (text && progressWindow.__restoreProgressHistory.at(-1) !== text) {
          progressWindow.__restoreProgressHistory.push(text);
        }
      });
      observer.observe(container, {
        characterData: true,
        childList: true,
        subtree: true,
      });
    });

    const restoreResponsePromise = page.waitForResponse((response) =>
      response.request().method() === "POST"
      && new URL(response.url()).pathname === "/api/library/audio-backup/restore",
    );
    await restoreButton.click();
    const restoreResponse = await restoreResponsePromise;
    assert.equal(restoreResponse.status(), 200, "the browser posted the archive through the real restore handler");
    await page.waitForFunction(() => {
      const status = document.querySelector('[data-testid="audio-restore-phase"]')?.textContent ?? "";
      return status.includes("Checking checksums: 0 of 3");
    }, null, { timeout: 20_000 });
    const responseLines = (await restoreResponse.text())
      .split(/\r?\n/)
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const restored = responseLines.at(-1);
    assert.equal(restored?.type, "complete", "the stream ends with final per-file results");
    assert.ok(responseLines.some((event) => event.type === "progress" && event.phase === "validating" && event.completedFiles === 1));
    assert.ok(responseLines.some((event) => event.type === "progress" && event.phase === "restoring" && event.completedFiles === 1));
    const progressHistory = await page.evaluate(() =>
      (window as unknown as { __restoreProgressHistory: string[] }).__restoreProgressHistory,
    );
    assert.ok(progressHistory.some((text) => text.includes("Checking checksums: 0 of 3")), JSON.stringify(progressHistory));
    assert.ok(progressHistory.some((text) => text.includes("Checking checksums: 1 of 3")), JSON.stringify(progressHistory));
    assert.ok(progressHistory.some((text) => text.includes("Restoring 0 of 3")), JSON.stringify(progressHistory));
    assert.ok(progressHistory.some((text) => text.includes("Restored 1 of 3")), JSON.stringify(progressHistory));
    assert.deepEqual(
      {
        totalTracks: restored?.totalTracks,
        restored: restored?.restored,
        duplicates: restored?.duplicates,
        failed: restored?.failed,
      },
      { totalTracks: audioFormats.length, restored: audioFormats.length, duplicates: 0, failed: 0 },
    );
    const restoredResults = restored?.results as Array<{ status: string; title: string }>;
    assert.deepEqual(
      restoredResults.map((result) => result.title),
      audioFixtures.map((fixture) => fixture.title),
    );
    assert.deepEqual(
      await page.locator("[data-testid='audio-restore-result']").allInnerTexts(),
      audioFixtures.map((fixture) => `${fixture.title}\nRestored`),
      "the browser presents a final result for every file",
    );
    const restoredTrackIds = restoredResults.map((result: { trackId: string }) => result.trackId);
    assert.ok(restoredTrackIds.every((id: string) => /^[0-9a-f-]{36}$/i.test(id)));
    await page.getByRole("status").filter({ hasText: /Restored 3 originals/ }).waitFor({ timeout: 10_000 });

    const libraryService = await import("../lib/arena/src/lib/waveyard/library/service.ts");
    const restoredOwnerTracks = await libraryService.listTracks({ ownerId: localOwnerId });
    assert.equal(restoredOwnerTracks.length, audioFormats.length, "all restored rows are in the disposable library");
    const tracksByTitle = new Map(restoredOwnerTracks.map((track) => [track.title, track]));
    const expectedApiOrigin = new URL(base).origin;
    for (const fixture of audioFixtures) {
      const track = tracksByTitle.get(fixture.title);
      assert.ok(track, `${fixture.title} appears in the Waveyard library`);
      const playButton = page.getByTestId(`button-play-${track.id}`);
      await playButton.waitFor({ state: "visible", timeout: 10_000 });

      const assetResponsePromise = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.origin === expectedApiOrigin && url.pathname === `/api/assets/${track.sourceAssetId}`;
      }, { timeout: 20_000 });
      await playButton.click();
      const assetResponse = await assetResponsePromise;
      assert.ok([200, 206].includes(assetResponse.status()), `${fixture.title} asset is served`);
      assert.equal(assetResponse.headers()["content-type"], fixture.mimeType, `${fixture.title} MIME is correct`);

      await page.getByTestId("session-play").waitFor({ state: "visible", timeout: 15_000 });
      await page.waitForFunction((assetId) => {
        const button = document.querySelector('[data-testid="session-play"]');
        const audio = document.querySelector('audio[aria-label="source audio"]') as HTMLAudioElement | null;
        return button?.getAttribute("aria-pressed") === "true"
          && audio !== null
          && audio.currentSrc.includes(`/api/assets/${assetId}`)
          && !audio.paused
          && audio.currentTime > 0.25;
      }, track.sourceAssetId, { timeout: 20_000 });
      const startingPosition = await page.locator('audio[aria-label="source audio"]').evaluate((audio) =>
        (audio as HTMLAudioElement).currentTime,
      );
      await page.waitForFunction(({ assetId, start }) => {
        const audio = document.querySelector('audio[aria-label="source audio"]') as HTMLAudioElement | null;
        return audio !== null
          && audio.currentSrc.includes(`/api/assets/${assetId}`)
          && !audio.paused
          && audio.currentTime > start + 0.2;
      }, { assetId: track.sourceAssetId, start: startingPosition }, { timeout: 10_000 });
      assert.ok(servedAssets.includes(track.sourceAssetId), `${fixture.title} was served by the actual asset route`);
      assert.deepEqual(
        servedAssetResponses.get(track.sourceAssetId),
        { status: assetResponse.status(), contentType: fixture.mimeType },
        `${fixture.title} response is tracked from the isolated route`,
      );
      assert.ok(track.durationSeconds >= 2.5 && track.durationSeconds <= 4.5, `${fixture.title} duration was probed`);
    }

    assert.ok(browserApiRequests.some((entry) => entry.method === "POST" && entry.path === "/api/library/audio-backup/restore"));
    for (const track of restoredOwnerTracks) {
      assert.ok(browserApiRequests.some((entry) => entry.method === "GET" && entry.path === `/api/assets/${track.sourceAssetId}`));
    }
    assert.deepEqual(pageErrors, [], "the real restore-and-play flow has no browser exceptions");

    const [finalLibrary, ownerTracks] = await Promise.all([
      fetch(`${apiBase}/api/library/tracks`).then((response) => response.json()),
      libraryService.listTracks({ ownerId: localOwnerId }),
    ]);
    assert.deepEqual(
      finalLibrary.tracks.map((track: { id: string }) => track.id).sort(),
      [...restoredTrackIds].sort(),
    );
    assert.equal(ownerTracks.length, audioFormats.length, "only generated restore fixtures exist in the isolated library");
    assert.ok(apiRequests.some((request) => request.path === "/api/library/audio-backup/restore"));
    assert.ok(apiRequests.some((request) => request.path === "/api/library/tracks"));
    assert.ok(apiRequests.some((request) => request.path.startsWith("/api/library/sessions/")));
    assert.ok(apiRequests.some((request) => request.path.startsWith("/api/assets/")));
    for (const entry of browserApiRequests) {
      assert.equal(entry.origin, expectedApiOrigin, `browser API ${entry.path} stayed on the app origin`);
      assert.ok(apiRequests.some((request) => request.method === entry.method && request.path === entry.path),
        `browser API request ${entry.method} ${entry.path} was served by the isolated route harness`);
    }
    await browserContext.close();
  } finally {
    await browser.close();
    await archive.dispose();
  }
});

