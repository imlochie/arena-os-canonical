#!/usr/bin/env node
/**
 * PRODUCT-PREVIEW FIXTURE SEEDER — Waveyard live session.
 *
 * This is acceptance scaffolding, NOT application code and NOT separation.
 * The sandbox cannot run the MDX/Demucs models (model weights are fetched from
 * blocked hosts), so this script:
 *
 *   1. imports two real WAV songs through the application's own library intake
 *      (`addTrackFromAudioFile` → ffprobe inspect, storage write, DB rows);
 *   2. publishes CONTROLLED PCM stems — one pure sine per stem category, a
 *      distinct frequency per (song, category) pair — against a dedicated
 *      completed processing job, with real storage objects and SHA-256
 *      checksums, so the application's own asset route and Web Audio path
 *      serve them;
 *   3. creates a listening session through the application's session service.
 *
 * Every stem row is labelled engine/model "controlled-pcm-fixture". Nothing
 * here is learned separation, inference, or evidence of musical quality.
 *
 * Run from the repository root:
 *   node --import ./scripts/register-src-loader.mjs <this file>
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

const root = process.cwd();
// Load .env exactly like the app's scripts do (first definition wins).
// The test loader pre-sets a throwaway DATABASE_URL; the .env file is the
// authoritative runtime configuration for this acceptance run.
for (const line of readFileSync(path.join(root, ".env"), "utf8").split(/\r?\n/)) {
  const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
  if (match && ["DATABASE_URL", "WAVEYARD_STORAGE_DIR", "WAVEYARD_MODELS_DIR"].includes(match[1])) process.env[match[1]] = match[2];
}
process.env.WAVEYARD_STORAGE_DIR ||= path.join(root, ".data/waveyard-storage");

const { db, pool } = await import("@/db");
const schema = await import("@/db/waveyardSchema");
const service = await import("@/lib/waveyard/library/service");
const sessions = await import("@/lib/waveyard/library/session-service");
const { LOCAL_OWNER_ID } = await import("@/lib/waveyard/local-context");
const { getStorage } = await import("@/lib/waveyard/storage");

const CATEGORIES = ["vocals", "drums", "bass", "instruments"];
const GAINS = [0.73, 0.41, 0.62, 0.91];
const FREQUENCIES = [
  [220, 440, 660, 880],
  [1100, 1320, 1540, 1760],
];

function pcm(hz, seconds = 90) {
  const frames = Math.round(44100 * seconds);
  const bytes = Buffer.alloc(44 + frames * 2);
  bytes.write("RIFF"); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(44100, 24); bytes.writeUInt32LE(88200, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36); bytes.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) bytes.writeInt16LE(Math.round(8192 * Math.sin((2 * Math.PI * hz * i) / 44100)), 44 + i * 2);
  return bytes;
}

const { sql } = await import("drizzle-orm");
// Idempotence: remove ONLY this scaffolding's own rows (identified by their
// explicit fixture labels), never application data. Sessions cascade to their
// tracks/swaps; swaps must go before the stem rows they reference.
await db.execute(sql`delete from wy_listen_sessions where name like 'Product preview · live session%'`);
await db.execute(sql`delete from stem_assets where model = 'controlled-pcm-fixture'`);
await db.execute(sql`delete from processing_jobs where model = 'controlled-pcm-fixture'`);

const work = path.join(tmpdir(), `arena-waveyard-fixture-${process.pid}`);
const runTag = new Date().toISOString().replace(/[:.]/g, "-");
mkdirSync(work, { recursive: true });

const tracks = [];
const assets = [];
const stemRows = [];
for (const song of [0, 1]) {
  const sourceFile = path.join(work, `controlled-song-${song}.wav`);
  // The two "songs" are different carrier tones; the session is about routing,
  // not about these being musically interesting.
  writeFileSync(sourceFile, pcm(200 + song * 100, 90));
  const intake = await service.addTrackFromAudioFile({
    ownerId: LOCAL_OWNER_ID,
    filePath: sourceFile,
    filename: `controlled-song-${song}-90s.wav`,
    mimeType: "audio/wav",
    title: `Controlled song ${song}`,
    artist: "Acceptance fixture",
    prepareSeparation: false,
  });
  tracks.push(intake.track.id);
  const detail = await service.getTrack(LOCAL_OWNER_ID, intake.track.id);
  if (!detail?.source) throw new Error(`track ${intake.track.id} has no source asset`);

  // A dedicated, completed job owns the fixture stems so any background
  // intake job's lifecycle can never invalidate them.
  const [job] = await db.insert(schema.processingJobs).values({
    projectId: intake.track.studioProjectId,
    sourceAssetId: detail.source.id,
    type: "separation",
    status: "complete",
    stage: "complete",
    idempotencyKey: `fixture:${detail.source.id}:${Date.now()}:${song}`,
    model: "controlled-pcm-fixture",
    requestedDevice: "cpu",
    resolvedDevice: "fixture",
    completedAt: new Date(),
  }).returning();

  assets[song] = [];
  for (const [i, stemType] of CATEGORIES.entries()) {
    const storageKey = `controlled-live/${runTag}/${song}/${stemType}.wav`;
    const bytes = pcm(FREQUENCIES[song][i], 90);
    const localPath = getStorage().getLocalPath(storageKey);
    mkdirSync(path.dirname(localPath), { recursive: true });
    writeFileSync(localPath, bytes);
    const checksumSha256 = createHash("sha256").update(bytes).digest("hex");
    const [asset] = await db.insert(schema.stemAssets).values({
      projectId: intake.track.studioProjectId,
      sourceAssetId: detail.source.id,
      separationJobId: job.id,
      stemType,
      engine: "controlled-pcm-fixture",
      model: "controlled-pcm-fixture",
      modelVersion: "fixture-v1",
      storageKey,
      checksumSha256,
      durationSeconds: 90,
      sampleRate: 44100,
      channels: 1,
      codec: "pcm_s16le",
      format: "wav",
      fileSizeBytes: bytes.length,
    }).returning();
    assets[song].push(asset.id);
    stemRows.push({ song, stemType, assetId: asset.id, frequencyHz: FREQUENCIES[song][i], checksumSha256 });
  }
}

const created = await sessions.createSession(LOCAL_OWNER_ID, `Product preview · live session ${new Date().toISOString().slice(11,19)}`);
for (const trackId of tracks) await sessions.addTrackToSession({ ownerId: LOCAL_OWNER_ID, sessionId: created.id, trackId });
const detail = await sessions.getSession(LOCAL_OWNER_ID, created.id);
for (const item of detail.tracks) {
  await sessions.updateSessionTrack(LOCAL_OWNER_ID, created.id, item.id, {
    stemMix: Object.fromEntries(CATEGORIES.map((name, i) => [name, GAINS[i]])),
  });
}

const fixture = {
  kind: "controlled-pcm-fixture",
  limitation: "Synthetic sine stems inserted by acceptance scaffolding; not separation output, not inference, not musical-quality evidence.",
  sessionId: created.id,
  sessionUrl: `/waveyard/session/${created.id}`,
  trackIds: tracks,
  segmentIds: detail.tracks.map(item => item.id),
  categories: CATEGORIES,
  gains: GAINS,
  frequencies: FREQUENCIES,
  assets,
  stems: stemRows,
  createdAt: new Date().toISOString(),
};
const out = path.join(root, ".data/acceptance/product-preview/waveyard-fixture.json");
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(fixture, null, 2));
console.log(JSON.stringify({ fixture: out, sessionId: created.id, tracks, assets }, null, 2));
await pool.end();
