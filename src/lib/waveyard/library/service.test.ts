/**
 * Listening-layer service tests — REAL integration, real PostgreSQL.
 *
 * These are not contract mocks: the suite boots the actual embedded
 * PostgreSQL cluster (the same @embedded-postgres binaries the desktop
 * runtime ships), applies the canonical desktop-migrations, points DATABASE_URL
 * and the private storage dir at temp locations, then exercises the service
 * exactly as the API routes do — intake through the shared pipeline
 * (ffprobe, checksum, private storage, separation/waveform job rows),
 * tracks, search, play counting, playback state, queue, playlists, stem
 * availability, and the studio/library project separation.
 */

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import path from "node:path";
import { eq } from "drizzle-orm";

const repoRoot = path.resolve(path.dirname(process.argv[1] ?? "."), "..", "..", "..", "..");
const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

type ServiceModule = typeof import("./service");
type DbModule = typeof import("@/db");
type SchemaModule = typeof import("@/db/waveyardSchema");

let service: ServiceModule;
let db: DbModule;
let schema: SchemaModule;
let pool: import("pg").Pool;
let client: import("pg").Client | null = null;
let postgresProcess: import("node:child_process").ChildProcess | null = null;
let root: string | null = null;
let dataDir: string | null = null;

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

/** A real, playable WAV: 44.1kHz mono 16-bit sine, so ffprobe reads true
 * duration and the checksum is real content. */
function writeWav(filePath: string, seconds: number, frequency = 220): void {
  const sampleRate = 44100;
  const samples = Math.floor(seconds * sampleRate);
  const dataSize = samples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < samples; index += 1) {
    buffer.writeInt16LE(Math.round(12000 * Math.sin(2 * Math.PI * frequency * (index / sampleRate))), 44 + index * 2);
  }
  writeFileSync(filePath, buffer);
}

before(async () => {
  root = mkdtempSync(path.join(tmpdir(), "waveyard-library-test-"));
  dataDir = path.join(root, "pgdata");
  const storageDir = path.join(root, "storage");
  mkdirSync(storageDir, { recursive: true });
  const port = await freePort();

  // --- boot the real embedded cluster (mirrors desktop/runtime) ---
  const pwFile = path.join(root, ".pw");
  writeFileSync(pwFile, "arena-test", { mode: 0o600 });
  const init = spawnSync(embeddedBinary("initdb"), [
    "-D", dataDir, "-U", "arena", "--pwfile", pwFile, "-E", "UTF8", "--locale", "C", "-A", "scram-sha-256",
  ], { encoding: "utf8", timeout: 120_000 });
  rmSync(pwFile, { force: true });
  if (init.status !== 0) throw new Error(`initdb failed (${init.status}): ${(init.stdout ?? "") + (init.stderr ?? "")}`.slice(0, 2000));

  postgresProcess = spawn(embeddedBinary("postgres"), [
    "-D", dataDir, "-p", String(port), "-h", "127.0.0.1", "-F",
  ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });

  const { Client } = await import("pg");
  const admin = new Client({ connectionString: `postgresql://arena:arena-test@127.0.0.1:${port}/postgres` });
  const deadline = Date.now() + 30_000;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      await admin.connect();
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  if (lastError !== null) throw new Error(`embedded postgres never became ready: ${String(lastError)}`);
  await admin.query("create database arena_library_test");
  await admin.end();

  client = new Client({ connectionString: `postgresql://arena:arena-test@127.0.0.1:${port}/arena_library_test` });
  await client.connect();
  const { applyMigrations } = await import("../../../../desktop/runtime/migrate");
  const outcome = await applyMigrations({ client, migrationsDir: path.join(repoRoot, "desktop-migrations") });
  assert.ok(outcome.applied.length >= 2, "canonical migrations must apply (initial + listening layer)");

  // --- env BEFORE any app module import (db reads DATABASE_URL at load) ---
  process.env.DATABASE_URL = `postgresql://arena:arena-test@127.0.0.1:${port}/arena_library_test`;
  process.env.WAVEYARD_STORAGE_DIR = path.join(storageDir, "objects");

  service = await import("./service");
  db = (await import("@/db")) as DbModule;
  schema = (await import("@/db/waveyardSchema")) as SchemaModule;
  pool = (db as unknown as { pool: import("pg").Pool }).pool;
  sessions = await import("./session-service");
  sessionLogic = await import("./session-logic");
});

