import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { execTool } from "../waveyard/ffmpeg";

// The local media library — the Plex-independence groundwork (PG-gated).
// Everything here is real: real video files generated with the real ffmpeg,
// really probed, really synced into the real database, really streamed back
// through the route handler with real HTTP Range requests, really transcoded
// through the Toolbox engine. No fixture servers at all — there is no server
// to fixture. That's the point.

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

// Route modules import the db pool at import time — only after the env fix.
const { saveMediaProvider, deleteMediaProvider, runProviderSync, testMediaProviderConnection } = await import("./sync");
const { runReconciliation } = await import("./reconcile");
const {
  LIBRARY_CACHE_ROOT,
  cachePathFor,
  classifyPlayability,
  getLocalItem,
  getTranscodeState,
  recordWatchProgress,
  resolvePlayability,
} = await import("./local");
const { GET: libraryGet, POST: libraryPost } = await import("../../app/api/library/route");
const { GET: streamGet, HEAD: streamHead } = await import("../../app/api/library/stream/[id]/route");
const { db, pool } = await import("@/db");
const {
  archiveItems,
  archiveObservations,
  archiveReviewItems,
  mediaLibraryItems,
  mediaRefreshes,
  mediaProviders,
  reconciliationRuns,
} = await import("@/db/schema");

const BASE = "http://local/api/library";
let mediaRoot: string | null = null;

async function makeLibrary(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "local-library-"));
  await import("node:fs/promises").then((fs) => fs.mkdir(join(root, "Movies"), { recursive: true }));
  await import("node:fs/promises").then((fs) => fs.mkdir(join(root, "Shows"), { recursive: true }));
  // Browser-playable MP4 (h264 + aac in an MP4 container).
  await execTool("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=12:duration=2",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
    "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac",
    join(root, "Movies", "Sintel.2010.mp4"),
  ]);
  // h264 in an MKV container — codecs fine, container isn't browser-safe.
  await execTool("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=12:duration=2",
    "-f", "lavfi", "-i", "sine=frequency=330:duration=2",
    "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac",
    join(root, "Movies", "Heat.1995.mkv"),
  ]);
  // HEVC episode — codec AND container both need a playable copy.
  await execTool("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=12:duration=2",
    "-c:v", "libx265", "-preset", "ultrafast", "-an",
    join(root, "Shows", "Show.Name.S01E01.mkv"),
  ]);
  // Junk pretending to be video → must be skipped honestly.
  await writeFile(join(root, "Movies", "broken.mp4"), "this is not a video");
  // Not a video extension → ignored entirely.
  await writeFile(join(root, "Movies", "notes.txt"), "shopping list");
  return root;
}

after(async () => {
  if (pgUp) {
    await db.delete(archiveObservations);
    await db.delete(archiveReviewItems);
    await db.delete(mediaLibraryItems);
    await db.delete(mediaRefreshes);
    await db.delete(mediaProviders);
    await db.delete(reconciliationRuns);
    await db.delete(archiveItems);
    await pool.end().catch(() => {});
  }
  if (mediaRoot) await rm(mediaRoot, { recursive: true, force: true }).catch(() => {});
  await rm(LIBRARY_CACHE_ROOT, { recursive: true, force: true }).catch(() => {});
});

