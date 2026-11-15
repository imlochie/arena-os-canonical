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
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { and, asc, eq } from "drizzle-orm";
import { checksumFile, probeAudio } from "@workspace/arena/lib/waveyard/audio";
import { requireTool } from "@workspace/arena/lib/waveyard/ffmpeg";
import { DESKTOP_ANALYSIS_ENGINE_VERSION } from "../types/analysis-provenance";
import { LOCAL_VOCAL_ANALYSIS_ENGINE, LOCAL_VOCAL_ANALYSIS_ENGINE_VERSION } from "../types/vocal-analysis";
import { getStorage } from "../storage";
import { createAudioBackupCsv, createVerifiedAudioBackupZip } from "./audio-backup";
import { restoreVerifiedAudioBackupZip } from "./audio-restore";
import { FOUR_STEM_MODELS } from "../worker-local/pinned-models.test-helper";

// The route handlers under test resolve the desktop/local owner from
// NODE_ENV. Establish the test mode before any route module is imported
// dynamically so the suite does not depend on the runner's ambient env.
process.env.NODE_ENV ??= "test";

function findWorkspaceRoot(start: string): string {
  let directory = path.resolve(start);
  while (true) {
    if (existsSync(path.join(directory, "pnpm-workspace.yaml"))) return directory;
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error("Could not locate pnpm-workspace.yaml from the Waveyard service test.");
    directory = parent;
  }
}

const repoRoot = findWorkspaceRoot(path.dirname(fileURLToPath(import.meta.url)));
const arenaRoot = path.join(repoRoot, "lib", "arena");
const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const RECOVERY_OWNER = "33333333-3333-4333-8333-333333333333";
const START_OWNER = "44444444-4444-4444-8444-444444444444";
const RESTORE_OWNER = "55555555-5555-4555-8555-555555555555";
const REPAIR_OWNER = "66666666-6666-4666-8666-666666666666";

type ServiceModule = typeof import("./service");
type SessionServiceModule = typeof import("./session-service");
type DbModule = typeof import("@workspace/db");
type SchemaModule = typeof import("@workspace/db/waveyardSchema");

let service: ServiceModule;
let sessionService: SessionServiceModule;
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
  const bundledCandidates = [
    path.join(repoRoot, "node_modules", "@embedded-postgres", pkg, "native", "bin", exe),
    path.join(repoRoot, "desktop", "node_modules", "@embedded-postgres", pkg, "native", "bin", exe),
  ];
  const bundled = bundledCandidates.find(existsSync);
  if (bundled) return bundled;
  const locator = process.platform === "win32" ? "where.exe" : "which";
  const located = spawnSync(locator, [exe], { encoding: "utf8" }).stdout?.trim().split(/\r?\n/)[0];
  return located && existsSync(located) ? located : bundledCandidates[0];
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

function pcmWavToneMagnitude(filePath: string, frequency: number, startMs: number, endMs: number, channel = 0): number {
  const wav = readFileSync(filePath);
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataBytes = 0;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const chunkName = wav.toString("ascii", offset, offset + 4);
    const chunkBytes = wav.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (chunkName === "fmt ") {
      channels = wav.readUInt16LE(body + 2);
      sampleRate = wav.readUInt32LE(body + 4);
      bitsPerSample = wav.readUInt16LE(body + 14);
    } else if (chunkName === "data") {
      dataOffset = body;
      dataBytes = chunkBytes;
      break;
    }
    offset = body + chunkBytes + (chunkBytes % 2);
  }
  assert.ok(dataOffset >= 0, "rendered WAV has a data chunk");
  assert.equal(bitsPerSample, 16, "rendered WAV uses the expected PCM test format");
  assert.ok(channel >= 0 && channel < channels, "the analyzed channel exists");
  const frameBytes = channels * 2;
  const firstFrame = Math.max(0, Math.floor((startMs / 1000) * sampleRate));
  const lastFrame = Math.min(Math.floor(dataBytes / frameBytes), Math.floor((endMs / 1000) * sampleRate));
  const frameCount = lastFrame - firstFrame;
  assert.ok(frameCount > 0, "tone window is inside the rendered audio");
  let real = 0;
  let imaginary = 0;
  let windowSum = 0;
  for (let index = 0; index < frameCount; index += 1) {
    const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / Math.max(1, frameCount - 1));
    const frame = firstFrame + index;
    const sample = wav.readInt16LE(dataOffset + frame * frameBytes + channel * 2) / 32768;
    const phase = (2 * Math.PI * frequency * frame) / sampleRate;
    real += sample * window * Math.cos(phase);
    imaginary += sample * window * Math.sin(phase);
    windowSum += window;
  }
  return (2 * Math.hypot(real, imaginary)) / windowSum;
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
    // The system PostgreSQL fallback may have no /run/postgresql directory;
    // these tests connect over TCP, so disable its unused Unix socket.
    "-c", "unix_socket_directories=",
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
  const { migrate } = await import("../../../../../../desktop/database.mjs");
  await migrate(client, path.join(arenaRoot, "desktop-migrations"));
  const appliedMigrations = await client.query("select name from arena_schema_migrations");
  assert.ok(appliedMigrations.rows.length >= 2, "canonical migrations must apply (initial + listening layer)");
  assert.ok(
    appliedMigrations.rows.some((row) => row.name === "0017_library_track_checksum_idempotency.sql"),
    "the upload checksum uniqueness migration must apply",
  );
  assert.ok(
    appliedMigrations.rows.some((row) => row.name === "0018_waveyard_session_queue_link.sql"),
    "queue/session linkage migration must apply",
  );
  assert.ok(
    appliedMigrations.rows.some((row) => row.name === "0019_session_swap_asset_identity.sql"),
    "exact live-swap stem identities must apply",
  );
  assert.ok(
    appliedMigrations.rows.some((row) => row.name === "0021_repair_legacy_library_track_duplicates.sql"),
    "legacy duplicate-track repair must apply",
  );
  assert.ok(
    appliedMigrations.rows.some((row) => row.name === "0023_duplicate_track_metadata_preference.sql"),
    "the forward metadata-preference update must apply after the original duplicate repair",
  );

  // --- env BEFORE any app module import (db reads DATABASE_URL at load) ---
  process.env.DATABASE_URL = `postgresql://arena:arena-test@127.0.0.1:${port}/arena_library_test`;
  process.env.WAVEYARD_STORAGE_DIR = path.join(storageDir, "objects");

  service = await import("./service");
  sessionService = await import("./session-service");
  db = (await import("@workspace/db")) as DbModule;
  schema = (await import("@workspace/db/waveyardSchema")) as SchemaModule;
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
  assert.equal(result.track.stemAvailability.status, "rejected", "a rejected queue handoff is visible on the track");
  assert.ok(result.track.stemAvailability.status === "rejected" && result.track.stemAvailability.retryJobId);
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

test("a library track with no separation job starts once and reports the active job", async () => {
  const [project] = await db.db
    .insert(schema.projects)
    .values({ ownerId: START_OWNER, title: "Unprocessed track", kind: "library", visibility: "private" })
    .returning({ id: schema.projects.id });
  const [source] = await db.db
    .insert(schema.sourceAssets)
    .values({
      projectId: project.id,
      originalFilename: "Unprocessed.wav",
      mimeType: "audio/wav",
      storageKey: `${project.id}/source/unprocessed.wav`,
      checksumSha256: "4".repeat(64),
      durationSeconds: 30,
      sampleRate: 44100,
      channels: 2,
      codec: "pcm_s16le",
      bitrate: 1411200,
      fileSizeBytes: 5_292_000,
    })
    .returning({ id: schema.sourceAssets.id });
  const [track] = await db.db
    .insert(schema.tracks)
    .values({
      ownerId: START_OWNER,
      sourceChecksumSha256: "4".repeat(64),
      title: "Unprocessed",
      artist: "Test",
      album: "",
      sourceAssetId: source.id,
      projectId: project.id,
      durationSeconds: 30,
    })
    .returning({ id: schema.tracks.id });

  let enqueueCount = 0;
  const enqueue = async (payload: { sourceAssetId: string }) => {
    enqueueCount += 1;
    assert.equal(payload.sourceAssetId, source.id);
  };
  const concurrentStarts = await Promise.all([
    service.startSeparationForTrack(START_OWNER, track.id, { enqueue }),
    service.startSeparationForTrack(START_OWNER, track.id, { enqueue }),
  ]);
  assert.deepEqual(
    concurrentStarts.map((result) => result.outcome).sort(),
    ["already-active", "queued"],
    "simultaneous starts share one active separation job",
  );
  assert.equal(enqueueCount, 1);
  const detail = await service.getTrack(START_OWNER, track.id);
  assert.equal(detail?.stemAvailability.status, "processing");

  const [job] = await db.db
    .select({ id: schema.processingJobs.id })
    .from(schema.processingJobs)
    .where(eq(schema.processingJobs.sourceAssetId, source.id))
    .limit(1);
  assert.ok(job, "starting separation persists a job that the library can query");
  await db.db
    .update(schema.processingJobs)
    .set({
      status: "processing",
      stage: "separating",
      metadata: JSON.stringify({ progress: { done: 2, total: 4, percent: 36, phase: "2/4", kind: "chunk" } }),
    })
    .where(eq(schema.processingJobs.id, job.id));
  const progressDetail = await service.getTrack(START_OWNER, track.id);
  assert.deepEqual(progressDetail?.stemAvailability, {
    status: "processing",
    reason: "Stem separation is running. The full source remains playable.",
    stage: "separating",
    progress: { percent: 36, phase: "pass 2/4 · chunk 2 of 4" },
    cancelJobId: job.id,
  });
  const [listedTrack] = await service.listTracks({ ownerId: START_OWNER, search: "Unprocessed" });
  assert.deepEqual(listedTrack?.stemAvailability, progressDetail?.stemAvailability);

  const duplicate = await service.startSeparationForTrack(START_OWNER, track.id, { enqueue });
  assert.equal(duplicate.outcome, "already-active");
  assert.equal(enqueueCount, 1, "a repeat start must not submit a second worker job");

  await db.db
    .update(schema.processingJobs)
    .set({ status: "complete", stage: "complete", completedAt: new Date() })
    .where(eq(schema.processingJobs.id, job.id));
  await db.db.insert(schema.stemAssets).values(
    ["vocals", "drums", "bass", "other"].map((stemType) => ({
      projectId: project.id,
      sourceAssetId: source.id,
      separationJobId: job.id,
      stemType,
      engine: "demucs",
      model: "htdemucs",
      modelVersion: "test",
      storageKey: `test/direct-start-${stemType}.wav`,
      checksumSha256: `direct-start-${stemType}`,
      durationSeconds: 30,
      sampleRate: 44100,
      channels: 2,
      codec: "wav",
      format: "wav",
      fileSizeBytes: 100,
    })),
  );
  const completed = await service.getTrack(START_OWNER, track.id);
  assert.deepEqual(completed?.stemAvailability, {
    status: "separated",
    stemCount: 4,
    stemTypes: ["bass", "drums", "other", "vocals"],
  });
  assert.equal(completed?.playback.kind, "stems", "completed library playback uses the produced stems");
  const afterCompletion = await service.startSeparationForTrack(START_OWNER, track.id, { enqueue });
  assert.deepEqual(afterCompletion, { outcome: "already-separated", stemCount: 4 });
  assert.equal(enqueueCount, 1, "a completed track does not submit another job");
});

test("concurrent same-file uploads create one source, track, and separation job", async () => {
  const firstPath = path.join(root!, "concurrent-original.wav");
  const retryPath = path.join(root!, "concurrent-retry.wav");
  writeWav(firstPath, 2, 440);
  writeWav(retryPath, 2, 440);

  const results = await Promise.all([
    service.addTrackFromAudioFile({
      ownerId: OTHER,
      filePath: firstPath,
      filename: "Concurrent Original.wav",
      mimeType: "audio/wav",
    }),
    service.addTrackFromAudioFile({
      ownerId: OTHER,
      filePath: retryPath,
      filename: "Concurrent Retry.wav",
      mimeType: "audio/wav",
    }),
  ]);

  assert.equal(results.filter((result) => result.created).length, 1);
  assert.equal(results[0].track.id, results[1].track.id);

  const ownerTracks = await db.db.select().from(schema.tracks).where(eq(schema.tracks.ownerId, OTHER));
  assert.equal(ownerTracks.length, 1);
  assert.ok(ownerTracks[0].sourceChecksumSha256);
  const ownerSources = await db.db
    .select({ id: schema.sourceAssets.id })
    .from(schema.sourceAssets)
    .innerJoin(schema.projects, eq(schema.sourceAssets.projectId, schema.projects.id))
    .where(eq(schema.projects.ownerId, OTHER));
  assert.equal(ownerSources.length, 1);
  assert.equal(ownerTracks[0].sourceAssetId, ownerSources[0].id);
  const separationJobs = await db.db
    .select()
    .from(schema.processingJobs)
    .where(and(
      eq(schema.processingJobs.sourceAssetId, ownerSources[0].id),
      eq(schema.processingJobs.type, "separation"),
    ));
  assert.equal(separationJobs.length, 1);
});

test("retry links a committed source without creating a second separation job", async () => {
  const filePath = path.join(root!, "interrupted-before-track.wav");
  writeWav(filePath, 2, 550);
  const checksum = await checksumFile(filePath);
  const [project] = await db.db
    .insert(schema.projects)
    .values({
      ownerId: RECOVERY_OWNER,
      title: "Interrupted upload",
      description: "Test recovery container",
      kind: "library",
      visibility: "private",
    })
    .returning({ id: schema.projects.id });
  const [source] = await db.db
    .insert(schema.sourceAssets)
    .values({
      projectId: project.id,
      originalFilename: "Interrupted upload.wav",
      mimeType: "audio/wav",
      storageKey: `${project.id}/source/interrupted.wav`,
      checksumSha256: checksum,
      durationSeconds: 2,
      sampleRate: 44100,
      channels: 1,
      codec: "pcm_s16le",
      bitrate: null,
      fileSizeBytes: 176444,
    })
    .returning({ id: schema.sourceAssets.id });
  await db.db.insert(schema.processingJobs).values({
    projectId: project.id,
    sourceAssetId: source.id,
    type: "separation",
    status: "queued",
    idempotencyKey: `separation:${source.id}:test-model`,
    model: "test-model",
    requestedDevice: "cpu",
  });

  const retried = await service.addTrackFromAudioFile({
    ownerId: RECOVERY_OWNER,
    filePath,
    filename: "Recovered Track.wav",
    mimeType: "audio/wav",
  });
  assert.equal(retried.created, true);
  assert.equal(retried.separationQueued, true);

  const recoveredTracks = await db.db
    .select()
    .from(schema.tracks)
    .where(eq(schema.tracks.ownerId, RECOVERY_OWNER));
  assert.equal(recoveredTracks.length, 1);
  assert.equal(recoveredTracks[0].sourceAssetId, source.id);
  assert.equal(recoveredTracks[0].sourceChecksumSha256, checksum);
  const separationJobs = await db.db
    .select()
    .from(schema.processingJobs)
    .where(and(
      eq(schema.processingJobs.sourceAssetId, source.id),
      eq(schema.processingJobs.type, "separation"),
    ));
  assert.equal(separationJobs.length, 1);
});

test("migration 0021 repairs a populated pre-migration library without losing saved order", async (t) => {
  const ownerId = randomUUID();
  const checksum = "f".repeat(64);
  const databaseName = `arena_library_upgrade_${process.pid}_${randomUUID().slice(0, 8)}`;
  const migrationsDir = path.join(root!, `migrations-before-0021-${randomUUID()}`);
  mkdirSync(migrationsDir, { recursive: true });

  const { Client } = await import("pg");
  const { drizzle: drizzlePg } = await import("drizzle-orm/node-postgres");
  const databaseUrl = new URL(process.env.DATABASE_URL!);
  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = "/postgres";
  const isolatedUrl = new URL(databaseUrl);
  isolatedUrl.pathname = `/${databaseName}`;
  const adminClient = new Client({ connectionString: adminUrl.toString() });
  let isolatedClient: import("pg").Client | null = null;
  t.after(async () => {
    await isolatedClient?.end().catch(() => {});
    await adminClient.query(`DROP DATABASE IF EXISTS "${databaseName}"`).catch(() => {});
    await adminClient.end().catch(() => {});
    rmSync(migrationsDir, { recursive: true, force: true });
  });

  await adminClient.connect();
  await adminClient.query(`CREATE DATABASE "${databaseName}"`);
  isolatedClient = new Client({ connectionString: isolatedUrl.toString() });
  await isolatedClient.connect();
  const legacyDb = drizzlePg(isolatedClient);
  const { migrate } = await import("../../../../../../desktop/database.mjs");
  const sourceMigrationsDir = path.join(arenaRoot, "desktop-migrations");
  const migration0021 = "0021_repair_legacy_library_track_duplicates.sql";
  for (const file of readdirSync(sourceMigrationsDir).filter(
    (entry) => entry.endsWith(".sql") && entry < migration0021,
  )) {
    copyFileSync(path.join(sourceMigrationsDir, file), path.join(migrationsDir, file));
  }
  await migrate(isolatedClient, migrationsDir);
  const appliedBeforeRepair = await isolatedClient.query(
    "select name from arena_schema_migrations where name = $1",
    [migration0021],
  );
  assert.equal(appliedBeforeRepair.rowCount, 0, "the fixture starts before migration 0021");

  const trackIds: string[] = [];
  for (const [index, title] of ["Original", "Raced upload"].entries()) {
    const [project] = await legacyDb.insert(schema.projects).values({
      ownerId, title: `${title} migration fixture`, kind: "library", visibility: "private",
    }).returning({ id: schema.projects.id });
    const [source] = await legacyDb.insert(schema.sourceAssets).values({
      projectId: project.id, originalFilename: `${title}.wav`, mimeType: "audio/wav",
      storageKey: `${project.id}/source.wav`, checksumSha256: checksum,
      durationSeconds: 12, sampleRate: 44_100, channels: 2, codec: "pcm_s16le",
      bitrate: 1_411_200, fileSizeBytes: 2_116_800,
    }).returning({ id: schema.sourceAssets.id });
    const [track] = await legacyDb.insert(schema.tracks).values({
      ownerId, title, artist: "Legacy Artist", album: "Legacy Album",
      sourceAssetId: source.id, projectId: project.id, durationSeconds: 12,
      createdAt: new Date(Date.UTC(2020 + index, 0, 1)),
    }).returning({ id: schema.tracks.id });
    trackIds.push(track.id);
  }

  const queueIds: string[] = [];
  for (const [position, trackId] of trackIds.entries()) {
    const [item] = await legacyDb.insert(schema.queueItems).values({
      ownerId, trackId, position,
    }).returning({ id: schema.queueItems.id });
    queueIds.push(item.id);
  }
  const [playlist] = await legacyDb.insert(schema.playlists).values({
    ownerId, name: "Pre-migration order",
  }).returning({ id: schema.playlists.id });
  const playlistItemIds: string[] = [];
  for (const [position, trackId] of trackIds.entries()) {
    const [item] = await legacyDb.insert(schema.playlistItems).values({
      playlistId: playlist.id, trackId, position,
    }).returning({ id: schema.playlistItems.id });
    playlistItemIds.push(item.id);
  }
  // This fixture must represent the schema BEFORE migration 0021. The current
  // Drizzle model includes columns added by later migrations (0024), so using
  // it here would fail on a column the legacy database does not have yet and
  // the repair would never be exercised. Insert only the original columns.
  const sessionId = randomUUID();
  await isolatedClient.query(
    "insert into wy_listen_sessions (id, owner_id, name) values ($1, $2, $3)",
    [sessionId, ownerId, "Pre-migration session"],
  );
  const session = { id: sessionId };
  const sessionTrackIds: string[] = [];
  for (const [position, trackId] of trackIds.entries()) {
    const [item] = await legacyDb.insert(schema.listenSessionTracks).values({
      sessionId: session.id, trackId, queueItemId: queueIds[position], position,
      stemMix: JSON.stringify({ vocals: 0.7 }), transition: JSON.stringify({ type: "cut" }),
    }).returning({ id: schema.listenSessionTracks.id });
    sessionTrackIds.push(item.id);
  }
  await legacyDb.update(schema.listenSessions)
    .set({ currentTrackId: sessionTrackIds[1], positionSeconds: 8.25 })
    .where(eq(schema.listenSessions.id, session.id));

  const beforeRepair = await legacyDb.select().from(schema.tracks)
    .where(eq(schema.tracks.ownerId, ownerId));
  assert.equal(beforeRepair.length, 2, "both duplicate legacy tracks exist before the upgrade");
  copyFileSync(
    path.join(sourceMigrationsDir, migration0021),
    path.join(migrationsDir, migration0021),
  );
  await migrate(isolatedClient, migrationsDir);
  const appliedRepair = await isolatedClient.query(
    "select name from arena_schema_migrations where name = $1",
    [migration0021],
  );
  assert.equal(appliedRepair.rowCount, 1, "the populated database records migration 0021 as applied");

  const afterRepair = await legacyDb.select().from(schema.tracks)
    .where(eq(schema.tracks.ownerId, ownerId));
  assert.equal(afterRepair.length, 1, "the listener library opens with one track per owner and checksum");
  assert.equal(afterRepair[0].id, trackIds[0], "the oldest legacy track identity is retained");
  assert.equal(afterRepair[0].sourceChecksumSha256, checksum);

  const repairedQueue = await legacyDb.select().from(schema.queueItems)
    .where(eq(schema.queueItems.ownerId, ownerId))
    .orderBy(asc(schema.queueItems.position));
  assert.deepEqual(
    repairedQueue.map(({ id, trackId, position }) => ({ id, trackId, position })),
    [
      { id: queueIds[0], trackId: trackIds[0], position: 0 },
      { id: queueIds[1], trackId: trackIds[0], position: 1 },
    ],
  );
  const repairedPlaylist = await legacyDb.select().from(schema.playlistItems)
    .where(eq(schema.playlistItems.playlistId, playlist.id))
    .orderBy(asc(schema.playlistItems.position));
  assert.deepEqual(
    repairedPlaylist.map(({ id, trackId, position }) => ({ id, trackId, position })),
    [
      { id: playlistItemIds[0], trackId: trackIds[0], position: 0 },
      { id: playlistItemIds[1], trackId: trackIds[0], position: 1 },
    ],
  );
  const repairedSessionTracks = await legacyDb.select().from(schema.listenSessionTracks)
    .where(eq(schema.listenSessionTracks.sessionId, session.id))
    .orderBy(asc(schema.listenSessionTracks.position));
  assert.deepEqual(
    repairedSessionTracks.map(({ id, trackId, queueItemId, position }) => ({ id, trackId, queueItemId, position })),
    [
      { id: sessionTrackIds[0], trackId: trackIds[0], queueItemId: queueIds[0], position: 0 },
      { id: sessionTrackIds[1], trackId: trackIds[0], queueItemId: queueIds[1], position: 1 },
    ],
  );
  // Read the repaired session through the pre-0024 columns. The current
  // Drizzle model also selects key_match_mode/key_shifts, which this fixture
  // intentionally does not have yet; selecting them would fail before the
  // assertion and hide whether migration 0021 preserved the session state.
  const { rows: repairedSessionRows } = await isolatedClient.query(
    "select id, current_track_id, position_seconds from wy_listen_sessions where id = $1",
    [session.id],
  );
  const repairedSession = repairedSessionRows[0];
  assert.equal(repairedSession.id, session.id);
  assert.equal(repairedSession.current_track_id, sessionTrackIds[1]);
  assert.equal(repairedSession.position_seconds, 8.25);
});