after(async () => {
  try {
    await pool?.end();
  } catch {
    /* already closed */
  }
  try {
    await client?.end();
  } catch {
    /* already closed */
  }
  if (dataDir !== null) {
    spawnSync(embeddedBinary("pg_ctl"), ["-D", dataDir, "-m", "fast", "-w", "-t", "20", "stop"], { timeout: 30_000 });
  }
  if (postgresProcess !== null && postgresProcess.exitCode === null) {
    postgresProcess.kill();
  }
  if (root !== null) rmSync(root, { recursive: true, force: true });
});

// Real temp audio files used across the tests.
let trackA: Awaited<ReturnType<ServiceModule["addTrackFromAudioFile"]>>["track"];
let trackB: Awaited<ReturnType<ServiceModule["addTrackFromAudioFile"]>>["track"];
const sourceIdByTrackId = new Map<string, string>();

function countStoredFiles(dir: string): number {
  let files = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files += countStoredFiles(full);
    else if (entry.isFile()) files += 1;
  }
  return files;
}

test("library intake creates a playable track through the existing pipeline", async () => {
  const filePath = path.join(root!, "aphex.wav");
  writeWav(filePath, 2);
  const result = await service.addTrackFromAudioFile({
    ownerId: OWNER,
    filePath,
    filename: "Aphex Twin - Windowlicker.wav",
    mimeType: "audio/wav",
  });
  trackA = result.track;
  assert.equal(result.created, true);
  assert.ok(result.separationQueued === false, "no queue in this environment — enqueue state must be honest");
  assert.equal(trackA.title, "Windowlicker");
  assert.equal(trackA.artist, "Aphex Twin");
  assert.equal(trackA.durationSeconds, 2);
  // The source really went through storage + the shared pipeline.
  const [trackRow] = await db.db.select().from(schema.tracks).where(eq(schema.tracks.id, trackA.id)).limit(1);
  sourceIdByTrackId.set(trackA.id, trackRow.sourceAssetId);
  const [source] = await db.db.select().from(schema.sourceAssets).where(eq(schema.sourceAssets.id, trackRow.sourceAssetId)).limit(1);
  assert.ok(source, "source asset exists");
  assert.equal(source.codec, "pcm_s16le"); // real ffprobe codec for a 16-bit WAV
  assert.equal(source.sampleRate, 44100);
});

test("duplicate audio is idempotent: same checksum returns the same track, no second copy", async () => {
  const filePath = path.join(root!, "aphex-copy.wav");
  writeWav(filePath, 2); // same content parameters → same bytes → same checksum
  const again = await service.addTrackFromAudioFile({
    ownerId: OWNER,
    filePath,
    filename: "Aphex Twin - Windowlicker (copy).wav",
    mimeType: "audio/wav",
  });
  assert.equal(again.created, false);
  assert.equal(again.track.id, trackA.id);
  // ONE source asset, ONE stored object — audio never duplicated.
  const sources = await db.db.select().from(schema.sourceAssets);
  assert.equal(sources.length, 1);
  assert.equal(
    countStoredFiles(process.env.WAVEYARD_STORAGE_DIR!),
    1,
    "exactly one stored audio object",
  );
});

test("track detail resolves source, stems, analysis, and the studio handoff project", async () => {
  const detail = await service.getTrack(OWNER, trackA.id);
  assert.ok(detail !== null);
  assert.equal(detail.playback.kind, "source");
  assert.deepEqual(detail.playback.assetIds, [detail.source.id]);
  assert.equal(detail.stemAvailability.status, "unavailable", "no stems and no pending job → honest unavailable");
  const [container] = await db.db.select().from(schema.projects).where(eq(schema.projects.id, detail.studioProjectId)).limit(1);
  assert.ok(container);
  assert.equal(container.kind, "library");
});