test("local library: connect, scan with the real ffprobe, sync into the shared machinery", async () => {
  if (!pgUp) return assert.fail("PG required");
  mediaRoot = await makeLibrary();

  // Connection test: honest folder listing, no server involved.
  const connection = await testMediaProviderConnection({ kind: "local", baseUrl: mediaRoot, token: "" });
  assert.equal(connection.ok, true);
  if (connection.ok) {
    assert.ok(connection.libraries.includes("Movies") && connection.libraries.includes("Shows"));
  }

  const saved = await saveMediaProvider({ kind: "local", name: "My disk", baseUrl: mediaRoot, token: "" });
  assert.equal(saved.kind, "local");
  assert.equal(saved.baseUrl, mediaRoot);

  const outcome = await runProviderSync("local");
  assert.equal(outcome.status, "synced");
  assert.equal(outcome.itemCount, 3, "three real video files indexed");
  assert.equal(outcome.snapshotCompleteness, "partial", "broken.mp4 was skipped → honest partial");
  assert.ok(outcome.failedLibraries.some((f) => f.library.includes("broken.mp4")));

  const rows = await db.select().from(mediaLibraryItems);
  const byKey = new Map(rows.map((r) => [r.ratingKey, r]));
  const sintel = byKey.get("Movies/Sintel.2010.mp4");
  const heat = byKey.get("Movies/Heat.1995.mkv");
  const episode = byKey.get("Shows/Show.Name.S01E01.mkv");
  assert.ok(sintel && heat && episode, "relative paths are the rating keys");

  // Real probed facts, not fixtures.
  assert.equal(sintel!.title, "Sintel");
  assert.equal(sintel!.year, 2010);
  assert.equal(sintel!.itemType, "movie");
  assert.equal((sintel!.raw as Record<string, unknown>).videoCodec, "h264");
  assert.ok((sintel!.durationMs ?? 0) > 1500, "duration really probed");

  assert.equal(heat!.year, 1995);
  assert.equal((heat!.raw as Record<string, unknown>).container, "matroska,webm");

  assert.equal(episode!.itemType, "episode");
  assert.equal(episode!.title, "Show Name");
  assert.equal((episode!.raw as Record<string, unknown>).videoCodec, "hevc");

  // http URL validation must still reject plex-style input for local, and
  // local folders must still be rejected for plex.
  await assert.rejects(
    () => saveMediaProvider({ kind: "local", baseUrl: "http://not-a-folder", token: "" }),
    /absolute folder path/,
  );
  await assert.rejects(
    () => saveMediaProvider({ kind: "plex", baseUrl: mediaRoot!, token: "" }),
    /http/,
  );
});

test("local library: playability is classified honestly", async () => {
  if (!pgUp) return assert.fail("PG required");
  const sintel = await getLocalItem((await db.select().from(mediaLibraryItems).where((await import("drizzle-orm")).eq(mediaLibraryItems.ratingKey, "Movies/Sintel.2010.mp4")))[0].id);
  const heat = await getLocalItem((await db.select().from(mediaLibraryItems).where((await import("drizzle-orm")).eq(mediaLibraryItems.ratingKey, "Movies/Heat.1995.mkv")))[0].id);
  assert.equal(classifyPlayability((sintel!.raw as Record<string, unknown>)).mode, "direct");
  const mkvPlay = classifyPlayability(heat!.raw as Record<string, unknown>);
  assert.equal(mkvPlay.mode, "transcode");
  assert.ok(mkvPlay.mode === "transcode" && mkvPlay.reason.includes("container"));
});

test("local library: watch progress is OURS and survives rescans", async () => {
  if (!pgUp) return assert.fail("PG required");
  const { eq } = await import("drizzle-orm");
  const [showRow] = await db.select().from(mediaLibraryItems).where(eq(mediaLibraryItems.ratingKey, "Shows/Show.Name.S01E01.mkv"));

  const mid = await recordWatchProgress({ itemId: showRow.id, positionMs: 800 });
  assert.equal(mid.viewOffsetMs, 800);

  // Rescan must NOT forget what was watched (800ms < 95% of the 2s file, so
  // this is genuinely in-progress, not finished).
  await runProviderSync("local");
  const [after] = await db.select().from(mediaLibraryItems).where(eq(mediaLibraryItems.id, showRow.id));
  assert.equal(after.viewOffsetMs, 800);
  assert.ok(after.lastViewedAt !== null);

  // Finishing bumps the count and resets the offset.
  const done = await recordWatchProgress({ itemId: showRow.id, positionMs: 2100, durationMs: 2000 });
  assert.equal(done.viewCount, 1);
  assert.equal(done.viewOffsetMs, 0);
});