test("legacy duplicate repair backfills identity and preserves every listening reference", async (t) => {
  const checksum = "a".repeat(64);
  const legacyTracks: Array<{ id: string; projectId: string; sourceAssetId: string }> = [];
  for (const [index, title] of ["Original", "Raced upload"].entries()) {
    const [project] = await db.db
      .insert(schema.projects)
      .values({
        ownerId: REPAIR_OWNER,
        title: `${title} library`,
        kind: "library",
        visibility: "private",
      })
      .returning({ id: schema.projects.id });
    const [source] = await db.db
      .insert(schema.sourceAssets)
      .values({
        projectId: project.id,
        originalFilename: `${title}.wav`,
        mimeType: "audio/wav",
        storageKey: `${project.id}/source/${index}.wav`,
        checksumSha256: checksum,
        durationSeconds: 12,
        sampleRate: 44100,
        channels: 2,
        codec: "pcm_s16le",
        bitrate: 1411200,
        fileSizeBytes: 2_116_800,
      })
      .returning({ id: schema.sourceAssets.id });
    const [track] = await db.db
      .insert(schema.tracks)
      .values({
        ownerId: REPAIR_OWNER,
        title: index === 0 ? "Original keeper title" : "Tagged upload title",
        artist: index === 0 ? "Legacy Artist" : "Tagged artist",
        album: index === 0 ? "" : "Tagged album",
        labels: JSON.stringify([`label-${index}`]),
        rating: index + 2,
        playCount: index + 3,
        sourceAssetId: source.id,
        projectId: project.id,
        durationSeconds: 12,
      })
      .returning({ id: schema.tracks.id });
    legacyTracks.push({ id: track.id, projectId: project.id, sourceAssetId: source.id });
  }
  const singletonChecksum = "b".repeat(64);
  const [singletonProject] = await db.db
    .insert(schema.projects)
    .values({
      ownerId: REPAIR_OWNER,
      title: "Legacy singleton library",
      kind: "library",
      visibility: "private",
    })
    .returning({ id: schema.projects.id });
  const [singletonSource] = await db.db
    .insert(schema.sourceAssets)
    .values({
      projectId: singletonProject.id,
      originalFilename: "Legacy singleton.wav",
      mimeType: "audio/wav",
      storageKey: `${singletonProject.id}/source/singleton.wav`,
      checksumSha256: singletonChecksum,
      durationSeconds: 12,
      sampleRate: 44100,
      channels: 2,
      codec: "pcm_s16le",
      bitrate: 1411200,
      fileSizeBytes: 2_116_800,
    })
    .returning({ id: schema.sourceAssets.id });
  const [singletonTrack] = await db.db
    .insert(schema.tracks)
    .values({
      ownerId: REPAIR_OWNER,
      title: "Legacy singleton",
      artist: "Legacy Artist",
      album: "Legacy Album",
      sourceAssetId: singletonSource.id,
      projectId: singletonProject.id,
      durationSeconds: 12,
    })
    .returning({ id: schema.tracks.id });

  const playlist = await service.createPlaylist(REPAIR_OWNER, "Legacy duplicates");
  await service.addTrackToPlaylist({
    ownerId: REPAIR_OWNER, playlistId: playlist.id, trackId: legacyTracks[0].id,
  });
  await service.addTrackToPlaylist({
    ownerId: REPAIR_OWNER, playlistId: playlist.id, trackId: legacyTracks[1].id,
  });

  const queueA = await service.addToQueue({ ownerId: REPAIR_OWNER, trackId: legacyTracks[0].id });
  const queueB = await service.addToQueue({ ownerId: REPAIR_OWNER, trackId: legacyTracks[1].id });
  const session = await sessionService.createSession(REPAIR_OWNER, "Legacy references");
  t.after(() => sessionService.deleteSession(REPAIR_OWNER, session.id));
  let sessionDetail = await sessionService.addTrackToSession({
    ownerId: REPAIR_OWNER,
    sessionId: session.id,
    trackId: legacyTracks[0].id,
    queueItemId: queueA.addedQueueItemId,
  });
  sessionDetail = await sessionService.addTrackToSession({
    ownerId: REPAIR_OWNER,
    sessionId: session.id,
    trackId: legacyTracks[1].id,
    queueItemId: queueB.addedQueueItemId,
  });
  const currentSessionTrackId = sessionDetail.tracks[1].id;
  await sessionService.saveSessionState(REPAIR_OWNER, session.id, currentSessionTrackId, 9.5);
  await service.savePlaybackState(REPAIR_OWNER, { currentTrackId: legacyTracks[1].id, positionSeconds: 9.5 });
  await db.db.insert(schema.listenSessionSwaps).values({
    sessionId: session.id,
    sessionTrackId: sessionDetail.tracks[0].id,
    stemType: "restore-test",
    fromTrackId: legacyTracks[1].id,
    toTrackId: legacyTracks[0].id,
  });

  const originalRows = await db.db
    .select()
    .from(schema.tracks)
    .where(eq(schema.tracks.ownerId, REPAIR_OWNER));
  const keeper = [...originalRows].sort((left, right) =>
    left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id),
  )[0];

  const repair = await service.repairDuplicateLibraryTracks();
  assert.ok(repair.mergedTrackCount >= 1);
  assert.ok(repair.checksumIdentityCount >= 1);

  const remainingTracks = await db.db
    .select()
    .from(schema.tracks)
    .where(eq(schema.tracks.ownerId, REPAIR_OWNER));
  assert.equal(remainingTracks.length, 2);
  const repairedKeeper = remainingTracks.find((track) => track.id === keeper.id)!;
  assert.equal(repairedKeeper.sourceChecksumSha256, checksum);
  assert.equal(repairedKeeper.title, "Tagged upload title", "richer conflicting tags win without changing the keeper ID");
  assert.equal(repairedKeeper.artist, "Tagged artist");
  assert.equal(repairedKeeper.album, "Tagged album", "a blank keeper album is filled from the richer duplicate");
  assert.equal(repairedKeeper.playCount, 7, "play history is combined");
  assert.equal(repairedKeeper.rating, 3, "the strongest saved rating is retained");
  assert.deepEqual(JSON.parse(repairedKeeper.labels!), ["label-0", "label-1"]);
  assert.equal(
    remainingTracks.find((track) => track.id === singletonTrack.id)?.sourceChecksumSha256,
    singletonChecksum,
    "a legacy track without duplicates still receives its checksum identity",
  );

  const repairedQueue = await service.listQueue(REPAIR_OWNER);
  assert.deepEqual(repairedQueue.map((item) => item.id), [queueA.addedQueueItemId, queueB.addedQueueItemId]);
  assert.deepEqual(repairedQueue.map((item) => item.track.id), [keeper.id, keeper.id]);
  const repairedPlaylist = await service.getPlaylist(REPAIR_OWNER, playlist.id);
  assert.equal(repairedPlaylist.items.length, 2);
  assert.deepEqual(repairedPlaylist.items.map((item) => item.track.id), [keeper.id, keeper.id]);

  const repairedSession = await sessionService.getSession(REPAIR_OWNER, session.id);
  assert.deepEqual(repairedSession.tracks.map((item) => item.track.id), [keeper.id, keeper.id]);
  assert.equal(repairedSession.currentSessionTrackId, currentSessionTrackId);
  assert.equal(repairedSession.positionSeconds, 9.5);
  assert.equal((await service.getPlaybackState(REPAIR_OWNER)).currentTrackId, keeper.id);
  const [swap] = await db.db
    .select()
    .from(schema.listenSessionSwaps)
    .where(eq(schema.listenSessionSwaps.sessionId, session.id));
  assert.equal(swap.fromTrackId, keeper.id);
  assert.equal(swap.toTrackId, keeper.id);

  const repeatedRepair = await service.repairDuplicateLibraryTracks();
  assert.equal(repeatedRepair.mergedTrackCount, 0, "repair is safe to run again");
  assert.equal((await db.db.select().from(schema.tracks).where(eq(schema.tracks.ownerId, REPAIR_OWNER))).length, 2);
});

test("duplicate metadata keeps populated keeper values over blanks and resolves matching ties deterministically", async () => {
  const ownerId = randomUUID();
  const groups = [
    {
      checksum: "c".repeat(64),
      rows: [
        { title: "Known song", artist: "Known artist", album: "Known album" },
        { title: "  ", artist: "", album: "\t" },
      ],
      expected: { title: "Known song", artist: "Known artist", album: "Known album" },
    },
    {
      checksum: "d".repeat(64),
      rows: [
        { title: "Same title", artist: "Same artist", album: "Keeper album" },
        { title: "Same title", artist: "Same artist", album: "Conflicting album" },
      ],
      expected: { title: "Same title", artist: "Same artist", album: "Keeper album" },
    },
  ];
  const keepers: Array<{ id: string; checksum: string; expected: { title: string; artist: string; album: string } }> = [];
  for (const group of groups) {
    let keeperId = "";
    for (const [index, metadata] of group.rows.entries()) {
      const [project] = await db.db.insert(schema.projects).values({
        ownerId, title: `Metadata fixture ${group.checksum[0]} ${index}`,
        kind: "library", visibility: "private",
      }).returning({ id: schema.projects.id });
      const [source] = await db.db.insert(schema.sourceAssets).values({
        projectId: project.id, originalFilename: `metadata-${group.checksum[0]}-${index}.wav`,
        mimeType: "audio/wav", storageKey: `${project.id}/source.wav`,
        checksumSha256: group.checksum, durationSeconds: 12, sampleRate: 44_100,
        channels: 2, codec: "pcm_s16le", bitrate: 1_411_200, fileSizeBytes: 2_116_800,
      }).returning({ id: schema.sourceAssets.id });
      const [track] = await db.db.insert(schema.tracks).values({
        ownerId, title: metadata.title, artist: metadata.artist, album: metadata.album,
        sourceAssetId: source.id, projectId: project.id, durationSeconds: 12,
        createdAt: new Date(Date.UTC(2024 + index, 0, 1)),
      }).returning({ id: schema.tracks.id });
      if (index === 0) keeperId = track.id;
    }
    keepers.push({ id: keeperId, checksum: group.checksum, expected: group.expected });
  }

  const repair = await service.repairDuplicateLibraryTracks();
  assert.ok(repair.mergedTrackCount >= groups.length);
  const repaired = await db.db.select().from(schema.tracks)
    .where(eq(schema.tracks.ownerId, ownerId));
  assert.equal(repaired.length, groups.length, "each matching-checksum pair resolves to one stable track");
  for (const keeper of keepers) {
    const row = repaired.find(track => track.id === keeper.id);
    assert.ok(row, "the oldest track identity survives metadata consolidation");
    assert.equal(row.sourceChecksumSha256, keeper.checksum);
    assert.deepEqual(
      { title: row.title, artist: row.artist, album: row.album },
      keeper.expected,
    );
  }
});

test("forward metadata migration repairs duplicates in an already-migrated desktop", async () => {
  const ownerId = randomUUID();
  const checksum = "e".repeat(64);
  const entries = [
    { title: "Old title", artist: "Old artist", album: "" },
    { title: "Tagged title", artist: "Tagged artist", album: "Tagged album" },
  ];
  let keeperId = "";
  for (const [index, metadata] of entries.entries()) {
    const [project] = await db.db.insert(schema.projects).values({
      ownerId, title: `Upgrade metadata fixture ${index}`,
      kind: "library", visibility: "private",
    }).returning({ id: schema.projects.id });
    const [source] = await db.db.insert(schema.sourceAssets).values({
      projectId: project.id, originalFilename: `upgrade-metadata-${index}.wav`,
      mimeType: "audio/wav", storageKey: `${project.id}/source.wav`,
      checksumSha256: checksum, durationSeconds: 12, sampleRate: 44_100,
      channels: 2, codec: "pcm_s16le", bitrate: 1_411_200, fileSizeBytes: 2_116_800,
    }).returning({ id: schema.sourceAssets.id });
    const [track] = await db.db.insert(schema.tracks).values({
      ownerId, ...metadata, sourceAssetId: source.id, projectId: project.id,
      durationSeconds: 12, createdAt: new Date(Date.UTC(2023 + index, 0, 1)),
    }).returning({ id: schema.tracks.id });
    if (index === 0) keeperId = track.id;
  }

  assert.equal(
    (await db.db.select().from(schema.tracks).where(eq(schema.tracks.ownerId, ownerId))).length,
    2,
  );
  await client!.query(
    "delete from arena_schema_migrations where name = $1",
    ["0023_duplicate_track_metadata_preference.sql"],
  );
  const { migrate } = await import("../../../../../../desktop/database.mjs");
  await migrate(client!, path.join(arenaRoot, "desktop-migrations"));

  const repaired = await db.db.select().from(schema.tracks)
    .where(eq(schema.tracks.ownerId, ownerId));
  assert.equal(repaired.length, 1, "the forward migration consolidates existing duplicate rows");
  assert.equal(repaired[0].id, keeperId, "the oldest track ID remains stable");
  assert.deepEqual(
    { title: repaired[0].title, artist: repaired[0].artist, album: repaired[0].album },
    { title: "Tagged title", artist: "Tagged artist", album: "Tagged album" },
  );
});

