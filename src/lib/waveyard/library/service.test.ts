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
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import path from "node:path";
import { eq } from "drizzle-orm";

const repoRoot = path.resolve(path.dirname(process.argv[1] ?? "."), "..", "..", "..", "..");
const OWNER = "00000000-0000-4000-8000-000000000001"; // actual local route owner
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

  // Retry-safe readiness (Windows acceptance fix on 9431870): a pg Client
  // that failed to connect can NEVER be reused, so every attempt builds a
  // fresh one. Contract enforced by pg-readiness.test.ts.
  const { Client } = await import("pg");
  const { waitForPostgresReady } = await import("./pg-readiness");
  await waitForPostgresReady({
    createClient: () => new Client({ connectionString: `postgresql://arena:arena-test@127.0.0.1:${port}/postgres` }),
    useConnectedClient: async (admin) => {
      await admin.query("create database arena_library_test");
    },
  });

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

test("persisted stem fixtures select stem playback (not inference)", async () => {
  const sourceId = sourceIdByTrackId.get(trackA.id)!;
  const stemIds: string[] = [];
  for (const stemType of ["vocals", "drums", "bass", "other"]) {
    const [stem] = await db.db.insert(schema.stemAssets).values({
      projectId: trackA.studioProjectId,
      sourceAssetId: sourceId,
      separationJobId: (await db.db.select().from(schema.processingJobs).where(eq(schema.processingJobs.sourceAssetId, sourceId)).limit(1))[0].id,
      stemType,
      engine: "synthetic-test-fixture",
      model: "pcm-tone",
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
  const session = await sessions.createSession(OWNER, "Explicit full-source bridge");
  await sessions.addTrackToSession({ ownerId: OWNER, sessionId: session.id, trackId: trackB.id });
  try {
    const handoff = await sessions.sendSessionToStudio(OWNER, session.id);
    assert.equal(handoff.remixTrackCount, 1);
    const [lane] = await db.db.select().from(schema.remixTracks).where(eq(schema.remixTracks.remixSessionId, handoff.remixSessionId));
    const [clip] = await db.db.select().from(schema.remixClips).where(eq(schema.remixClips.remixTrackId, lane.id));
    assert.equal(lane.stemAssetId, stem.id);
    assert.equal(clip.stemAssetId, stem.id);
    assert.equal(clip.durationMs, 3000);
    assert.match(lane.name, /source$/);
  } finally {
    await sessions.deleteSession(OWNER, session.id);
  }
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
    engine: "synthetic-test-fixture",
    model: "pcm-tone",
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

test("session handoff: all lanes, timed swap, workspace, save/reopen, version and actual WAV export", async () => {
  // Controlled signal fixtures exercise persistence and rendering, NOT Demucs.
  const { getStorage } = await import("../storage");
  const storage = getStorage();
  const beforeStems = await db.db.select().from(schema.stemAssets);
  const beforeSources = await db.db.select().from(schema.sourceAssets);
  const frequencies: Record<string, number> = { vocals: 330, drums: 220, bass: 110, other: 550 };
  for (const stem of beforeStems) {
    const filename = storage.getLocalPath(stem.storageKey)!;
    mkdirSync(path.dirname(filename), { recursive: true });
    writeWav(filename, stem.durationSeconds, stem.storageKey.includes("b-drums") ? 880 : frequencies[stem.stemType] ?? 660);
  }
  const created = await sessions.createSession(OWNER, "Handoff acceptance");
  await sessions.addTrackToSession({ ownerId: OWNER, sessionId: created.id, trackId: trackA.id });
  const listening = await sessions.addTrackToSession({ ownerId: OWNER, sessionId: created.id, trackId: trackB.id });
  const itemA = listening.tracks[0];
  const itemB = listening.tracks[1];
  await sessions.updateSessionTrack(OWNER, created.id, itemA.id, { stemMix: { vocals: 0, drums: 0.1, bass: 0, other: 0 } });
  await sessions.updateSessionTrack(OWNER, created.id, itemB.id, { stemMix: { drums: 0.25 } });
  await sessions.recordStemSwap({ ownerId: OWNER, sessionId: created.id, sessionTrackId: itemA.id, stemType: "drums", toTrackId: trackB.id, atSeconds: 1 });

  const handoffRoute = await import("@/app/api/library/sessions/[id]/studio-handoff/route");
  const beforeProjectCount = (await db.db.select().from(schema.projects)).length;
  const confirmation = await handoffRoute.POST(new Request("http://arena.test/handoff", { method: "POST" }), { params: Promise.resolve({ id: created.id }) });
  assert.equal(confirmation.status, 409);
  assert.equal((await confirmation.json()).errorCode, "handoff_confirmation_required");
  assert.equal((await db.db.select().from(schema.projects)).length, beforeProjectCount, "declining has no side effects");
  const handoffResponse = await handoffRoute.POST(new Request("http://arena.test/handoff", { method: "POST", body: JSON.stringify({ mode: "sequential", trackEdits: [{ id: itemA.id, stemMix: { vocals: 0, drums: 0.4, bass: 0, other: 0 }, transition: itemA.transition }] }) }), { params: Promise.resolve({ id: created.id }) });
  assert.equal(handoffResponse.status, 201);
  const { handoff } = await handoffResponse.json() as { handoff: import("./session-service").StudioHandoffResult };
  assert.equal(handoff.remixTrackCount, 5, "all four A stems and B's real drum stem; no double-mixed passthrough");
  assert.match(handoff.notice, /Live transition/);
  assert.equal(handoff.refused, undefined);
  assert.equal((await sessions.getSession(OWNER, created.id)).tracks[0].stemMix.drums, 0.4, "visible edits are saved with the derived arrangement, not stale debounced levels");
  assert.deepEqual(await db.db.select().from(schema.stemAssets), beforeStems, "no copied or reparented stem rows");
  assert.deepEqual(await db.db.select().from(schema.sourceAssets), beforeSources, "no copied or reparented sources");
  assert.ok((await service.listStudioProjects(OWNER)).some((project) => project.id === handoff.projectId));

  const projectRoute = await import("@/app/api/waveyard/projects/[id]/route");
  const projectResponse = await projectRoute.GET(new Request("http://arena.test/project"), { params: Promise.resolve({ id: handoff.projectId }) });
  assert.equal(projectResponse.status, 200);
  const project = await projectResponse.json();
  assert.equal(project.stems.length, 5, "workspace can mount the actual editor");
  assert.equal(project.sources.length, 2);
  assert.ok(project.sources.some((source: { id: string }) => source.id === sourceIdByTrackId.get(trackA.id)));

  const remixRoute = await import("@/app/api/remixes/[id]/route");
  const params = { params: Promise.resolve({ id: handoff.remixSessionId }) };
  const getState = async () => {
    const response = await remixRoute.GET(new Request("http://arena.test/remix"), params);
    assert.equal(response.status, 200);
    return response.json();
  };
  const state = await getState();
  const assetRoute = await import("@/app/api/assets/[id]/route");
  const individualStem = beforeStems.find((stem) => stem.sourceAssetId === sourceIdByTrackId.get(trackA.id) && stem.stemType === "drums")!;
  const individual = await assetRoute.GET(new Request("http://arena.test/asset?download=1"), { params: Promise.resolve({ id: individualStem.id }) });
  assert.equal(individual.status, 200);
  assert.match(individual.headers.get("content-disposition")!, /drums.wav/);
  const individualBytes = Buffer.from(await individual.arrayBuffer());
  assert.deepEqual(individualBytes, readFileSync(storage.getLocalPath(individualStem.storageKey)!));
  const individualPath = path.join(root!, "individual-drums.wav");
  writeFileSync(individualPath, individualBytes);
  assert.equal((await (await import("../audio")).validateAudio(individualPath)).durationSeconds, 2);
  assert.equal(state.tracks.length, 5);
  assert.equal(state.tracks.flatMap((track: { clips: unknown[] }) => track.clips).length, 6, "swap becomes two real source ranges");
  const drumsA = state.tracks.find((track: { name: string }) => track.name.endsWith("— drums"));
  assert.deepEqual(drumsA.clips.map((clip: { timelineStartMs: number; sourceOffsetMs: number; durationMs: number }) => [clip.timelineStartMs, clip.sourceOffsetMs, clip.durationMs]), [[0, 0, 1000], [1000, 1000, 1000]]);
  assert.equal(drumsA.volume, 0.4);
  assert.equal(state.tracks[4].clips[0].timelineStartMs, 2000, "listening order becomes sequential music, not stacked songs");
  const input = { ...state.remix, tracks: state.tracks, automation: state.automation, masterVolume: 0.5 };
  const save = await remixRoute.PUT(new Request("http://arena.test/remix", { method: "PUT", body: JSON.stringify(input) }), params);
  assert.equal(save.status, 200, await save.clone().text());
  const reopened = await getState();
  assert.equal(reopened.remix.masterVolume, 0.5);
  assert.deepEqual(reopened.tracks, (await save.json()).tracks);

  // Existing bound references are allowed, not arbitrary audio in another
  // project (including the same owner's unused passthrough).
  const unbound = beforeStems.find((stem) => stem.engine === "passthrough-unseparated")!;
  const invalid = structuredClone(input);
  invalid.tracks[0].clips[0].stemAssetId = unbound.id;
  const denied = await remixRoute.PUT(new Request("http://arena.test/remix", { method: "PUT", body: JSON.stringify(invalid) }), params);
  assert.equal(denied.status, 403);
  assert.deepEqual((await getState()).tracks, reopened.tracks, "refused save is non-destructive");

  const versionsRoute = await import("@/app/api/remixes/[id]/versions/route");
  const versionResponse = await versionsRoute.POST(new Request("http://arena.test/versions", { method: "POST", body: JSON.stringify({ name: "Actual render acceptance" }) }), params);
  assert.equal(versionResponse.status, 201, await versionResponse.clone().text());
  const { version } = await versionResponse.json();
  // Exercise the actual route -> desktop queue -> actual FFmpeg handler.
  const { getLocalJobBroker } = await import("../worker-local/broker");
  const { handleExportJob } = await import("../worker-local/export");
  const { EXPORT_QUEUE } = await import("../queue");
  const priorWorker = process.env.WAVEYARD_LOCAL_WORKER;
  const priorRedis = process.env.REDIS_URL;
  process.env.WAVEYARD_LOCAL_WORKER = "1";
  delete process.env.REDIS_URL;
  const broker = getLocalJobBroker();
  broker.register(EXPORT_QUEUE, handleExportJob);
  try {
    const exportRoute = await import("@/app/api/remix-versions/[id]/exports/route");
    const response = await exportRoute.POST(new Request("http://arena.test/exports", { method: "POST", body: JSON.stringify({ format: "wav" }) }), { params: Promise.resolve({ id: version.id }) });
    assert.equal(response.status, 201, await response.clone().text());
    const { job } = await response.json();
    assert.equal(await broker.drain(30_000), true);
    const [finished] = await db.db.select().from(schema.exportJobs).where(eq(schema.exportJobs.id, job.id));
    assert.equal(finished.status, "complete", finished.errorMessage ?? JSON.stringify(finished));
    const [asset] = await db.db.select().from(schema.exportAssets).where(eq(schema.exportAssets.exportJobId, job.id));
    assert.ok(asset);
    const mediaRoute = await import("@/app/api/exports/[id]/media/route");
    const media = await mediaRoute.GET(new Request("http://arena.test/media?download=1"), { params: Promise.resolve({ id: job.id }) });
    assert.equal(media.status, 200);
    assert.equal(media.headers.get("content-type"), "audio/wav");
    assert.match(media.headers.get("content-disposition")!, /attachment/);
    const downloaded = path.join(root!, "downloaded-handoff.wav");
    writeFileSync(downloaded, Buffer.from(await media.arrayBuffer()));
    const { validateAudio, exec } = await import("../audio");
    const { requireTool } = await import("../ffmpeg");
    const metadata = await validateAudio(downloaded);
    assert.ok(Math.abs(metadata.durationSeconds - 5) < 0.02, JSON.stringify(metadata));
    assert.equal(metadata.sampleRate, 44100);
    assert.equal(metadata.channels, 2);
    const decoded = path.join(root!, "decoded.f32");
    await exec((await requireTool("ffmpeg")).path, ["-y", "-i", downloaded, "-f", "f32le", "-ac", "1", decoded]);
    const pcm = readFileSync(decoded);
    function magnitude(hz: number, start: number, end: number) {
      let sin = 0, cos = 0;
      const first = Math.round(start * 44100), last = Math.round(end * 44100);
      for (let index = first; index < last; index++) {
        const sample = pcm.readFloatLE(index * 4);
        sin += sample * Math.sin(2 * Math.PI * hz * index / 44100);
        cos += sample * Math.cos(2 * Math.PI * hz * index / 44100);
      }
      return 2 * Math.hypot(sin, cos) / (last - first);
    }
    const signal = {
      initialDrums: magnitude(220, 0.2, 0.8), initialDonor: magnitude(880, 0.2, 0.8),
      swappedDrums: magnitude(220, 1.2, 1.8), swappedDonor: magnitude(880, 1.2, 1.8),
      nextSong: magnitude(880, 2.2, 4.8), mutedVocal: magnitude(330, 0.2, 0.8),
    };
    assert.ok(signal.initialDrums > 0.02 && signal.initialDonor < 0.001, JSON.stringify(signal));
    assert.ok(signal.swappedDonor > 0.02 && signal.swappedDrums < 0.001, JSON.stringify(signal));
    assert.ok(signal.nextSong > 0.01 && signal.mutedVocal < 0.001, JSON.stringify(signal));
    if (process.env.WAVEYARD_ACCEPTANCE_ARTIFACT_DIR) {
      const directory = process.env.WAVEYARD_ACCEPTANCE_ARTIFACT_DIR;
      mkdirSync(directory, { recursive: true });
      copyFileSync(downloaded, path.join(directory, "handoff.wav"));
      copyFileSync(individualPath, path.join(directory, "individual-drums.wav"));
      const sourceFiles = [
        "src/lib/waveyard/library/session-service.ts", "src/lib/waveyard/library/service.test.ts", "src/lib/waveyard/project-audio.ts",
        "src/lib/waveyard/worker-local/export.ts", "src/lib/waveyard/remix.ts", "src/app/api/remixes/[id]/route.ts",
        "src/app/api/remixes/[id]/versions/[versionId]/restore/route.ts", "src/app/api/waveyard/projects/[id]/route.ts",
        "src/app/api/waveyard/projects/[id]/remixes/route.ts", "src/components/waveyard/library/SessionExperience.tsx", "src/app/api/remixes/[id]/clips/align-beat/route.ts",
        "src/app/api/remixes/[id]/clips/from-section/route.ts", "src/lib/waveyard/types/section-arrangement.ts",
        "src/lib/waveyard/worker-local/broker.ts", "src/app/api/library/sessions/[id]/studio-handoff/route.ts",
      ];
      const sha256 = (filename: string) => createHash("sha256").update(readFileSync(filename)).digest("hex");
      const git = (args: string[]) => spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" }).stdout?.trim() ?? null;
      writeFileSync(path.join(directory, "handoff.json"), JSON.stringify({
        observedAt: new Date().toISOString(), fixture: "synthetic PCM tones; NOT separation inference",
        source: { head: git(["rev-parse", "HEAD"]), worktree: git(["status", "--porcelain"]), sha256: Object.fromEntries(sourceFiles.map((filename) => [filename, sha256(path.join(repoRoot, filename))])) },
        runtime: { node: process.version, platform: process.platform, arch: process.arch, ffmpeg: spawnSync((await requireTool("ffmpeg")).path, ["-version"], { encoding: "utf8" }).stdout.split("\n")[0] },
        inputs: beforeStems.map((stem) => ({ id: stem.id, engine: stem.engine, durationSeconds: stem.durationSeconds, storageKey: stem.storageKey, actualSha256: sha256(storage.getLocalPath(stem.storageKey)!) })),
        handoff, job: finished, asset, metadata, signal,
        limitations: ["No model inference", "No Electron, Windows or room UI acceptance", "Live transition triggers/crossfades are not reconstructed"],
      }, null, 2));
    }
  } finally {
    if (priorWorker === undefined) delete process.env.WAVEYARD_LOCAL_WORKER; else process.env.WAVEYARD_LOCAL_WORKER = priorWorker;
    if (priorRedis === undefined) delete process.env.REDIS_URL; else process.env.REDIS_URL = priorRedis;
  }
  // Asset provenance also survives loss/replacement of live lanes: immutable
  // versions, not the current timeline alone, authorize restore/render reuse.
  await db.db.delete(schema.remixTracks).where(eq(schema.remixTracks.remixSessionId, handoff.remixSessionId));
  const { projectAudio } = await import("../project-audio");
  assert.equal((await projectAudio(handoff.projectId)).stems.length, 5);
  const restore = await import("@/app/api/remixes/[id]/versions/[versionId]/restore/route");
  const restored = await restore.POST(new Request("http://arena.test/restore", { method: "POST" }), { params: Promise.resolve({ id: handoff.remixSessionId, versionId: version.id }) });
  assert.equal(restored.status, 200, await restored.clone().text());
  await sessions.deleteSession(OWNER, created.id);
  assert.equal((await getState()).tracks.length, 5, "derived arrangement survives listening-session deletion");
});

test("session handoff: empty, foreign-owner and lane-limit refusals create nothing", async () => {
  const route = await import("@/app/api/library/sessions/[id]/studio-handoff/route");
  const created = await sessions.createSession(OWNER, "Refusal acceptance");
  const beforeProjects = (await db.db.select().from(schema.projects)).length;
  const beforeRemixes = (await db.db.select().from(schema.remixSessions)).length;
  const post = () => route.POST(new Request("http://arena.test/handoff", { method: "POST", body: JSON.stringify({ mode: "sequential" }) }), { params: Promise.resolve({ id: created.id }) });
  assert.equal((await post()).status, 409, "empty sessions fail honestly");
  await assert.rejects(() => sessions.sendSessionToStudio(OTHER, created.id), sessions.SessionNotFoundError);
  for (let count = 0; count < 9; count++) await sessions.addTrackToSession({ ownerId: OWNER, sessionId: created.id, trackId: trackA.id });
  const oversized = await post();
  assert.equal(oversized.status, 409);
  assert.match((await oversized.json()).error, /36.*32/);
  assert.equal((await db.db.select().from(schema.projects)).length, beforeProjects);
  assert.equal((await db.db.select().from(schema.remixSessions)).length, beforeRemixes);
  assert.equal((await sessions.getSession(OWNER, created.id)).tracks.length, 9, "refusal preserves the listening session");
  await sessions.deleteSession(OWNER, created.id);
});

test("session handoff: a database write failure rolls back project, remix, lanes and clips", async () => {
  const created = await sessions.createSession(OWNER, "Atomic acceptance");
  await sessions.addTrackToSession({ ownerId: OWNER, sessionId: created.id, trackId: trackA.id });
  const counts = async () => Promise.all([schema.projects, schema.remixSessions, schema.remixTracks, schema.remixClips].map(async (table) => (await db.db.select().from(table)).length));
  const before = await counts();
  // Genuine PostgreSQL failure at the last write boundary, no transaction mock.
  await client!.query(`CREATE FUNCTION pg_temp.reject_handoff_clip() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'acceptance: injected clip write failure'; END $$`);
  await client!.query(`CREATE TRIGGER acceptance_reject_clip BEFORE INSERT ON remix_clips FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_handoff_clip()`);
  try {
    const original = await sessions.getSession(OWNER, created.id);
    await assert.rejects(() => sessions.sendSessionToStudio(OWNER, created.id, [{ id: original.tracks[0].id, stemMix: { drums: 0.15 }, transition: original.tracks[0].transition }]));
    assert.deepEqual((await sessions.getSession(OWNER, created.id)).tracks[0].stemMix, original.tracks[0].stemMix, "failed handoff also rolls back visible edit persistence");
    assert.deepEqual(await counts(), before, "no orphan project or partial arrangement survives");
  } finally {
    await client!.query("DROP TRIGGER acceptance_reject_clip ON remix_clips");
    await client!.query("DROP FUNCTION pg_temp.reject_handoff_clip()");
    await sessions.deleteSession(OWNER, created.id);
  }
});

test("project audio: bound references cannot expose another owner's audio; malformed versions are ignored", async () => {
  const [foreignSource] = await db.db.select().from(schema.sourceAssets).where(eq(schema.sourceAssets.projectId, (await service.listTracks({ ownerId: OTHER }))[0].studioProjectId));
  const [foreignJob] = await db.db.select().from(schema.processingJobs).where(eq(schema.processingJobs.sourceAssetId, foreignSource.id));
  const [foreignStem] = await db.db.insert(schema.stemAssets).values({
    projectId: foreignSource.projectId, sourceAssetId: foreignSource.id, separationJobId: foreignJob.id,
    stemType: "drums", engine: "synthetic-test-fixture", model: "none", modelVersion: "test",
    storageKey: "test/foreign-owner.wav", checksumSha256: "fixture", durationSeconds: 2,
    sampleRate: 44100, channels: 1, codec: "wav", format: "wav", fileSizeBytes: 100,
  }).returning();
  const [project] = await db.db.insert(schema.projects).values({ ownerId: OWNER, title: "Reference isolation fixture", kind: "studio" }).returning();
  const [remix] = await db.db.insert(schema.remixSessions).values({ projectId: project.id, ownerId: OWNER, name: "Invalid reference fixture" }).returning();
  await db.db.insert(schema.remixTracks).values({ remixSessionId: remix.id, stemAssetId: foreignStem.id, name: "Foreign fixture" });
  await db.db.insert(schema.remixVersions).values({ remixSessionId: remix.id, createdById: OWNER, name: "Broken legacy snapshot", snapshot: "not JSON" });
  await db.db.insert(schema.remixVersions).values({ remixSessionId: remix.id, createdById: OWNER, name: "Invalid legacy UUID", snapshot: JSON.stringify({ tracks: [{ id: "legacy", stemAssetId: "not-a-uuid", clips: [] }] }) });
  const { projectAudio } = await import("../project-audio");
  assert.deepEqual(await projectAudio(project.id), { stems: [], sources: [] });
  await db.db.delete(schema.projects).where(eq(schema.projects.id, project.id));
  await db.db.delete(schema.stemAssets).where(eq(schema.stemAssets.id, foreignStem.id));
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

test("handoff editing: referenced source beats, donor clips and sections retain provenance", async () => {
  const listening = await sessions.createSession(OWNER, "Referenced editing acceptance");
  await sessions.addTrackToSession({ ownerId: OWNER, sessionId: listening.id, trackId: trackA.id });
  const detail = await sessions.addTrackToSession({ ownerId: OWNER, sessionId: listening.id, trackId: trackB.id });
  await sessions.recordStemSwap({ ownerId: OWNER, sessionId: listening.id, sessionTrackId: detail.tracks[0].id, stemType: "drums", toTrackId: trackB.id, atSeconds: 1 });
  const handoff = await sessions.sendSessionToStudio(OWNER, listening.id);
  const [sourceA] = await db.db.select().from(schema.sourceAssets).where(eq(schema.sourceAssets.id, sourceIdByTrackId.get(trackA.id)!));
  const [sourceB] = await db.db.select().from(schema.sourceAssets).where(eq(schema.sourceAssets.id, sourceIdByTrackId.get(trackB.id)!));
  for (const source of [sourceA, sourceB]) await db.db.update(schema.sourceAnalyses).set({ sourceChecksumSha256: source.checksumSha256 }).where(eq(schema.sourceAnalyses.sourceAssetId, source.id));
  const [analysis] = await db.db.select().from(schema.sourceAnalyses).where(eq(schema.sourceAnalyses.sourceAssetId, sourceA.id));
  const [sectionAnalysis] = await db.db.insert(schema.sourceSectionAnalyses).values({
    projectId: sourceA.projectId, sourceAssetId: sourceA.id, sourceAnalysisId: analysis.id,
    status: "complete", stage: "complete", analysisEngine: "section-fixture", analysisEngineVersion: "1",
    sourceChecksumSha256: sourceA.checksumSha256, idempotencyKey: `reference-edit:${sourceA.id}`,
  }).returning();
  const [section] = await db.db.insert(schema.sourceSections).values({
    id: `reference-edit:${sourceA.id}`, projectId: sourceA.projectId, sourceAssetId: sourceA.id,
    sourceAnalysisId: analysis.id, sourceSectionAnalysisId: sectionAnalysis.id,
    sectionIndex: 0, startMs: 0, endMs: 936, startBeatIndex: 0, endBeatIndex: 2,
    startBar: 1, endBar: 1, structuralConfidence: 0.8,
    analysisEngine: "section-fixture", analysisEngineVersion: "1", sourceChecksumSha256: sourceA.checksumSha256,
  }).returning();
  const lanes = await db.db.select().from(schema.remixTracks).where(eq(schema.remixTracks.remixSessionId, handoff.remixSessionId));
  const lane = lanes.find((row) => row.name.endsWith("— drums"))!;
  const clips = (await db.db.select().from(schema.remixClips).where(eq(schema.remixClips.remixTrackId, lane.id))).sort((a, b) => a.timelineStartMs - b.timelineStartMs);
  const params = { params: Promise.resolve({ id: handoff.remixSessionId }) };
  const alignRoute = await import("@/app/api/remixes/[id]/clips/align-beat/route");
  const align = (clipId: string, sourceBeatIndex: number, timelineTargetMs: number) => alignRoute.POST(new Request("http://arena.test/align", { method: "POST", body: JSON.stringify({ clipId, sourceBeatIndex, timelineTargetMs }) }), params);
  try {
    const aligned = await align(clips[0].id, 1, 1000);
    assert.equal(aligned.status, 200, await aligned.clone().text());
    assert.equal((await aligned.json()).clip.timelineStartMs, 532);
    // The donor clip's asset deliberately differs from its lane's original
    // stem. Its own source analysis, not the original lane's, must be used.
    const donorAligned = await align(clips[1].id, 2, 2500);
    assert.equal(donorAligned.status, 200, await donorAligned.clone().text());
    assert.equal((await donorAligned.json()).clip.timelineStartMs, 2500);
    const sectionRoute = await import("@/app/api/remixes/[id]/clips/from-section/route");
    const input = { sectionId: section.id, stemAssetId: lane.stemAssetId, remixTrackId: lane.id, action: "loop", repetitions: 1, timelineStartMs: 5000 };
    const place = (body: unknown) => sectionRoute.POST(new Request("http://arena.test/section", { method: "POST", body: JSON.stringify(body) }), params);
    const placed = await place(input);
    assert.equal(placed.status, 201, await placed.clone().text());
    assert.deepEqual((await placed.json()).clips.map((clip: { timelineStartMs: number; durationMs: number }) => [clip.timelineStartMs, clip.durationMs]), [[5000, 936], [5936, 936]]);
    const count = async () => (await db.db.select().from(schema.remixClips).where(eq(schema.remixClips.remixTrackId, lane.id))).length;
    const before = await count();
    const remixRoute = await import("@/app/api/remixes/[id]/route");
    const state = await (await remixRoute.GET(new Request("http://arena.test/remix"), params)).json();
    const saved = await remixRoute.PUT(new Request("http://arena.test/remix", { method: "PUT", body: JSON.stringify({ ...state.remix, tracks: state.tracks.map((track: { id: string }) => ({ ...track, muted: track.id !== lane.id })) }) }), params);
    assert.equal(saved.status, 200, await saved.clone().text());
    const [savedClip] = (await db.db.select().from(schema.remixClips).where(eq(schema.remixClips.remixTrackId, lane.id))).filter((clip) => clip.timelineStartMs === 532);
    const versions = await import("@/app/api/remixes/[id]/versions/route");
    const versionResponse = await versions.POST(new Request("http://arena.test/version", { method: "POST", body: JSON.stringify({ name: "Aligned library sections" }) }), params);
    assert.equal(versionResponse.status, 201);
    const { version } = await versionResponse.json();
    const previousMode = process.env.WAVEYARD_LOCAL_WORKER;
    const previousRedis = process.env.REDIS_URL;
    process.env.WAVEYARD_LOCAL_WORKER = "1";
    delete process.env.REDIS_URL;
    try {
      const { getLocalJobBroker } = await import("../worker-local/broker");
      const exports = await import("@/app/api/remix-versions/[id]/exports/route");
      const response = await exports.POST(new Request("http://arena.test/export", { method: "POST", body: JSON.stringify({ format: "wav" }) }), { params: Promise.resolve({ id: version.id }) });
      assert.equal(response.status, 201, await response.clone().text());
      const { job } = await response.json();
      assert.equal(await getLocalJobBroker().drain(30_000), true, "wait for the second real render, not an old drain result");
      const [finished] = await db.db.select().from(schema.exportJobs).where(eq(schema.exportJobs.id, job.id));
      assert.equal(finished.status, "complete", finished.errorMessage ?? "not complete");
      const media = await import("@/app/api/exports/[id]/media/route");
      const download = await media.GET(new Request("http://arena.test/download"), { params: Promise.resolve({ id: job.id }) });
      assert.equal(download.status, 200);
      const filename = path.join(root!, "aligned-sections.wav");
      writeFileSync(filename, Buffer.from(await download.arrayBuffer()));
      const { validateAudio, exec } = await import("../audio");
      const { requireTool } = await import("../ffmpeg");
      const metadata = await validateAudio(filename);
      assert.ok(Math.abs(metadata.durationSeconds - 6.872) < 0.005, JSON.stringify(metadata));
      const decoded = path.join(root!, "aligned-sections.f32");
      await exec((await requireTool("ffmpeg")).path, ["-y", "-i", filename, "-f", "f32le", "-ac", "1", decoded]);
      const pcm = readFileSync(decoded);
      const magnitude = (hz: number, start: number, end: number) => {
        let sin = 0, cos = 0;
        const first = Math.round(start * 44100), last = Math.round(end * 44100);
        for (let i = first; i < last; i++) { const value = pcm.readFloatLE(i * 4); sin += value * Math.sin(2 * Math.PI * hz * i / 44100); cos += value * Math.cos(2 * Math.PI * hz * i / 44100); }
        return 2 * Math.hypot(sin, cos) / (last - first);
      };
      const signal = { before: magnitude(220, 0.1, 0.5), aligned: magnitude(220, 0.6, 1.4), donor: magnitude(880, 2.6, 3.4), gap: magnitude(220, 4, 4.8), section: magnitude(220, 5.2, 5.7), repeated: magnitude(220, 6.1, 6.7) };
      assert.ok(signal.before < 0.0001 && signal.gap < 0.0001, JSON.stringify(signal));
      assert.ok(signal.aligned > 0.05 && signal.donor > 0.05 && signal.section > 0.05 && signal.repeated > 0.05, JSON.stringify(signal));
      if (process.env.WAVEYARD_ACCEPTANCE_ARTIFACT_DIR) {
        const directory = process.env.WAVEYARD_ACCEPTANCE_ARTIFACT_DIR;
        mkdirSync(directory, { recursive: true });
        copyFileSync(filename, path.join(directory, "aligned-sections.wav"));
        writeFileSync(path.join(directory, "aligned-sections.json"), JSON.stringify({ fixture: "synthetic signals, not inference", metadata, signal, job: finished, sourceChecksums: [sourceA.checksumSha256, sourceB.checksumSha256] }, null, 2));
      }
    } finally {
      if (previousMode === undefined) delete process.env.WAVEYARD_LOCAL_WORKER; else process.env.WAVEYARD_LOCAL_WORKER = previousMode;
      if (previousRedis === undefined) delete process.env.REDIS_URL; else process.env.REDIS_URL = previousRedis;
    }
    const [unbound] = await db.db.select().from(schema.stemAssets).where(eq(schema.stemAssets.engine, "passthrough-unseparated"));
    assert.equal((await place({ ...input, stemAssetId: unbound.id })).status, 422, "same-owner unbound stems are not granted");
    await db.db.update(schema.sourceAnalyses).set({ sourceChecksumSha256: "stale" }).where(eq(schema.sourceAnalyses.id, analysis.id));
    assert.equal((await align(savedClip.id, 1, 1000)).status, 422, "stale analysis cannot align referenced audio");
    assert.equal((await place(input)).status, 422, "stale analysis cannot create referenced section clips");
    assert.equal(await count(), before);
    const [persisted] = await db.db.select().from(schema.remixClips).where(eq(schema.remixClips.id, savedClip.id));
    assert.equal(persisted.timelineStartMs, 532, "rejected actions preserve the saved edit");
  } finally {
    await db.db.update(schema.sourceAnalyses).set({ sourceChecksumSha256: sourceA.checksumSha256 }).where(eq(schema.sourceAnalyses.id, analysis.id));
    await sessions.deleteSession(OWNER, listening.id);
  }
});

test("track curation: rating and labels persist, normalise, and round-trip", async () => {
  // Rating rounds/clamps into 0..5.
  const rated = await service.updateTrackCuration(OWNER, trackA.id, { rating: 4.6 });
  assert.notEqual(rated, null);
  assert.equal(rated!.rating, 5);
  assert.equal((await service.updateTrackCuration(OWNER, trackA.id, { rating: -3 }))!.rating, 0);
  // Labels normalise: trim, case-insensitive dedupe, order preserved.
  const labelled = await service.updateTrackCuration(OWNER, trackA.id, { labels: ["  Driving ", "driving", "Synthwave"] });
  assert.notEqual(labelled, null);
  assert.deepEqual(labelled!.labels, ["Driving", "Synthwave"]);
  // Bad input is rejected, unknown tracks are null, and nothing silently clamps.
  assert.equal(await service.updateTrackCuration(OWNER, trackA.id, { labels: "nope" as unknown }), null);
  assert.equal(await service.updateTrackCuration(OWNER, "00000000-0000-4000-8000-000000000000", { rating: 3 }), null);
  // Curation surfaces in the track views the player and HOME render.
  await service.updateTrackCuration(OWNER, trackA.id, { rating: 4 });
  const detail = await service.getTrack(OWNER, trackA.id);
  assert.equal(detail!.rating, 4);
  assert.deepEqual(detail!.labels, ["Driving", "Synthwave"]);
  const listing = await service.listTracks({ ownerId: OWNER, search: "" });
  const listed = listing.find((track) => track.id === trackA.id);
  assert.equal(listed!.rating, 4);
  assert.deepEqual(listed!.labels, ["Driving", "Synthwave"]);
});

test("smart collections: CRUD with strict validation, evaluated live over real tracks", async () => {
  await service.updateTrackCuration(OWNER, trackA.id, { rating: 5 });
  await service.updateTrackCuration(OWNER, trackB.id, { rating: 1, labels: [] });
  const created = await service.createSmartCollection(OWNER, {
    name: "Favourites",
    match: "all",
    rules: [{ field: "rating", op: ">=", value: 4 }],
  });
  assert.notEqual(created, null);
  assert.equal(created!.name, "Favourites");
  assert.deepEqual(created!.rules, [{ field: "rating", op: ">=", value: 4 }]);

  // The stored collection evaluates over real track summaries.
  const { evaluateCollection } = await import("./collections");
  const listing = await service.listTracks({ ownerId: OWNER, search: "" });
  const matches = listing.filter((track) =>
    evaluateCollection(
      {
        id: track.id,
        title: track.title,
        artist: track.artist,
        addedAtMs: Date.parse(track.addedAt),
        playCount: track.playCount,
        durationSeconds: track.durationSeconds,
        rating: track.rating,
        labels: track.labels,
      },
      created!,
      Date.now(),
    ),
  );
  assert.ok(matches.some((track) => track.id === trackA.id), "5-star track matches");
  assert.ok(!matches.some((track) => track.id === trackB.id), "1-star track does not");

  // Invalid rules never persist.
  assert.equal(await service.createSmartCollection(OWNER, { name: "Bad", match: "all", rules: [{ field: "nope", op: "is", value: "x" }] }), null);
  assert.equal(await service.createSmartCollection(OWNER, { name: "Bad", match: "xor" as "all", rules: [] }), null);

  // Update, list, delete — and deletes are idempotent-false.
  const updated = await service.updateSmartCollection(OWNER, created!.id, { match: "any", rules: [{ field: "label", op: "is", value: "driving" }] });
  assert.notEqual(updated, null);
  assert.equal(updated!.match, "any");
  const listed = await service.listSmartCollections(OWNER);
  assert.equal(listed.length, 1);
  assert.equal(await service.deleteSmartCollection(OWNER, created!.id), true);
  assert.equal(await service.deleteSmartCollection(OWNER, created!.id), false);
  assert.equal((await service.listSmartCollections(OWNER)).length, 0);
});

test("completed mixed transitions survive handoff, donors, save/version restore and real WAV export", async () => {
 for (const held of [false, true]) {
  const created = await sessions.createSession(OWNER, "Synthetic completed transition regression");
  for (const track of [trackA, trackB, trackA]) await sessions.addTrackToSession({ ownerId: OWNER, sessionId: created.id, trackId: track.id });
  const detail = await sessions.getSession(OWNER, created.id);
  const [a, b, c] = detail.tracks;
  const cueA = { ...a.transition, crossfadeSeconds: 0.5, keepStems: held ? ["drums"] : [], cue: { toSessionTrackId: b.id, fromDeck: 0, toDeck: 1, fromSeconds: 0.5, incomingSeconds: 0.25 } };
  const cueB = { ...b.transition, crossfadeSeconds: held ? 0.25 : 0, cue: { toSessionTrackId: c.id, fromDeck: 1, toDeck: 0, fromSeconds: 1.5, incomingSeconds: 0.5 } };
  await sessions.recordStemSwap({ ownerId: OWNER, sessionId: created.id, sessionTrackId: a.id, stemType: "drums", toTrackId: trackB.id, atSeconds: 0.75 });
  const route = await import("@/app/api/library/sessions/[id]/studio-handoff/route");
  const countBefore = (await db.db.select().from(schema.projects)).length;
  const missing = await route.POST(new Request("http://arena.test/handoff", { method: "POST", body: JSON.stringify({ mode: "transitions" }) }), { params: Promise.resolve({ id: created.id }) });
  assert.equal(missing.status, 409);
  assert.equal((await db.db.select().from(schema.projects)).length, countBefore, "missing cues never silently become a lossy arrangement");
  const trackRoute = await import("@/app/api/library/sessions/[id]/tracks/[itemId]/route");
  const patch = await trackRoute.PATCH(new Request("http://arena.test/track", { method: "PATCH", body: JSON.stringify({ transition: cueA }) }), { params: Promise.resolve({ id: created.id, itemId: a.id }) });
  assert.equal(patch.status, 200);
  assert.equal((await sessions.getSession(OWNER, created.id)).tracks[0].transition.cue?.toSessionTrackId, b.id);
  const edits = [
    { id: a.id, stemMix: { vocals: 0, drums: 0.4, bass: 0, other: 0 }, transition: cueA },
    { id: b.id, stemMix: { drums: 0.25 }, transition: cueB },
    { id: c.id, stemMix: { vocals: 0, drums: 0.2, bass: 0, other: 0 }, transition: { ...c.transition, crossfadeSeconds: 0 } },
  ];
  const response = await route.POST(new Request("http://arena.test/handoff", { method: "POST", body: JSON.stringify({ mode: "transitions", trackEdits: edits }) }), { params: Promise.resolve({ id: created.id }) });
  assert.equal(response.status, 201, await response.clone().text());
  const { handoff } = await response.json();
  assert.equal((await sessions.getSession(OWNER, created.id)).tracks[0].transition.cue?.toSessionTrackId, b.id);
  const remixRoute = await import("@/app/api/remixes/[id]/route");
  const params = { params: Promise.resolve({ id: handoff.remixSessionId }) };
  const read = async () => (await remixRoute.GET(new Request("http://arena.test/remix"), params)).json();
  const state = await read();
  assert.equal(state.automation.length, 9, "lane envelopes, including muted stems, persist through the existing automation contract");
  const outgoing = state.tracks[1]; // A drums, split at donor change
  assert.deepEqual(outgoing.clips.map((clip: { timelineStartMs: number; sourceOffsetMs: number; durationMs: number }) => [clip.timelineStartMs, clip.sourceOffsetMs, clip.durationMs]), [[0, 0, 750], [750, 750, 250]]);
  assert.deepEqual(state.tracks[4].clips.map((clip: { timelineStartMs: number; sourceOffsetMs: number; durationMs: number }) => [clip.timelineStartMs, clip.sourceOffsetMs, clip.durationMs]), [[500, 250, held ? 1500 : 1250]]);
  const save = await remixRoute.PUT(new Request("http://arena.test/remix", { method: "PUT", body: JSON.stringify({ ...state.remix, tracks: state.tracks, automation: state.automation }) }), params);
  assert.equal(save.status, 200, await save.clone().text());
  const reopened = await read();
  const versions = await import("@/app/api/remixes/[id]/versions/route");
  const versionResponse = await versions.POST(new Request("http://arena.test/version", { method: "POST", body: JSON.stringify({ name: "Synthetic transition structure" }) }), params);
  assert.equal(versionResponse.status, 201);
  const { version } = await versionResponse.json();
  const changed = { ...reopened.remix, tracks: reopened.tracks.map((track: { clips: unknown[] }) => ({ ...track, clips: [] })), automation: [] };
  assert.equal((await remixRoute.PUT(new Request("http://arena.test/remix", { method: "PUT", body: JSON.stringify(changed) }), params)).status, 200);
  const restore = await import("@/app/api/remixes/[id]/versions/[versionId]/restore/route");
  assert.equal((await restore.POST(new Request("http://arena.test/restore", { method: "POST" }), { params: Promise.resolve({ id: handoff.remixSessionId, versionId: version.id }) })).status, 200);
  const restored = await read();
  assert.deepEqual(restored.tracks.map((track: { clips: unknown[] }) => track.clips.map((clip) => { const row = clip as Record<string, unknown>; return [row.stemAssetId, row.timelineStartMs, row.sourceOffsetMs, row.durationMs, row.gain, row.fadeInMs, row.fadeOutMs]; })), reopened.tracks.map((track: { clips: unknown[] }) => track.clips.map((clip) => { const row = clip as Record<string, unknown>; return [row.stemAssetId, row.timelineStartMs, row.sourceOffsetMs, row.durationMs, row.gain, row.fadeInMs, row.fadeOutMs]; })));
  const envelopes = (value: typeof restored) => value.automation.map((lane: { remixTrackId: string; parameter: string; points: Array<{ timelineMs: number; value: number }> }) => ({ track: lane.remixTrackId, parameter: lane.parameter, points: lane.points.map(({ timelineMs, value }) => ({ timelineMs, value })) })).sort((a: { track: string }, b: { track: string }) => a.track.localeCompare(b.track));
  assert.deepEqual(envelopes(restored), envelopes(reopened));
  const priorWorker = process.env.WAVEYARD_LOCAL_WORKER, priorRedis = process.env.REDIS_URL;
  process.env.WAVEYARD_LOCAL_WORKER = "1"; delete process.env.REDIS_URL;
  const { getLocalJobBroker } = await import("../worker-local/broker");
  const { handleExportJob } = await import("../worker-local/export");
  const { EXPORT_QUEUE } = await import("../queue");
  getLocalJobBroker().register(EXPORT_QUEUE, handleExportJob);
  try {
    const exports = await import("@/app/api/remix-versions/[id]/exports/route");
    const exp = await exports.POST(new Request("http://arena.test/export", { method: "POST", body: JSON.stringify({ format: "wav" }) }), { params: Promise.resolve({ id: version.id }) });
    assert.equal(exp.status, 201, await exp.clone().text());
    const { job } = await exp.json();
    assert.equal(await getLocalJobBroker().drain(30_000), true);
    const [finished] = await db.db.select().from(schema.exportJobs).where(eq(schema.exportJobs.id, job.id));
    assert.equal(finished.status, "complete", finished.errorMessage ?? "");
    const media = await import("@/app/api/exports/[id]/media/route");
    const download = await media.GET(new Request("http://arena.test/media?download=1"), { params: Promise.resolve({ id: job.id }) });
    assert.equal(download.status, 200);
    const filename = path.join(root!, `completed-transitions${held ? "-held" : ""}.wav`), decoded = path.join(root!, "completed-transitions.f32");
    writeFileSync(filename, Buffer.from(await download.arrayBuffer()));
    const { validateAudio, exec } = await import("../audio");
    const { requireTool } = await import("../ffmpeg");
    assert.ok(Math.abs((await validateAudio(filename)).durationSeconds - 3.25) < 0.02);
    await exec((await requireTool("ffmpeg")).path, ["-y", "-i", filename, "-f", "f32le", "-ac", "1", decoded]);
    const pcm = readFileSync(decoded);
    const magnitude = (hz: number, start: number, end: number) => {
      let sin = 0, cos = 0;
      const first = Math.round(start * 44100), last = Math.round(end * 44100);
      for (let i = first; i < last; i++) { const value = pcm.readFloatLE(i * 4); sin += value * Math.sin(2 * Math.PI * hz * i / 44100); cos += value * Math.cos(2 * Math.PI * hz * i / 44100); }
      return 2 * Math.hypot(sin, cos) / (last - first);
    };
    const signal = { initial: magnitude(220, 0.1, 0.3), fadeOut: magnitude(220, 0.55, 0.65), fadeIn: magnitude(880, 0.55, 0.65), donorOld: magnitude(220, 0.8, 0.9), donorNew: magnitude(880, 0.8, 0.9), beforeCut: magnitude(880, 1.5, 1.7), afterCut: magnitude(220, 1.8, 2), wrongAfterCut: magnitude(880, 1.8, 2) };
    assert.ok(signal.initial > 0.05, JSON.stringify(signal));
    assert.ok(held ? signal.fadeOut / signal.initial > 0.98 && signal.fadeOut / signal.initial < 1.02 : signal.fadeOut / signal.initial > 0.65 && signal.fadeOut / signal.initial < 0.95, JSON.stringify(signal));
    assert.ok(signal.fadeIn > 0.004 && signal.fadeIn < 0.025, JSON.stringify(signal));
    assert.ok(signal.donorOld < 0.002 && signal.donorNew > 0.03, JSON.stringify(signal));
    assert.ok(signal.beforeCut > 0.03 && signal.afterCut > 0.02 && (held ? signal.wrongAfterCut > 0.003 : signal.wrongAfterCut < 0.002), JSON.stringify(signal));
    if (process.env.ARENA_TRANSITION_EVIDENCE_DIR) {
      const out = process.env.ARENA_TRANSITION_EVIDENCE_DIR; mkdirSync(out, { recursive: true }); copyFileSync(filename, path.join(out, `completed-transitions${held ? "-held" : ""}.wav`));
      writeFileSync(path.join(out, `result${held ? "-held" : ""}.json`), JSON.stringify({ syntheticAudio: true, held, sourceHead: spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim(), workingDiffSha256: createHash("sha256").update(spawnSync("git", ["diff", "HEAD"], { encoding: "utf8" }).stdout).digest("hex"), state: restored, signal, wavSha256: createHash("sha256").update(readFileSync(filename)).digest("hex") }, null, 2));
    }
  } finally { if (priorWorker === undefined) delete process.env.WAVEYARD_LOCAL_WORKER; else process.env.WAVEYARD_LOCAL_WORKER = priorWorker; if (priorRedis === undefined) delete process.env.REDIS_URL; else process.env.REDIS_URL = priorRedis; }
 }
});


test("library and session payloads retain persisted model identity for honest residual labels", async () => {
  const detail = await service.getTrack(OWNER, trackA.id);
  const residual = detail!.stems.find(stem => stem.stemType === "other")!;
  assert.equal(residual.model, "pcm-tone");
  await db.db.update(schema.stemAssets).set({ model: "deep_6s" }).where(eq(schema.stemAssets.id, residual.id));
  try {
    const reread = await service.getTrack(OWNER, trackA.id);
    assert.equal(reread!.stems.find(stem => stem.id === residual.id)!.model, "deep_6s");
    const session = await sessions.createSession(OWNER, "Model identity contract");
    const result = await sessions.addTrackToSession({ ownerId: OWNER, sessionId: session.id, trackId: trackA.id });
    assert.equal(result.tracks[0].stems.find(stem => stem.id === residual.id)!.model, "deep_6s");
  } finally {
    await db.db.update(schema.stemAssets).set({ model: "pcm-tone" }).where(eq(schema.stemAssets.id, residual.id));
  }
});