test("local library: transcode-on-demand builds a real playable copy through the Toolbox engine", async () => {
  if (!pgUp) return assert.fail("PG required");
  const { eq } = await import("drizzle-orm");
  const [heatRow] = await db.select().from(mediaLibraryItems).where(eq(mediaLibraryItems.ratingKey, "Movies/Heat.1995.mkv"));

  const before = await resolvePlayability(heatRow);
  assert.equal(before.mode, "transcode");

  const response = await libraryPost(
    new Request(BASE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "transcode", itemId: heatRow.id }),
    }),
  );
  assert.equal(response.status, 200);
  const started = (await response.json()).transcode as { status: string };
  assert.equal(started.status, "running");

  const deadline = Date.now() + 120_000;
  for (;;) {
    const state = getTranscodeState(heatRow.id);
    if (state?.status === "done" || state?.status === "failed") {
      assert.equal(state.status, "done", `transcode failed: ${state.error}`);
      break;
    }
    if (Date.now() > deadline) throw new Error("transcode timed out");
    await new Promise((r) => setTimeout(r, 300));
  }

  // The cached copy is a REAL h264 mp4 — re-probed, not assumed.
  const { probeSource } = await import("../toolbox/convert");
  const cacheProbe = await probeSource(cachePathFor(heatRow.id));
  assert.equal(cacheProbe.videoCodec, "h264");
  assert.ok(cacheProbe.formatName?.includes("mp4"));

  // Playability flips to cached, and the route says so.
  const after = await resolvePlayability(heatRow);
  assert.equal(after.mode, "cached");
  const itemResponse = await libraryGet(new Request(`${BASE}?id=${heatRow.id}`));
  const data = await itemResponse.json();
  assert.equal(data.playability.mode, "cached");
  assert.ok(String(data.streamUrl).includes("/api/library/stream/"));
});

test("local library: streaming works with real HTTP Range semantics", async () => {
  if (!pgUp) return assert.fail("PG required");
  const { eq } = await import("drizzle-orm");
  const [sintelRow] = await db.select().from(mediaLibraryItems).where(eq(mediaLibraryItems.ratingKey, "Movies/Sintel.2010.mp4"));
  const [heatRow] = await db.select().from(mediaLibraryItems).where(eq(mediaLibraryItems.ratingKey, "Movies/Heat.1995.mkv"));

  // Direct file: full body.
  const full = await streamGet(new Request(`${BASE}/stream/${sintelRow.id}`), { params: Promise.resolve({ id: String(sintelRow.id) }) });
  assert.equal(full.status, 200);
  assert.equal(full.headers.get("content-type"), "video/mp4");
  assert.equal(full.headers.get("accept-ranges"), "bytes");
  assert.equal(full.headers.get("x-stream-source"), "source-file");
  const fullBytes = new Uint8Array(await full.arrayBuffer());
  const onDisk = await readFile(join(mediaRoot!, "Movies", "Sintel.2010.mp4"));
  assert.equal(fullBytes.length, onDisk.length);

  // Range request: the exact requested slice.
  const ranged = await streamGet(
    new Request(`${BASE}/stream/${sintelRow.id}`, { headers: { range: "bytes=0-99" } }),
    { params: Promise.resolve({ id: String(sintelRow.id) }) },
  );
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get("content-length"), "100");
  assert.equal(ranged.headers.get("content-range"), `bytes 0-99/${onDisk.length}`);
  const slice = new Uint8Array(await ranged.arrayBuffer());
  assert.deepEqual(Buffer.from(slice), onDisk.subarray(0, 100));

  // Suffix range: the last 50 bytes.
  const suffix = await streamGet(
    new Request(`${BASE}/stream/${sintelRow.id}`, { headers: { range: "bytes=-50" } }),
    { params: Promise.resolve({ id: String(sintelRow.id) }) },
  );
  assert.equal(suffix.status, 206);
  const tail = new Uint8Array(await suffix.arrayBuffer());
  assert.deepEqual(Buffer.from(tail), onDisk.subarray(onDisk.length - 50));

  // Out-of-range start → 416 with the honest size.
  const invalid = await streamGet(
    new Request(`${BASE}/stream/${sintelRow.id}`, { headers: { range: `bytes=${onDisk.length + 10}-` } }),
    { params: Promise.resolve({ id: String(sintelRow.id) }) },
  );
  assert.equal(invalid.status, 416);
  assert.equal(invalid.headers.get("content-range"), `bytes */${onDisk.length}`);

  // HEAD: headers, no body.
  const head = await streamHead(new Request(`${BASE}/stream/${sintelRow.id}`, { method: "HEAD" }), { params: Promise.resolve({ id: String(sintelRow.id) }) });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), String(onDisk.length));
  assert.equal(await head.text(), "");

  // Cached item serves the transcode cache as MP4.
  const cached = await streamGet(new Request(`${BASE}/stream/${heatRow.id}`), { params: Promise.resolve({ id: String(heatRow.id) }) });
  assert.equal(cached.status, 200);
  assert.equal(cached.headers.get("content-type"), "video/mp4");
  assert.equal(cached.headers.get("x-stream-source"), "transcode-cache");

  // Unknown id → 404.
  const missing = await streamGet(new Request(`${BASE}/stream/999999`), { params: Promise.resolve({ id: "999999" }) });
  assert.equal(missing.status, 404);
});