test("track detail resolves source, stems, analysis, and the studio handoff project", async () => {
  const detail = await service.getTrack(OWNER, trackA.id);
  assert.ok(detail !== null);
  assert.equal(detail.playback.kind, "source");
  assert.deepEqual(detail.playback.assetIds, [detail.source.id]);
  assert.equal(detail.stemAvailability.status, "rejected", "the detail view preserves a rejected separation job");
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
  assert.equal(all[0].sourceAssetId, sourceIdByTrackId.get(trackB.id), "the owner-scoped list exposes the exact original asset for backup");

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

test("queue: add end/next, move, remove, clear — ordered and owner-scoped", async (t) => {
  const addedA = await service.addToQueue({ ownerId: OWNER, trackId: trackA.id });
  let queue = addedA.queue;
  assert.equal(queue.length, 1);
  queue = (await service.addToQueue({ ownerId: OWNER, trackId: trackB.id })).queue;
  assert.equal(queue.map((item) => item.track.id).join(","), [trackA.id, trackB.id].join(","), "adds stack at the end in order");

  // "next" inserts right after the currently playing track.
  queue = (await service.addToQueue({ ownerId: OWNER, trackId: trackB.id, at: "next", currentTrackId: trackA.id })).queue;
  assert.equal(
    queue.map((item) => item.track.id).join(","),
    [trackA.id, trackB.id, trackB.id].join(","),
  );

  // queue is [A, B₂, B₁]; moving B₁ (queue[2]) to the front → [B₁, A, B₂].
  const moved = await service.moveQueueItem(OWNER, queue[2].id, 0);
  assert.equal(moved.queue.map((item) => item.track.id).join(","), [trackB.id, trackA.id, trackB.id].join(","));

  const session = await sessionService.createSession(OWNER, "Queue provenance test");
  t.after(() => sessionService.deleteSession(OWNER, session.id));
  let sessionDetail = await sessionService.addTrackToSession({
    ownerId: OWNER, sessionId: session.id, trackId: trackB.id, queueItemId: moved.queue[0].id,
  });
  const currentSessionTrackId = sessionDetail.tracks[0].id;
  sessionDetail = await sessionService.addTrackToSession({ ownerId: OWNER, sessionId: session.id, trackId: trackA.id });
  const directSessionTrackIds = [sessionDetail.tracks[1].id];
  sessionDetail = await sessionService.addTrackToSession({
    ownerId: OWNER, sessionId: session.id, trackId: trackA.id, queueItemId: addedA.addedQueueItemId,
  });
  sessionDetail = await sessionService.addTrackToSession({ ownerId: OWNER, sessionId: session.id, trackId: trackB.id });
  directSessionTrackIds.push(sessionDetail.tracks[3].id);
  await sessionService.saveSessionState(OWNER, session.id, currentSessionTrackId, 73.5);

  // Moving the saved A above linked B swaps only the linked positions. The
  // direct A/B additions stay in place and the current track pointer is untouched.
  const reordered = await service.moveQueueItem(OWNER, addedA.addedQueueItemId, 0, session.id);
  assert.deepEqual(reordered.queue.map((item) => item.id), [
    addedA.addedQueueItemId,
    moved.queue[0].id,
    moved.queue[2].id,
  ]);
  assert.deepEqual(reordered.affectedSessionIds, [session.id]);
  sessionDetail = await sessionService.getSession(OWNER, session.id);
  assert.deepEqual(
    sessionDetail.tracks.map((item) => item.track.id),
    [trackA.id, trackA.id, trackB.id, trackB.id],
    "saved links follow the queue while direct entries stay in their session slots",
  );
  assert.deepEqual(
    sessionDetail.tracks.filter((item) => item.queueItemId === null).map((item) => item.id),
    directSessionTrackIds,
    "playlist-only session rows remain distinct and in order",
  );
  assert.equal(sessionDetail.currentSessionTrackId, currentSessionTrackId, "queue moves never reset the current playback row");
  assert.equal(sessionDetail.positionSeconds, 73.5, "queue moves never reset the saved playback position");

  const retainedPlaybackTrackId = sessionDetail.tracks[0].id;
  await sessionService.saveSessionState(OWNER, session.id, retainedPlaybackTrackId, 73.5);
  // removing B₁ leaves [A, B₂].
  const removed = await service.removeQueueItem(OWNER, moved.queue[0].id);
  assert.equal(removed.queue.map((item) => item.track.id).join(","), [trackA.id, trackB.id].join(","));
  assert.deepEqual(removed.queue.map((item) => item.position), [0, 1], "positions resequence without gaps");
  assert.deepEqual(removed.affectedSessionIds, [session.id]);
  sessionDetail = await sessionService.getSession(OWNER, session.id);
  assert.equal(sessionDetail.currentSessionTrackId, retainedPlaybackTrackId, "removing a non-current mix target preserves the playing session row");
  assert.equal(sessionDetail.positionSeconds, 73.5, "removing a non-current mix target preserves playback position");
  assert.deepEqual(
    sessionDetail.tracks.map((item) => item.track.id),
    [trackA.id, trackA.id, trackB.id],
    "removing one repeated queued song keeps the direct session copies and other songs",
  );
  const removedCurrent = await service.removeQueueItem(OWNER, addedA.addedQueueItemId);
  assert.deepEqual(removedCurrent.queue.map((item) => item.track.id), [trackB.id]);
  assert.deepEqual(removedCurrent.affectedSessionIds, [session.id]);
  sessionDetail = await sessionService.getSession(OWNER, session.id);
  assert.equal(sessionDetail.currentSessionTrackId, null, "removing the current linked row clears its server pointer");
  assert.equal(sessionDetail.positionSeconds, 0, "removing the current linked row resets its saved position");
  assert.deepEqual(
    sessionDetail.tracks.map((item) => item.id),
    directSessionTrackIds,
    "removing the current linked row leaves direct playlist entries intact",
  );

  // Another owner's queue is independent.
  writeWav(path.join(root!, "other-owner.wav"), 2, 440); // distinct content
  const otherQueue = await service.addToQueue({ ownerId: OTHER, trackId: (await service.addTrackFromAudioFile({
    ownerId: OTHER,
    filePath: path.join(root!, "other-owner.wav"),
    filename: "Other Owner - Isolated Track.wav",
    mimeType: "audio/wav",
  })).track.id });
  assert.equal(otherQueue.queue.length, 1);
  assert.equal((await service.listQueue(OWNER)).length, 1);

  const cleared = await service.clearQueue(OWNER);
  assert.equal(cleared.queue.length, 0);
  assert.deepEqual(cleared.affectedSessionIds, [], "clearing the remaining unlinked saved row does not affect the session");
  sessionDetail = await sessionService.getSession(OWNER, session.id);
  assert.deepEqual(
    sessionDetail.tracks.map((item) => item.track.id),
    [trackA.id, trackB.id],
    "clearing the saved queue keeps only session-only entries",
  );
  assert.equal(sessionDetail.currentSessionTrackId, null, "clearing later unlinked queue rows keeps the valid empty current pointer");
  assert.equal(sessionDetail.positionSeconds, 0, "clearing later unlinked queue rows keeps the reset position");
  assert.equal((await service.listQueue(OTHER)).length, 1, "clearing one owner never touches another");

  const savedForSession = await service.addToQueue({ ownerId: OWNER, trackId: trackA.id });
  const linkedDetail = await sessionService.addTrackToSession({
    ownerId: OWNER,
    sessionId: session.id,
    trackId: trackA.id,
    queueItemId: savedForSession.addedQueueItemId,
  });
  await sessionService.removeSessionTrack(OWNER, session.id, linkedDetail.tracks.at(-1)!.id);
  assert.equal((await service.listQueue(OWNER)).length, 0, "removing a linked session entry also removes its saved queue row");

  const unrelatedSaved = await service.addToQueue({ ownerId: OWNER, trackId: trackB.id });
  const withDirectAddition = await sessionService.addTrackToSession({ ownerId: OWNER, sessionId: session.id, trackId: trackB.id });
  await sessionService.removeSessionTrack(OWNER, session.id, withDirectAddition.tracks.at(-1)!.id);
  assert.deepEqual(
    (await service.listQueue(OWNER)).map((item) => item.id),
    [unrelatedSaved.addedQueueItemId],
    "removing a session-only duplicate leaves an unlinked saved queue entry untouched",
  );
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

test("playlist add rolls back the inserted entry when resequencing fails", async () => {
  const playlist = await service.createPlaylist(OWNER, "Atomic add");
  await service.addTrackToPlaylist({ ownerId: OWNER, playlistId: playlist.id, trackId: trackA.id });
  await client!.query(`
    CREATE FUNCTION fail_playlist_resequence() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'synthetic playlist resequence failure';
    END;
    $$ LANGUAGE plpgsql
  `);
  await client!.query(`
    CREATE TRIGGER fail_playlist_resequence_trigger
    BEFORE UPDATE ON wy_playlist_items
    FOR EACH ROW EXECUTE FUNCTION fail_playlist_resequence()
  `);
  try {
    await assert.rejects(
      () => service.addTrackToPlaylist({ ownerId: OWNER, playlistId: playlist.id, trackId: trackB.id }),
      (error) => {
        const wrapped = error as Error & { cause?: unknown };
        assert.match(String(wrapped.cause), /synthetic playlist resequence failure/);
        return true;
      },
    );
  } finally {
    await client!.query("DROP TRIGGER IF EXISTS fail_playlist_resequence_trigger ON wy_playlist_items");
    await client!.query("DROP FUNCTION IF EXISTS fail_playlist_resequence()");
  }
  const detail = await service.getPlaylist(OWNER, playlist.id);
  assert.deepEqual(
    detail.items.map((item) => item.track.id),
    [trackA.id],
    "a failed atomic add must not leave a second track entry behind",
  );
  await service.deletePlaylist(OWNER, playlist.id);
});

test("real stems change availability and what the player loads", async () => {
  const sourceId = sourceIdByTrackId.get(trackA.id)!;
  const stemIds: string[] = [];
  for (const stemType of ["vocals", "drums", "bass", "other"]) {
    const storageKey = `test/${stemType}.wav`;
    await getStorage().putFile(storageKey, path.join(root!, "aphex.wav"), "audio/wav");
    const [stem] = await db.db.insert(schema.stemAssets).values({
      projectId: trackA.studioProjectId,
      sourceAssetId: sourceId,
      separationJobId: (await db.db.select().from(schema.processingJobs).where(eq(schema.processingJobs.sourceAssetId, sourceId)).limit(1))[0].id,
      stemType,
      engine: "demucs",
      model: "htdemucs",
      modelVersion: "test",
      storageKey,
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
  assert.deepEqual(
    detail!.stemAvailability.status === "separated" ? detail!.stemAvailability.stemTypes : [],
    ["bass", "drums", "other", "vocals"],
  );
  assert.equal(detail!.playback.kind, "stems");
  assert.deepEqual(detail!.playback.assetIds, stemIds);
  const listed = await service.listTracks({ ownerId: OWNER });
  const listedTrack = listed.find((track) => track.id === trackA.id);
  assert.equal(listedTrack?.stemAvailability.status, "separated");
  assert.deepEqual(
    listedTrack?.stemAvailability.status === "separated" ? listedTrack.stemAvailability.stemTypes : [],
    ["bass", "drums", "other", "vocals"],
  );
});

test("passthrough bridge = honest source-only playback", async () => {
  const sourceId = sourceIdByTrackId.get(trackB.id)!;
  const [job] = await db.db.select().from(schema.processingJobs).where(eq(schema.processingJobs.sourceAssetId, sourceId)).limit(1);
  await getStorage().putFile("test/passthrough.wav", path.join(root!, "aphex.wav"), "audio/wav");
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
  const [source] = await db.db.select().from(schema.sourceAssets)
    .where(eq(schema.sourceAssets.id, sourceId)).limit(1);
  assert.ok(source);
  await db.db.insert(schema.sourceAnalyses).values({
    projectId: trackA.studioProjectId,
    sourceAssetId: sourceId,
    status: "complete",
    stage: "complete",
    analysisEngine: "arena-js-dsp",
    analysisEngineVersion: DESKTOP_ANALYSIS_ENGINE_VERSION,
    sourceChecksumSha256: source.checksumSha256,
    idempotencyKey: `analysis-test:${sourceId}`,
    bpm: 128.5,
    musicalKey: "A minor",
    beatGrid: JSON.stringify([0, 468, 936, 1404, 1872, 2340]),
  });
  const detail = await service.getTrack(OWNER, trackA.id);
  assert.equal(detail!.analysis?.status, "complete");
  assert.equal(detail!.analysis?.bpm, 128.5);
  assert.equal(detail!.analysis?.musicalKey, "A minor");
  const listed = await service.listTracks({ ownerId: OWNER });
  const listedTrack = listed.find((track) => track.id === trackA.id);
  assert.equal(listedTrack?.analysis?.status, "complete");
  assert.equal(listedTrack?.analysis?.bpm, 128.5);
  assert.equal(listedTrack?.analysis?.musicalKey, "A minor");
  assert.equal(listed.find((track) => track.id === trackB.id)?.analysis, null);
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

test("session: playlist-only moves preserve linked slots, duplicate identity and playback", async (t) => {
  const created = await sessions.createSession(OWNER, "Playlist-only moves");
  const firstQueue = await service.addToQueue({ ownerId: OWNER, trackId: trackB.id });
  const secondQueue = await service.addToQueue({ ownerId: OWNER, trackId: trackA.id });
  t.after(async () => {
    await sessions.deleteSession(OWNER, created.id);
    await service.removeQueueItem(OWNER, firstQueue.addedQueueItemId);
    await service.removeQueueItem(OWNER, secondQueue.addedQueueItemId);
  });
  let detail = await sessions.addTrackToSession({ ownerId: OWNER, sessionId: created.id, trackId: trackA.id });
  detail = await sessions.addTrackToSession({ ownerId: OWNER, sessionId: created.id, trackId: trackB.id, queueItemId: firstQueue.addedQueueItemId });
  detail = await sessions.addTrackToSession({ ownerId: OWNER, sessionId: created.id, trackId: trackA.id });
  detail = await sessions.addTrackToSession({ ownerId: OWNER, sessionId: created.id, trackId: trackA.id, queueItemId: secondQueue.addedQueueItemId });
  detail = await sessions.addTrackToSession({ ownerId: OWNER, sessionId: created.id, trackId: trackB.id });
  const originalIds = detail.tracks.map((entry) => entry.id);
  const queueBefore = await service.listQueue(OWNER);
  await sessions.saveSessionState(OWNER, created.id, originalIds[0], 23.5);

  // Move the second occurrence of A above the first across a linked slot.
  detail = await sessions.moveSessionTrack(OWNER, created.id, originalIds[2], 0, true);
  assert.deepEqual(detail.tracks.map((entry) => entry.id), [originalIds[2], originalIds[1], originalIds[0], originalIds[3], originalIds[4]]);
  assert.deepEqual(detail.tracks.map((entry) => entry.position), [0, 1, 2, 3, 4]);
  assert.equal(detail.currentSessionTrackId, originalIds[0], "duplicate entries are identified by session row, not song");
  assert.equal(detail.positionSeconds, 23.5);
  assert.deepEqual(await service.listQueue(OWNER), queueBefore, "session-only moves never write saved queue rows");

  detail = await sessions.moveSessionTrack(OWNER, created.id, originalIds[2], 2, true);
  assert.deepEqual(detail.tracks.map((entry) => entry.id), originalIds, "moving down restores the exact duplicate order");
  detail = await sessions.moveSessionTrack(OWNER, created.id, originalIds[4], 0, true);
  assert.deepEqual(detail.tracks.map((entry) => entry.id), [originalIds[4], originalIds[1], originalIds[0], originalIds[3], originalIds[2]]);
  assert.equal(detail.currentSessionTrackId, originalIds[0], "moving another song leaves playback selected");
  assert.equal(detail.positionSeconds, 23.5);
  assert.deepEqual(await service.listQueue(OWNER), queueBefore);
  assert.deepEqual((await sessions.getSession(OWNER, created.id))?.tracks.map((entry) => entry.id), detail.tracks.map((entry) => entry.id), "order survives reloading");
  await assert.rejects(sessions.moveSessionTrack(OTHER, created.id, originalIds[4], 0, true), sessions.SessionNotFoundError);
  await assert.rejects(sessions.moveSessionTrack(OWNER, created.id, originalIds[1], 0, true), sessions.SessionTrackNotFoundError);
  await assert.rejects(sessions.moveSessionTrack(OWNER, created.id, randomUUID(), 0, true), sessions.SessionTrackNotFoundError);
});

test("session ordering concurrency: all ordering writers share a transactional lock", async (t) => {
  // The barrier holds the production advisory lock on a separate PostgreSQL
  // connection. Wait for actual database lock contention, not arbitrary sleeps,
  // so a writer that still reads/writes outside the protocol fails this test.
  async function blockedPair<A, B>(owner: string, first: () => Promise<A>, second: () => Promise<B>) {
    const blocker = await pool.connect();
    const pending: Promise<PromiseSettledResult<unknown>>[] = [];
    const start = (work: () => Promise<unknown>) => {
      pending.push(work().then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason) => ({ status: "rejected" as const, reason }),
      ));
    };
    async function waitForWaiters(count: number) {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const result = await blocker.query(
          "select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event = 'advisory'",
        );
        if (result.rows[0].n >= count) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.fail(`Expected ${count} ordering writers waiting on the real database lock`);
    }
    try {
      await blocker.query("begin");
      await blocker.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`waveyard-order:${owner}`]);
      start(first);
      await waitForWaiters(1);
      start(second);
      await waitForWaiters(2);
      await blocker.query("commit");
      return await Promise.all(pending);
    } finally {
      await blocker.query("rollback");
      blocker.release();
      await Promise.all(pending);
    }
  }

  async function fixture(owner = randomUUID()) {
    const filePath = path.join(root!, `ordering-${owner}.wav`);
    writeWav(filePath, 0.1);
    const { track } = await service.addTrackFromAudioFile({
      ownerId: owner, filePath, filename: "Ordering test.wav", mimeType: "audio/wav",
      enqueue: async () => {},
    });
    const created = await sessions.createSession(owner, "Concurrent ordering");
    const q1 = await service.addToQueue({ ownerId: owner, trackId: track.id });
    const q2 = await service.addToQueue({ ownerId: owner, trackId: track.id });
    let detail = await sessions.getSession(owner, created.id);
    for (const queueItemId of [undefined, q1.addedQueueItemId, undefined, q2.addedQueueItemId, undefined]) {
      detail = await sessions.addTrackToSession({ ownerId: owner, sessionId: created.id, trackId: track.id, queueItemId });
    }
    const ids = detail.tracks.map((item) => item.id);
    await sessions.saveSessionState(owner, created.id, ids[0], 0.04);
    return {
      owner, sessionId: created.id, ids, trackId: track.id,
      queueIds: (await service.listQueue(owner)).map((item) => item.id),
    };
  }

  const cases = [
    ["playlist then general", "playlist", "general", [4, 2, 1, 0, 3]],
    ["general then playlist", "general", "playlist", [4, 0, 1, 3, 2]],
    ["playlist then queue", "playlist", "queue", [4, 3, 0, 1, 2]],
    ["queue then playlist", "queue", "playlist", [4, 3, 0, 1, 2]],
    ["general then queue", "general", "queue", [0, 2, 3, 1, 4]],
    ["queue then general", "queue", "general", [0, 2, 3, 1, 4]],
  ] as const;
  for (const [name, first, second, expected] of cases) {
    await t.test(name, async () => {
      const f = await fixture();
      const move = (kind: "playlist" | "general" | "queue") => kind === "queue"
        ? service.moveQueueItem(f.owner, f.queueIds[1], 0, f.sessionId)
        : sessions.moveSessionTrack(f.owner, f.sessionId, f.ids[kind === "playlist" ? 4 : 2], kind === "playlist" ? 0 : 1, kind === "playlist");
      const results = await blockedPair(f.owner, () => move(first), () => move(second));
      assert.deepEqual(results.map((result) => result.status), ["fulfilled", "fulfilled"]);
      const fresh = await sessions.getSession(f.owner, f.sessionId);
      assert.deepEqual(fresh.tracks.map((item) => item.id), expected.map((index) => f.ids[index]));
      assert.deepEqual(fresh.tracks.map((item) => item.position), [0, 1, 2, 3, 4]);
      assert.equal(fresh.currentSessionTrackId, f.ids[0]);
      assert.equal(fresh.positionSeconds, 0.04);
      assert.deepEqual((await service.listQueue(f.owner)).map((item) => item.id),
        first === "queue" || second === "queue" ? [...f.queueIds].reverse() : f.queueIds);
    });
  }

  await t.test("stale playlist/general edits conflict, leave the winner intact, and can retry", async () => {
    for (const firstOnly of [true, false]) {
      const f = await fixture();
      const results = await blockedPair(f.owner,
        () => sessions.moveSessionTrack(f.owner, f.sessionId, f.ids[4], 0, firstOnly, f.ids),
        () => sessions.moveSessionTrack(f.owner, f.sessionId, f.ids[2], 1, !firstOnly, f.ids),
      );
      assert.equal(results[0].status, "fulfilled");
      assert.equal(results[1].status, "rejected");
      if (results[1].status === "rejected") assert.ok(results[1].reason instanceof sessions.OrderingConflictError);
      const fresh = await sessions.getSession(f.owner, f.sessionId);
      assert.deepEqual(fresh.tracks.map((item) => item.id),
        (firstOnly ? [4, 1, 0, 3, 2] : [4, 0, 1, 2, 3]).map((index) => f.ids[index]));
      const retried = await sessions.moveSessionTrack(f.owner, f.sessionId, f.ids[2], 1, !firstOnly, fresh.tracks.map((item) => item.id));
      assert.equal(retried.tracks.length, 5);
    }
  });

  await t.test("stale queue edit rolls back linked-session writes and retries from fresh state", async () => {
    const f = await fixture();
    const results = await blockedPair(f.owner,
      () => service.moveQueueItem(f.owner, f.queueIds[1], 0, f.sessionId, f.queueIds),
      () => service.moveQueueItem(f.owner, f.queueIds[0], 0, f.sessionId, f.queueIds),
    );
    assert.equal(results[0].status, "fulfilled");
    assert.equal(results[1].status, "rejected");
    if (results[1].status === "rejected") assert.ok(results[1].reason instanceof service.OrderingConflictError);
    const fresh = await sessions.getSession(f.owner, f.sessionId);
    assert.deepEqual(fresh.tracks.map((item) => item.id), [0, 3, 2, 1, 4].map((index) => f.ids[index]));
    const queue = await service.listQueue(f.owner);
    await service.moveQueueItem(f.owner, f.queueIds[0], 0, f.sessionId, queue.map((item) => item.id));
    assert.deepEqual((await sessions.getSession(f.owner, f.sessionId)).tracks.map((item) => item.id), f.ids);
    await assert.rejects(service.moveQueueItem(f.owner, f.queueIds[1], 0, randomUUID()), service.QueueSessionNotFoundError);
    assert.deepEqual((await service.listQueue(f.owner)).map((item) => item.id), f.queueIds, "failed session validation rolls back queue positions too");
  });

  await t.test("membership and empty-list writers participate in the same lock", async () => {
    const f = await fixture();
    let results = await blockedPair(f.owner,
      () => sessions.moveSessionTrack(f.owner, f.sessionId, f.ids[4], 0, true),
      () => sessions.addTrackToSession({ ownerId: f.owner, sessionId: f.sessionId, trackId: f.trackId }),
    );
    assert.deepEqual(results.map((result) => result.status), ["fulfilled", "fulfilled"]);
    let fresh = await sessions.getSession(f.owner, f.sessionId);
    assert.deepEqual(fresh.tracks.slice(0, 5).map((item) => item.id), [4, 1, 0, 3, 2].map((index) => f.ids[index]));
    results = await blockedPair(f.owner,
      () => service.removeQueueItem(f.owner, f.queueIds[0]),
      () => sessions.moveSessionTrack(f.owner, f.sessionId, f.ids[2], 0, true),
    );
    assert.deepEqual(results.map((result) => result.status), ["fulfilled", "fulfilled"]);
    fresh = await sessions.getSession(f.owner, f.sessionId);
    assert.deepEqual(fresh.tracks.map((item) => item.position), [0, 1, 2, 3, 4]);
    assert.equal(fresh.tracks[2].id, f.ids[3], "surviving linked slot stays fixed after deletion compacts the list");
    results = await blockedPair(f.owner,
      () => sessions.removeSessionTrack(f.owner, f.sessionId, f.ids[4]),
      () => service.moveQueueItem(f.owner, f.queueIds[1], 0, f.sessionId),
    );
    assert.deepEqual(results.map((result) => result.status), ["fulfilled", "fulfilled"]);
    await service.clearQueue(f.owner);
    results = await blockedPair(f.owner,
      () => service.addToQueue({ ownerId: f.owner, trackId: f.trackId }),
      () => service.addToQueue({ ownerId: f.owner, trackId: f.trackId }),
    );
    assert.deepEqual(results.map((result) => result.status), ["fulfilled", "fulfilled"]);
    assert.deepEqual((await service.listQueue(f.owner)).map((item) => item.position), [0, 1]);
    const raw = await pool.query("select position from wy_queue_items where owner_id = $1 order by position", [f.owner]);
    assert.deepEqual(raw.rows.map((row) => row.position), [0, 1], "check stored positions, not the payload's normalized indices");
  });

  await t.test("real reorder routes return 409 with fresh ordering and accept an explicit retry", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";
    try {
      const { LOCAL_OWNER_ID } = await import("../local-context");
      const sessionRoute = await import("../../../../../../artifacts/api-server/src/imported/library/sessions/[id]/tracks/route");
      const queueRoute = await import("../../../../../../artifacts/api-server/src/imported/library/queue/[id]/route");
      const f = await fixture(LOCAL_OWNER_ID);
      const sessionRequest = (expectedOrder: string[]) => new Request(`http://localhost/api/library/sessions/${f.sessionId}/tracks`, {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionTrackId: f.ids[2], position: 0, sessionOnly: true, expectedOrder }),
      });
      const context = { params: Promise.resolve({ id: f.sessionId }) };
      await sessions.moveSessionTrack(f.owner, f.sessionId, f.ids[4], 0, true);
      const conflict = await sessionRoute.PATCH(sessionRequest(f.ids), context);
      assert.equal(conflict.status, 409);
      const body = await conflict.json();
      assert.match(body.error, /another tab.*Try your move again/);
      const freshIds = body.session.tracks.map((item: { id: string }) => item.id);
      assert.deepEqual(freshIds, [4, 1, 0, 3, 2].map((index) => f.ids[index]));
      assert.equal(body.session.currentSessionTrackId, f.ids[0]);
      const retried = await sessionRoute.PATCH(sessionRequest(freshIds), context);
      assert.equal(retried.status, 200);

      const queueRequest = (expectedOrder: string[]) => new Request(`http://localhost/api/library/queue/${f.queueIds[0]}`, {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ position: 0, sessionId: f.sessionId, expectedOrder }),
      });
      const queueContext = { params: Promise.resolve({ id: f.queueIds[0] }) };
      await service.moveQueueItem(f.owner, f.queueIds[1], 0, f.sessionId);
      const queueConflict = await queueRoute.PATCH(queueRequest(f.queueIds), queueContext);
      assert.equal(queueConflict.status, 409);
      const queueBody = await queueConflict.json();
      assert.match(queueBody.error, /another tab.*Try your move again/);
      assert.deepEqual(queueBody.queue.map((item: { id: string }) => item.id), [...f.queueIds].reverse());
      const queueRetried = await queueRoute.PATCH(queueRequest(queueBody.queue.map((item: { id: string }) => item.id)), queueContext);
      assert.equal(queueRetried.status, 200);
      const invalid = await sessionRoute.PATCH(sessionRequest(["not-an-entry-id"]), context);
      assert.equal(invalid.status, 400);
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }
  });
});