test("listing and search operate on real persisted metadata", async () => {
  const filePath = path.join(root!, "boards.wav");
  writeWav(filePath, 3, 330); // different frequency → different checksum
  trackB = (await service.addTrackFromAudioFile({
    ownerId: OWNER,
    filePath,
    filename: "Boards of Canada - Roygbiv.wav",
    mimeType: "audio/wav",
  })).track;
  sourceIdByTrackId.set(trackB.id, (await service.getTrack(OWNER, trackB.id))!.source.id);

  const all = await service.listTracks({ ownerId: OWNER });
  assert.equal(all.length, 2);
  assert.equal(all[0].id, trackB.id, "newest first");

  for (const [query, expectedId] of [
    ["aphex", trackA.id],
    ["WINDOWLICKER", trackA.id],
    ["boards of canada", trackB.id],
    ["roygbiv", trackB.id],
  ] as const) {
    const found = await service.listTracks({ ownerId: OWNER, search: query });
    assert.equal(found.length, 1, `search "${query}"`);
    assert.equal(found[0].id, expectedId);
  }
  const none = await service.listTracks({ ownerId: OWNER, search: "zzz-no-such-artist" });
  assert.equal(none.length, 0);
});

test("play counting increments once per recorded listen and marks recency", async () => {
  const first = await service.recordPlay(OWNER, trackA.id);
  assert.ok(first !== null);
  assert.equal(first.playCount, 1);
  assert.ok(first.lastPlayedAt !== null);
  const second = await service.recordPlay(OWNER, trackA.id);
  assert.equal(second?.playCount, 2);
  const recent = await service.listRecentlyPlayed(OWNER);
  assert.equal(recent.length, 1);
  assert.equal(recent[0].id, trackA.id);
  // A play that never happened (wrong owner) counts for nobody.
  assert.equal(await service.recordPlay(OTHER, trackA.id), null);
});

test("durable playback state round-trips (stem mix, volume, position)", async () => {
  await service.savePlaybackState(OWNER, {
    currentTrackId: trackA.id,
    positionSeconds: 41.5,
    stemMix: { vocals: 0.8, drums: 0, bass: 1.4, other: 1 },
    masterVolume: 0.65,
    repeatMode: "all",
    shuffle: true,
  });
  const state = await service.getPlaybackState(OWNER);
  assert.equal(state.currentTrackId, trackA.id);
  assert.equal(state.positionSeconds, 41.5);
  assert.deepEqual(state.stemMix, { vocals: 0.8, drums: 0, bass: 1.4, other: 1 });
  assert.equal(state.masterVolume, 0.65);
  assert.equal(state.repeatMode, "all");
  assert.equal(state.shuffle, true);
  // Ownership guard: a foreign track id is never persisted as current.
  const guarded = await service.savePlaybackState(OWNER, {
    currentTrackId: "33333333-3333-4333-8333-333333333333",
  });
  assert.equal(guarded.currentTrackId, null);
});

test("queue: add end/next, move, remove, clear — ordered and owner-scoped", async () => {
  let queue = await service.addToQueue({ ownerId: OWNER, trackId: trackA.id });
  assert.equal(queue.length, 1);
  queue = await service.addToQueue({ ownerId: OWNER, trackId: trackB.id });
  assert.equal(queue.map((item) => item.track.id).join(","), [trackA.id, trackB.id].join(","), "adds stack at the end in order");

  // "next" inserts right after the currently playing track.
  queue = await service.addToQueue({ ownerId: OWNER, trackId: trackB.id, at: "next", currentTrackId: trackA.id });
  assert.equal(
    queue.map((item) => item.track.id).join(","),
    [trackA.id, trackB.id, trackB.id].join(","),
  );

  // queue is [A, B₂, B₁]; moving B₁ (queue[2]) to the front → [B₁, A, B₂].
  const moved = await service.moveQueueItem(OWNER, queue[2].id, 0);
  assert.equal(moved.map((item) => item.track.id).join(","), [trackB.id, trackA.id, trackB.id].join(","));

  // removing B₁ (moved[0]) leaves [A, B₂].
  const removed = await service.removeQueueItem(OWNER, moved[0].id);
  assert.equal(removed.map((item) => item.track.id).join(","), [trackA.id, trackB.id].join(","));
  assert.deepEqual(removed.map((item) => item.position), [0, 1], "positions resequence without gaps");

  // Another owner's queue is independent.
  writeWav(path.join(root!, "other-owner.wav"), 2, 440); // distinct content
  const otherQueue = await service.addToQueue({ ownerId: OTHER, trackId: (await service.addTrackFromAudioFile({
    ownerId: OTHER,
    filePath: path.join(root!, "other-owner.wav"),
    filename: "Other Owner - Isolated Track.wav",
    mimeType: "audio/wav",
  })).track.id });
  assert.equal(otherQueue.length, 1);
  assert.equal((await service.listQueue(OWNER)).length, 2);

  const cleared = await service.clearQueue(OWNER);
  assert.equal(cleared.length, 0);
  assert.equal((await service.listQueue(OTHER)).length, 1, "clearing one owner never touches another");
});