test("local library: nothing outside the configured root can ever be streamed", async () => {
  if (!pgUp) return assert.fail("PG required");
  const { eq } = await import("drizzle-orm");
  const [heatRow] = await db.select().from(mediaLibraryItems).where(eq(mediaLibraryItems.ratingKey, "Movies/Heat.1995.mkv"));
  // Simulate a tampered row pointing outside the library.
  await db
    .update(mediaLibraryItems)
    .set({ raw: { ...(heatRow.raw as Record<string, unknown>), filePath: "/etc/passwd" } })
    .where(eq(mediaLibraryItems.id, heatRow.id));
  const attempt = await streamGet(new Request(`${BASE}/stream/${heatRow.id}`), { params: Promise.resolve({ id: String(heatRow.id) }) });
  assert.equal(attempt.status, 404);
});

test("local library: the shelf list and progress route work over HTTP", async () => {
  if (!pgUp) return assert.fail("PG required");
  const listResponse = await libraryGet(new Request(BASE));
  const list = await listResponse.json();
  assert.equal(list.items.length, 3);
  assert.ok(list.items.every((i: { libraryName: string }) => ["Movies", "Shows"].includes(i.libraryName)));

  const [sintelRow] = await db.select().from(mediaLibraryItems).where((await import("drizzle-orm")).eq(mediaLibraryItems.ratingKey, "Movies/Sintel.2010.mp4"));
  const progressResponse = await libraryPost(
    new Request(BASE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "progress", itemId: sintelRow.id, positionMs: 800 }),
    }),
  );
  assert.equal(progressResponse.status, 200);
  const progress = await progressResponse.json();
  assert.equal(progress.viewOffsetMs, 800);

  const badProgress = await libraryPost(
    new Request(BASE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "progress", itemId: sintelRow.id, positionMs: -5 }),
    }),
  );
  assert.equal(badProgress.status, 400);
});

test("local library: local items flow into reconciliation as a first-class provider", async () => {
  if (!pgUp) return assert.fail("PG required");
  const [inserted] = await db
    .insert(archiveItems)
    .values({ name: "Heat (1995)", kind: "video", path: join(mediaRoot!, "Movies", "Heat.1995.mkv") })
    .returning();
  try {
    const summary = await runReconciliation();
    assert.ok(summary.providerCount >= 3, "local library items count as provider items");
    assert.ok(summary.matchedCount >= 1, "Heat matched across the index and the local library");
  } finally {
    await db.delete(archiveItems).where((await import("drizzle-orm")).eq(archiveItems.id, inserted.id));
  }
  // Deleting the provider keeps the rows as inert history (same as plex),
  // but streaming must die with it — no root, no bytes.
  const [heatForGuard] = await db.select().from(mediaLibraryItems).where((await import("drizzle-orm")).eq(mediaLibraryItems.ratingKey, "Movies/Heat.1995.mkv"));
  assert.equal(await deleteMediaProvider("local"), true);
  const providersLeft = await db.select().from(mediaProviders);
  assert.equal(providersLeft.length, 0);
  const blocked = await streamGet(new Request(`${BASE}/stream/${heatForGuard.id}`), { params: Promise.resolve({ id: String(heatForGuard.id) }) });
  assert.equal(blocked.status, 404);
});