test("session: per-track stem mix and transition persist and round-trip", async () => {
  const created = await sessions.createSession(OWNER, "Mix lab");
  const detail = await sessions.addTrackToSession({ ownerId: OWNER, sessionId: created.id, trackId: trackA.id });
  const performance = {
    snap: "beat",
    instantRestore: true,
    recall: { vocals: 0.64 },
    isolatedStem: null,
    beforeIsolation: null,
  };

  const updated = await sessions.updateSessionTrack(OWNER, created.id, detail.tracks[0].id, {
    stemMix: { vocals: 0, drums: 1.4, bass: 0.8 },
    transition: { mode: "bar", crossfadeSeconds: 8, keepStems: ["drums"], performance },
    playbackPreference: "source",
  });
  assert.deepEqual(updated.tracks[0].stemMix, { vocals: 0, drums: 1.4, bass: 0.8 });
  assert.deepEqual(updated.tracks[0].transition, { mode: "bar", crossfadeSeconds: 8, keepStems: ["drums"], performance });
  assert.equal(updated.tracks[0].playbackPreference, "source");
  assert.equal(updated.tracks[0].playback?.kind, "source");

  const reread = await sessions.getSession(OWNER, created.id);
  assert.deepEqual(reread.tracks[0].stemMix, { vocals: 0, drums: 1.4, bass: 0.8 }, "mix survives a fresh read");
  assert.deepEqual(reread.tracks[0].transition, { mode: "bar", crossfadeSeconds: 8, keepStems: ["drums"], performance });
  assert.equal(reread.tracks[0].playbackPreference, "source", "playback choice survives a fresh session read");

  const selectedStems = await sessions.updateSessionTrack(OWNER, created.id, detail.tracks[0].id, {
    playbackPreference: "stems",
  });
  assert.equal(selectedStems.tracks[0].playbackPreference, "stems");
  assert.equal(selectedStems.tracks[0].playback?.kind, "stems");
  assert.deepEqual(
    selectedStems.tracks[0].playback?.assetIds,
    detail.tracks[0].stems.map((stem) => stem.id),
    "a saved stems choice resolves to the real available stem assets",
  );
  const reopened = await sessions.getSession(OWNER, created.id);
  assert.equal(reopened.tracks[0].playbackPreference, "stems");
  assert.equal(reopened.tracks[0].playback?.kind, "stems", "fresh session reads restore the selected playback mode");
  const withDuplicate = await sessions.addTrackToSession({ ownerId: OWNER, sessionId: created.id, trackId: trackA.id });
  const upcomingId = withDuplicate.tracks[1].id;
  await sessions.updateSessionTrack(OWNER, created.id, upcomingId, { playbackPreference: "source" });
  const prepared = await sessions.getSession(OWNER, created.id);
  assert.equal(prepared.tracks[0].playbackPreference, "stems", "preparing a duplicate song must not change the other session entry");
  assert.equal(prepared.tracks[1].playbackPreference, "source", "upcoming entries can be prepared before loading a deck");
  assert.equal(prepared.currentSessionTrackId, reopened.currentSessionTrackId, "preparation must not move the session play pointer");
  assert.equal(prepared.positionSeconds, reopened.positionSeconds, "preparation must not seek the session");
  await assert.rejects(
    () => sessions.updateSessionTrack(OWNER, created.id, detail.tracks[0].id, { playbackPreference: "invalid" }),
    /playback preference is invalid/i,
    "invalid playback preferences are refused",
  );

  await assert.rejects(
    () => sessions.updateSessionTrack(OWNER, created.id, detail.tracks[0].id, { transition: { mode: "warp", crossfadeSeconds: 1 } }),
    /invalid/i,
    "invalid transition configs are refused",
  );
  await assert.rejects(
    () => sessions.updateSessionTrack(OWNER, created.id, detail.tracks[0].id, {
      transition: {
        mode: "manual",
        crossfadeSeconds: 4,
        performance: { ...performance, recall: { vocals: 4 } },
      },
    }),
    /invalid/i,
    "invalid performance recall is refused",
  );
  await sessions.deleteSession(OWNER, created.id);
});