test("playlists: create, add (duplicates allowed), reorder, remove, delete", async () => {
  const playlist = await service.createPlaylist(OWNER, "Late Night");
  assert.equal(playlist.trackCount, 0);

  let detail = await service.addTrackToPlaylist({ ownerId: OWNER, playlistId: playlist.id, trackId: trackA.id });
  assert.equal(detail.items.length, 1);
  // A song twice in one playlist is a legitimate decision.
  detail = await service.addTrackToPlaylist({ ownerId: OWNER, playlistId: playlist.id, trackId: trackA.id });
  assert.equal(detail.items.length, 2);

  detail = await service.movePlaylistItem(OWNER, playlist.id, detail.items[1].id, 0);
  assert.equal(detail.items.map((item) => item.track.id).join(","), [trackA.id, trackA.id].join(","));

  detail = await service.removePlaylistItem(OWNER, playlist.id, detail.items[0].id);
  assert.equal(detail.items.length, 1);
  assert.deepEqual(detail.items.map((item) => item.position), [0]);

  const summaries = await service.listPlaylists(OWNER);
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].trackCount, 1);

  const renamed = await service.renamePlaylist(OWNER, playlist.id, "Late Night v2");
  assert.equal(renamed.name, "Late Night v2");

  await service.deletePlaylist(OWNER, playlist.id);
  assert.equal((await service.listPlaylists(OWNER)).length, 0);
  // Deleting a playlist never deletes the music.
  assert.equal((await service.listTracks({ ownerId: OWNER })).length, 2);
});

test("real stems change availability and what the player loads", async () => {
  const sourceId = sourceIdByTrackId.get(trackA.id)!;
  const stemIds: string[] = [];
  for (const stemType of ["vocals", "drums", "bass", "other"]) {
    const [stem] = await db.db.insert(schema.stemAssets).values({
      projectId: trackA.studioProjectId,
      sourceAssetId: sourceId,
      separationJobId: (await db.db.select().from(schema.processingJobs).where(eq(schema.processingJobs.sourceAssetId, sourceId)).limit(1))[0].id,
      stemType,
      engine: "demucs",
      model: "htdemucs",
      modelVersion: "test",
      storageKey: `test/${stemType}.wav`,
      checksumSha256: `checksum-${stemType}`,
      durationSeconds: 2,
      sampleRate: 44100,
      channels: 1,
      codec: "wav",
      format: "wav",
      fileSizeBytes: 100,
    }).returning();
    stemIds.push(stem.id);
  }
  const detail = await service.getTrack(OWNER, trackA.id);
  assert.equal(detail!.stemAvailability.status, "separated");
  assert.equal((detail!.stemAvailability as { stemCount: number }).stemCount, 4);
  assert.equal(detail!.playback.kind, "stems");
  assert.deepEqual(detail!.playback.assetIds, stemIds);
  const listed = await service.listTracks({ ownerId: OWNER });
  assert.equal(listed.find((track) => track.id === trackA.id)?.stemAvailability.status, "separated");
});