test("session: concurrent per-stem patches from separate tabs preserve both edits", async () => {
  const created = await sessions.createSession(OWNER, "Parallel stem mix edits");
  const detail = await sessions.addTrackToSession({ ownerId: OWNER, sessionId: created.id, trackId: trackA.id });
  const sessionTrackId = detail.tracks[0].id;

  await Promise.all([
    sessions.updateSessionTrack(OWNER, created.id, sessionTrackId, {
      stemMixPatch: { vocals: 0.37 },
    }),
    sessions.updateSessionTrack(OWNER, created.id, sessionTrackId, {
      stemMixPatch: { drums: 0 },
    }),
  ]);

  const reread = await sessions.getSession(OWNER, created.id);
  assert.deepEqual(
    reread.tracks[0].stemMix,
    { vocals: 0.37, drums: 0 },
    "a concurrent mute patch does not discard the other tab's fader update",
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

test("session: key mode and track shifts survive reload but stale identities are cleared", async () => {
  const created = await sessions.createSession(OWNER, "Saved key match");
  await sessions.addTrackToSession({ ownerId: OWNER, sessionId: created.id, trackId: trackA.id });
  const withB = await sessions.addTrackToSession({ ownerId: OWNER, sessionId: created.id, trackId: trackB.id });
  const [entryA, entryB] = withB.tracks;

  const saved = await sessions.saveSessionState(OWNER, created.id, entryA.id, 73.5, {
    mode: "match",
    shifts: {
      [entryA.id]: { trackId: trackA.id, semitones: 0 },
      [entryB.id]: { trackId: trackB.id, semitones: -3 },
      ["33333333-3333-4333-8333-333333333333"]: { trackId: trackB.id, semitones: 6 },
    },
  });
  assert.equal(saved.keyMatchMode, "match");
  assert.deepEqual(saved.keyShifts, {
    [entryA.id]: { trackId: trackA.id, semitones: 0 },
    [entryB.id]: { trackId: trackB.id, semitones: -3 },
  }, "foreign session-entry shifts cannot be saved");
  assert.equal(saved.currentSessionTrackId, entryA.id);
  assert.equal(saved.positionSeconds, 73.5);

  const reloaded = await sessions.getSession(OWNER, created.id);
  assert.equal(reloaded.keyMatchMode, "match");
  assert.deepEqual(reloaded.keyShifts, saved.keyShifts);
  assert.equal(reloaded.currentSessionTrackId, entryA.id, "saving key settings never changes the current entry");
  assert.equal(reloaded.positionSeconds, 73.5, "saving key settings never seeks the playhead");

  // Simulate a session entry being rebound to another library track. Its old
  // correction must not return if the entry is later loaded or saved again.
  await db.db.update(schema.listenSessionTracks)
    .set({ trackId: trackA.id })
    .where(eq(schema.listenSessionTracks.id, entryB.id));
  const replaced = await sessions.getSession(OWNER, created.id);
  assert.deepEqual(replaced.keyShifts, {
    [entryA.id]: { trackId: trackA.id, semitones: 0 },
  }, "the shift for a replaced source identity is dropped");
  const [persistedSession] = await db.db.select().from(schema.listenSessions)
    .where(eq(schema.listenSessions.id, created.id)).limit(1);
  assert.equal(persistedSession.keyShifts, JSON.stringify(replaced.keyShifts),
    "stale shift data is physically pruned from the saved session");

  const removed = await sessions.removeSessionTrack(OWNER, created.id, entryA.id);
  assert.deepEqual(removed.keyShifts, {}, "removing a session entry clears its shift");
  assert.equal(removed.currentSessionTrackId, null);
  assert.equal(removed.positionSeconds, 0);
  await sessions.deleteSession(OWNER, created.id);
});

test("session: a missing original can be restored without changing stems or session state", async () => {
  const sourceId = sourceIdByTrackId.get(trackA.id)!;
  const [originalSource] = await db.db.select().from(schema.sourceAssets)
    .where(eq(schema.sourceAssets.id, sourceId)).limit(1);
  const [originalTrack] = await db.db.select().from(schema.tracks)
    .where(eq(schema.tracks.id, trackA.id)).limit(1);
  const [originalAcquisition] = await db.db.select().from(schema.sourceAcquisitions)
    .where(eq(schema.sourceAcquisitions.sourceAssetId, sourceId)).limit(1);
  const [originalAnalysis] = await db.db.select().from(schema.sourceAnalyses)
    .where(eq(schema.sourceAnalyses.sourceAssetId, sourceId)).limit(1);
  assert.ok(originalSource && originalTrack && originalAcquisition && originalAnalysis);
  assert.equal(originalAnalysis.sourceChecksumSha256, originalSource.checksumSha256);
  const originalStems = await db.db.select().from(schema.stemAssets)
    .where(eq(schema.stemAssets.sourceAssetId, sourceId));
  assert.ok(originalStems.length > 0);
  const originalStemIds = originalStems.map((stem) => stem.id).sort();
  const created = await sessions.createSession(OWNER, "Restore original");
  const withTrack = await sessions.addTrackToSession({ ownerId: OWNER, sessionId: created.id, trackId: trackA.id });
  const sessionTrackId = withTrack.tracks[0].id;
  const selected = await sessions.updateSessionTrack(OWNER, created.id, sessionTrackId, {
    playbackPreference: "stems",
    stemMix: { vocals: 0.42, drums: 0.78 },
    transition: { mode: "bar", crossfadeSeconds: 6, keepStems: ["vocals"] },
  });
  await sessions.saveSessionState(OWNER, created.id, sessionTrackId, 37.5);
  const oldWaveformKey = `test/restore-waveform-${randomUUID()}.json`;
  const [oldWaveformJob] = await db.db.insert(schema.waveformJobs).values({
    projectId: originalSource.projectId,
    sourceAssetId: sourceId,
    status: "complete",
    stage: "complete",
    idempotencyKey: `waveform:restore-existing:${sourceId}`,
  }).returning();
  await getStorage().putBuffer(oldWaveformKey, JSON.stringify({ old: true }));
  await db.db.insert(schema.waveformAssets).values({
    projectId: originalSource.projectId,
    sourceAssetId: sourceId,
    waveformJobId: oldWaveformJob.id,
    storageKey: oldWaveformKey,
    checksumSha256: "old-waveform-checksum",
    metadata: JSON.stringify({ format: "waveyard-peaks-v1" }),
  });
  const replacementPath = path.join(root!, "replacement-original.wav");
  writeWav(replacementPath, 2, 880);
  try {
    await getStorage().delete(originalSource.storageKey);
    const missing = await sessions.getSession(OWNER, created.id);
    assert.equal(missing.tracks[0].sourceAssetId, null, "a missing private file is not presented as an available original");
    assert.equal(missing.tracks[0].playback?.kind, "stems");
    assert.deepEqual(missing.tracks[0].stems.map(({ id }) => id).sort(), originalStemIds);

    const restored = await sessions.restoreSessionTrackOriginalAudio(OWNER, created.id, sessionTrackId, {
      filePath: replacementPath,
      filename: "Authorized replacement.wav",
      mimeType: "audio/wav",
    });
    const entry = restored.tracks[0];
    assert.equal(entry.sourceAssetId, sourceId, "the track keeps its original source identity");
    assert.deepEqual(entry.stems.map(({ id }) => id).sort(), originalStemIds, "the separated stems remain attached");
    assert.equal(entry.playback?.kind, "stems", "restoring a source does not change the chosen session playback mode");
    assert.deepEqual(entry.stemMix, selected.tracks[0].stemMix);
    assert.deepEqual(entry.transition, selected.tracks[0].transition);
    assert.equal(restored.currentSessionTrackId, sessionTrackId);
    assert.equal(restored.positionSeconds, 37.5, "the session cue survives the original restore");
    const [updatedSource] = await db.db.select().from(schema.sourceAssets)
      .where(eq(schema.sourceAssets.id, sourceId)).limit(1);
    assert.equal(await getStorage().exists(updatedSource.storageKey), true);
    assert.notEqual(updatedSource.checksumSha256, originalSource.checksumSha256);
    const [updatedAnalysis] = await db.db.select().from(schema.sourceAnalyses)
      .where(eq(schema.sourceAnalyses.sourceAssetId, sourceId)).limit(1);
    assert.equal(updatedAnalysis.sourceChecksumSha256, updatedSource.checksumSha256);
    assert.ok(["queued", "preparing", "processing", "complete", "failed"].includes(updatedAnalysis.status));
    if (updatedAnalysis.status !== "complete") {
      assert.equal(updatedAnalysis.bpm, null);
      assert.equal(updatedAnalysis.musicalKey, null);
      assert.equal(updatedAnalysis.beatGrid, null);
    }
    assert.deepEqual(await sessions.sessionTrackAnalysis(OWNER, trackA.id), {
      bpm: null,
      bpmConfidence: null,
      beatConfidence: null,
      downbeatConfidence: null,
      keyConfidence: null,
      musicalKey: null,
      beatGridMs: null,
      downbeatGridMs: null,
      sections: null,
      vocalActivityStartsMs: null,
      voicedPhraseStartsMs: null,
    });
    const updatedTrack = await service.getTrack(OWNER, trackA.id);
    assert.equal(updatedTrack?.analysis?.bpm, null);
    assert.equal(updatedTrack?.analysis?.musicalKey, null);
    const oldWaveformAssets = await db.db.select().from(schema.waveformAssets)
      .where(eq(schema.waveformAssets.sourceAssetId, sourceId));
    assert.equal(oldWaveformAssets.some((asset) => asset.storageKey === oldWaveformKey), false);
    assert.equal(await getStorage().exists(oldWaveformKey), false);
    const sourceWaveformJobs = await db.db.select().from(schema.waveformJobs)
      .where(eq(schema.waveformJobs.sourceAssetId, sourceId));
    assert.ok(sourceWaveformJobs.some((job) =>
      job.idempotencyKey.startsWith(`waveform:source:${sourceId}:restore:${updatedSource.checksumSha256}:`),
    ), "replacement bytes receive a distinct waveform job without creating new stems");
  } finally {
    await sessions.deleteSession(OWNER, created.id);
    const [updatedSource] = await db.db.select().from(schema.sourceAssets)
      .where(eq(schema.sourceAssets.id, sourceId)).limit(1);
    await getStorage().delete(updatedSource.storageKey);
    await getStorage().putFile(originalSource.storageKey, path.join(root!, "aphex.wav"), "audio/wav");
    await db.db.update(schema.sourceAssets).set({
      originalFilename: originalSource.originalFilename,
      mimeType: originalSource.mimeType,
      storageKey: originalSource.storageKey,
      checksumSha256: originalSource.checksumSha256,
      durationSeconds: originalSource.durationSeconds,
      sampleRate: originalSource.sampleRate,
      channels: originalSource.channels,
      codec: originalSource.codec,
      bitrate: originalSource.bitrate,
      fileSizeBytes: originalSource.fileSizeBytes,
    }).where(eq(schema.sourceAssets.id, sourceId));
    await db.db.update(schema.tracks).set({
      sourceChecksumSha256: originalTrack.sourceChecksumSha256,
    }).where(eq(schema.tracks.id, trackA.id));
    await db.db.update(schema.sourceAcquisitions).set({
      method: originalAcquisition.method,
      sourceUrl: originalAcquisition.sourceUrl,
      title: originalAcquisition.title,
      artist: originalAcquisition.artist,
      resolver: originalAcquisition.resolver,
      metadata: originalAcquisition.metadata,
    }).where(eq(schema.sourceAcquisitions.id, originalAcquisition.id));
    await db.db.update(schema.sourceAnalyses).set({
      status: originalAnalysis.status,
      stage: originalAnalysis.stage,
      attempts: originalAnalysis.attempts,
      idempotencyKey: originalAnalysis.idempotencyKey,
      analysisEngine: originalAnalysis.analysisEngine,
      analysisEngineVersion: originalAnalysis.analysisEngineVersion,
      sourceChecksumSha256: originalAnalysis.sourceChecksumSha256,
      bpm: originalAnalysis.bpm,
      bpmConfidence: originalAnalysis.bpmConfidence,
      musicalKey: originalAnalysis.musicalKey,
      keyConfidence: originalAnalysis.keyConfidence,
      beatGrid: originalAnalysis.beatGrid,
      beatConfidence: originalAnalysis.beatConfidence,
      analysisError: originalAnalysis.analysisError,
      errorCode: originalAnalysis.errorCode,
      startedAt: originalAnalysis.startedAt,
      analyzedAt: originalAnalysis.analyzedAt,
      completedAt: originalAnalysis.completedAt,
      updatedAt: originalAnalysis.updatedAt,
    }).where(eq(schema.sourceAnalyses.id, originalAnalysis.id));
    await getStorage().delete(oldWaveformKey).catch(() => undefined);
    await db.db.delete(schema.waveformJobs).where(eq(schema.waveformJobs.id, oldWaveformJob.id));
    const restoredWaveformJobs = await db.db.select().from(schema.waveformJobs)
      .where(eq(schema.waveformJobs.sourceAssetId, sourceId));
    for (const job of restoredWaveformJobs.filter((row) => row.idempotencyKey.startsWith(`waveform:source:${sourceId}:restore:`))) {
      const assets = await db.db.select().from(schema.waveformAssets)
        .where(eq(schema.waveformAssets.waveformJobId, job.id));
      for (const asset of assets) await getStorage().delete(asset.storageKey).catch(() => undefined);
      await db.db.delete(schema.waveformJobs).where(eq(schema.waveformJobs.id, job.id));
    }
  }
});

test("session stem swaps: distinct donors round-trip into Studio; impossible swaps refused honestly", async () => {
  // Give track B two real stem types so both can be replaced independently.
  const sourceB = sourceIdByTrackId.get(trackB.id)!;
  const [jobB] = await db.db.select().from(schema.processingJobs).where(eq(schema.processingJobs.sourceAssetId, sourceB)).limit(1);
  for (const stemType of ["drums", "vocals"]) {
    const storageKey = `test/b-${stemType}.wav`;
    await getStorage().putFile(storageKey, path.join(root!, "aphex.wav"), "audio/wav");
    await db.db.insert(schema.stemAssets).values({
      projectId: trackB.studioProjectId,
      sourceAssetId: sourceB,
      separationJobId: jobB.id,
      stemType,
      engine: "demucs",
      model: "htdemucs",
      modelVersion: "test",
      storageKey,
      checksumSha256: `checksum-b-${stemType}`,
      durationSeconds: 3,
      sampleRate: 44100,
      channels: 1,
      codec: "wav",
      format: "wav",
      fileSizeBytes: 100,
    });
  }

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
  const swap = swapped.swaps[0];
  assert.deepEqual(
    {
      id: swap.id,
      sessionTrackId: swap.sessionTrackId,
      stemType: swap.stemType,
      fromTrackId: swap.fromTrackId,
      toTrackId: swap.toTrackId,
      atSeconds: swap.atSeconds,
    },
    { id: swap.id, sessionTrackId: sessionTrackB, stemType: "drums", fromTrackId: trackB.id, toTrackId: trackA.id, atSeconds: 12.5 },
    "provenance: source track, donor track, stem type, session context",
  );
  assert.equal(
    swap.fromStemAssetId,
    detail.tracks[0].stems.find((stem) => stem.stemType === "drums")?.id,
    "the original stem asset is pinned",
  );
  assert.equal(swap.donorTrack?.id, trackA.id, "restored swap includes the donor track");
  assert.ok(swap.donorTrack?.stems.some((stem) => stem.stemType === "drums"), "restored donor includes the real replacement stem");
  assert.equal(
    swap.toStemAssetId,
    swap.donorTrack?.stems.find((stem) => stem.stemType === "drums")?.id,
    "the exact donor stem asset is pinned",
  );
  const swappedWithVocals = await sessions.recordStemSwap({
    ownerId: OWNER,
    sessionId: created.id,
    sessionTrackId: sessionTrackB,
    stemType: "vocals",
    toTrackId: trackA.id,
    atSeconds: 16,
    donorEntryOffsetMs: 1_000,
  });
  assert.equal(swappedWithVocals.swaps.length, 2, "distinct stem swaps stay active together");
  const drumSwap = swappedWithVocals.swaps.find((entry) => entry.stemType === "drums");
  const vocalSwap = swappedWithVocals.swaps.find((entry) => entry.stemType === "vocals");
  assert.ok(drumSwap && vocalSwap);
  assert.equal(drumSwap.toTrackId, trackA.id);
  assert.equal(vocalSwap.toTrackId, trackA.id);
  assert.equal(vocalSwap.donorEntryOffsetMs, 1_000, "the chosen donor vocal entry survives the persisted session response");
  assert.notEqual(drumSwap.toStemAssetId, vocalSwap.toStemAssetId,
    "different stem types pin different assets even when they share a donor track");

  const swapHandoff = await sessions.sendSessionToStudio(OWNER, created.id, [sessionTrackB], [
    { sessionTrackId: sessionTrackB, stemMix: { drums: 0.37, vocals: 0.72 } },
  ]);
  assert.equal(swapHandoff.preservedSwapCount, 2, "both saved live swaps are reported as carried into Studio");
  const swappedStudioTracks = await db.db.select().from(schema.remixTracks)
    .where(eq(schema.remixTracks.remixSessionId, swapHandoff.remixSessionId));
  assert.equal(swappedStudioTracks.length, 2, "Studio contains both real stem lanes");
  for (const [stemType, donorSwap] of [["drums", drumSwap], ["vocals", vocalSwap]] as const) {
    const studioTrack = swappedStudioTracks.find((entry) => entry.stemAssetId === donorSwap.toStemAssetId);
    assert.ok(studioTrack, `Studio binds the exact ${stemType} donor audio asset`);
    assert.equal(studioTrack.volume, stemType === "drums" ? 0.37 : 0.72,
      `the latest ${stemType} fader value is carried into Studio`);
    assert.match(studioTrack.name, new RegExp(trackA.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      `the ${stemType} lane identifies the live-swap donor`);
  }

  // Refusal: B has no real "other" layer to replace.
  await assert.rejects(
    () => sessions.recordStemSwap({ ownerId: OWNER, sessionId: created.id, sessionTrackId: sessionTrackB, stemType: "other", toTrackId: trackA.id, atSeconds: 1 }),
    (error: Error) => error instanceof sessions.StemSwapRefusedError && /current track has no real/i.test(error.message),
  );
  await assert.rejects(
    () => sessions.recordStemSwap({
      ownerId: OWNER,
      sessionId: created.id,
      sessionTrackId: sessionTrackB,
      stemType: "drums",
      toTrackId: trackA.id,
      atSeconds: 1,
      donorEntryOffsetMs: 500,
    }),
    (error: Error) => error instanceof sessions.StemSwapRefusedError && /only be set for a vocal swap/i.test(error.message),
  );
  await assert.rejects(
    () => sessions.recordStemSwap({
      ownerId: OWNER,
      sessionId: created.id,
      sessionTrackId: sessionTrackB,
      stemType: "vocals",
      toTrackId: trackA.id,
      atSeconds: 1,
      donorEntryOffsetMs: Math.round(trackA.durationSeconds * 1000),
    }),
    (error: Error) => error instanceof sessions.StemSwapRefusedError && /outside the donor track/i.test(error.message),
  );
  const replaced = await sessions.recordStemSwap({
    ownerId: OWNER, sessionId: created.id, sessionTrackId: sessionTrackB,
    stemType: "drums", toTrackId: trackA.id, atSeconds: 18,
  });
  assert.equal(replaced.swaps.length, 2, "one active donor per stem after repeated live selections");
  assert.equal(replaced.swaps.find((entry) => entry.stemType === "drums")?.atSeconds, 18);
  const previousDrums = replaced.swaps.find((entry) => entry.stemType === "drums")!;
  const failedReplacement = await sessions.recordStemSwap({
    ownerId: OWNER, sessionId: created.id, sessionTrackId: sessionTrackB,
    stemType: "drums", toTrackId: trackB.id, atSeconds: 19,
  });
  const failedSwapId = failedReplacement.swaps.find((entry) => entry.stemType === "drums")!.id;
  const rollback = {
    ownerId: OWNER, sessionId: created.id, sessionTrackId: sessionTrackB,
    stemType: "drums", toTrackId: previousDrums.toTrackId,
    toStemAssetId: previousDrums.toStemAssetId, atSeconds: previousDrums.atSeconds,
    expectedSwapId: failedSwapId,
  };
  const recovered = await sessions.recordStemSwap(rollback);
  const recoveredDrums = recovered.swaps.find((entry) => entry.stemType === "drums")!;
  assert.equal(recoveredDrums.toTrackId, previousDrums.toTrackId, "restore the audible donor, not the original stem");
  assert.equal(recoveredDrums.toStemAssetId, previousDrums.toStemAssetId, "restore its exact saved audio asset");
  assert.equal(recoveredDrums.atSeconds, previousDrums.atSeconds);
  assert.deepEqual(recovered.swaps.find((entry) => entry.stemType === "vocals"),
    replaced.swaps.find((entry) => entry.stemType === "vocals"), "restoration leaves the other donor unchanged");
  const repeated = await sessions.recordStemSwap(rollback);
  assert.equal(repeated.swaps.find((entry) => entry.stemType === "drums")!.id, recoveredDrums.id,
    "repeating a recovery after a lost response is idempotent");
  const newSelection = await sessions.recordStemSwap({
    ownerId: OWNER, sessionId: created.id, sessionTrackId: sessionTrackB,
    stemType: "drums", toTrackId: trackB.id, atSeconds: 21,
  });
  const newerDrums = newSelection.swaps.find((entry) => entry.stemType === "drums")!;
  const staleRestore = await sessions.recordStemSwap(rollback);
  assert.equal(staleRestore.swaps.find((entry) => entry.stemType === "drums")!.id, newerDrums.id,
    "a late failed-B restore cannot overwrite a newer selection");
  const staleCancel = await sessions.removeStemSwap(OWNER, created.id, recoveredDrums.id);
  assert.equal(staleCancel.swaps.find((entry) => entry.stemType === "drums")!.id, newerDrums.id,
    "an old cancellation cannot delete a newer donor");
  await assert.rejects(() => sessions.recordStemSwap({ ...rollback, expectedSwapId: newerDrums.id, toStemAssetId: randomUUID() }),
    /exact audio/i, "an unavailable prior asset cannot silently resolve to different audio");
  const restored = await sessions.removeStemSwap(
    OWNER,
    created.id,
    newerDrums.id,
  );
  assert.deepEqual(restored.swaps.map((entry) => entry.stemType), ["vocals"],
    "removing one swap leaves the other stem's donor choice intact");
  await db.db.insert(schema.listenSessionSwaps).values({
    sessionId: created.id,
    sessionTrackId: sessionTrackB,
    stemType: "drums",
    fromTrackId: trackB.id,
    toTrackId: trackA.id,
    atSeconds: 20,
  });
  await assert.rejects(
    () => sessions.sendSessionToStudio(OWNER, created.id, [sessionTrackB]),
    /reapply that live swap/i,
    "legacy swap rows are not guessed from today's donor track contents",
  );
  await sessions.deleteSession(OWNER, created.id);
});

test("Studio reload routes and exports preserve both saved donors and clip edits after blocked library deletion", async (t) => {
  // Real database, private WAV fixtures, service mutations, and production GET
  // handlers. These tones test routing/persistence, not separation quality.
  const routeOwner = (await import("../local-context")).LOCAL_OWNER_ID;
  const seed = async (name: string, frequency: number, types: string[]) => {
    const filePath = path.join(root!, `${name}.wav`);
    writeWav(filePath, 1, frequency);
    const { track } = await service.addTrackFromAudioFile({
      ownerId: routeOwner, filePath, filename: `${name}.wav`, mimeType: "audio/wav",
    });
    const [row] = await db.db.select().from(schema.tracks).where(eq(schema.tracks.id, track.id));
    const [job] = await db.db.select().from(schema.processingJobs)
      .where(eq(schema.processingJobs.sourceAssetId, row.sourceAssetId));
    const stemIds = new Map<string, string>();
    for (const stemType of types) {
      const storageKey = `route-fixtures/${track.id}/${stemType}.wav`;
      await getStorage().putFile(storageKey, filePath, "audio/wav");
      const [stem] = await db.db.insert(schema.stemAssets).values({
        projectId: track.studioProjectId,
        sourceAssetId: row.sourceAssetId,
        separationJobId: job.id,
        stemType,
        engine: "demucs",
        model: "routing-fixture",
        modelVersion: "test",
        storageKey,
        checksumSha256: createHash("sha256").update(readFileSync(filePath)).digest("hex"),
        durationSeconds: 1,
        sampleRate: 44100,
        channels: 1,
        codec: "wav",
        format: "wav",
        fileSizeBytes: statSync(filePath).size,
      }).returning();
      stemIds.set(stemType, stem.id);
    }
    return { track, sourceId: row.sourceAssetId, stemIds };
  };
  const base = await seed("Studio route base", 311, ["vocals", "drums"]);
  const vocals = await seed("Studio route vocal donor", 523, ["vocals"]);
  const drums = await seed("Studio route drum donor", 733, ["drums"]);
  const clipOnlyDrums = await seed("Studio route clip-only drum donor", 997, ["drums"]);
  assert.notEqual(vocals.sourceId, drums.sourceId);
  assert.notEqual(drums.sourceId, clipOnlyDrums.sourceId);
  const session = await sessions.createSession(routeOwner, "Distinct donor route reload");
  const detail = await sessions.addTrackToSession({
    ownerId: routeOwner, sessionId: session.id, trackId: base.track.id,
  });
  const sessionTrackId = detail.tracks[0].id;
  const expected = [
    { type: "vocals", donor: vocals, volume: 0.72 },
    { type: "drums", donor: drums, volume: 0.37 },
  ];
  for (const { type, donor } of expected) {
    await sessions.recordStemSwap({
      ownerId: routeOwner, sessionId: session.id, sessionTrackId,
      stemType: type as "vocals" | "drums", toTrackId: donor.track.id, atSeconds: 0,
    });
  }
  const handoff = await sessions.sendSessionToStudio(routeOwner, session.id, [sessionTrackId], [
    { sessionTrackId, stemMix: { vocals: 0.72, drums: 0.37 } },
  ]);
  assert.equal(handoff.preservedSwapCount, 2);
  // Import after the temporary database is configured, without replacing DB,
  // access-control helpers, or any route response with a mock.
  const projectRoute = await import(new URL(
    "../../../../../../artifacts/api-server/src/imported/waveyard/projects/[id]/route.ts",
    import.meta.url,
  ).href);
  const remixRoute = await import(new URL(
    "../../../../../../artifacts/api-server/src/imported/remixes/[id]/route.ts",
    import.meta.url,
  ).href);
  let firstTrackIds: string[] | undefined;
  for (let reload = 0; reload < 2; reload += 1) {
    const projectResponse = await projectRoute.GET(
      new Request(`http://localhost/api/waveyard/projects/${handoff.projectId}`),
      { params: Promise.resolve({ id: handoff.projectId }) },
    );
    const remixResponse = await remixRoute.GET(
      new Request(`http://localhost/api/remixes/${handoff.remixSessionId}`),
      { params: Promise.resolve({ id: handoff.remixSessionId }) },
    );
    assert.equal(projectResponse.status, 200);
    assert.equal(remixResponse.status, 200);
    const project = await projectResponse.json();
    const remix = await remixResponse.json();
    assert.equal(project.sources.length, 0, "handoff links audio rather than copying sources");
    assert.equal(project.studioSources.length, 2, "both different donor sources reach Studio");
    assert.equal(project.stems.length, 2);
    assert.equal(remix.tracks.length, 2);
    assert.equal(remix.stems.length, 2);
    const trackIds = remix.tracks.map((track: { id: string }) => track.id).sort();
    if (firstTrackIds) assert.deepEqual(trackIds, firstTrackIds, "reload keeps saved lane IDs");
    firstTrackIds = trackIds;
    for (const { type, donor, volume } of expected) {
      const stemId = donor.stemIds.get(type)!;
      const projectStem = project.stems.find((stem: { id: string }) => stem.id === stemId);
      const remixStem = remix.stems.find((stem: { id: string }) => stem.id === stemId);
      assert.ok(projectStem && remixStem, `${type} donor appears in both actual route responses`);
      assert.equal(projectStem.sourceAssetId, donor.sourceId);
      assert.equal(projectStem.projectId, donor.track.studioProjectId);
      assert.equal(remixStem.sourceAssetId, donor.sourceId);
      assert.equal(remixStem.stemType, type);
      assert.ok(project.studioSources.some((source: { id: string; linkedFromLibrary: boolean }) =>
        source.id === donor.sourceId && source.linkedFromLibrary));
      const lane = remix.tracks.find((track: { stemAssetId: string }) => track.stemAssetId === stemId);
      assert.ok(lane, `${type} lane keeps its exact donor asset after reload`);
      assert.equal(lane.volume, volume);
      assert.ok(lane.name.includes(donor.track.title));
      assert.equal(lane.clips.length, 1);
      assert.equal(lane.clips[0].stemAssetId, stemId);
      assert.equal(lane.clips[0].remixTrackId, lane.id);
      assert.equal("storageKey" in projectStem, false, "private storage paths stay off the API");
    }
  }
  // Unlike the browser fixture, this round trip uses the real PUT/GET routes
  // against the temporary PostgreSQL database and the actual ownership checks.
  const sourcesBefore = await db.db.select().from(schema.sourceAssets);
  const stemsBefore = await db.db.select().from(schema.stemAssets);
  const remixParams = { params: Promise.resolve({ id: handoff.remixSessionId }) };
  const beforeEdit = await (await remixRoute.GET(
    new Request(`http://localhost/api/remixes/${handoff.remixSessionId}`), remixParams,
  )).json();
  await t.test("export/routing evidence: both reloaded donors retain saved levels without original-stem substitution", async () => {
    // Deterministic file-backed tones stand in for already-separated stems.
    // This proves saved audio routing and rendering, NOT model separation quality.
    const versionsRoute = await import(new URL(
      "../../../../../../artifacts/api-server/src/imported/remixes/[id]/versions/route.ts", import.meta.url,
    ).href);
    const response = await versionsRoute.POST(new Request(
      `http://localhost/api/remixes/${handoff.remixSessionId}/versions`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Both saved donors routing proof" }) },
    ), remixParams);
    assert.equal(response.status, 201);
    const { version } = await response.json();
    const [persistedVersion] = await db.db.select().from(schema.remixVersions)
      .where(eq(schema.remixVersions.id, version.id));
    assert.ok(persistedVersion, "export reloads an immutable version from PostgreSQL");
    const snapshot = JSON.parse(persistedVersion.snapshot);
    assert.equal(snapshot.tracks.length, 2);
    assert.equal(snapshot.masterVolume, 1);
    for (const { type, donor, volume } of expected) {
      const lane = snapshot.tracks.find((track: { stemAssetId: string }) =>
        track.stemAssetId === donor.stemIds.get(type));
      assert.ok(lane, `saved version retains the ${type} donor`);
      assert.equal(lane.volume, volume);
      assert.equal(lane.pan, 0);
      assert.equal(lane.muted, false);
      assert.equal(lane.clips.length, 1);
      assert.equal(lane.clips[0].stemAssetId, donor.stemIds.get(type));
      assert.equal(lane.clips[0].gain, 1);
    }
    // Use the real export handler, not a test mixer or a mocked audio loader.
    // Its only audio inputs are the stem IDs re-read from the saved version.
    const [job] = await db.db.insert(schema.exportJobs).values({
      projectId: handoff.projectId,
      remixSessionId: handoff.remixSessionId,
      remixVersionId: persistedVersion.id,
      requestedById: routeOwner,
      idempotencyKey: `both-donors-export:${randomUUID()}`,
      format: "wav",
      sampleRate: 44_100,
      channels: 2,
    }).returning();
    const { handleExportJob } = await import("../worker-local/export");
    await handleExportJob({
      exportJobId: job.id, projectId: handoff.projectId,
      remixSessionId: handoff.remixSessionId, remixVersionId: persistedVersion.id, format: "wav",
    });
    const [completed] = await db.db.select().from(schema.exportJobs)
      .where(eq(schema.exportJobs.id, job.id));
    assert.equal(completed.status, "complete", completed.errorMessage ?? "both donors render successfully");
    const assets = await db.db.select().from(schema.exportAssets)
      .where(eq(schema.exportAssets.exportJobId, job.id));
    assert.equal(assets.length, 1, "the worker persists one real export asset");
    const output = path.join(root!, "both-saved-donors-export.wav");
    await getStorage().getToFile(assets[0].storageKey, output);
    assert.equal(await checksumFile(output), assets[0].checksumSha256);
    const metadata = await probeAudio(output);
    assert.equal(metadata.sampleRate, 44_100);
    assert.equal(metadata.channels, 2);
    assert.ok(Math.abs(metadata.durationSeconds - 1) < 0.02);
    // A mono fixture is expanded to stereo (-3 dB per channel), followed by
    // the exporter's equal-power center pan (-3 dB). No peak normalization.
    const unityAmplitude = (12000 / 32768) * Math.SQRT1_2 * Math.SQRT1_2;
    for (const channel of [0, 1]) {
      for (const { type, frequency, volume } of [
        { type: "vocals", frequency: 523, volume: 0.72 },
        { type: "drums", frequency: 733, volume: 0.37 },
      ]) {
        const measured = pcmWavToneMagnitude(output, frequency, 200, 800, channel);
        const target = unityAmplitude * volume;
        assert.ok(Math.abs(measured - target) < target * 0.02,
          `${type} channel ${channel}: saved level ${volume} yields ${target}, measured ${measured}`);
      }
      const original = pcmWavToneMagnitude(output, 311, 200, 800, channel);
      assert.ok(original < 0.0001, `channel ${channel}: original audio must be absent (${original})`);
      const unselected = pcmWavToneMagnitude(output, 997, 200, 800, channel);
      assert.ok(unselected < 0.0001, `channel ${channel}: unselected clip donor must be absent (${unselected})`);
    }
  });
  const drumsStemId = drums.stemIds.get("drums")!;
  const clipOnlyDrumsStemId = clipOnlyDrums.stemIds.get("drums")!;
  const editedTrackId = beforeEdit.tracks.find((track: { id: string; stemAssetId: string }) =>
    track.stemAssetId === drumsStemId)?.id;
  assert.ok(editedTrackId, "the drum lane exists before editing its clip");
  const input = {
    ...beforeEdit.remix,
    tracks: beforeEdit.tracks.map((track: { id: string; clips: Array<{ stemAssetId: string; timelineStartMs: number }> }) =>
      track.id === editedTrackId ? {
        ...track, volume: 0.61,
        clips: track.clips.map(clip => ({
          ...clip,
          stemAssetId: clipOnlyDrumsStemId,
          timelineStartMs: clip.timelineStartMs + 250,
          beatSnapEnabled: false,
        })),
      } : track),
    automation: beforeEdit.automation,
    expectedVersion: beforeEdit.remix.version,
  };
  const saveResponse = await remixRoute.PUT(new Request(`http://localhost/api/remixes/${handoff.remixSessionId}`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
  }), remixParams);
  assert.equal(saveResponse.status, 200, "a handed-off arrangement remains editable through the real API");
  const savedBeforeDeletion = await (await remixRoute.GET(
    new Request(`http://localhost/api/remixes/${handoff.remixSessionId}`), remixParams,
  )).json();
  const persistedClipRows = await db.db.select().from(schema.remixClips)
    .where(eq(schema.remixClips.remixTrackId, editedTrackId));
  assert.equal(persistedClipRows.length, 1);
  assert.equal(persistedClipRows[0].stemAssetId, clipOnlyDrumsStemId,
    "PostgreSQL stores the clip-only donor on the file-backed clip relation");
  const [olderClient, newerClient] = await Promise.all([
    remixRoute.GET(new Request(`http://localhost/api/remixes/${handoff.remixSessionId}`), remixParams)
      .then((response: Response) => response.json()),
    remixRoute.GET(new Request(`http://localhost/api/remixes/${handoff.remixSessionId}`), remixParams)
      .then((response: Response) => response.json()),
  ]);
  assert.equal(olderClient.remix.version, newerClient.remix.version,
    "independent Studio clients begin from the same authoritative version");
  const newerClientInput = {
    ...newerClient.remix,
    masterVolume: 0.67,
    tracks: newerClient.tracks,
    automation: newerClient.automation,
    expectedVersion: newerClient.remix.version,
  };
  const olderClientInput = {
    ...olderClient.remix,
    masterVolume: 0.24,
    tracks: olderClient.tracks,
    automation: olderClient.automation,
    expectedVersion: olderClient.remix.version,
  };
  const newerClientSave = await remixRoute.PUT(new Request(
    `http://localhost/api/remixes/${handoff.remixSessionId}`,
    { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(newerClientInput) },
  ), remixParams);
  assert.equal(newerClientSave.status, 200, "the first independent client saves its arrangement");
  const staleClientSave = await remixRoute.PUT(new Request(
    `http://localhost/api/remixes/${handoff.remixSessionId}`,
    { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(olderClientInput) },
  ), remixParams);
  assert.equal(staleClientSave.status, 409, "a stale independent client cannot overwrite the newer save");
  assert.equal((await staleClientSave.json()).code, "REMIX_VERSION_CONFLICT");
  const authoritativeAfterConflict = await (await remixRoute.GET(
    new Request(`http://localhost/api/remixes/${handoff.remixSessionId}`), remixParams,
  )).json();
  assert.equal(authoritativeAfterConflict.remix.masterVolume, 0.67,
    "reload selects the newer authoritative arrangement, not the stale snapshot");
  assert.equal(authoritativeAfterConflict.tracks.find((track: { id: string }) =>
    track.id === editedTrackId).clips[0].stemAssetId, clipOnlyDrumsStemId,
  "the winning arrangement retains its selected clip donor");
  for (let reload = 0; reload < 3; reload += 1) {
    const projectAfterEdit = await (await projectRoute.GET(
      new Request(`http://localhost/api/waveyard/projects/${handoff.projectId}`),
      { params: Promise.resolve({ id: handoff.projectId }) },
    )).json();
    const remixAfterEdit = reload === 0
      ? savedBeforeDeletion
      : await (await remixRoute.GET(
        new Request(`http://localhost/api/remixes/${handoff.remixSessionId}`), remixParams,
      )).json();
    assert.equal(projectAfterEdit.stems.length, 3, "the project reload includes all lane and clip-only stems");
    assert.equal(projectAfterEdit.studioSources.length, 3, "the project reload includes the clip donor source");
    assert.equal(remixAfterEdit.stems.length, 3, "the remix reload includes a donor used only by a clip");
    const drumLane = remixAfterEdit.tracks.find((lane: { id: string }) => lane.id === editedTrackId);
    assert.ok(drumLane, "the edited lane remains present on every reload");
    assert.equal(drumLane.stemAssetId, drumsStemId, "the lane default stays unchanged on every reload");
    assert.equal(drumLane.clips.length, 1, "the edited clip does not become an empty lane");
    assert.equal(drumLane.clips[0].stemAssetId, clipOnlyDrumsStemId);
    assert.equal(drumLane.clips[0].remixTrackId, drumLane.id, "clip-to-lane identity survives reload");
    const routeStem = remixAfterEdit.stems.find((stem: { id: string }) => stem.id === clipOnlyDrumsStemId);
    assert.ok(routeStem, "the remix response contains the exact clip donor");
    assert.equal(routeStem.sourceAssetId, clipOnlyDrums.sourceId);
    assert.equal(routeStem.stemType, "drums");
    assert.equal(routeStem.fileSizeBytes, statSync(path.join(root!, "Studio route clip-only drum donor.wav")).size);
    assert.ok(projectAfterEdit.stems.some((stem: { id: string; sourceAssetId: string }) =>
      stem.id === clipOnlyDrumsStemId && stem.sourceAssetId === clipOnlyDrums.sourceId),
    "the project response resolves the clip donor to its source");
    assert.ok(projectAfterEdit.studioSources.some((source: { id: string; linkedFromLibrary?: boolean }) =>
      source.id === clipOnlyDrums.sourceId && source.linkedFromLibrary),
    "the clip donor source is available as a linked library source");
  }
  assert.equal((await service.getTrackDeletionProtection(routeOwner, clipOnlyDrums.track.id))?.inUse, true,
    "a clip-only donor remains protected from library deletion");
  const assetsRoute = await import(new URL(
    "../../../../../../artifacts/api-server/src/imported/assets/[id]/route.ts", import.meta.url,
  ).href);
  const fileResponse = await assetsRoute.GET(
    new Request(`http://localhost/api/assets/${clipOnlyDrumsStemId}`),
    { params: Promise.resolve({ id: clipOnlyDrumsStemId }) },
  );
  assert.equal(fileResponse.status, 200, "the selected clip donor is file-backed and readable");
  const fileBytes = Buffer.from(await fileResponse.arrayBuffer());
  const clipDonorStem = stemsBefore.find((stem) => stem.id === clipOnlyDrumsStemId)!;
  assert.equal(createHash("sha256").update(fileBytes).digest("hex"), clipDonorStem.checksumSha256,
    "the asset route streams the exact selected donor bytes");
  const tracksBeforeDeletion = await db.db.select().from(schema.tracks);
  const deletionRoute = await import(new URL(
    "../../../../../../artifacts/api-server/src/imported/library/tracks/[id]/route.ts", import.meta.url,
  ).href);
  for (const { donor, type } of [...expected, { donor: clipOnlyDrums, type: "drums" }]) {
    const response = await deletionRoute.DELETE(
      new Request(`http://localhost/api/library/tracks/${donor.track.id}`, { method: "DELETE" }),
      { params: Promise.resolve({ id: donor.track.id }) },
    );
    assert.equal(response.status, 409, `${type} donor deletion is blocked explicitly`);
    const refusal = await response.json();
    assert.equal(refusal.errorCode, "LIBRARY_AUDIO_IN_USE");
    assert.equal(refusal.audioPreserved, true);
    assert.match(refusal.error, /Open Studio/);
    assert.ok(refusal.studioProjects.some((project: { id: string; name: string }) =>
      project.id === handoff.projectId && project.name.length > 0),
    "the refusal identifies the saved mix that requires this song");
    assert.equal(await service.getTrackDeletionProtection(OTHER, donor.track.id), null,
      "another owner cannot inspect this song's dependencies");
    const stem = stemsBefore.find(row => row.id === donor.stemIds.get(type))!;
    const restored = path.join(root!, `retained-${type}.wav`);
    await getStorage().getToFile(stem.storageKey, restored);
    assert.equal(await checksumFile(restored), stem.checksumSha256, "the exact donor WAV bytes survive");
  }
  const unsupported = await deletionRoute.DELETE(
    new Request(`http://localhost/api/library/tracks/${base.track.id}`, { method: "DELETE" }),
    { params: Promise.resolve({ id: base.track.id }) },
  );
  assert.equal(unsupported.status, 405, "do not invent destructive deletion for an unreferenced song");
  assert.equal((await unsupported.json()).errorCode, "LIBRARY_AUDIO_DELETION_UNAVAILABLE");
  assert.equal(unsupported.headers.get("allow"), "GET, PATCH");
  const missing = await deletionRoute.DELETE(
    new Request("http://localhost/api/library/tracks/missing", { method: "DELETE" }),
    { params: Promise.resolve({ id: randomUUID() }) },
  );
  assert.equal(missing.status, 404);
  assert.deepEqual(await db.db.select().from(schema.tracks), tracksBeforeDeletion,
    "both referenced donors and every unrelated library song remain unchanged");
  const reopened = await (await remixRoute.GET(
    new Request(`http://localhost/api/remixes/${handoff.remixSessionId}`), remixParams,
  )).json();
  assert.deepEqual(reopened.tracks, authoritativeAfterConflict.tracks,
    "reload keeps the selected authoritative lanes and clips after the stale write is rejected");
  const projectAfterDeletion = await (await projectRoute.GET(
    new Request(`http://localhost/api/waveyard/projects/${handoff.projectId}`),
    { params: Promise.resolve({ id: handoff.projectId }) },
  )).json();
  assert.deepEqual(new Set(projectAfterDeletion.stems.map((stem: { id: string }) => stem.id)),
    new Set([...expected.map(({ donor, type }) => donor.stemIds.get(type)), clipOnlyDrumsStemId]),
    "the project reload still resolves both lane donors and the clip-only donor");
  const editedTrack = reopened.tracks.find((track: { id: string }) => track.id === editedTrackId);
  assert.equal(editedTrack.volume, 0.61, "track level survives a fresh database-backed read");
  assert.equal(editedTrack.clips[0].timelineStartMs, beforeEdit.tracks[0].clips[0].timelineStartMs + 250,
    "clip position survives a fresh database-backed read");
  assert.equal(editedTrack.stemAssetId, drumsStemId, "the drum lane default remains unchanged");
  assert.equal(editedTrack.clips[0].stemAssetId, clipOnlyDrumsStemId,
    "the saved clip points to its selected donor, not the lane default");
  assert.notEqual(editedTrack.clips[0].stemAssetId, editedTrack.stemAssetId,
    "the persisted clip asset is deliberately distinct from its lane default");
  assert.deepEqual(await db.db.select().from(schema.sourceAssets), sourcesBefore, "Studio edits do not mutate original source rows");
  assert.deepEqual(await db.db.select().from(schema.stemAssets), stemsBefore, "Studio edits do not mutate original stem rows");
  const versionsRoute = await import(new URL(
    "../../../../../../artifacts/api-server/src/imported/remixes/[id]/versions/route.ts", import.meta.url,
  ).href);
  const versionResponse = await versionsRoute.POST(new Request(
    `http://localhost/api/remixes/${handoff.remixSessionId}/versions`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Clip-only donor export proof" }) },
  ), remixParams);
  assert.equal(versionResponse.status, 201, "the edited clip can be saved as an exportable version");
  const versionPayload = await versionResponse.json();
  const [savedVersion] = await db.db.select().from(schema.remixVersions)
    .where(eq(schema.remixVersions.id, versionPayload.version.id));
  const versionSnapshot = JSON.parse(savedVersion.snapshot);
  const versionTrack = versionSnapshot.tracks.find((track: { id: string }) => track.id === editedTrackId);
  assert.equal(versionTrack.stemAssetId, drumsStemId);
  assert.equal(versionTrack.clips[0].stemAssetId, clipOnlyDrumsStemId,
    "the immutable export snapshot preserves the clip-specific donor");
  const temporaryDefaultState = {
    ...reopened.remix,
    tracks: reopened.tracks.map((track: { id: string; clips: Array<{ stemAssetId: string }> }) =>
      track.id === editedTrackId ? {
        ...track,
        clips: track.clips.map(clip => ({ ...clip, stemAssetId: drumsStemId })),
      } : track),
    automation: reopened.automation,
    expectedVersion: reopened.remix.version,
  };
  const changedAgain = await remixRoute.PUT(new Request(
    `http://localhost/api/remixes/${handoff.remixSessionId}`,
    { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(temporaryDefaultState) },
  ), remixParams);
  assert.equal(changedAgain.status, 200, "a later clip edit can be saved before restoring a version");
  const restoreRoute = await import(new URL(
    "../../../../../../artifacts/api-server/src/imported/remixes/[id]/versions/[versionId]/restore/route.ts", import.meta.url,
  ).href);
  const restoreResponse = await restoreRoute.POST(new Request(
    `http://localhost/api/remixes/${handoff.remixSessionId}/versions/${savedVersion.id}/restore`,
    { method: "POST" },
  ), { params: Promise.resolve({ id: handoff.remixSessionId, versionId: savedVersion.id }) });
  assert.equal(restoreResponse.status, 200, "saved versions can restore clip-only linked donors");
  const restoredRemix = await (await remixRoute.GET(
    new Request(`http://localhost/api/remixes/${handoff.remixSessionId}`), remixParams,
  )).json();
  const restoredDrumLane = restoredRemix.tracks.find((track: { id: string }) => track.id === editedTrackId);
  assert.equal(restoredDrumLane.stemAssetId, drumsStemId);
  assert.equal(restoredDrumLane.clips[0].stemAssetId, clipOnlyDrumsStemId,
    "restoring a saved version keeps its exact clip donor");
  assert.equal(restoredDrumLane.clips[0].remixTrackId, restoredDrumLane.id,
    "restored clips remain attached to their original lane identity");
  const [exportJob] = await db.db.insert(schema.exportJobs).values({
    projectId: handoff.projectId,
    remixSessionId: handoff.remixSessionId,
    remixVersionId: savedVersion.id,
    requestedById: routeOwner,
    idempotencyKey: `clip-only-export:${randomUUID()}`,
    format: "wav",
    sampleRate: 44_100,
    channels: 2,
  }).returning();
  const exportWorker = await import(new URL(
    "../../../../../../lib/arena/src/lib/waveyard/worker-local/export.ts", import.meta.url,
  ).href);
  await exportWorker.handleExportJob({
    exportJobId: exportJob.id,
    projectId: handoff.projectId,
    remixSessionId: handoff.remixSessionId,
    remixVersionId: savedVersion.id,
    format: "wav",
  });
  const [completedExport] = await db.db.select().from(schema.exportJobs)
    .where(eq(schema.exportJobs.id, exportJob.id));
  assert.equal(completedExport.status, "complete", "the local exporter renders a linked clip-only donor");
  const [exportAsset] = await db.db.select().from(schema.exportAssets)
    .where(eq(schema.exportAssets.exportJobId, exportJob.id));
  assert.ok(exportAsset, "a real file-backed export is created");
  const exportedWav = path.join(root!, "clip-only-donor-export.wav");
  await getStorage().getToFile(exportAsset.storageKey, exportedWav);
  const donorTone = pcmWavToneMagnitude(exportedWav, 997, 400, 900);
  const laneDefaultTone = pcmWavToneMagnitude(exportedWav, 733, 400, 900);
  assert.ok(donorTone > 0.05, `export contains the selected donor tone (magnitude ${donorTone})`);
  assert.ok(donorTone > laneDefaultTone * 8,
    `export reads clip donor audio, not lane-default audio (${donorTone} vs ${laneDefaultTone})`);
  await sessions.deleteSession(routeOwner, session.id);
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
  const firstSession = await sessions.addTrackToSession({ ownerId: OWNER, sessionId: created.id, trackId: trackA.id });
  await sessions.updateSessionTrack(OWNER, created.id, firstSession.tracks[0].id, {
    stemMix: { vocals: 0.42, drums: 0.78 },
    transition: { mode: "manual", crossfadeSeconds: 0.75, keepStems: ["drums"] },
  });
  await sessions.addTrackToSession({ ownerId: OWNER, sessionId: created.id, trackId: trackB.id });

  const sessionBeforeHandoff = await sessions.getSession(OWNER, created.id);
  const sourcesBeforeHandoff = await db.db.select().from(schema.sourceAssets);
  const stemsBeforeHandoff = await db.db.select().from(schema.stemAssets);
  const selectedEntries = sessionBeforeHandoff.tracks.slice(0, 2);
  assert.equal(selectedEntries.length, 2, "the fixture must contain two ready session entries");
  const ownerProjectsBeforeEmptySelection = await db.db
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .where(eq(schema.projects.ownerId, OWNER));
  await assert.rejects(
    () => sessions.sendSessionToStudio(OWNER, created.id, []),
    sessions.StudioHandoffSelectionError,
    "an empty handoff selection is rejected before creating a project",
  );
  assert.equal(
    (await db.db.select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.ownerId, OWNER))).length,
    ownerProjectsBeforeEmptySelection.length,
    "an empty selection does not create a blank Studio project",
  );
  await assert.rejects(
    () => sessions.sendSessionToStudio(OWNER, created.id, [OTHER]),
    sessions.StudioHandoffSelectionError,
    "session entries from outside this session cannot be included",
  );
  const handoffMixes = selectedEntries.map((entry, index) => ({
    sessionTrackId: entry.id,
    stemMix: Object.fromEntries(entry.stems.map((stem) => [stem.stemType, index === 0 ? 0.23 : 0.64])),
  }));
  const handoff = await sessions.sendSessionToStudio(
    OWNER,
    created.id,
    selectedEntries.map((entry) => entry.id),
    handoffMixes,
  );
  assert.ok(handoff.projectId);
  assert.ok(handoff.remixSessionId);
  let expectedTimelineStartMs = 0;
  const expectedAssets = selectedEntries.flatMap((entry, index) => {
    const separated = entry.stems.filter((stem) => stem.engine !== "passthrough-unseparated");
    const playable = separated.length
      ? separated
      : entry.stems.filter((stem) => stem.engine === "passthrough-unseparated");
    const assets = playable.map((stem) => ({ stemId: stem.id, startMs: expectedTimelineStartMs }));
    const durationMs = Math.max(1, Math.round(entry.track.durationSeconds * 1000));
    const outgoingFadeMs = index < selectedEntries.length - 1
      ? Math.min(Math.round(entry.transition.crossfadeSeconds * 1000), durationMs)
      : 0;
    expectedTimelineStartMs += durationMs - outgoingFadeMs;
    return assets;
  });
  assert.equal(handoff.preservedTransitionCount, 1, "the saved crossfade is carried into Studio");
  assert.equal(handoff.remixTrackCount, expectedAssets.length, "every separated layer is retained; passthrough is used only when separation is absent");

  // The derived project is a STUDIO project (visible in studio listings).
  const studioList = await service.listStudioProjects(OWNER);
  assert.ok(studioList.some((project) => project.id === handoff.projectId));

  // The remix tracks reference the EXISTING stem asset rows — no new audio.
  const remixTrackRows = await db.db.select().from(schema.remixTracks).where(eq(schema.remixTracks.remixSessionId, handoff.remixSessionId));
  assert.equal(remixTrackRows.length, expectedAssets.length);
  assert.deepEqual(
    new Set(remixTrackRows.map((row) => row.stemAssetId)),
    new Set(expectedAssets.map((entry) => entry.stemId)),
    "only the selected session entries contribute remix tracks",
  );
  const expectedVolumeByStemId = new Map(
    selectedEntries.flatMap((entry, index) =>
      entry.stems.map((stem) => [stem.id, index === 0 ? 0.23 : 0.64] as const),
    ),
  );
  for (const row of remixTrackRows) {
    assert.equal(row.volume, expectedVolumeByStemId.get(row.stemAssetId),
      `remix track ${row.id} uses the latest session fader snapshot`);
  }
  const stemIdsBefore = new Set(stemsBeforeHandoff.map((row) => row.id));
  for (const row of remixTrackRows) {
    assert.ok(stemIdsBefore.has(row.stemAssetId), `remix track ${row.id} references a pre-existing stem`);
  }
  const clips = await db.db.select().from(schema.remixClips);
  const handoffClips = clips.filter((clip) => remixTrackRows.some((track) => track.id === clip.remixTrackId));
  assert.equal(handoffClips.length, remixTrackRows.length, "each mixer lane opens as a visible timeline clip");
  const firstEntryStemIds = new Set(selectedEntries[0].stems.map((stem) => stem.id));
  const firstEntryTrackIds = new Set(remixTrackRows
    .filter((track) => firstEntryStemIds.has(track.stemAssetId))
    .map((track) => track.id));
  const firstEntryClips = handoffClips.filter((clip) => firstEntryTrackIds.has(clip.remixTrackId));
  const secondEntryClips = handoffClips.filter((clip) => !firstEntryTrackIds.has(clip.remixTrackId));
  const keptDrumStemId = selectedEntries[0].stems.find((stem) => stem.stemType === "drums")?.id;
  const keptDrumTrackId = remixTrackRows.find((track) => track.stemAssetId === keptDrumStemId)?.id;
  assert.ok(keptDrumTrackId, "the selected first entry includes the retained drum layer");
  assert.ok(firstEntryClips.filter((clip) => clip.remixTrackId !== keptDrumTrackId)
    .every((clip) => clip.fadeOutMs === 750), "outgoing stems fade for the saved crossfade length");
  assert.equal(firstEntryClips.find((clip) => clip.remixTrackId === keptDrumTrackId)?.fadeOutMs, 0,
    "stems configured to stay up are not faded out");
  assert.ok(secondEntryClips.every((clip) => clip.fadeInMs === 750), "incoming stems fade for the saved crossfade length");
  assert.ok(handoffClips.every((clip) => clip.fadeInMs + clip.fadeOutMs <= clip.durationMs),
    "carried fades never exceed the clip's available duration");
  const expectedStartByStemId = new Map(expectedAssets.map((entry) => [entry.stemId, entry.startMs]));
  assert.ok(
    handoffClips.every((clip) => clip.timelineStartMs === expectedStartByStemId.get(clip.stemAssetId)),
    "each selected entry starts after the prior song while its stems stay aligned",
  );
  assert.deepEqual(
    (await db.db.select().from(schema.sourceAssets)).sort((left, right) => left.id.localeCompare(right.id)),
    sourcesBeforeHandoff.sort((left, right) => left.id.localeCompare(right.id)),
    "the original source assets remain unchanged",
  );
  assert.deepEqual(
    (await db.db.select().from(schema.stemAssets)).sort((left, right) => left.id.localeCompare(right.id)),
    stemsBeforeHandoff.sort((left, right) => left.id.localeCompare(right.id)),
    "the original stem assets remain unchanged",
  );
  const singleTrackHandoff = await sessions.sendSessionToStudio(OWNER, created.id, [selectedEntries[1].id]);
  const selectedRealStems = selectedEntries[1].stems.filter((stem) => stem.engine !== "passthrough-unseparated");
  const selectedPlayableStems = selectedRealStems.length > 0
    ? selectedRealStems
    : selectedEntries[1].stems.filter((stem) => stem.engine === "passthrough-unseparated");
  assert.equal(singleTrackHandoff.remixTrackCount, selectedPlayableStems.length,
    "a single selected entry contributes only its own stem lanes");
  const singleTrackRows = await db.db
    .select()
    .from(schema.remixTracks)
    .where(eq(schema.remixTracks.remixSessionId, singleTrackHandoff.remixSessionId));
  assert.deepEqual(
    new Set(singleTrackRows.map((row) => row.stemAssetId)),
    new Set(selectedPlayableStems.map((stem) => stem.id)),
    "unselected session entries contribute no tracks to the derived arrangement",
  );

  await sessions.deleteSession(OWNER, created.id);
});

test("session: partial Studio handoff names audio lost after selection; all-refused creates no project", async () => {
  const created = await sessions.createSession(OWNER, "Changing audio availability");
  const sourceFile = path.join(root!, "handoff-source-that-disappears.wav");
  writeWav(sourceFile, 2, 517);
  const lostSource = await service.addTrackFromAudioFile({
    ownerId: OWNER,
    filePath: sourceFile,
    filename: "Handoff Lost Source.wav",
    mimeType: "audio/wav",
  });
  const [sourceRow] = await db.db
    .select()
    .from(schema.tracks)
    .where(eq(schema.tracks.id, lostSource.track.id))
    .limit(1);
  const [separationJob] = await db.db
    .select()
    .from(schema.processingJobs)
    .where(eq(schema.processingJobs.sourceAssetId, sourceRow.sourceAssetId))
    .limit(1);
  assert.ok(separationJob, "the temporary track has a separation job for its test stems");
  const lostSourceStems = await db.db.insert(schema.stemAssets).values(
    ["vocals", "drums", "bass", "other"].map((stemType) => ({
      projectId: lostSource.track.studioProjectId,
      sourceAssetId: sourceRow.sourceAssetId,
      separationJobId: separationJob.id,
      stemType,
      engine: "test-demucs",
      model: "htdemucs",
      modelVersion: "test",
      storageKey: `test/handoff-lost-source-${stemType}.wav`,
      checksumSha256: `handoff-lost-source-${stemType}`,
      durationSeconds: 2,
      sampleRate: 44100,
      channels: 1,
      codec: "wav",
      format: "wav",
      fileSizeBytes: 100,
    })),
  ).returning();
  const first = await sessions.addTrackToSession({ ownerId: OWNER, sessionId: created.id, trackId: trackA.id });
  const firstSessionTrackId = first.tracks[0].id;
  const second = await sessions.addTrackToSession({ ownerId: OWNER, sessionId: created.id, trackId: lostSource.track.id });
  const lostSessionTrackId = second.tracks[1].id;
  const selectedBeforeLoss = await sessions.getSession(OWNER, created.id);
  assert.ok(selectedBeforeLoss.tracks.every((entry) => entry.stems.length > 0),
    "both entries are selectable before the second track loses its separated audio");

  try {
    // Model source separation/artifact cleanup completing after the browser
    // selected both entries but before the handoff request resolves them.
    await db.db.delete(schema.stemAssets).where(eq(schema.stemAssets.sourceAssetId, sourceRow.sourceAssetId));
    const partial = await sessions.sendSessionToStudio(
      OWNER,
      created.id,
      [firstSessionTrackId, lostSessionTrackId],
    );
    const availableStems = selectedBeforeLoss.tracks[0].stems;
    assert.equal(partial.remixTrackCount, availableStems.length, "the available entry still opens in Studio");
    assert.deepEqual(partial.refused, [{
      title: lostSource.track.title,
      reason: "No separated stems or full-source audio are available.",
    }], "the refused entry is reported by its track title and reason");
    const partialTracks = await db.db
      .select()
      .from(schema.remixTracks)
      .where(eq(schema.remixTracks.remixSessionId, partial.remixSessionId));
    assert.deepEqual(
      new Set(partialTracks.map((track) => track.stemAssetId)),
      new Set(availableStems.map((stem) => stem.id)),
      "the partial arrangement only references the still-available entry",
    );
    await db.db.delete(schema.projects).where(eq(schema.projects.id, partial.projectId));

    const projectCountBeforeAllRefused = (await db.db
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(eq(schema.projects.ownerId, OWNER))).length;
    await assert.rejects(
      () => sessions.sendSessionToStudio(OWNER, created.id, [lostSessionTrackId]),
      (error: unknown) => error instanceof sessions.StemSwapRefusedError
        && error.message.includes(lostSource.track.title)
        && error.message.includes("No Studio project was created")
        && error.message.includes("re-separate"),
      "when every selected entry loses audio, the error names it and explains recovery",
    );
    assert.equal(
      (await db.db.select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.ownerId, OWNER))).length,
      projectCountBeforeAllRefused,
      "an all-refused handoff creates no empty Studio project",
    );
  } finally {
    await sessions.deleteSession(OWNER, created.id);
    await db.db.delete(schema.projects).where(eq(schema.projects.id, lostSource.track.studioProjectId));
  }
});