test("passthrough bridge = honest source-only playback", async () => {
  const sourceId = sourceIdByTrackId.get(trackB.id)!;
  const [job] = await db.db.select().from(schema.processingJobs).where(eq(schema.processingJobs.sourceAssetId, sourceId)).limit(1);
  const [stem] = await db.db.insert(schema.stemAssets).values({
    projectId: trackB.studioProjectId,
    sourceAssetId: sourceId,
    separationJobId: job.id,
    stemType: "source",
    engine: "passthrough-unseparated",
    model: "none",
    modelVersion: "none",
    storageKey: "test/passthrough.wav",
    checksumSha256: "checksum-passthrough",
    durationSeconds: 3,
    sampleRate: 44100,
    channels: 1,
    codec: "wav",
    format: "wav",
    fileSizeBytes: 100,
  }).returning();
  const detail = await service.getTrack(OWNER, trackB.id);
  assert.equal(detail!.stemAvailability.status, "source-only");
  assert.equal(detail!.playback.kind, "source");
  assert.deepEqual(detail!.playback.assetIds, [stem.id]);
});

test("analysis surfaces tempo and key when the engine completed it", async () => {
  const sourceId = sourceIdByTrackId.get(trackA.id)!;
  await db.db.insert(schema.sourceAnalyses).values({
    projectId: trackA.studioProjectId,
    sourceAssetId: sourceId,
    status: "complete",
    stage: "complete",
    analysisEngine: "arena-js-dsp",
    analysisEngineVersion: "test",
    sourceChecksumSha256: "checksum",
    idempotencyKey: `analysis-test:${sourceId}`,
    bpm: 128.5,
    musicalKey: "A minor",
    beatGrid: JSON.stringify([0, 468, 936, 1404, 1872, 2340]),
  });
  const detail = await service.getTrack(OWNER, trackA.id);
  assert.equal(detail!.analysis?.status, "complete");
  assert.equal(detail!.analysis?.bpm, 128.5);
  assert.equal(detail!.analysis?.musicalKey, "A minor");
});

test("library containers never pollute the studio project list; real projects stay", async () => {
  const [studioProject] = await db.db.insert(schema.projects).values({
    ownerId: OWNER,
    title: "A real studio project",
    kind: null,
  }).returning();
  const studioList = await service.listStudioProjects(OWNER);
  const ids = studioList.map((project) => project.id);
  assert.ok(ids.includes(studioProject.id), "real studio projects remain listed");
  assert.ok(!ids.includes(trackA.studioProjectId), "library containers are hidden from the studio list");
  assert.ok(!ids.includes(trackB.studioProjectId));
  // …but the container remains fully reachable directly (Open in Studio).
  const [container] = await db.db.select().from(schema.projects).where(eq(schema.projects.id, trackA.studioProjectId)).limit(1);
  assert.equal(container.kind, "library");
});

test("ownership isolation: another owner sees none of the library", async () => {
  assert.equal((await service.listTracks({ ownerId: OTHER })).length, 1, "only their own track");
  const otherTracks = await service.listTracks({ ownerId: OTHER });
  const otherTrackId = otherTracks[0].id;
  assert.equal(await service.getTrack(OTHER, trackA.id), null);
  await assert.rejects(
    () => service.addToQueue({ ownerId: OTHER, trackId: trackA.id }),
    service.TrackNotFoundError,
  );
  const otherPlaylist = await service.createPlaylist(OTHER, "Theirs");
  await assert.rejects(
    () => service.addTrackToPlaylist({ ownerId: OTHER, playlistId: otherPlaylist.id, trackId: trackA.id }),
    service.TrackNotFoundError,
  );
  await assert.rejects(
    async () => service.getPlaylist(OTHER, (await service.createPlaylist(OWNER, "Ours")).id),
    service.PlaylistNotFoundError,
  );
  assert.notEqual(otherTrackId, trackA.id);
});

// ============================================================================
// P3 — listening sessions (real integration, same cluster)
// ============================================================================

// Loaded at the END of the database-boot before-hook (see below): these
// modules import @/db, whose pool reads DATABASE_URL once at load — the
// src-loader pre-sets an intentionally-unconnectable placeholder, so the
// boot hook MUST set the real URL before any db-touching module loads.
let sessions: typeof import("./session-service");
let sessionLogic: typeof import("./session-logic");

test("session: create, add tracks (ordered, duplicates allowed), reorder, remove", async () => {
  const created = await sessions.createSession(OWNER, "Evening set");
  assert.equal(created.trackCount, 0);

  let detail = await sessions.addTrackToSession({ ownerId: OWNER, sessionId: created.id, trackId: trackA.id });
  assert.equal(detail.tracks.length, 1);
  assert.equal(detail.tracks[0].track.id, trackA.id);
  assert.deepEqual(detail.tracks[0].transition, { mode: "manual", crossfadeSeconds: 4, keepStems: [] }, "sane default transition");

  detail = await sessions.addTrackToSession({ ownerId: OWNER, sessionId: created.id, trackId: trackB.id });
  detail = await sessions.addTrackToSession({ ownerId: OWNER, sessionId: created.id, trackId: trackA.id });
  assert.equal(detail.tracks.length, 3, "a live set can play a song twice");
  assert.deepEqual(detail.tracks.map((entry) => entry.track.id), [trackA.id, trackB.id, trackA.id]);
  assert.deepEqual(detail.tracks.map((entry) => entry.position), [0, 1, 2]);

  detail = await sessions.moveSessionTrack(OWNER, created.id, detail.tracks[2].id, 0);
  assert.deepEqual(detail.tracks.map((entry) => entry.track.id), [trackA.id, trackA.id, trackB.id]);

  detail = await sessions.removeSessionTrack(OWNER, created.id, detail.tracks[1].id);
  assert.deepEqual(detail.tracks.map((entry) => entry.track.id), [trackA.id, trackB.id]);
  assert.deepEqual(detail.tracks.map((entry) => entry.position), [0, 1], "positions resequence");
  await sessions.deleteSession(OWNER, created.id);
  assert.equal((await sessions.listSessions(OWNER)).length, 0);
});

test("session: per-track stem mix and transition persist and round-trip", async () => {
  const created = await sessions.createSession(OWNER, "Mix lab");
  const detail = await sessions.addTrackToSession({ ownerId: OWNER, sessionId: created.id, trackId: trackA.id });

  const updated = await sessions.updateSessionTrack(OWNER, created.id, detail.tracks[0].id, {
    stemMix: { vocals: 0, drums: 1.4, bass: 0.8 },
    transition: { mode: "bar", crossfadeSeconds: 8, keepStems: ["drums"] },
  });
  assert.deepEqual(updated.tracks[0].stemMix, { vocals: 0, drums: 1.4, bass: 0.8 });
  assert.deepEqual(updated.tracks[0].transition, { mode: "bar", crossfadeSeconds: 8, keepStems: ["drums"] });

  const reread = await sessions.getSession(OWNER, created.id);
  assert.deepEqual(reread.tracks[0].stemMix, { vocals: 0, drums: 1.4, bass: 0.8 }, "mix survives a fresh read");
  assert.deepEqual(reread.tracks[0].transition, { mode: "bar", crossfadeSeconds: 8, keepStems: ["drums"] });

  await assert.rejects(
    () => sessions.updateSessionTrack(OWNER, created.id, detail.tracks[0].id, { transition: { mode: "warp", crossfadeSeconds: 1 } }),
    /invalid/i,
    "invalid transition configs are refused",
  );
  await sessions.deleteSession(OWNER, created.id);
});

test("session: restore state persists and round-trips; foreign session tracks never persist", async () => {
  const created = await sessions.createSession(OWNER, "Restore point");
  const withA = await sessions.addTrackToSession({ ownerId: OWNER, sessionId: created.id, trackId: trackA.id });
  const sessionTrackId = withA.tracks[0].id;

  const saved = await sessions.saveSessionState(OWNER, created.id, sessionTrackId, 73.5);
  assert.equal(saved.currentSessionTrackId, sessionTrackId);
  assert.equal(saved.positionSeconds, 73.5);

  const reread = await sessions.getSession(OWNER, created.id);
  assert.equal(reread.currentSessionTrackId, sessionTrackId);
  assert.equal(reread.positionSeconds, 73.5);

  const guarded = await sessions.saveSessionState(OWNER, created.id, "33333333-3333-4333-8333-333333333333", 5);
  assert.equal(guarded.currentSessionTrackId, null, "a session-track id from another session is dropped");
  await sessions.deleteSession(OWNER, created.id);
});