test("session: Studio handoff checks selected and live-donor audio files, keeping other tracks", async () => {
  const created = await sessions.createSession(OWNER, "Missing private audio");
  const [trackARow] = await db.db.select().from(schema.tracks).where(eq(schema.tracks.id, trackA.id)).limit(1);
  const [trackBRow] = await db.db.select().from(schema.tracks).where(eq(schema.tracks.id, trackB.id)).limit(1);
  const playableTrackAStems = await db.db
    .select()
    .from(schema.stemAssets)
    .where(eq(schema.stemAssets.sourceAssetId, trackARow.sourceAssetId));
  const trackBStems = await db.db
    .select()
    .from(schema.stemAssets)
    .where(eq(schema.stemAssets.sourceAssetId, trackBRow.sourceAssetId));
  const playableTrackBStems = trackBStems.filter((stem) => stem.engine !== "passthrough-unseparated");
  const sourceFixture = path.join(root!, "aphex.wav");
  const storage = getStorage();
  const deletedKeys = new Set<string>();
  const removeAudioObject = async (storageKey: string) => {
    await storage.delete(storageKey);
    deletedKeys.add(storageKey);
  };
  const restoreDeletedAudioObjects = async () => {
    for (const storageKey of deletedKeys) {
      await storage.putFile(storageKey, sourceFixture, "audio/wav");
    }
    deletedKeys.clear();
  };
  const projectsBefore = new Set((await db.db
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .where(eq(schema.projects.ownerId, OWNER))).map((project) => project.id));
  let partialProjectId: string | null = null;

  try {
    assert.ok(playableTrackAStems.length > 0, "the kept selected track has separated stem rows");
    const missingSelectedStem = playableTrackBStems.find((stem) => stem.stemType === "drums");
    const donorDrums = playableTrackAStems.find((stem) => stem.stemType === "drums");
    assert.ok(missingSelectedStem, "the selected track has a drum stem to remove from storage");
    assert.ok(donorDrums, "the donor track has a drum stem to remove from storage");

    const withTrackA = await sessions.addTrackToSession({
      ownerId: OWNER,
      sessionId: created.id,
      trackId: trackA.id,
    });
    const withTrackB = await sessions.addTrackToSession({
      ownerId: OWNER,
      sessionId: created.id,
      trackId: trackB.id,
    });
    const trackASessionId = withTrackA.tracks.find((entry) => entry.track.id === trackA.id)!.id;
    const trackBSessionId = withTrackB.tracks.find((entry) => entry.track.id === trackB.id)!.id;

    await removeAudioObject(missingSelectedStem.storageKey);
    assert.equal(await storage.exists(missingSelectedStem.storageKey), false);
    assert.equal((await db.db.select({ id: schema.stemAssets.id })
      .from(schema.stemAssets)
      .where(eq(schema.stemAssets.id, missingSelectedStem.id))).length, 1,
    "the database stem row remains even though its private object is gone");
    const partial = await sessions.sendSessionToStudio(OWNER, created.id, [trackASessionId, trackBSessionId]);
    partialProjectId = partial.projectId;
    assert.equal(partial.remixTrackCount, playableTrackAStems.length,
      "the playable selected track still opens while the entry with a missing stem is refused");
    const missingSelectedRefusal = partial.refused?.find((item) => item.title === trackB.title);
    assert.ok(missingSelectedRefusal);
    assert.match(missingSelectedRefusal.reason, /drums stem file is missing from private storage/i,
      "the result identifies the track title and exact missing stem");
    const partialTracks = await db.db.select().from(schema.remixTracks)
      .where(eq(schema.remixTracks.remixSessionId, partial.remixSessionId));
    assert.deepEqual(
      new Set(partialTracks.map((entry) => entry.stemAssetId)),
      new Set(playableTrackAStems.map((stem) => stem.id)),
      "Studio lanes reference only existing audio objects from the playable selected track",
    );
    await db.db.delete(schema.projects).where(eq(schema.projects.id, partial.projectId));
    partialProjectId = null;
    await restoreDeletedAudioObjects();

    await sessions.recordStemSwap({
      ownerId: OWNER,
      sessionId: created.id,
      sessionTrackId: trackBSessionId,
      stemType: "drums",
      toTrackId: trackA.id,
      atSeconds: 0,
    });
    await removeAudioObject(donorDrums.storageKey);
    const projectCountBeforeMissingDonor = (await db.db.select({ id: schema.projects.id })
      .from(schema.projects)
      .where(eq(schema.projects.ownerId, OWNER))).length;
    await assert.rejects(
      () => sessions.sendSessionToStudio(OWNER, created.id, [trackBSessionId]),
      (error: unknown) => error instanceof sessions.StemSwapRefusedError
        && error.message.includes(trackB.title)
        && error.message.includes(trackA.title)
        && /drums live-swap audio .* missing from private storage/i.test(error.message)
        && error.message.includes("No Studio project was created"),
      "a missing live-donor object is named and must not create a broken Studio lane",
    );
    assert.equal(
      (await db.db.select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.ownerId, OWNER))).length,
      projectCountBeforeMissingDonor,
      "a handoff with no usable selected entry does not create a project",
    );
    await restoreDeletedAudioObjects();

    for (const stem of trackBStems) await removeAudioObject(stem.storageKey);
    const projectCountBeforeAllMissing = (await db.db.select({ id: schema.projects.id })
      .from(schema.projects)
      .where(eq(schema.projects.ownerId, OWNER))).length;
    await assert.rejects(
      () => sessions.sendSessionToStudio(OWNER, created.id, [trackBSessionId]),
      (error: unknown) => error instanceof sessions.StemSwapRefusedError
        && error.message.startsWith("No selected session entry can be opened in Studio.")
        && error.message.includes(trackB.title)
        && error.message.includes("vocals")
        && error.message.includes("drums")
        && error.message.includes("No Studio project was created")
        && error.message.includes("Restore or re-separate the named tracks in the Library"),
      "an all-missing selection gives the UI its Library recovery message",
    );
    assert.equal(
      (await db.db.select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.ownerId, OWNER))).length,
      projectCountBeforeAllMissing,
      "an all-missing selection does not create an empty Studio project",
    );
  } finally {
    await restoreDeletedAudioObjects();
    if (partialProjectId !== null) {
      await db.db.delete(schema.projects).where(eq(schema.projects.id, partialProjectId));
    }
    const projectsAddedByTest = (await db.db
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(eq(schema.projects.ownerId, OWNER)))
      .filter((project) => !projectsBefore.has(project.id));
    for (const project of projectsAddedByTest) {
      await db.db.delete(schema.projects).where(eq(schema.projects.id, project.id));
    }
    await sessions.deleteSession(OWNER, created.id);
  }
});