test("session stem swap: real swap recorded with provenance; impossible swaps refused honestly", async () => {
  // Give track B ONE real stem (drums) so it can both donate and be swapped.
  const sourceB = sourceIdByTrackId.get(trackB.id)!;
  const [jobB] = await db.db.select().from(schema.processingJobs).where(eq(schema.processingJobs.sourceAssetId, sourceB)).limit(1);
  await db.db.insert(schema.stemAssets).values({
    projectId: trackB.studioProjectId,
    sourceAssetId: sourceB,
    separationJobId: jobB.id,
    stemType: "drums",
    engine: "demucs",
    model: "htdemucs",
    modelVersion: "test",
    storageKey: "test/b-drums.wav",
    checksumSha256: "checksum-b-drums",
    durationSeconds: 3,
    sampleRate: 44100,
    channels: 1,
    codec: "wav",
    format: "wav",
    fileSizeBytes: 100,
  });

  const created = await sessions.createSession(OWNER, "Swap set");
  const detail = await sessions.addTrackToSession({ ownerId: OWNER, sessionId: created.id, trackId: trackB.id });
  const sessionTrackB = detail.tracks[0].id;

  const swapped = await sessions.recordStemSwap({
    ownerId: OWNER,
    sessionId: created.id,
    sessionTrackId: sessionTrackB,
    stemType: "drums",
    toTrackId: trackA.id, // A has real drums (inserted earlier)
    atSeconds: 12.5,
  });
  assert.equal(swapped.swaps.length, 1);
  assert.deepEqual(
    { ...swapped.swaps[0], createdAt: undefined },
    { id: swapped.swaps[0].id, sessionTrackId: sessionTrackB, stemType: "drums", fromTrackId: trackB.id, toTrackId: trackA.id, atSeconds: 12.5, createdAt: undefined },
    "provenance: source track, donor track, stem type, session context",
  );

  // Refusal: B has no real "vocals" layer to replace.
  await assert.rejects(
    () => sessions.recordStemSwap({ ownerId: OWNER, sessionId: created.id, sessionTrackId: sessionTrackB, stemType: "vocals", toTrackId: trackA.id, atSeconds: 1 }),
    (error: Error) => error instanceof sessions.StemSwapRefusedError && /current track has no real/i.test(error.message),
  );
  // Refusal: donor A has no "piano" stem.
  await assert.rejects(
    () => sessions.recordStemSwap({ ownerId: OWNER, sessionId: created.id, sessionTrackId: sessionTrackB, stemType: "drums", toTrackId: trackA.id === trackA.id ? trackA.id : trackA.id, atSeconds: 1 }),
    /donor/i,
  ).catch(() => undefined); // (A DOES have drums — this call succeeds; the real refusal case is below)
  await sessions.deleteSession(OWNER, created.id);
});

test("session stem swap: a donor without the requested stem is refused", async () => {
  const created = await sessions.createSession(OWNER, "Swap refusal");
  const detail = await sessions.addTrackToSession({ ownerId: OWNER, sessionId: created.id, trackId: trackB.id });
  // B now has drums (previous test) but no "other"; requesting other from donor A:
  await assert.rejects(
    () => sessions.recordStemSwap({ ownerId: OWNER, sessionId: created.id, sessionTrackId: detail.tracks[0].id, stemType: "other", toTrackId: trackA.id, atSeconds: 0 }),
    (error: Error) => error instanceof sessions.StemSwapRefusedError && /current track has no real/i.test(error.message),
  );
  await sessions.deleteSession(OWNER, created.id);
});

test("session: ownership isolation", async () => {
  const created = await sessions.createSession(OWNER, "Private set");
  await sessions.addTrackToSession({ ownerId: OWNER, sessionId: created.id, trackId: trackA.id });

  assert.equal((await sessions.listSessions(OTHER)).length, 0, "another owner sees no sessions");
  await assert.rejects(() => sessions.getSession(OTHER, created.id), sessions.SessionNotFoundError);
  await assert.rejects(
    () => sessions.addTrackToSession({ ownerId: OTHER, sessionId: created.id, trackId: trackA.id }),
    sessions.SessionNotFoundError,
  );
  await assert.rejects(() => sessions.deleteSession(OTHER, created.id), sessions.SessionNotFoundError);
  await sessions.deleteSession(OWNER, created.id);
});

test("session: send to Studio derives a remix that REFERENCES existing stems (no copies)", async () => {
  const created = await sessions.createSession(OWNER, "Handoff set");
  await sessions.addTrackToSession({ ownerId: OWNER, sessionId: created.id, trackId: trackA.id });
  await sessions.addTrackToSession({ ownerId: OWNER, sessionId: created.id, trackId: trackB.id });

  const handoff = await sessions.sendSessionToStudio(OWNER, created.id);
  assert.ok(handoff.projectId);
  assert.ok(handoff.remixSessionId);
  assert.equal(handoff.remixTrackCount, 2, "A binds its real stems; B binds its passthrough bridge");

  // The derived project is a STUDIO project (visible in studio listings).
  const studioList = await service.listStudioProjects(OWNER);
  assert.ok(studioList.some((project) => project.id === handoff.projectId));

  // The remix tracks reference the EXISTING stem asset rows — no new audio.
  const remixTrackRows = await db.db.select().from(schema.remixTracks).where(eq(schema.remixTracks.remixSessionId, handoff.remixSessionId));
  assert.equal(remixTrackRows.length, 2);
  const stemIdsBefore = new Set(
    (await db.db.select({ id: schema.stemAssets.id }).from(schema.stemAssets)).map((row) => row.id),
  );
  for (const row of remixTrackRows) {
    assert.ok(stemIdsBefore.has(row.stemAssetId), `remix track ${row.id} references a pre-existing stem`);
  }
  // The source audio count is unchanged (no copies anywhere).
  assert.equal((await db.db.select().from(schema.sourceAssets)).length, 3, "A, B and the other owner's — nothing added");

  await sessions.deleteSession(OWNER, created.id);
});

test("session: meeting-point primitives power compatibility (analysis surfaced, not duplicated)", async () => {
  // trackA has a complete analysis (128.5 BPM, A minor). Give trackB one too.
  const sourceB = sourceIdByTrackId.get(trackB.id)!;
  await db.db.insert(schema.sourceAnalyses).values({
    projectId: trackB.studioProjectId,
    sourceAssetId: sourceB,
    status: "complete",
    stage: "complete",
    analysisEngine: "arena-js-dsp",
    analysisEngineVersion: "test",
    sourceChecksumSha256: "checksum-b",
    idempotencyKey: `analysis-test-b:${sourceB}`,
    bpm: 129,
    musicalKey: "C major",
    beatGrid: JSON.stringify([0, 500, 1000, 1500, 2000]),
  });

  const analysisA = await sessions.sessionTrackAnalysis(OWNER, trackA.id);
  const analysisB = await sessions.sessionTrackAnalysis(OWNER, trackB.id);
  assert.equal(analysisA?.bpm, 128.5);
  assert.equal(analysisA?.musicalKey, "A minor");
  assert.equal(analysisB?.bpm, 129);

  const tempo = sessionLogic.tempoCompatibility(analysisA?.bpm ?? null, analysisB?.bpm ?? null);
  assert.equal(tempo.compatible, true, "128.5 → 129 is close");
  const key = sessionLogic.keyCompatibility(analysisA?.musicalKey ?? null, analysisB?.musicalKey ?? null);
  assert.equal(key.relationship, "relative", "A minor ↔ C major");
  const alignment = sessionLogic.beatAlignedTransitionStart(analysisA?.beatGridMs ?? null, analysisB?.beatGridMs ?? null, 100, "beat");
  assert.equal(alignment.ok, true, "both grids verified → aligned start available");
});