test("session: meeting-point primitives power compatibility (analysis surfaced, not duplicated)", async () => {
  // trackA has a complete analysis (128.5 BPM, A minor). Give trackB one too.
  const sourceB = sourceIdByTrackId.get(trackB.id)!;
  const [sourceAssetB] = await db.db.select().from(schema.sourceAssets)
    .where(eq(schema.sourceAssets.id, sourceB)).limit(1);
  assert.ok(sourceAssetB);
  const trackBDetail = await service.getTrack(OWNER, trackB.id);
  const donorVocalStem = trackBDetail?.stems.find((stem) => stem.stemType === "vocals");
  assert.ok(donorVocalStem, "the donor's isolated vocal asset is available");
  const [donorVocalStemRecord] = await db.db.select().from(schema.stemAssets)
    .where(eq(schema.stemAssets.id, donorVocalStem.id)).limit(1);
  assert.ok(donorVocalStemRecord);
  await db.db.insert(schema.sourceAnalyses).values({
    projectId: trackB.studioProjectId,
    sourceAssetId: sourceB,
    status: "complete",
    stage: "complete",
    analysisEngine: "arena-js-dsp",
    analysisEngineVersion: DESKTOP_ANALYSIS_ENGINE_VERSION,
    sourceChecksumSha256: sourceAssetB.checksumSha256,
    idempotencyKey: `analysis-test-b:${sourceB}`,
    bpm: 129,
    bpmConfidence: 0.9,
    musicalKey: "C major",
    beatGrid: JSON.stringify([0, 500, 1000, 1500, 2000]),
    beatConfidence: 0.9,
    downbeatGrid: JSON.stringify([0, 2000]),
    downbeatConfidence: 0.9,
  });

  const [vocalAnalysisRow] = await db.db.insert(schema.vocalAnalyses).values({
    projectId: trackB.studioProjectId,
    sourceAssetId: sourceB,
    stemAssetId: donorVocalStem.id,
    status: "complete",
    stage: "complete",
    idempotencyKey: `session-vocal-entry:${randomUUID()}`,
    analysisEngine: LOCAL_VOCAL_ANALYSIS_ENGINE,
    analysisEngineVersion: LOCAL_VOCAL_ANALYSIS_ENGINE_VERSION,
    sourceChecksumSha256: sourceAssetB.checksumSha256!,
    stemChecksumSha256: donorVocalStemRecord.checksumSha256,
  }).returning();
  try {
    await db.db.insert(schema.vocalActivityIntervals).values([
      {
        vocalAnalysisId: vocalAnalysisRow.id,
        intervalIndex: 0,
        startMs: 250,
        endMs: 850,
        confidence: 0.92,
      },
      {
        vocalAnalysisId: vocalAnalysisRow.id,
        intervalIndex: 1,
        startMs: Math.round(trackB.durationSeconds * 1000),
        endMs: Math.round(trackB.durationSeconds * 1000) + 500,
        confidence: 0.99,
      },
    ]);
    await db.db.insert(schema.vocalPhrases).values([
      {
        vocalAnalysisId: vocalAnalysisRow.id,
        phraseIndex: 0,
        startMs: 1_100,
        endMs: 2_100,
        confidence: 0.7,
      },
      {
        vocalAnalysisId: vocalAnalysisRow.id,
        phraseIndex: 1,
        startMs: Math.round(trackB.durationSeconds * 1000) - 100,
        endMs: Math.round(trackB.durationSeconds * 1000) + 100,
        confidence: 0.9,
      },
    ]);

    await db.db.update(schema.vocalAnalyses).set({
      sourceChecksumSha256: "a".repeat(64),
      stemChecksumSha256: "b".repeat(64),
    }).where(eq(schema.vocalAnalyses.id, vocalAnalysisRow.id));
    const staleAnalysis = await sessions.sessionTrackAnalysis(OWNER, trackB.id);
    assert.deepEqual(staleAnalysis?.vocalActivityStartsMs, null,
      "source or stem checksum changes suppress otherwise complete vocal evidence");
    await db.db.update(schema.vocalAnalyses).set({
      sourceChecksumSha256: sourceAssetB.checksumSha256!,
      stemChecksumSha256: donorVocalStemRecord.checksumSha256,
    }).where(eq(schema.vocalAnalyses.id, vocalAnalysisRow.id));

    const analysisA = await sessions.sessionTrackAnalysis(OWNER, trackA.id);
    const analysisB = await sessions.sessionTrackAnalysis(OWNER, trackB.id);
    assert.equal(analysisA?.bpm, 128.5);
    assert.equal(analysisA?.musicalKey, "A minor");
    assert.equal(analysisB?.bpm, 129);
    assert.deepEqual(analysisB?.downbeatGridMs, [0, 2000],
      "the session endpoint exposes persisted downbeats only on the current analysis beat grid");
    assert.equal(analysisB?.downbeatConfidence, 0.9);
    await db.db.update(schema.sourceAnalyses).set({ downbeatConfidence: 0.64 })
      .where(eq(schema.sourceAnalyses.sourceAssetId, sourceB));
    const weakDownbeatAnalysis = await sessions.sessionTrackAnalysis(OWNER, trackB.id);
    assert.equal(weakDownbeatAnalysis?.downbeatGridMs, null,
      "persisted candidate positions are suppressed when downbeat confidence falls below the bar-action threshold");
    assert.equal(weakDownbeatAnalysis?.downbeatConfidence, 0.64);
    await db.db.update(schema.sourceAnalyses).set({ downbeatConfidence: 0.9 })
      .where(eq(schema.sourceAnalyses.sourceAssetId, sourceB));
    assert.deepEqual(analysisB?.vocalActivityStartsMs, [{ startMs: 250, confidence: 0.92 }],
      "session analysis exposes only current-checksum vocal activity that ends inside the source and stem");
    assert.deepEqual(analysisB?.voicedPhraseStartsMs, [{ startMs: 1_100, confidence: 0.7 }],
      "pitch-continuity phrase starts remain distinct and source-bounded");

    const session = await sessions.createSession(OWNER, "Persisted vocal entry");
    try {
      const withRecipient = await sessions.addTrackToSession({ ownerId: OWNER, sessionId: session.id, trackId: trackA.id });
      const withDonorSwap = await sessions.recordStemSwap({
        ownerId: OWNER,
        sessionId: session.id,
        sessionTrackId: withRecipient.tracks[0].id,
        stemType: "vocals",
        toTrackId: trackB.id,
        atSeconds: 1,
        donorEntryOffsetMs: 1_100,
      });
      assert.deepEqual(withDonorSwap.swaps[0]?.donorTrack?.analysis?.voicedPhraseStartsMs,
        [{ startMs: 1_100, confidence: 0.7 }],
        "the selected donor's measured entry points are available through the persisted session swap response");
      assert.equal(withDonorSwap.swaps[0]?.donorEntryOffsetMs, 1_100);
    } finally {
      await sessions.deleteSession(OWNER, session.id);
    }

    const tempo = sessionLogic.tempoCompatibility(analysisA?.bpm ?? null, analysisB?.bpm ?? null);
    assert.equal(tempo.compatible, true, "128.5 → 129 is close");
    const key = sessionLogic.keyCompatibility(analysisA?.musicalKey ?? null, analysisB?.musicalKey ?? null);
    assert.equal(key.relationship, "relative", "A minor ↔ C major");
    const alignment = sessionLogic.beatAlignedTransitionStart(analysisA?.beatGridMs ?? null, analysisB?.beatGridMs ?? null, 100, "beat");
    assert.equal(alignment.ok, true, "both grids verified → aligned start available");
  } finally {
    await db.db.delete(schema.vocalAnalyses).where(eq(schema.vocalAnalyses.id, vocalAnalysisRow.id));
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

test("library intake preserves embedded title, artist, and album tags for audio backups", async () => {
  const plainPath = path.join(root!, "tag-source.wav");
  const taggedPath = path.join(root!, "tagged-library-audio.wav");
  writeWav(plainPath, 2, 330);
  const ffmpeg = await requireTool("ffmpeg");
  const tagged = spawnSync(ffmpeg.path, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    plainPath,
    "-metadata",
    "title=Embedded Title",
    "-metadata",
    "artist=Embedded Artist",
    "-metadata",
    "album=Embedded Album",
    "-c:a",
    "copy",
    "-y",
    taggedPath,
  ], { encoding: "utf8" });
  assert.equal(tagged.status, 0, tagged.stderr);
  const probed = await probeAudio(taggedPath);
  assert.deepEqual(probed.tags, {
    title: "Embedded Title",
    artist: "Embedded Artist",
    album: "Embedded Album",
  });
  const exactAudioChecksum = await checksumFile(taggedPath);
  const imported = await service.addTrackFromAudioFile({
    ownerId: OTHER,
    filePath: taggedPath,
    filename: "01 - Filename Artist - Filename Title.wav",
    mimeType: "audio/wav",
  });
  assert.equal(imported.track.title, "Embedded Title");
  assert.equal(imported.track.artist, "Embedded Artist");
  assert.equal(imported.track.album, "Embedded Album");
  const [storedTrack] = await db.db.select().from(schema.tracks).where(eq(schema.tracks.id, imported.track.id)).limit(1);
  assert.equal(storedTrack.sourceChecksumSha256, exactAudioChecksum,
    "tag extraction must not transcode or replace the original audio bytes");
});

test("audio backup restore creates a playable local library track and skips the same audio on retry", async () => {
  const fixturePath = path.join(root!, "audio-backup-round-trip.wav");
  writeWav(fixturePath, 2, 440);
  const audioBytes = statSync(fixturePath).size;
  const audioChecksum = await checksumFile(fixturePath);
  const backupTrackId = randomUUID();
  const backupPath = `audio/Restore Artist/Restore Album/${backupTrackId} - Restored Session.wav`;
  const manifestBytes = Buffer.from(createAudioBackupCsv([{
    trackId: backupTrackId,
    title: "Restored Session",
    artist: "Restore Artist",
    album: "Restore Album",
    durationSeconds: 2,
    codec: "pcm_s16le",
    originalFilename: "restored-session.wav",
    archivePath: backupPath,
    fileSizeBytes: audioBytes,
    checksumSha256: audioChecksum,
  }]));
  const archive = await createVerifiedAudioBackupZip([
    {
      name: backupPath,
      bytes: audioBytes,
      sha256: audioChecksum,
      open: async () => createReadStream(fixturePath),
    },
    {
      name: "manifest.csv",
      bytes: manifestBytes.length,
      sha256: createHash("sha256").update(manifestBytes).digest("hex"),
      open: async () => Readable.from([manifestBytes]),
    },
  ]);

  try {
    const restoreOne = async (row: {
      originalFilename: string;
      title: string;
      artist: string;
      album: string;
    }, filePath: string) => service.addTrackFromAudioFile({
      ownerId: RESTORE_OWNER,
      filePath,
      filename: row.originalFilename,
      mimeType: "audio/wav",
      title: row.title,
      artist: row.artist,
      album: row.album,
      prepareSeparation: false,
    });

    const firstRestore = await restoreVerifiedAudioBackupZip(archive.path, restoreOne);
    const firstImport = firstRestore.results[0];
    assert.ok(firstImport, "the verified archive imports one library track");
    assert.equal(firstImport.created, true);
    assert.equal(firstImport.track.title, "Restored Session");
    assert.equal(firstImport.track.artist, "Restore Artist");
    assert.equal(firstImport.track.album, "Restore Album");
    assert.equal(firstImport.track.durationSeconds, 2);

    const [storedTrack] = await db.db.select().from(schema.tracks).where(eq(schema.tracks.id, firstImport.track.id)).limit(1);
    assert.ok(storedTrack);
    const [storedSource] = await db.db.select().from(schema.sourceAssets).where(eq(schema.sourceAssets.id, storedTrack.sourceAssetId)).limit(1);
    assert.ok(storedSource);
    const trackDetail = await service.getTrack(RESTORE_OWNER, firstImport.track.id);
    assert.ok(trackDetail);
    assert.equal(trackDetail.playback.kind, "source", "the player resolves the restored track to its original audio");
    assert.deepEqual(trackDetail.playback.assetIds, [storedSource.id]);
    assert.equal(storedSource.checksumSha256, audioChecksum);
    assert.equal(storedSource.sampleRate, 44100);
    assert.equal(storedSource.channels, 1);
    assert.equal(storedSource.fileSizeBytes, audioBytes);

    const storedAudioPath = getStorage().getLocalPath(storedSource.storageKey);
    assert.ok(storedAudioPath, "the restored source uses the app's local audio storage");
    assert.deepEqual(readFileSync(storedAudioPath), readFileSync(fixturePath), "restore preserves the exact original WAV bytes");

    const processingRows = await db.db.select().from(schema.processingJobs).where(eq(schema.processingJobs.sourceAssetId, storedSource.id));
    assert.equal(processingRows.length, 0, "archive restore does not silently enqueue heavy processing");

    const retry = await restoreVerifiedAudioBackupZip(archive.path, restoreOne);
    assert.equal(retry.results[0].created, false, "replaying a partially completed restore is idempotent by content");
    assert.equal((await service.listTracks({ ownerId: RESTORE_OWNER })).length, 1);
  } finally {
    await archive.dispose();
  }
});

test("a converted local track appears in the library and downloads with its verified ZIP checksum", async (context) => {
  const routeOwner = (await import("../local-context")).LOCAL_OWNER_ID;
  const conversionsRoute = await import(new URL(
    "../../../../../../artifacts/api-server/src/imported/library/conversions/route.ts",
    import.meta.url,
  ).href);
  const tracksRoute = await import(new URL(
    "../../../../../../artifacts/api-server/src/imported/library/tracks/route.ts",
    import.meta.url,
  ).href);
  const backupRoute = await import(new URL(
    "../../../../../../artifacts/api-server/src/imported/library/audio-backup/route.ts",
    import.meta.url,
  ).href);

  const options = await conversionsRoute.GET();
  const formats = (await options.json() as { formats: Array<{ id: string; available: boolean }> }).formats;
  if (!formats.some((format) => format.id === "flac" && format.available)) {
    context.skip("FFmpeg and its FLAC encoder are required for the conversion-route integration test.");
    return;
  }

  const sourcePath = path.join(root!, "converted-audio-backup-source.wav");
  writeWav(sourcePath, 1, 440);
  const originalBytes = readFileSync(sourcePath);
  const originalChecksum = createHash("sha256").update(originalBytes).digest("hex");
  const upload = new FormData();
  upload.append("file", new File([originalBytes], "Backup handoff source.wav", { type: "audio/wav" }));
  upload.append("title", "Converted Backup Handoff");
  upload.append("artist", "Integration Artist");
  upload.append("album", "Integration Album");

  const intakeResponse = await tracksRoute.POST(new Request("http://localhost/api/library/tracks", {
    method: "POST",
    body: upload,
  }));
  assert.equal(intakeResponse.status, 201, await intakeResponse.clone().text());
  const intake = await intakeResponse.json() as { track: { id: string } };
  const originalTrackId = intake.track.id;

  const conversionResponse = await conversionsRoute.POST(new Request("http://localhost/api/library/conversions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      trackId: originalTrackId,
      format: "flac",
      bitrate: 192,
      rightsReviewed: true,
    }),
  }));
  assert.ok([200, 202].includes(conversionResponse.status), await conversionResponse.clone().text());
  const conversion = await conversionResponse.json() as { id: string };

  const { libraryConversionJobs } = await import("@workspace/db/waveyardSchema");
  let completedJob: typeof libraryConversionJobs.$inferSelect | undefined;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    [completedJob] = await db.db.select().from(libraryConversionJobs)
      .where(eq(libraryConversionJobs.id, conversion.id)).limit(1);
    assert.ok(completedJob, "the conversion route persisted a durable job");
    if (completedJob.status === "complete" || completedJob.status === "failed") break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(completedJob?.status, "complete", completedJob?.errorMessage ?? "conversion completes before the integration-test deadline");
  assert.ok(completedJob.convertedTrackId, "the completed job links the converted library track");

  const libraryResponse = await tracksRoute.GET(new Request("http://localhost/api/library/tracks"));
  assert.equal(libraryResponse.status, 200);
  const library = await libraryResponse.json() as { tracks: Array<{ id: string }> };
  assert.ok(library.tracks.some((track) => track.id === completedJob!.convertedTrackId),
    "the converted track is visible through the authenticated library route");
  assert.ok(library.tracks.some((track) => track.id === originalTrackId),
    "the original remains in the library beside its conversion");
  assert.deepEqual(readFileSync(sourcePath), originalBytes, "conversion leaves the generated source file byte-identical");
  assert.equal(await checksumFile(sourcePath), originalChecksum);

  const [originalRow] = await db.db.select().from(schema.tracks)
    .where(eq(schema.tracks.id, originalTrackId)).limit(1);
  assert.ok(originalRow);
  const [originalSource] = await db.db.select().from(schema.sourceAssets)
    .where(eq(schema.sourceAssets.id, originalRow.sourceAssetId)).limit(1);
  assert.ok(originalSource);
  const storedOriginalPath = getStorage().getLocalPath(originalSource.storageKey);
  assert.ok(storedOriginalPath, "the original remains addressable in private local storage");
  assert.deepEqual(readFileSync(storedOriginalPath), originalBytes, "the original stored asset remains byte-identical");

  const backupResponse = await backupRoute.GET(new Request(
    `http://localhost/api/library/audio-backup?ids=${completedJob.convertedTrackId}`,
  ));
  assert.equal(backupResponse.status, 200, await backupResponse.clone().text());
  assert.match(backupResponse.headers.get("content-type") ?? "", /application\/zip/i);
  const archivePath = path.join(root!, "converted-track-audio-backup.zip");
  writeFileSync(archivePath, Buffer.from(await backupResponse.arrayBuffer()));

  const [convertedRow] = await db.db.select().from(schema.tracks)
    .where(eq(schema.tracks.id, completedJob.convertedTrackId)).limit(1);
  assert.ok(convertedRow);
  const [convertedSource] = await db.db.select().from(schema.sourceAssets)
    .where(eq(schema.sourceAssets.id, convertedRow.sourceAssetId)).limit(1);
  assert.ok(convertedSource);
  const storedConvertedPath = getStorage().getLocalPath(convertedSource.storageKey);
  assert.ok(storedConvertedPath, "the converted audio is in private local storage");
  const convertedBytes = readFileSync(storedConvertedPath);
  const convertedChecksum = createHash("sha256").update(convertedBytes).digest("hex");
  assert.equal(convertedSource.checksumSha256, convertedChecksum);

  const verifiedBackup = await restoreVerifiedAudioBackupZip(archivePath, async (manifest, extractedPath) => ({
    manifest,
    bytes: readFileSync(extractedPath),
  }));
  assert.equal(verifiedBackup.results.length, 1);
  const [backupEntry] = verifiedBackup.results;
  assert.ok(backupEntry);
  assert.equal(backupEntry.manifest.trackId, completedJob.convertedTrackId);
  assert.equal(backupEntry.manifest.codec, "flac");
  assert.equal(backupEntry.manifest.fileSizeBytes, convertedBytes.length);
  assert.equal(backupEntry.manifest.sha256, convertedChecksum, "the manifest records the converted file's SHA-256");
  assert.deepEqual(backupEntry.bytes, convertedBytes, "the downloaded ZIP contains the exact converted file bytes");
});

// Keep this after the shared-fixture checks, which intentionally count the first
// intake's rows. Requires the running preview, Chromium and pinned Kim model:
// WAVEYARD_RUN_REAL_LIBRARY_RETRY=1 pnpm --filter @workspace/scripts exec tsx --test <absolute path to this file>
test("library retry action completes its original job through the real stem worker", {
  skip: process.env.WAVEYARD_RUN_REAL_LIBRARY_RETRY !== "1",
  timeout: 180_000,
}, async t => {
  assert.ok(client && root);
  const { verifyLibraryRetryWithRealWorker } = await import("./retry-worker-acceptance.test-helper");
  const result = await verifyLibraryRetryWithRealWorker({
    database: db.db, client, directory: root, addTrack: service.addTrackFromAudioFile,
  });
  t.diagnostic(`Real library retry: ${result.separation.privateOutputCount} stems on ${result.separation.resolvedDevice} in ${result.performance.elapsedMs} ms; one-second synthetic input, not Windows or separation-quality evidence.`);
});

test("library default four-stem retry reaches real live-mixing controls", {
  skip: process.env.WAVEYARD_RUN_REAL_LIBRARY_RETRY !== "1",
  timeout: 1_260_000,
}, async t => {
  assert.ok(client && root);
  const { verifyLibraryRetryWithRealWorker } = await import("./retry-worker-acceptance.test-helper");
  const realInputs = [
    process.env.WAVEYARD_REAL_LIBRARY_AUDIO_INPUT?.trim(),
    process.env.WAVEYARD_REAL_LIBRARY_INCOMING_AUDIO_INPUT?.trim(),
  ].filter((path): path is string => Boolean(path));
  const result = await verifyLibraryRetryWithRealWorker({
    database: db.db, client, directory: root, addTrack: service.addTrackFromAudioFile,
    recipe: "default-four-stem",
    audioInputPath: process.env.WAVEYARD_REAL_LIBRARY_AUDIO_INPUT?.trim() || undefined,
    incomingAudioInputPath: process.env.WAVEYARD_REAL_LIBRARY_INCOMING_AUDIO_INPUT?.trim() || undefined,
  });
  t.diagnostic(`Default-recipe library retry and transition: ${JSON.stringify(result)}. ${realInputs.length}/2 source files were supplied as real audio; remaining files are four-second synthetic controls. Pinned CPU execution and UI routing do not establish subjective separation quality or Windows performance.`);
});

// Exercises a generated, non-DRM AAC stream in an M4A container through the
// same default four-model CPU path, persisted outputs, and real mixer controls.
// Opt in separately so this does not run two long four-model jobs by default.
test("AAC/M4A library import creates a playable isolated four-stem mix", {
  skip: process.env.WAVEYARD_RUN_REAL_LIBRARY_M4A !== "1",
  timeout: 720_000,
}, async t => {
  assert.ok(client && root);
  const { verifyLibraryRetryWithRealWorker } = await import("./retry-worker-acceptance.test-helper");
  const result = await verifyLibraryRetryWithRealWorker({
    database: db.db,
    client,
    directory: root,
    addTrack: service.addTrackFromAudioFile,
    recipe: "default-four-stem",
    inputFormat: "m4a",
    withIncomingTrack: false,
  });
  assert.match(result.codecImport.container ?? "", /mov,mp4,m4a/i);
  assert.equal(result.codecImport.codec, "aac");
  assert.equal(result.codecImport.mimeType, "audio/mp4");
  assert.equal(result.codecImport.originalFilename, "Fixture - Library AAC acceptance.m4a");
  assert.equal(result.codecImport.sampleRate, 44_100);
  assert.equal(result.codecImport.channels, 2);
  assert.equal(result.codecImport.inputUnchanged, true);
  assert.deepEqual(result.separation.outputStemTypes, ["bass", "drums", "other", "vocals"]);
  assert.equal(result.separation.resolvedDevice, "cpu");
  assert.deepEqual(result.separation.completedModelPasses, FOUR_STEM_MODELS.map(model => model.id));
  assert.equal(result.separation.privateOutputCount, 4);
  assert.deepEqual(result.separation.isolatedStemTypes, ["bass", "drums", "other", "vocals"]);
  assert.equal(result.separation.subjectiveQualityAssessed, false);
  assert.equal(result.performance.windowsPerformanceMeasured, false);
  t.diagnostic(`Codec/import evidence: ${JSON.stringify(result.codecImport)}. FFmpeg generated a disposable non-DRM AAC/M4A; the imported metadata matches ffprobe.`);
  t.diagnostic(`Separation/mixer evidence: ${JSON.stringify(result.separation)}. Four pinned CPU outputs were persisted, served privately, decoded by the live mixer, and each isolation control muted the other three. Subjective separation quality was not assessed.`);
  t.diagnostic(`Performance evidence: ${JSON.stringify(result.performance)}. This Linux CPU duration is not Windows performance evidence.`);
});

// Opt-in real CPU load and HTTP latency measurement, using this suite's private
// PostgreSQL/storage. WAVEYARD_RUN_REAL_API_RESPONSIVENESS=1 enables it.
test("four-model separation keeps real library and session HTTP routes responsive", {
  skip: process.env.WAVEYARD_RUN_REAL_API_RESPONSIVENESS !== "1",
  timeout: 600_000,
}, async t => {
  assert.ok(root);
  const { verifyApiResponsivenessDuringSeparation } = await import("./api-responsiveness.test-helper");
  const result = await verifyApiResponsivenessDuringSeparation({
    database: db.db, directory: root, addTrack: service.addTrackFromAudioFile, port: await freePort(),
  });
  t.diagnostic(`Real routed HTTP responsiveness: ${JSON.stringify(result)}. Two-second synthetic input on Linux CPU; not Windows throughput or subjective audio-quality evidence.`);
});

// End-to-end control check: a prepared, audible session track stays usable
// while a different library track runs all four pinned CPU models.
test("live session controls remain usable during real four-model separation", {
  skip: process.env.WAVEYARD_RUN_REAL_LIVE_CONTROLS !== "1",
  timeout: 600_000,
}, async t => {
  assert.ok(root);
  const { createLiveControlsBrowserDriver } = await import("./live-controls-during-separation.test-helper");
  const { verifyApiResponsivenessDuringSeparation } = await import("./api-responsiveness.test-helper");
  const browserDriver = await createLiveControlsBrowserDriver();
  try {
    const result = await verifyApiResponsivenessDuringSeparation({
      database: db.db, directory: root, addTrack: service.addTrackFromAudioFile, port: await freePort(),
      liveSeparationHooks: {
        onPrepared: browserDriver.onPrepared,
        onVerifiedPhase: browserDriver.onVerifiedPhase,
        onCompleted: browserDriver.onCompleted,
      },
    });
    t.diagnostic(`Real worker/browser controls on Linux CPU: ${JSON.stringify(result)}. The playing track uses prepared test stems; the other track runs the pinned stems_4 worker. Not Windows throughput or separation-quality evidence.`);
  } finally {
    await browserDriver.close();
  }
});
