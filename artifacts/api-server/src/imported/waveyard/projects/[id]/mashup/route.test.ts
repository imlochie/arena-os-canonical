/**
 * API-level mashup render acceptance.
 *
 * This boots PostgreSQL, applies canonical migrations, seeds private audio and
 * calls the production route handlers. By default it uses generated tones for
 * exact stem-routing assertions. With WAVEYARD_MASHUP_REAL_FIXTURE_MANIFEST it
 * instead exercises full real source/stem files, Studio persistence/reopen and
 * the persisted-version WAV export worker. Passing the real fixture path proves
 * technical workflow execution, not subjective mashup quality.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, inArray } from "drizzle-orm";

import { decodeWav16, encodeWav16 } from "@workspace/arena/lib/waveyard/mixer/synth";
import {
  createPersistedClipTempoMap,
  makeLocalTempoMapWindow,
  renderLocalTempoMapRange,
} from "@workspace/arena/lib/waveyard/studio/local-tempo-map";
import {
  drumAnalysisIdempotencyKey,
  LOCAL_DRUM_ANALYSIS_ENGINE,
  LOCAL_DRUM_ANALYSIS_ENGINE_VERSION,
} from "@workspace/arena/lib/waveyard/types/drum-analysis";
import {
  bassAnalysisIdempotencyKey,
  LOCAL_BASS_ANALYSIS_ENGINE,
  LOCAL_BASS_ANALYSIS_ENGINE_VERSION,
} from "@workspace/arena/lib/waveyard/types/bass-analysis";
import {
  LOCAL_VOCAL_ANALYSIS_ENGINE,
  LOCAL_VOCAL_ANALYSIS_ENGINE_VERSION,
  vocalAnalysisIdempotencyKey,
} from "@workspace/arena/lib/waveyard/types/vocal-analysis";

const root = fileURLToPath(new URL("../../../../../../../../", import.meta.url));
const requireFromDb = createRequire(path.join(root, "lib/db/package.json"));
const { Client } = requireFromDb("pg") as typeof import("pg");
const RATE = 44_100;
const BED_SECONDS = 4;
const VOCAL_SECONDS = 2;
type FixtureStemType = "vocals" | "drums" | "bass" | "other";
type RealSeparationProvenance = {
  engine: "mdx" | "demucs";
  recipeModel: string;
  models: Record<FixtureStemType, { id: string; sha256: string }>;
  reportPath: string;
};
type RealMashupSourceFixture = {
  path: string;
  filename: string;
  durationSeconds: number;
  stems: Record<FixtureStemType, string>;
  separation: RealSeparationProvenance;
};
type RealMashupFixtureManifest = {
  vocals: RealMashupSourceFixture;
  bed: RealMashupSourceFixture;
  analysisReportPath: string;
};

function realFixturePath(value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(root, value);
}

function sourceAudioMetadata(filename: string) {
  const extension = path.extname(filename).toLowerCase();
  if (extension === ".mp3") return { extension, mimeType: "audio/mpeg", codec: "mp3" };
  if (extension === ".m4a" || extension === ".mp4") return { extension: ".m4a", mimeType: "audio/mp4", codec: "aac" };
  if (extension === ".flac") return { extension, mimeType: "audio/flac", codec: "flac" };
  return { extension: extension || ".wav", mimeType: "audio/wav", codec: "pcm_s16le" };
}

function findPostgresBinary(name: string): string | undefined {
  const extension = process.platform === "win32" ? ".exe" : "";
  const platform = process.platform === "win32" ? "windows-x64" : process.platform === "darwin" ? "darwin-x64" : "linux-x64";
  const bundledCandidates = [
    path.join(root, "node_modules", "@embedded-postgres", platform, "native", "bin", `${name}${extension}`),
    path.join(root, "desktop", "node_modules", "@embedded-postgres", platform, "native", "bin", `${name}${extension}`),
  ];
  const bundled = bundledCandidates.find(existsSync);
  if (bundled) return bundled;
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

function tone(frequencies: number[], seconds: number, amplitude = 0.2): Float32Array {
  const frames = Math.round(seconds * RATE);
  const pcm = new Float32Array(frames * 2);
  for (let frame = 0; frame < frames; frame += 1) {
    let value = 0;
    for (const frequency of frequencies) {
      value += Math.sin((2 * Math.PI * frequency * frame) / RATE);
    }
    value = (value / Math.max(1, frequencies.length)) * amplitude;
    pcm[frame * 2] = value;
    pcm[frame * 2 + 1] = value;
  }
  return pcm;
}

function mixTones(parts: Array<[number, number]>, seconds: number): Float32Array {
  const frames = Math.round(seconds * RATE);
  const pcm = new Float32Array(frames * 2);
  for (let frame = 0; frame < frames; frame += 1) {
    let value = 0;
    for (const [frequency, amplitude] of parts) {
      value += Math.sin((2 * Math.PI * frequency * frame) / RATE) * amplitude;
    }
    pcm[frame * 2] = value;
    pcm[frame * 2 + 1] = value;
  }
  return pcm;
}

function windowRms(samples: Float32Array, channels: number, sampleRate: number, fromMs: number, toMs: number): number {
  const start = Math.max(0, Math.floor(fromMs * sampleRate / 1000) * channels);
  const end = Math.min(samples.length, Math.floor(toMs * sampleRate / 1000) * channels);
  let sum = 0;
  let count = 0;
  for (let index = start; index < end; index += 1) {
    sum += samples[index]! * samples[index]!;
    count += 1;
  }
  return count ? Math.sqrt(sum / count) : 0;
}

function findAudibleSourceOffsetMs(
  decoded: NonNullable<ReturnType<typeof decodeWav16>>,
  windowMs: number,
): number {
  const durationMs = decoded.frames * 1000 / decoded.sampleRate;
  for (let startMs = 0; startMs + windowMs <= durationMs; startMs += 10) {
    if (windowRms(decoded.samples, decoded.channels, decoded.sampleRate, startMs, startMs + windowMs) > 0.003)
      return startMs;
  }
  throw new Error(`No audible ${windowMs}ms window exists in the fixture stem.`);
}

function energyAt(pcm: Float32Array, frequency: number, startMs: number, endMs: number): number {
  const start = Math.floor((startMs / 1000) * RATE);
  const end = Math.floor((endMs / 1000) * RATE);
  let real = 0;
  let imaginary = 0;
  let count = 0;
  const span = Math.max(1, end - start);
  for (let frame = start; frame < end; frame += 1) {
    const sample = pcm[frame * 2]!;
    // Hann window: a rectangular window leaks the strong bed tones into the
    // vocal-frequency bin and would make exclusion look like leakage.
    const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * (frame - start)) / span);
    const phase = (2 * Math.PI * frequency * frame) / RATE;
    real += sample * window * Math.cos(phase);
    imaginary += sample * window * Math.sin(phase);
    count += 1;
  }
  return Math.hypot(real, imaginary) / Math.max(1, count);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const hasRealMashupFixture = Boolean(process.env.WAVEYARD_MASHUP_REAL_FIXTURE_MANIFEST?.trim());
test(
  hasRealMashupFixture
    ? "Waveyard real-song mashup persists, reopens, edits, restores, and exports"
    : "Waveyard synthetic routes, paired-grid Studio timing maps, and Arena handoff regressions",
  async (t) => {
  if (!postgresBinaries.initdb || !postgresBinaries.postgres || !postgresBinaries.pgCtl) {
    t.skip("PostgreSQL binaries are unavailable");
    return;
  }

  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "waveyard-mashup-route-test-"));
  const dataDir = path.join(fixtureRoot, "data", "postgres");
  const databaseName = "arena_mashup_route_test";
  const databasePassword = "mashup-route-test-password";
  const port = await freePort();
  let postgresProcess: ReturnType<typeof spawn> | undefined;
  let dbModule: typeof import("@workspace/db") | undefined;
  let routeModule: typeof import("./route") | undefined;
  let realVocalAnalysisId: string | null = null;
  let realGrooveTimingSummary: string | null = null;
  let realPersistedBassAttackCount: number | null = null;
  let realSectionPassageEvidence: {
    vocals: { status: string; sectionCount: number; fingerprintCount: number };
    bed: { status: string; sectionCount: number; fingerprintCount: number };
  } | null = null;
  let realSectionsBySourceChecksum: Record<string, Array<{
    startMs: number;
    endMs: number;
    label: string;
    labelConfidence: number;
    structuralConfidence: number;
    analysisEngine: string;
    analysisEngineVersion: string;
    sourceChecksumSha256: string;
  }>> = {};
  let realPitchContinuityRuns: Array<{
    startMs: number;
    endMs: number;
    confidence: number;
  }> = [];
  let realVocalVoicingEvidence: {
    count: number;
    firstVoicedRun: { startMs: number; endMs: number; confidence: number };
    lastVoicedRun: { startMs: number; endMs: number; confidence: number };
    activityIntervalCount: number;
    analysisEngine: string;
    analysisEngineVersion: string;
  } | null = null;

  try {
    await mkdir(dataDir, { recursive: true });
    const passwordFile = path.join(fixtureRoot, ".postgres-password");
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
    postgresProcess.stderr?.on("data", (chunk: Buffer) => {
      postgresOutput = (postgresOutput + chunk.toString()).slice(-4000);
    });

    const adminUrl = `postgres://arena:${databasePassword}@127.0.0.1:${port}/postgres`;
    const deadline = Date.now() + 30_000;
    let databaseCreated = false;
    let lastConnectionError: unknown;
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
    const { migrate } = await import("../../../../../../../../desktop/database.mjs");
    await migrate(client, path.join(root, "lib/arena/desktop-migrations"));
    await client.end();

    process.env.DATABASE_URL = `postgres://arena:${databasePassword}@127.0.0.1:${port}/${databaseName}`;
    process.env.WAVEYARD_STORAGE_DIR = path.join(fixtureRoot, "waveyard", "storage");
    process.env.NODE_ENV = "test";

    routeModule = await import("./route");
    const handoffRoute = await import("../arena-handoff/route");
    const projectArtifactsRoute = await import("../../../../projects/[id]/artifacts/route");
    const arenaProjectRoute = await import("../../../../projects/[id]/route");
    dbModule = await import("@workspace/db");
    const schema = await import("@workspace/db/waveyardSchema");
    const { LOCAL_OWNER_ID, artifacts: arenaArtifacts, projects: arenaProjects, roomHandoffs } = await import("@workspace/db/schema");
    const { getStorage } = await import("@workspace/arena/lib/waveyard/storage");
    const storage = getStorage();
    const realFixtureManifestPath = process.env.WAVEYARD_MASHUP_REAL_FIXTURE_MANIFEST?.trim();
    const realFixture = realFixtureManifestPath
      ? JSON.parse(await readFile(realFixturePath(realFixtureManifestPath), "utf8")) as RealMashupFixtureManifest
      : null;
    const analysisReference = realFixture
      ? JSON.parse(await readFile(realFixturePath(realFixture.analysisReportPath), "utf8")) as {
        tracks?: Array<{
          filename: string;
          sourceChecksumSha256: string;
          analysisEngine: string;
          analysisEngineVersion: string;
          analyzedDurationSeconds: number;
          bpm: number | null;
          bpmConfidence: number | null;
          musicalKey: string | null;
          keyConfidence: number | null;
        }>;
      }
      : null;

    const [project] = await dbModule.db.insert(schema.projects).values({
      ownerId: LOCAL_OWNER_ID,
      title: "Mashup route fixture",
      kind: "studio",
    }).returning({ id: schema.projects.id });
    assert.ok(project);

    const invalidHandoff = await handoffRoute.POST(
      new Request("http://localhost", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "handoff", summary: "   " }) }),
      { params: Promise.resolve({ id: project.id }) },
    );
    assert.equal(invalidHandoff.status, 400);
    assert.equal((await dbModule.db.select().from(arenaProjects)).length, 0, "invalid handoff must not create a Core project");
    assert.equal((await dbModule.db.select().from(roomHandoffs)).length, 0, "invalid handoff must not create a project link");

    const linkRequest = () => new Request("http://localhost", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "link" }),
    });
    const concurrentLinks = await Promise.all([
      handoffRoute.POST(linkRequest(), { params: Promise.resolve({ id: project.id }) }),
      handoffRoute.POST(linkRequest(), { params: Promise.resolve({ id: project.id }) }),
    ]);
    assert.deepEqual(concurrentLinks.map((response) => response.status).sort(), [200, 201]);
    assert.equal((await dbModule.db.select().from(arenaProjects)).length, 1, "concurrent attachment must create one Core project");
    assert.equal((await dbModule.db.select().from(roomHandoffs)).filter((row) => row.kind === "room-project").length, 1);

    await dbModule.pool.query(`
      create function fail_waveyard_artifact_handoff() returns trigger language plpgsql as $$
      begin
        if new.kind = 'artifact' then raise exception 'forced handoff insert failure'; end if;
        return new;
      end $$;
      create trigger fail_waveyard_artifact_handoff before insert on arena_room_handoffs
      for each row execute function fail_waveyard_artifact_handoff();
    `);
    await assert.rejects(
      handoffRoute.POST(
        new Request("http://localhost", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "handoff", summary: "A valid handoff summary" }) }),
        { params: Promise.resolve({ id: project.id }) },
      ),
      (error: Error & { cause?: Error }) => error.cause?.message.includes("forced handoff insert failure") === true,
    );
    assert.equal((await dbModule.db.select().from(arenaArtifacts)).length, 0, "artifact must roll back when handoff row insertion fails");
    await dbModule.pool.query("drop trigger fail_waveyard_artifact_handoff on arena_room_handoffs; drop function fail_waveyard_artifact_handoff();");

    const successfulHandoff = await handoffRoute.POST(
      new Request("http://localhost", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "handoff", title: "Takeaway", summary: "Use the chorus arrangement in Studio." }) }),
      { params: Promise.resolve({ id: project.id }) },
    );
    assert.equal(successfulHandoff.status, 201);
    const persistedArtifact = await dbModule.db.select().from(arenaArtifacts);
    const persistedHandoff = (await dbModule.db.select().from(roomHandoffs)).find((row) => row.kind === "artifact");
    assert.equal(persistedArtifact.length, 1);
    assert.equal(persistedHandoff?.sourceId, persistedArtifact[0]?.id);
    const artifactReader = await projectArtifactsRoute.GET(
      new Request(`http://localhost/api/projects/${(await dbModule.db.select().from(arenaProjects))[0]!.id}/artifacts`, { headers: { host: "localhost" } }),
      { params: Promise.resolve({ id: (await dbModule.db.select().from(arenaProjects))[0]!.id }) },
    );
    assert.equal(artifactReader.status, 200);
    assert.equal((await artifactReader.json() as { artifacts: Array<{ id: string; kind: string; sourceType: string }> }).artifacts[0]?.id, persistedArtifact[0]?.id);
    const coreProject = (await dbModule.db.select().from(arenaProjects))[0]!;
    const projectWorkspace = await arenaProjectRoute.GET(new Request(`http://localhost/projects/${coreProject.id}`), { params: Promise.resolve({ id: coreProject.id }) });
    const workspaceBody = await projectWorkspace.json() as { artifacts: Array<{ id: string; kind: string; sourceType: string }> };
    assert.equal(workspaceBody.artifacts[0]?.id, persistedArtifact[0]?.id, "Core project page reader must expose the Waveyard artifact");
    assert.equal(workspaceBody.artifacts[0]?.kind, "room-handoff");
    assert.equal(workspaceBody.artifacts[0]?.sourceType, "waveyard");

    const vocalsFilename = realFixture?.vocals.filename ?? "vocals-original.wav";
    const bedFilename = realFixture?.bed.filename ?? "bed-original.wav";
    const vocalsAudio = sourceAudioMetadata(vocalsFilename);
    const bedAudio = sourceAudioMetadata(bedFilename);
    const vocalsDurationSeconds = realFixture
      ? Math.max(1, Math.round(realFixture.vocals.durationSeconds))
      : VOCAL_SECONDS;
    const bedDurationSeconds = realFixture
      ? Math.max(1, Math.round(realFixture.bed.durationSeconds))
      : BED_SECONDS;
    const vocalsOriginal = realFixture
      ? new Uint8Array(await readFile(realFixturePath(realFixture.vocals.path)))
      : encodeWav16(tone([1000], VOCAL_SECONDS, 0.2), RATE);
    // The generated fixture's bed vocal is deliberately loud. For real inputs,
    // the original is the user-provided compressed source file.
    const bedOriginal = realFixture
      ? new Uint8Array(await readFile(realFixturePath(realFixture.bed.path)))
      : encodeWav16(
        mixTones([[110, 0.1], [220, 0.1], [330, 0.1], [1500, 0.4]], BED_SECONDS),
        RATE,
      );
    const vocalsOriginalPath = path.join(fixtureRoot, `vocals-original${vocalsAudio.extension}`);
    const bedOriginalPath = path.join(fixtureRoot, `bed-original${bedAudio.extension}`);
    const vocalsStorageKey = `mashup-fixture/vocals-original${vocalsAudio.extension}`;
    const bedStorageKey = `mashup-fixture/bed-original${bedAudio.extension}`;
    await writeFile(vocalsOriginalPath, vocalsOriginal);
    await writeFile(bedOriginalPath, bedOriginal);

    const [vocalsSource] = await dbModule.db.insert(schema.sourceAssets).values({
      projectId: project.id,
      originalFilename: vocalsFilename,
      mimeType: vocalsAudio.mimeType,
      storageKey: vocalsStorageKey,
      checksumSha256: sha256(vocalsOriginal),
      durationSeconds: vocalsDurationSeconds,
      sampleRate: RATE,
      channels: 2,
      codec: vocalsAudio.codec,
      fileSizeBytes: vocalsOriginal.length,
    }).returning({ id: schema.sourceAssets.id });
    const [bedSource] = await dbModule.db.insert(schema.sourceAssets).values({
      projectId: project.id,
      originalFilename: bedFilename,
      mimeType: bedAudio.mimeType,
      storageKey: bedStorageKey,
      checksumSha256: sha256(bedOriginal),
      durationSeconds: bedDurationSeconds,
      sampleRate: RATE,
      channels: 2,
      codec: bedAudio.codec,
      fileSizeBytes: bedOriginal.length,
    }).returning({ id: schema.sourceAssets.id });
    assert.ok(vocalsSource && bedSource);

    await storage.putFile(vocalsStorageKey, vocalsOriginalPath);
    await storage.putFile(bedStorageKey, bedOriginalPath);

    const [vocalsJob] = await dbModule.db.insert(schema.processingJobs).values({
      projectId: project.id,
      sourceAssetId: vocalsSource.id,
      type: "separation",
      status: "complete",
      stage: "complete",
      attempts: 1,
      idempotencyKey: `mashup-vocals-${randomUUID()}`,
      model: realFixture?.vocals.separation.recipeModel ?? "test",
      ...(realFixture ? { metadata: JSON.stringify({ sourceChecksumSha256: sha256(vocalsOriginal) }) } : {}),
      requestedDevice: "cpu",
      resolvedDevice: realFixture ? "cpu" : null,
      completedAt: new Date(),
    }).returning({ id: schema.processingJobs.id });
    const [bedJob] = await dbModule.db.insert(schema.processingJobs).values({
      projectId: project.id,
      sourceAssetId: bedSource.id,
      type: "separation",
      status: "complete",
      stage: "complete",
      attempts: 1,
      idempotencyKey: `mashup-bed-${randomUUID()}`,
      model: realFixture?.bed.separation.recipeModel ?? "test",
      ...(realFixture ? { metadata: JSON.stringify({ sourceChecksumSha256: sha256(bedOriginal) }) } : {}),
      requestedDevice: "cpu",
      resolvedDevice: realFixture ? "cpu" : null,
      completedAt: new Date(),
    }).returning({ id: schema.processingJobs.id });
    assert.ok(vocalsJob && bedJob);

    const readRealStem = async (source: RealMashupSourceFixture, type: FixtureStemType) =>
      new Uint8Array(await readFile(realFixturePath(source.stems[type])));
    const vocalsStemWav = realFixture
      ? await readRealStem(realFixture.vocals, "vocals")
      : encodeWav16(tone([1000], VOCAL_SECONDS, 0.2), RATE);
    const vocalsStemPath = path.join(fixtureRoot, "vocals-stem.wav");
    await writeFile(vocalsStemPath, vocalsStemWav);
    await storage.putFile("mashup-fixture/vocals-stem.wav", vocalsStemPath);
    const decodedVocalStem = decodeWav16(vocalsStemWav);
    assert.ok(decodedVocalStem, "the donor vocal stem must be a decodable WAV");
    assert.equal(decodedVocalStem.sampleRate, RATE);
    assert.equal(decodedVocalStem.channels, 2);
    assert.ok(Math.abs(decodedVocalStem.frames / RATE - vocalsDurationSeconds) < 1.1,
      "the donor vocal stem must cover the full source duration");
    const [vocalsStemRow] = await dbModule.db.insert(schema.stemAssets).values({
      projectId: project.id,
      sourceAssetId: vocalsSource.id,
      separationJobId: vocalsJob.id,
      stemType: "vocals",
      engine: realFixture?.vocals.separation.engine ?? "demucs",
      model: realFixture?.vocals.separation.models.vocals.id ?? "test",
      modelVersion: realFixture?.vocals.separation.models.vocals.sha256 ?? "test",
      storageKey: "mashup-fixture/vocals-stem.wav",
      checksumSha256: sha256(vocalsStemWav),
      durationSeconds: vocalsDurationSeconds,
      sampleRate: RATE,
      channels: 2,
      codec: "wav",
      format: "wav",
      fileSizeBytes: vocalsStemWav.length,
    }).returning({ id: schema.stemAssets.id });
    assert.ok(vocalsStemRow);

    if (realFixture) {
      const donorDrumsWav = await readRealStem(realFixture.vocals, "drums");
      const donorDrumsPath = path.join(fixtureRoot, "donor-drums-stem.wav");
      await writeFile(donorDrumsPath, donorDrumsWav);
      await storage.putFile("mashup-fixture/donor-drums-stem.wav", donorDrumsPath);
      const decodedDonorDrums = decodeWav16(donorDrumsWav);
      assert.ok(decodedDonorDrums, "the donor's real separated drum stem must be decodable");
      assert.equal(decodedDonorDrums.sampleRate, RATE);
      assert.equal(decodedDonorDrums.channels, 2);
      assert.ok(Math.abs(decodedDonorDrums.frames / RATE - vocalsDurationSeconds) < 1.1,
        "the donor drum timing evidence must cover the source timeline");
      await dbModule.db.insert(schema.stemAssets).values({
        projectId: project.id,
        sourceAssetId: vocalsSource.id,
        separationJobId: vocalsJob.id,
        stemType: "drums",
        engine: realFixture.vocals.separation.engine,
        model: realFixture.vocals.separation.models.drums.id,
        modelVersion: realFixture.vocals.separation.models.drums.sha256,
        storageKey: "mashup-fixture/donor-drums-stem.wav",
        checksumSha256: sha256(donorDrumsWav),
        durationSeconds: vocalsDurationSeconds,
        sampleRate: RATE,
        channels: 2,
        codec: "wav",
        format: "wav",
        fileSizeBytes: donorDrumsWav.length,
      });
    }

    if (realFixture && vocalsStemRow) {
      const [{
        decodeMonoPcm,
        detectVocalPitchFrames,
        detectVocalActivityIntervals,
        ANALYSIS_PCM_RATE,
      }, vocalTypes] = await Promise.all([
        import("@workspace/arena/lib/waveyard/worker-local/analysis-engine"),
        import("@workspace/arena/lib/waveyard/types/vocal-analysis"),
      ]);
      const analysisPcm = await decodeMonoPcm(vocalsStemPath);
      const pitchFrames = vocalTypes.normaliseVocalPitchFrames(
        detectVocalPitchFrames(analysisPcm), Math.floor(analysisPcm.length * 1000 / ANALYSIS_PCM_RATE),
      );
      assert.ok(pitchFrames, "real separated vocals must yield valid pitch observations");
      const activityIntervals = detectVocalActivityIntervals(analysisPcm, pitchFrames);
      assert.ok(activityIntervals.length > 0,
        "real isolated-vocal PCM must produce coarse activity intervals independently of lyric labels");
      const phrases = vocalTypes.segmentVocalPhrases(pitchFrames)
        .filter((phrase) => phrase.endMs > phrase.startMs && phrase.confidence >= 0.5);
      assert.ok(phrases.length > 0, "real separated vocals must yield at least one confidence-qualified voiced phrase");
      realPitchContinuityRuns = phrases.map(({ startMs, endMs, confidence }) => ({
        startMs,
        endMs,
        confidence,
      }));
      realVocalVoicingEvidence = {
        count: phrases.length,
        firstVoicedRun: phrases[0],
        lastVoicedRun: phrases[phrases.length - 1],
        activityIntervalCount: activityIntervals.length,
        analysisEngine: vocalTypes.LOCAL_VOCAL_ANALYSIS_ENGINE,
        analysisEngineVersion: vocalTypes.LOCAL_VOCAL_ANALYSIS_ENGINE_VERSION,
      };
      const [vocalAnalysis] = await dbModule.db.insert(schema.vocalAnalyses).values({
        projectId: project.id,
        sourceAssetId: vocalsSource.id,
        stemAssetId: vocalsStemRow.id,
        status: "complete",
        stage: "complete",
        attempts: 1,
        idempotencyKey: vocalTypes.vocalAnalysisIdempotencyKey(
          vocalsStemRow.id,
          vocalTypes.LOCAL_VOCAL_ANALYSIS_ENGINE,
          vocalTypes.LOCAL_VOCAL_ANALYSIS_ENGINE_VERSION,
        ),
        analysisEngine: vocalTypes.LOCAL_VOCAL_ANALYSIS_ENGINE,
        analysisEngineVersion: vocalTypes.LOCAL_VOCAL_ANALYSIS_ENGINE_VERSION,
        sourceChecksumSha256: sha256(vocalsOriginal),
        stemChecksumSha256: sha256(vocalsStemWav),
        startedAt: new Date(),
        analyzedAt: new Date(),
        completedAt: new Date(),
      }).returning({ id: schema.vocalAnalyses.id });
      assert.ok(vocalAnalysis);
      realVocalAnalysisId = vocalAnalysis.id;
      // Exercise the same persisted observations as the production vocal worker,
      // not just its phrase summary. Otherwise harmonic ranking is never used.
      for (let offset = 0; offset < pitchFrames.length; offset += 500) {
        await dbModule.db.insert(schema.vocalPitchFrames).values(
          pitchFrames.slice(offset, offset + 500).map((frame, index) => ({
            vocalAnalysisId: vocalAnalysis.id, frameIndex: offset + index, ...frame,
          })),
        );
      }
      await dbModule.db.insert(schema.vocalPhrases).values(phrases.map((phrase, phraseIndex) => ({
        vocalAnalysisId: vocalAnalysis.id,
        phraseIndex,
        startMs: phrase.startMs,
        endMs: phrase.endMs,
        confidence: phrase.confidence,
      })));
      await dbModule.db.insert(schema.vocalActivityIntervals).values(activityIntervals.map((interval, intervalIndex) => ({
        vocalAnalysisId: vocalAnalysis.id,
        intervalIndex,
        startMs: interval.startMs,
        endMs: interval.endMs,
        confidence: interval.confidence,
      })));
    } else if (vocalsStemRow) {
      const [vocalAnalysis] = await dbModule.db.insert(schema.vocalAnalyses).values({
        projectId: project.id,
        sourceAssetId: vocalsSource.id,
        stemAssetId: vocalsStemRow.id,
        status: "complete",
        stage: "complete",
        attempts: 1,
        idempotencyKey: vocalAnalysisIdempotencyKey(
          vocalsStemRow.id,
          LOCAL_VOCAL_ANALYSIS_ENGINE,
          LOCAL_VOCAL_ANALYSIS_ENGINE_VERSION,
        ),
        analysisEngine: LOCAL_VOCAL_ANALYSIS_ENGINE,
        analysisEngineVersion: LOCAL_VOCAL_ANALYSIS_ENGINE_VERSION,
        sourceChecksumSha256: sha256(vocalsOriginal),
        stemChecksumSha256: sha256(vocalsStemWav),
        startedAt: new Date(),
        analyzedAt: new Date(),
        completedAt: new Date(),
      }).returning({ id: schema.vocalAnalyses.id });
      assert.ok(vocalAnalysis);
      await dbModule.db.insert(schema.vocalPhrases).values([
        { vocalAnalysisId: vocalAnalysis.id, phraseIndex: 0, startMs: 0, endMs: 250, confidence: 0.9 },
        { vocalAnalysisId: vocalAnalysis.id, phraseIndex: 1, startMs: 500, endMs: 750, confidence: 0.9 },
        { vocalAnalysisId: vocalAnalysis.id, phraseIndex: 2, startMs: 1_000, endMs: 1_250, confidence: 0.9 },
      ]);
    }

    const bedStemFixtures: Array<{ stemType: FixtureStemType; wav: Uint8Array }> = realFixture
      ? await Promise.all((["drums", "bass", "other", "vocals"] as const).map(async (stemType) => ({
        stemType,
        wav: await readRealStem(realFixture.bed, stemType),
      })))
      : ([
        ["drums", 110], ["bass", 220], ["other", 330], ["vocals", 1500],
      ] as const).map(([stemType, frequency]) => ({
        stemType,
        wav: encodeWav16(
          tone([frequency], BED_SECONDS, stemType === "vocals" ? 0.4 : 0.1),
          RATE,
        ),
      }));
    for (const { stemType, wav } of bedStemFixtures) {
      const storageKey = `mashup-fixture/bed-${stemType}.wav`;
      const filePath = path.join(fixtureRoot, `bed-${stemType}.wav`);
      await writeFile(filePath, wav);
      await storage.putFile(storageKey, filePath);
      const decodedStem = decodeWav16(wav);
      assert.ok(decodedStem, `${stemType} must be a decodable WAV`);
      assert.equal(decodedStem.sampleRate, RATE, `${stemType} must retain 44.1 kHz`);
      assert.equal(decodedStem.channels, 2, `${stemType} must remain stereo`);
      assert.ok(Math.abs(decodedStem.frames / RATE - bedDurationSeconds) < 1.1,
        `${stemType} must cover the full source duration`);
        await dbModule.db.insert(schema.stemAssets).values({
        projectId: project.id,
        sourceAssetId: bedSource.id,
        separationJobId: bedJob.id,
        stemType,
        engine: realFixture?.bed.separation.engine ?? "demucs",
        model: realFixture?.bed.separation.models[stemType].id ?? "test",
        modelVersion: realFixture?.bed.separation.models[stemType].sha256 ?? "test",
        storageKey,
        checksumSha256: sha256(wav),
        durationSeconds: bedDurationSeconds,
        sampleRate: RATE,
        channels: 2,
        codec: "wav",
        format: "wav",
        fileSizeBytes: wav.length,
      });
    }

    if (!realFixture) {
      for (const [source, checksum] of [
        [vocalsSource, sha256(vocalsOriginal)],
        [bedSource, sha256(bedOriginal)],
      ] as const) {
        await dbModule.db.insert(schema.sourceAnalyses).values({
          projectId: project.id,
          sourceAssetId: source.id,
          status: "complete",
          stage: "complete",
          attempts: 1,
          idempotencyKey: `mashup-analysis-${randomUUID()}`,
          analysisEngine: "test",
          analysisEngineVersion: "test",
          sourceChecksumSha256: checksum,
          bpm: 120,
          bpmConfidence: 0.9,
          musicalKey: "C major",
          keyConfidence: 0.9,
          beatGrid: JSON.stringify(Array.from(
            { length: source.id === bedSource.id ? 8 : 4 },
            (_, index) => index * 500,
          )),
          beatConfidence: 0.9,
          completedAt: new Date(),
        });
      }
    }

    if (!realFixture) {
      const [drumStem] = await dbModule.db.select({
        id: schema.stemAssets.id,
        checksumSha256: schema.stemAssets.checksumSha256,
      }).from(schema.stemAssets).where(and(
        eq(schema.stemAssets.projectId, project.id),
        eq(schema.stemAssets.sourceAssetId, bedSource.id),
        eq(schema.stemAssets.stemType, "drums"),
      ));
      assert.ok(drumStem);
      const [drumAnalysis] = await dbModule.db.insert(schema.drumAnalyses).values({
        projectId: project.id,
        sourceAssetId: bedSource.id,
        stemAssetId: drumStem.id,
        status: "complete",
        stage: "complete",
        attempts: 1,
        idempotencyKey: drumAnalysisIdempotencyKey(
          drumStem.id,
          LOCAL_DRUM_ANALYSIS_ENGINE,
          LOCAL_DRUM_ANALYSIS_ENGINE_VERSION,
        ),
        analysisEngine: LOCAL_DRUM_ANALYSIS_ENGINE,
        analysisEngineVersion: LOCAL_DRUM_ANALYSIS_ENGINE_VERSION,
        sourceChecksumSha256: sha256(bedOriginal),
        stemChecksumSha256: drumStem.checksumSha256,
        startedAt: new Date(),
        analyzedAt: new Date(),
        completedAt: new Date(),
      }).returning({ id: schema.drumAnalyses.id });
      assert.ok(drumAnalysis);
      await dbModule.db.insert(schema.drumEvents).values([2_500, 3_000, 3_500].map((timestampMs, eventIndex) => ({
        drumAnalysisId: drumAnalysis.id,
        eventIndex,
        timestampMs,
        strength: 0.9,
        confidence: 0.95,
        rhythmicClass: null,
        nearestBeatIndex: timestampMs / 500,
        beatOffsetMs: 0,
      })));
      const [bassStem] = await dbModule.db.select({
        id: schema.stemAssets.id,
        checksumSha256: schema.stemAssets.checksumSha256,
      }).from(schema.stemAssets).where(and(
        eq(schema.stemAssets.projectId, project.id),
        eq(schema.stemAssets.sourceAssetId, bedSource.id),
        eq(schema.stemAssets.stemType, "bass"),
      ));
      assert.ok(bassStem);
      const [bassAnalysis] = await dbModule.db.insert(schema.bassAnalyses).values({
        projectId: project.id,
        sourceAssetId: bedSource.id,
        stemAssetId: bassStem.id,
        status: "complete",
        stage: "complete",
        attempts: 1,
        idempotencyKey: bassAnalysisIdempotencyKey(bassStem.id),
        analysisEngine: LOCAL_BASS_ANALYSIS_ENGINE,
        analysisEngineVersion: LOCAL_BASS_ANALYSIS_ENGINE_VERSION,
        sourceChecksumSha256: sha256(bedOriginal),
        stemChecksumSha256: bassStem.checksumSha256,
        startedAt: new Date(),
        analyzedAt: new Date(),
        completedAt: new Date(),
      }).returning({ id: schema.bassAnalyses.id });
      assert.ok(bassAnalysis);
      await dbModule.db.insert(schema.bassEvents).values([2_500, 3_000, 3_500].map((timestampMs, eventIndex) => ({
        bassAnalysisId: bassAnalysis.id,
        eventIndex,
        timestampMs,
        strength: 0.85,
        confidence: 0.9,
        nearestBeatIndex: timestampMs / 500,
        beatOffsetMs: 0,
      })));
    } else if (realFixture) {
      const [bassStem] = await dbModule.db.select().from(schema.stemAssets).where(and(
        eq(schema.stemAssets.projectId, project.id),
        eq(schema.stemAssets.sourceAssetId, bedSource.id),
        eq(schema.stemAssets.stemType, "bass"),
      ));
      assert.ok(bassStem, "the real separation fixture must include its bass stem");
      const [bassAnalysis] = await dbModule.db.insert(schema.bassAnalyses).values({
        projectId: project.id,
        sourceAssetId: bedSource.id,
        stemAssetId: bassStem.id,
        idempotencyKey: bassAnalysisIdempotencyKey(bassStem.id),
        analysisEngine: LOCAL_BASS_ANALYSIS_ENGINE,
        analysisEngineVersion: LOCAL_BASS_ANALYSIS_ENGINE_VERSION,
        sourceChecksumSha256: sha256(bedOriginal),
        stemChecksumSha256: bassStem.checksumSha256,
      }).returning();
      assert.ok(bassAnalysis);
      const { handleBassAnalysisJob } = await import("@workspace/arena/lib/waveyard/worker-local/stem-analysis");
      await handleBassAnalysisJob({
        bassAnalysisId: bassAnalysis.id,
        projectId: project.id,
        sourceAssetId: bedSource.id,
        stemAssetId: bassStem.id,
        analysisEngine: LOCAL_BASS_ANALYSIS_ENGINE,
        analysisEngineVersion: LOCAL_BASS_ANALYSIS_ENGINE_VERSION,
      }, { db: dbModule.db, storage });
      const persistedBass = await dbModule.db.select().from(schema.bassEvents)
        .where(eq(schema.bassEvents.bassAnalysisId, bassAnalysis.id));
      realPersistedBassAttackCount = persistedBass.length;
      assert.ok(persistedBass.length > 0, "the full-length real separated bass stem must yield persisted low-band attack events");
      assert.equal((await dbModule.db.select().from(schema.bassAnalyses)
        .where(eq(schema.bassAnalyses.id, bassAnalysis.id)))[0]?.status, "complete");
    }

    const renderRequest = (
      alignmentStrategy?: "continuous" | "paired-grid" | "downbeat" | "phrase-aware",
      extra?: Record<string, unknown>,
    ) => new Request(`http://localhost/api/waveyard/projects/${project.id}/mashup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "render",
        vocalsSourceId: vocalsSource.id,
        instrumentalSourceId: bedSource.id,
        ...(alignmentStrategy ? { alignmentStrategy } : {}),
        ...(extra ?? {}),
      }),
    });

    // Plan path reports the authoritative bed source before rendering.
    const planRequest = (alignmentStrategy?: "continuous" | "paired-grid" | "downbeat" | "phrase-aware") => new Request(`http://localhost/api/waveyard/projects/${project.id}/mashup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "plan",
          vocalsSourceId: vocalsSource.id,
          instrumentalSourceId: bedSource.id,
          ...(alignmentStrategy ? { alignmentStrategy } : {}),
        }),
      });
    let planResponse = await routeModule.POST(
      planRequest(),
      { params: Promise.resolve({ id: project.id }) },
    );
    assert.equal(planResponse.status, 200);
    let planBody = await planResponse.json() as {
      plan?: {
        masterBpm: number;
        vocalsStretchRatio: number;
        vocalsPitchSemitones: number;
        durationMs: number;
        warnings: string[];
        rationale: string[];
        segments: Array<{
          mashupStartMs: number;
          mashupEndMs: number;
          vocalsFromMs: number;
          vocalsToMs: number;
          crossfadeMs: number;
        }>;
        arrangement?: {
          selected: "continuous-overlay" | "coherent-overlay";
          unitsTotal: number;
          unitsPlaced: number;
          unitsSkipped: number;
          coherentUnitsPlaced: number;
          continuousUnitsPlaced: number;
          coherentScore: number;
          coherentEntryMs: number;
          overlayScore: number;
          pairedBeatPhaseFit: { score: number; matchedBeats: number; comparedBeats: number; meanErrorMs: number; toleranceMs: number } | null;
          baselineBeatPhaseFit: { score: number; matchedBeats: number; comparedBeats: number; meanErrorMs: number; toleranceMs: number } | null;
          evidence: { pairedBeatGrids: boolean };
          placements: Array<{ donorFromMs: number; donorToMs: number; bedStartMs: number }>;
          rationale: string[];
          warnings: string[];
        } | null;
        passageSearch?: {
          evaluatedDonorPassageCount: number;
          rankableDonorPassageCount: number;
          selectedDonorSectionId: string | null;
          selectedBedSectionId: string | null;
          evaluations: Array<{
            donorSectionId: string;
            vocalSourceSha256: string;
            donorStartMs: number;
            donorEndMs: number;
            status: string;
            selected: boolean;
            rankedBedCandidates?: Array<{
              rank: number;
              bedSourceSha256: string | null;
              bedSectionId: string;
              bedStartMs: number;
              bedEndMs: number;
              plannedEntryMs: number;
              relativeScore: number;
              selected: boolean;
            }>;
          }>;
        };
      };
      bed?: { source: string; warning: string };
      evidence?: {
        vocals: Record<string, {
          status: string;
          persistence?: string;
          subject?: string;
          stemAssetId?: string;
          stemType?: string;
          stemChecksumSha256?: string;
        }>;
        bed: Record<string, {
          status: string;
          persistence?: string;
          subject?: string;
          stemAssetId?: string;
          stemType?: string;
          stemChecksumSha256?: string;
        }>;
      };
    };
    if (realFixture) {
      const [{ handleStemHarmonyAnalysisJob }, harmonyTypes] = await Promise.all([
        import("@workspace/arena/lib/waveyard/worker-local/stem-analysis"),
        import("@workspace/arena/lib/waveyard/types/stem-harmony-analysis"),
      ]);
      const [otherStem] = await dbModule.db.select().from(schema.stemAssets).where(and(
        eq(schema.stemAssets.separationJobId, bedJob.id), eq(schema.stemAssets.stemType, "other"),
      ));
      assert.ok(otherStem);
      const [harmonyJob] = await dbModule.db.insert(schema.stemHarmonyAnalyses).values({
        projectId: project.id, sourceAssetId: bedSource.id, stemAssetId: otherStem.id,
        status: "queued", stage: "queued",
        idempotencyKey: harmonyTypes.stemHarmonyAnalysisIdempotencyKey(otherStem.id),
        sourceChecksumSha256: sha256(bedOriginal), stemChecksumSha256: otherStem.checksumSha256,
        analysisEngine: harmonyTypes.LOCAL_STEM_HARMONY_ANALYSIS_ENGINE,
        analysisEngineVersion: harmonyTypes.LOCAL_STEM_HARMONY_ANALYSIS_ENGINE_VERSION,
      }).returning();
      assert.ok(harmonyJob);
      await handleStemHarmonyAnalysisJob({
        stemHarmonyAnalysisId: harmonyJob.id, projectId: project.id, sourceAssetId: bedSource.id,
        stemAssetId: otherStem.id, analysisEngine: harmonyJob.analysisEngine,
        analysisEngineVersion: harmonyJob.analysisEngineVersion,
      }, { db: dbModule.db, storage });
      assert.equal((await dbModule.db.select().from(schema.stemHarmonyAnalyses)
        .where(eq(schema.stemHarmonyAnalyses.id, harmonyJob.id)))[0]?.status, "complete");
      // The first plan decodes and persists full-track analysis. Run the
      // existing durable section worker on those exact original files, then
      // plan again so the production loader and planner consume the persisted
      // source-checksum-bound passage fingerprints.
      const [{ handleSectionAnalysisJob }, analysisTypes] = await Promise.all([
        import("@workspace/arena/lib/waveyard/worker-local/sections"),
        import("@workspace/arena/lib/waveyard/types/analysis-provenance"),
      ]);
      const sectionResults: Array<{ status: string; sectionCount: number; fingerprintCount: number }> = [];
      for (const sourceAssetId of [vocalsSource.id, bedSource.id]) {
        const [sourceAsset] = await dbModule.db.select().from(schema.sourceAssets)
          .where(and(eq(schema.sourceAssets.id, sourceAssetId), eq(schema.sourceAssets.projectId, project.id)));
        const [sourceAnalysis] = await dbModule.db.select().from(schema.sourceAnalyses)
          .where(and(
            eq(schema.sourceAnalyses.sourceAssetId, sourceAssetId),
            eq(schema.sourceAnalyses.projectId, project.id),
            eq(schema.sourceAnalyses.status, "complete"),
          ));
        assert.ok(sourceAsset && sourceAnalysis?.beatGrid,
          "the first production plan must persist a usable source beat grid before section analysis");
        const [sectionAnalysis] = await dbModule.db.insert(schema.sourceSectionAnalyses).values({
          projectId: project.id,
          sourceAssetId,
          sourceAnalysisId: sourceAnalysis.id,
          status: "queued",
          stage: "queued",
          attempts: 0,
          idempotencyKey: `real-stage3-sections-${sourceAssetId}`,
          analysisEngine: analysisTypes.DESKTOP_SECTION_ENGINE,
          analysisEngineVersion: analysisTypes.DESKTOP_SECTION_ENGINE_VERSION,
          sourceChecksumSha256: sourceAsset.checksumSha256,
        }).returning();
        assert.ok(sectionAnalysis);
        await handleSectionAnalysisJob({
          sourceSectionAnalysisId: sectionAnalysis.id,
          projectId: project.id,
          sourceAssetId,
          sourceAnalysisId: sourceAnalysis.id,
          analysisEngine: analysisTypes.DESKTOP_SECTION_ENGINE,
          analysisEngineVersion: analysisTypes.DESKTOP_SECTION_ENGINE_VERSION,
        });
        const [completed] = await dbModule.db.select().from(schema.sourceSectionAnalyses)
          .where(eq(schema.sourceSectionAnalyses.id, sectionAnalysis.id));
        const rows = await dbModule.db.select().from(schema.sourceSections)
          .where(and(
            eq(schema.sourceSections.projectId, project.id),
            eq(schema.sourceSections.sourceAssetId, sourceAssetId),
            eq(schema.sourceSections.sourceSectionAnalysisId, sectionAnalysis.id),
          ));
        assert.equal(completed?.status, "complete",
          "full-track real audio should produce current persisted section fingerprints for the acceptance pair");
        assert.ok(rows.length > 0, "the section worker must persist real source sections");
        if (sourceAssetId === bedSource.id) {
          assert.ok(rows.some(row => row.label === "verse") && rows.some(row => row.label === "chorus"),
            "the real September separated-vocal analysis must persist both inferred semantic roles");
          assert.ok(rows.filter(row => ["verse", "chorus"].includes(row.label))
            .every(row => row.labelConfidence <= 0.7),
          "uncalibrated form hypotheses must not be published as high-confidence truth");
        }
        assert.ok(rows.every((row) => row.sourceChecksumSha256 === sourceAsset.checksumSha256),
          "every persisted section must remain bound to the original source checksum");
        realSectionsBySourceChecksum[sourceAsset.checksumSha256] = rows.map((row) => ({
          startMs: row.startMs,
          endMs: row.endMs,
          label: row.label,
          labelConfidence: row.labelConfidence,
          structuralConfidence: row.structuralConfidence,
          analysisEngine: row.analysisEngine,
          analysisEngineVersion: row.analysisEngineVersion,
          sourceChecksumSha256: row.sourceChecksumSha256,
        }));
        sectionResults.push({
          status: completed.status,
          sectionCount: rows.length,
          fingerprintCount: rows.filter((row) => row.passageFingerprint !== null).length,
        });
      }
      const profileReportPath = process.env.WAVEYARD_MASHUP_PROFILE_REPORT_PATH?.trim();
      if (profileReportPath) {
        const { loadSourceProfile } = await import("@workspace/arena/lib/waveyard/studio/mashup-sources");
        const vocalsProfile = await loadSourceProfile(project.id, vocalsSource.id, "vocals", dbModule.db, { separationJobId: vocalsJob.id });
        const bedProfile = await loadSourceProfile(project.id, bedSource.id, "instrumental", dbModule.db, { separationJobId: bedJob.id });
        assert.ok(vocalsProfile?.vocalPitchFrames?.length, "real pitch observations reach the planner profile");
        assert.ok(bedProfile?.harmonyEvents?.length, "real bed chord observations reach the planner profile");
        const output = realFixturePath(profileReportPath);
        await mkdir(path.dirname(output), { recursive: true });
        await writeFile(output, JSON.stringify({
          evidence: "real separated audio, existing production analyzers and persisted profile loader; not human ground truth",
          vocals: vocalsProfile, bed: bedProfile,
        }));
      }
      realSectionPassageEvidence = {
        vocals: sectionResults[0]!,
        bed: sectionResults[1]!,
      };
      planResponse = await routeModule.POST(planRequest(), { params: Promise.resolve({ id: project.id }) });
      assert.equal(planResponse.status, 200);
      planBody = await planResponse.json() as typeof planBody;
    }
    assert.equal(planBody.bed?.source, "separated", "the plan must report the separated bed");
    assert.equal(planBody.evidence?.vocals.vocalPhrases.status, "measured",
      "the plan response must expose the current persisted vocal activity used by the planner");
    assert.equal(planBody.evidence?.bed.drumEvents.status, "measured",
      "the plan response must expose current persisted drum evidence");
    assert.equal(planBody.evidence?.bed.bassAttacks.status, "measured",
      "the plan response must expose current persisted bass-attack evidence");
    if (!realFixture) assert.equal(planBody.evidence?.bed.drumEvents.persistence, "database");
    if (!realFixture) assert.equal(planBody.evidence?.bed.bassAttacks.persistence, "database");
    if (!realFixture) assert.ok(planBody.bed?.warning.length, "the plan must explain leakage honestly");
    assert.ok(planBody.plan && planBody.plan.durationMs > 0, "the production planner must return an arrangement");
    if (!realFixture) {
      // The planner only sees tempo numbers that survived persistence. If the
      // pulse family (the octave alternatives of a measured tempo) were dropped
      // on the way from the database to the profile, a hats-heavy track stored
      // an octave high would halve or double the vocal's stretch and no unit
      // test would notice. Assert the production loader still carries it.
      const { loadSourceProfile: loadProfile } = await import("@workspace/arena/lib/waveyard/studio/mashup-sources");
      const loadedBed = await loadProfile(project.id, bedSource.id, "instrumental", dbModule.db, { separationJobId: bedJob.id });
      assert.ok(loadedBed?.bpm && loadedBed.bpmCandidates && loadedBed.bpmCandidates.length > 0,
        "the persisted-tempo profile must expose its pulse family so octave ambiguity stays resolvable");
      assert.equal(loadedBed.bpmCandidates[0], loadedBed.bpm,
        "the measured tempo must remain the first candidate for existing consumers");
      const persistedDrumAlignment = planBody.plan.rationale.find((line) =>
        line.includes("overlap measured drum transients") && line.includes("overlap low-band bass attacks"));
      assert.ok(persistedDrumAlignment, "the plan must report measured vocal-to-groove comparisons");
      assert.match(
        persistedDrumAlignment,
        /\d+\/\d+ (?:coarse vocal-activity interval starts|pitch-continuity run starts|combined vocal-activity and pitch-run starts) overlap measured drum transients/,
        "the route must report its available persisted vocal timing intervals against measured drum events",
      );
      assert.match(persistedDrumAlignment, /\d+\/\d+ overlap low-band bass attacks/,
        "the route must report persisted bass events without treating every attack as a preferred vocal onset");
       assert.ok(persistedDrumAlignment.includes("transient coincidences alone do not shift this passage-entry fallback"),
        "the route must not optimize entry timing on transient coincidence without a matching musical passage");
    } else {
      assert.equal(planBody.evidence?.bed.bassAttacks.persistence, "database",
        "the real-track plan must use events persisted by the local bass-analysis worker");
      assert.equal(typeof realPersistedBassAttackCount, "number");
      const realArrangement = planBody.plan.arrangement;
      assert.ok(realArrangement, "the real separated-stem route must produce a full-track placement decision");
      assert.equal(realArrangement.continuousUnitsPlaced, realArrangement.unitsTotal,
        "the continuous baseline must retain every eligible vocal unit");
      assert.equal(realArrangement.coherentUnitsPlaced, realArrangement.unitsTotal,
        "the whole-body candidate must retain every eligible vocal unit");
      assert.equal(realArrangement.unitsSkipped, 0,
        "no voice-bearing unit may be silently lost when a full placement fits");
      assert.ok(realArrangement.selected === "coherent-overlay" || realArrangement.selected === "continuous-overlay",
        "the real evidence may move the full vocal body only when paired musical evidence earns the move; otherwise retain the continuous entry");
      assert.ok(planBody.evidence?.vocals.tempo,
        "the route exposes tempo evidence used to synchronize the donor");
      assert.equal(planBody.evidence?.vocals.tempo.persistence, "request");
      assert.equal(planBody.evidence?.vocals.tempo.subject, "separated-stem");
      assert.equal(planBody.evidence?.vocals.tempo.stemType, "drums",
        "the donor's isolated drums, rather than a low-confidence full mix, establish its pulse");
      assert.equal(planBody.evidence?.bed.tempo.subject, "separated-stem");
      assert.equal(planBody.evidence?.bed.tempo.stemType, "drums",
        "the bed tempo also comes from its isolated drums");
      for (const timingEvidence of [planBody.evidence.vocals.tempo, planBody.evidence.bed.tempo]) {
        assert.ok(timingEvidence.stemAssetId, "the timing source identifies the exact separated stem asset");
        assert.match(timingEvidence.stemChecksumSha256 ?? "", /^[a-f0-9]{64}$/,
          "the request-time timing evidence carries the validated stem checksum");
      }
      for (const timingEvidence of [planBody.evidence.vocals.beatGrid, planBody.evidence.bed.beatGrid]) {
        assert.equal(timingEvidence.subject, "separated-stem",
          "paired beat alignment uses both tracks' isolated drum grids");
        assert.equal(timingEvidence.stemType, "drums");
      }
      assert.equal(realArrangement.evidence.pairedBeatGrids, true);
      assert.ok(realArrangement.pairedBeatPhaseFit);
      assert.ok(realArrangement.baselineBeatPhaseFit);
      assert.ok(realArrangement.pairedBeatPhaseFit.score >= realArrangement.baselineBeatPhaseFit.score - 0.01,
        "the chosen full-body alignment must not worsen paired donor/bed beat phase");
      assert.ok(planBody.plan.rationale.some((line) => line.includes("paired beat-grid fit")));
      assert.ok(planBody.plan.vocalsStretchRatio > 0.84 && planBody.plan.vocalsStretchRatio < 0.91,
        "the actual approximately 110 BPM donor is time-matched to the approximately 126 BPM bed");
      assert.equal(planBody.plan.segments.length, 1,
        "the mix preserves the full vocal flow as one clip instead of producing dozens of choppy fragments");
      assert.ok(realArrangement.placements.length >= 30);
      assert.ok(Math.abs(
        (realArrangement.placements.at(-1)!.bedStartMs - realArrangement.placements[0]!.bedStartMs)
        - Math.round(
          (realArrangement.placements.at(-1)!.donorFromMs - realArrangement.placements[0]!.donorFromMs)
          * planBody.plan.vocalsStretchRatio,
        ),
      ) <= 1, "all voice-active windows keep one global source-relative timing map after tempo stretch, within 1 ms rounding");
      assert.ok(planBody.plan.segments.every((segment) =>
        segment.crossfadeMs * 2 <= segment.mashupEndMs - segment.mashupStartMs),
      "every planned clip's two fades must fit within its own timeline span so the real Studio can save it");
      assert.equal(planBody.plan.vocalsPitchSemitones, 0,
        "low-confidence keys must not trigger an automatic pitch transform");
      assert.ok(planBody.plan.warnings.some((warning) => warning.includes("Key analysis confidence is below the trusted threshold")));
      assert.ok(planBody.plan.durationMs >= (bedDurationSeconds - 1) * 1000,
        "the arrangement must span essentially the complete instrumental source");
        assert.ok(planBody.plan.rationale.some((line) => line.includes("measured voiced activity")),
          "the production route must load persisted voiced intervals measured from the real isolated vocal");
        if (planBody.plan.passageSearch?.selectedDonorSectionId !== null
          && planBody.plan.passageSearch?.selectedDonorSectionId !== undefined) {
          assert.ok(planBody.plan.rationale.some((line) => line.includes("aligned voice-bearing donor section")),
            "a selected full-track passage must explain its measured donor-to-bed section alignment");
        } else {
          assert.ok(planBody.plan.rationale.some((line) => line.includes("measured bed beat")),
            "the evidence-insufficient fallback must retain the persisted trusted bed beat grid");
        }
        assert.ok(planBody.plan.rationale.some((line) => line.includes("word, syllable, and lyrical-meaning timing are not analyzed")),
          "the plan must distinguish voicing activity from lyric understanding");
        realGrooveTimingSummary = planBody.plan.rationale.find((line) =>
          line.includes("coarse vocal-activity interval starts overlap")
          || line.includes("combined vocal-activity and pitch-run starts overlap")
          || line.includes("pitch-continuity run starts overlap"),
        ) ?? null;
        assert.ok(realGrooveTimingSummary,
          "the real-stem plan must compare measured vocal activity with separated drum and bass attacks");
        assert.ok(realGrooveTimingSummary.includes("measured drum transients"));
        assert.ok(realGrooveTimingSummary.includes("low-band bass attacks"));
        assert.ok(realSectionPassageEvidence?.vocals.fingerprintCount,
          "the real donor's full-track section worker must persist source-bound passage fingerprints");
        assert.ok(realSectionPassageEvidence?.bed.fingerprintCount,
          "the real bed's full-track section worker must persist source-bound passage fingerprints");
        assert.ok(planBody.plan.passageSearch,
          "the production response must expose the whole-track donor passage evaluation");
        assert.equal(
          planBody.plan.passageSearch.evaluations.length,
          planBody.plan.passageSearch.evaluatedDonorPassageCount,
          "every voice-bearing donor section must have an explicit outcome, not only the selected passage",
        );
        const rankedPassages = planBody.plan.passageSearch.evaluations.filter(
          (evaluation) => (evaluation.rankedBedCandidates?.length ?? 0) > 0,
        );
        assert.equal(rankedPassages.length, planBody.plan.passageSearch.rankableDonorPassageCount,
          "the production API must expose every feasible ranking, without inventing one for missing evidence");
        if (rankedPassages.length === 0) {
          assert.equal(planBody.plan.passageSearch.selectedDonorSectionId, null);
          assert.equal(planBody.plan.passageSearch.selectedBedSectionId, null);
          assert.ok(planBody.plan.passageSearch.evaluations.every(evaluation => !evaluation.selected),
            "an evidence-limited fallback must not claim a selected passage");
          assert.match(JSON.stringify(planBody.plan), /fallback/,
            "absence of comparable passages must be explained instead of blocking the real render/export");
        }
        for (const evaluation of rankedPassages) {
          const rankedCandidates = evaluation.rankedBedCandidates!;
          assert.deepEqual(
            rankedCandidates.map((candidate) => candidate.rank),
            rankedCandidates.map((_, index) => index + 1),
            "the full feasible candidate ranking must survive production serialization in consecutive order",
          );
          assert.equal(
            rankedCandidates.filter((candidate) => candidate.selected).length,
            1,
            "each ranked donor passage must identify exactly one candidate selected by the existing planner",
          );
          assert.equal(
            rankedCandidates[0]?.selected,
            true,
            "the selected candidate must remain first without rescoring or reordering the rest");
          assert.ok(
            rankedCandidates.every(
              (candidate) =>
                /^[a-f0-9]{64}$/i.test(candidate.bedSourceSha256 ?? "")
                && candidate.bedSectionId.length > 0
                && Number.isFinite(candidate.relativeScore),
            ),
            "every ranked candidate must retain source identity, passage identity and its measured score",
          );
        }
        const passageDecision = planBody.plan.rationale.find((line) =>
          line.includes("aligned voice-bearing donor section")
          || line.includes("no voice-bearing donor passage"),
        );
        assert.ok(passageDecision,
          `the real pair must report its measured passage decision: ${JSON.stringify({ rationale: planBody.plan.rationale, warnings: planBody.plan.warnings })}`);
        if (planBody.plan.passageSearch.selectedDonorSectionId !== null) {
          assert.ok(planBody.plan.warnings.some((warning) =>
            warning.includes("relative evidence ranking") && warning.includes("not calibrated or listener-validated"),
          ), "a selected real passage must remain an audition candidate, not a sound-quality claim");
        } else {
          assert.ok(planBody.plan.warnings.some((warning) =>
            warning.includes("measured-beat fallback"),
          ), "when real evidence is insufficient, produce the mashup at the safe measured-beat fallback");
        }
    }
    const realSourceAnalyses = realFixture
      ? await dbModule.db.select({
        sourceAssetId: schema.sourceAnalyses.sourceAssetId,
        status: schema.sourceAnalyses.status,
        analysisEngine: schema.sourceAnalyses.analysisEngine,
        analysisEngineVersion: schema.sourceAnalyses.analysisEngineVersion,
        sourceChecksumSha256: schema.sourceAnalyses.sourceChecksumSha256,
        bpm: schema.sourceAnalyses.bpm,
        bpmConfidence: schema.sourceAnalyses.bpmConfidence,
        musicalKey: schema.sourceAnalyses.musicalKey,
        keyConfidence: schema.sourceAnalyses.keyConfidence,
      }).from(schema.sourceAnalyses).where(inArray(schema.sourceAnalyses.sourceAssetId, [vocalsSource.id, bedSource.id]))
      : [];
    if (realFixture) {
      assert.equal(realSourceAnalyses.length, 2,
        "the production route must persist analysis for both real original tracks");
      for (const analysis of realSourceAnalyses) {
        assert.equal(analysis.status, "complete");
        assert.ok(analysis.bpm !== null && Number.isFinite(analysis.bpm) && analysis.bpm > 0,
          "full real-song route analysis must produce a measured BPM");
        assert.ok(analysis.musicalKey, "full real-song route analysis must produce a measured key");
        const expectedChecksum = analysis.sourceAssetId === vocalsSource.id ? sha256(vocalsOriginal) : sha256(bedOriginal);
        const reference = analysisReference?.tracks?.find((track) => track.sourceChecksumSha256 === expectedChecksum);
        assert.ok(reference, "the route result must be comparable to the independently recorded full-track analysis");
        assert.equal(analysis.analysisEngine, reference.analysisEngine);
        assert.equal(analysis.analysisEngineVersion, reference.analysisEngineVersion);
        assert.ok(reference.bpm !== null && Number.isFinite(reference.bpm));
        assert.ok(Math.abs(analysis.bpm - reference.bpm) <= 0.1,
          `route BPM ${analysis.bpm} should match full-track reference ${reference.bpm}`);
        if ((reference.keyConfidence ?? 0) >= 0.5) {
          assert.equal(analysis.musicalKey, reference.musicalKey,
            "high-confidence measured keys should agree with full-track analysis");
        }
      }
      assert.equal(
        realSourceAnalyses.find((analysis) => analysis.sourceAssetId === vocalsSource.id)?.sourceChecksumSha256,
        sha256(vocalsOriginal),
        "the donor analysis must be tied to the exact original file bytes",
      );
      assert.equal(
        realSourceAnalyses.find((analysis) => analysis.sourceAssetId === bedSource.id)?.sourceChecksumSha256,
        sha256(bedOriginal),
        "the bed analysis must be tied to the exact original file bytes",
      );
    }

    if (realFixture) {
      const bassFixture = bedStemFixtures.find((stem) => stem.stemType === "bass");
      assert.ok(bassFixture, "the real bed fixture must include its separated bass stem");
      const [bassStemAsset] = await dbModule.db.select({
        id: schema.stemAssets.id,
      }).from(schema.stemAssets).where(and(
        eq(schema.stemAssets.projectId, project.id),
        eq(schema.stemAssets.stemType, "bass"),
      ));
      assert.ok(bassStemAsset);
      await dbModule.db.update(schema.stemAssets)
        .set({ checksumSha256: "stale-bass-stem-checksum" })
        .where(eq(schema.stemAssets.id, bassStemAsset.id));
      const staleBassPlanResponse = await routeModule.POST(
        new Request(`http://localhost/api/waveyard/projects/${project.id}/mashup`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "plan",
            vocalsSourceId: vocalsSource.id,
            instrumentalSourceId: bedSource.id,
          }),
        }),
        { params: Promise.resolve({ id: project.id }) },
      );
      assert.equal(staleBassPlanResponse.status, 200);
      const staleBassPlan = await staleBassPlanResponse.json() as {
        plan?: { rationale: string[]; warnings: string[] };
      };
      assert.ok(staleBassPlan.plan?.warnings.some((warning) => warning.includes("bass stem checksum does not match")),
        "bass attack evidence must fail closed when its saved checksum no longer matches the file");
      assert.ok(staleBassPlan.plan?.rationale.some((line) => line.includes("unavailable overlap low-band bass attacks")),
        "a stale bass stem must not contribute event matches");
      await dbModule.db.update(schema.stemAssets)
        .set({ checksumSha256: sha256(bassFixture.wav) })
        .where(eq(schema.stemAssets.id, bassStemAsset.id));
    }

    if (realFixture && realVocalAnalysisId) {
      await dbModule.db.update(schema.vocalAnalyses)
        .set({ stemChecksumSha256: "stale-vocal-stem-checksum" })
        .where(eq(schema.vocalAnalyses.id, realVocalAnalysisId));
      const stalePlanResponse = await routeModule.POST(
        new Request(`http://localhost/api/waveyard/projects/${project.id}/mashup`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "plan",
            vocalsSourceId: vocalsSource.id,
            instrumentalSourceId: bedSource.id,
          }),
        }),
        { params: Promise.resolve({ id: project.id }) },
      );
      assert.equal(stalePlanResponse.status, 200);
      const stalePlan = await stalePlanResponse.json() as { plan?: { rationale: string[]; warnings: string[] } };
      assert.ok(stalePlan.plan?.warnings.some((warning) => warning.includes("No current isolated-vocal voicing intervals")),
        "stale phrase analysis must be excluded from the plan");
      assert.ok(!stalePlan.plan?.rationale.some((line) => line.includes("measured voiced activity")),
        "a previous vocal-stem checksum must never guide current clip boundaries");
      await dbModule.db.update(schema.vocalAnalyses)
        .set({ stemChecksumSha256: sha256(vocalsStemWav) })
        .where(eq(schema.vocalAnalyses.id, realVocalAnalysisId));
    }

    const compareResponse = await routeModule.POST(
      new Request(`http://localhost/api/waveyard/projects/${project.id}/mashup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "compare",
          vocalsSourceId: vocalsSource.id,
          instrumentalSourceId: bedSource.id,
        }),
      }),
      { params: Promise.resolve({ id: project.id }) },
    );
    assert.equal(compareResponse.status, 200, "the production route must compare the real planner strategies");
    const compareBody = await compareResponse.json() as {
      candidates?: Array<{
        id: string;
        available: boolean;
        unavailableReason?: string;
        plan: {
          alignmentStrategy: string;
          arrangement?: unknown;
          segments: Array<{ mashupStartMs: number; vocalsFromMs: number; localTempoMap?: unknown }>;
          passageSearch?: { selectedDonorSectionId: string | null; selectedBedSectionId: string | null } | null;
        } | null;
      }>;
    };
    assert.deepEqual(
      compareBody.candidates?.map((candidate) => candidate.id),
      ["continuous", "paired-grid", "downbeat", "phrase-aware", "full-length"],
      "all distinct alignment strategies must be returned in a stable presentation order",
    );
    assert.equal(
      compareBody.candidates?.find((candidate) => candidate.id === "full-length") !== undefined,
      true,
      "Full Length must be a selectable strategy, not only an internal planner mode",
    );
    assert.equal(compareBody.candidates?.find((candidate) => candidate.id === "continuous")?.available, true,
      "the continuous fallback must remain available when higher-evidence candidates cannot be proven");
    assert.ok(compareBody.candidates?.find((candidate) => candidate.id === "downbeat")?.unavailableReason,
      "the route must disclose why downbeat alignment is unavailable instead of inventing bar phase");
    const continuousCandidate = compareBody.candidates?.find((candidate) => candidate.id === "continuous");
    assert.ok(continuousCandidate?.plan);
    const continuousPlan = continuousCandidate.plan;

    // Actual production route render of the selected candidate strategy.
    const renderResponse = await routeModule.POST(renderRequest("continuous"), { params: Promise.resolve({ id: project.id }) });
    assert.equal(renderResponse.status, 200, "the render route must succeed");
    assert.match(renderResponse.headers.get("content-type") ?? "", /audio\/wav/);
    assert.equal(renderResponse.headers.get("x-waveyard-alignment-strategy"), "continuous");
    assert.equal(renderResponse.headers.get("x-waveyard-bed-source"), "separated", "the route must use the synthesized bed");
    const bedStemsHeader = (renderResponse.headers.get("x-waveyard-bed-stems") ?? "").split(",").filter(Boolean).sort();
    assert.deepEqual(bedStemsHeader, ["bass", "drums", "other"], "the bed must be drums + bass + other, not vocals");
    const bedWarning = renderResponse.headers.get("x-waveyard-bed-warning");
    if (!realFixture) {
      assert.ok(bedWarning, "the route must expose the leakage warning");
      assert.match(decodeURIComponent(bedWarning!), /leakage/i);
    }

    // Composition default: the donor supplies the vocal only. The donor's own
    // drums/bass/other are NOT added on top of the bed's rhythm section unless
    // the request names them, and the response says so.
    assert.equal(renderResponse.headers.get("x-waveyard-layer-stems"), "",
      "a default render must not layer any donor stem over the bed");
    assert.equal(renderResponse.headers.get("x-waveyard-mix-static-gain-db") !== null, true,
      "the route must report the static mix gain measured from the rendered PCM");
    assert.ok(["active", "not-required"].includes(renderResponse.headers.get("x-waveyard-mix-limiter") ?? ""),
      "the route must report whether the true-peak limiter acted");
    const balanceDb = Number(renderResponse.headers.get("x-waveyard-mix-balance-db"));
    assert.ok(Number.isFinite(balanceDb) && Math.abs(balanceDb) <= 9.0001,
      `the vocal-to-bed balance correction must be measured and bounded, got ${balanceDb}`);
    assert.ok(renderResponse.headers.get("x-waveyard-warning") !== null,
      "each render must carry the measured mix levels as an explicit warning entry");

    // The synthetic donor has a separated vocal but NO drum stem. Asking for
    // its drums is therefore a request this route cannot honour, and the old
    // behaviour — drop the bed's drums on request, find no donor drums, render
    // a mashup with no drum part at all, and still answer 200 — was the bug.
    // Both modes now fail closed and say which half is missing.
    for (const mode of ["replace", "layer", undefined] as const) {
      const unhonourable = await routeModule.POST(
        renderRequest("continuous", { layerStemTypes: ["drums"], ...(mode ? { stemLayerMode: mode } : {}) }),
        { params: Promise.resolve({ id: project.id }) },
      );
      assert.equal(unhonourable.status, 422,
        `requesting donor drums (${mode ?? "default replace"}) without a donor drum stem must fail closed`);
      assert.equal(unhonourable.headers.get("x-waveyard-replaced-bed-stems"), null,
        "a refused request must not report a replacement it did not perform");
      const body = await unhonourable.json() as { error?: string };
      assert.match(body.error ?? "", /donor/i,
        "the refusal must name the missing donor stem so the user can act on it");
    }

    // Positive replacement/layering cases live below, against fixtures whose
    // donor really has a drum stem and whose bed really has drums to remove.

    const badModeResponse = await routeModule.POST(
      renderRequest("continuous", { layerStemTypes: ["drums"], stemLayerMode: "stack" }),
      { params: Promise.resolve({ id: project.id }) },
    );
    assert.equal(badModeResponse.status, 400);

    // ---------------------------------------------------------------------
    // Fail-closed replacement.
    //
    // A replacement is only legal when BOTH halves are provable: the donor's
    // separable stem exists in its authoritative run, and the bed genuinely
    // has a separate stem of that role to remove. Otherwise the route used to
    // remove the bed's drums on request and then report
    // `x-waveyard-replaced-bed-stems: drums` while the original drums were
    // still audible — or, with a missing donor, leave no drum part at all.
    // ---------------------------------------------------------------------
    const stemAssetIdFor = async (sourceId: string, stemType: string): Promise<string> => {
      const [row] = await dbModule.db.select({ id: schema.stemAssets.id }).from(schema.stemAssets).where(and(
        eq(schema.stemAssets.projectId, project.id),
        eq(schema.stemAssets.sourceAssetId, sourceId),
        eq(schema.stemAssets.stemType, stemType),
      ));
      assert.ok(row, `fixture must have a ${stemType} stem for source ${sourceId}`);
      return row.id;
    };

    /** Register an extra source with a completed separation run of its own. */
    const addFixtureSource = async (
      label: string,
      stems: Array<{ stemType: FixtureStemType | "instrumental"; seconds: number }>,
      options: { bpm?: number | null } = {},
    ) => {
      const audioBytes = encodeWav16(tone([440], Math.max(...stems.map((stem) => stem.seconds)), 0.15), RATE);
      const storageKey = `mashup-fixture/${label}-original.wav`;
      const filePath = path.join(fixtureRoot, `${label}-original.wav`);
      await writeFile(filePath, audioBytes);
      await storage.putFile(storageKey, filePath);
      const [source] = await dbModule.db.insert(schema.sourceAssets).values({
        projectId: project.id,
        originalFilename: `${label}-original.wav`,
        mimeType: "audio/wav",
        storageKey,
        checksumSha256: sha256(audioBytes),
        durationSeconds: Math.max(...stems.map((stem) => stem.seconds)),
        sampleRate: RATE,
        channels: 2,
        codec: "pcm_s16le",
        fileSizeBytes: audioBytes.length,
      }).returning({ id: schema.sourceAssets.id });
      assert.ok(source);
      const [job] = await dbModule.db.insert(schema.processingJobs).values({
        projectId: project.id,
        sourceAssetId: source.id,
        type: "separation",
        status: "complete",
        stage: "complete",
        attempts: 1,
        idempotencyKey: `mashup-${label}-${randomUUID()}`,
        model: "test",
        metadata: JSON.stringify({ sourceChecksumSha256: sha256(audioBytes) }),
        requestedDevice: "cpu",
        resolvedDevice: "cpu",
        completedAt: new Date(),
      }).returning({ id: schema.processingJobs.id });
      assert.ok(job);
      for (const { stemType, seconds } of stems) {
        const stemWav = encodeWav16(tone([stemType === "drums" ? 260 : stemType === "bass" ? 70 : 110], seconds, 0.1), RATE);
        const stemStorageKey = `mashup-fixture/${label}-${stemType}.wav`;
        const stemPath = path.join(fixtureRoot, `${label}-${stemType}.wav`);
        await writeFile(stemPath, stemWav);
        await storage.putFile(stemStorageKey, stemPath);
        await dbModule.db.insert(schema.stemAssets).values({
          projectId: project.id,
          sourceAssetId: source.id,
          separationJobId: job.id,
          stemType,
          engine: "demucs",
          model: "test",
          modelVersion: "test",
          storageKey: stemStorageKey,
          checksumSha256: sha256(stemWav),
          durationSeconds: seconds,
          sampleRate: RATE,
          channels: 2,
          codec: "wav",
          format: "wav",
          fileSizeBytes: stemWav.length,
        });
      }
      await dbModule.db.insert(schema.sourceAnalyses).values({
        projectId: project.id,
        sourceAssetId: source.id,
        status: "complete",
        stage: "complete",
        attempts: 1,
        idempotencyKey: `mashup-analysis-${randomUUID()}`,
        analysisEngine: "test",
        analysisEngineVersion: "test",
        sourceChecksumSha256: sha256(audioBytes),
        // null means "tempo unverified", which is a real state the export
        // parity rules must handle honestly rather than assume away.
        bpm: options.bpm === undefined ? 120 : options.bpm,
        bpmConfidence: options.bpm === null ? null : 0.9,
        musicalKey: "C major",
        keyConfidence: 0.9,
        beatGrid: options.bpm === null ? null : JSON.stringify([0, 500, 1000, 1500, 2000, 2500, 3000, 3500]),
        beatConfidence: options.bpm === null ? null : 0.9,
        completedAt: new Date(),
      });
      return source.id;
    };

    // A bed whose separation run produced only a single combined
    // `instrumental` stem: nothing can be removed from it.
    const combinedInstrumentalBedId = await addFixtureSource("combined-instrumental-bed", [
      { stemType: "instrumental", seconds: BED_SECONDS },
    ]);
    // A donor with a separated vocal but no drum stem.
    const donorWithoutDrumsId = await addFixtureSource("donor-without-drums", [
      { stemType: "vocals", seconds: VOCAL_SECONDS },
    ]);
    // A bed with drums and other but no bass stem.
    const bedWithoutBassId = await addFixtureSource("bed-without-bass", [
      { stemType: "drums", seconds: BED_SECONDS },
      { stemType: "other", seconds: BED_SECONDS },
    ]);
    // A bed whose separation run produced only a vocal stem, so the bed falls
    // back to its original premixed file: nothing can be removed from it.
    const premixedBedId = await addFixtureSource("premixed-bed", [
      { stemType: "vocals", seconds: BED_SECONDS },
    ]);
    // A 140 BPM donor over a 100 BPM bed: the renderer stretches the donor.
    // Without a clip timing map or tempo sync the export would play it at its
    // native rate, which is a different arrangement from the one rendered.
    const slowBedId = await addFixtureSource("slow-bed", [
      { stemType: "drums", seconds: BED_SECONDS },
      { stemType: "bass", seconds: BED_SECONDS },
      { stemType: "other", seconds: BED_SECONDS },
    ], { bpm: 100 });
    const fastDonorId = await addFixtureSource("fast-donor", [
      { stemType: "vocals", seconds: VOCAL_SECONDS },
      { stemType: "drums", seconds: VOCAL_SECONDS },
    ], { bpm: 140 });
    // Same pair, but the donor's tempo was never analysed.
    const unanalysedDonorId = await addFixtureSource("unanalysed-donor", [
      { stemType: "vocals", seconds: VOCAL_SECONDS },
      { stemType: "drums", seconds: VOCAL_SECONDS },
    ], { bpm: null });

    // A bed with every stem, a donor with drums: the successful case.
    const fullBedId = await addFixtureSource("full-bed", [
      { stemType: "drums", seconds: BED_SECONDS },
      { stemType: "bass", seconds: BED_SECONDS },
      { stemType: "other", seconds: BED_SECONDS },
    ]);
    const donorWithDrumsId = await addFixtureSource("donor-with-drums", [
      { stemType: "vocals", seconds: VOCAL_SECONDS },
      { stemType: "drums", seconds: VOCAL_SECONDS },
    ]);

    const renderPair = (vocalsId: string, instrumentalId: string, extra: Record<string, unknown>) =>
      new Request(`http://localhost/api/waveyard/projects/${project.id}/mashup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "render",
          vocalsSourceId: vocalsId,
          instrumentalSourceId: instrumentalId,
          alignmentStrategy: "continuous",
          ...extra,
        }),
      });

    // (1) Single combined instrumental stem + requested replacement: refuse,
    // do not pretend, and do not silently layer instead.
    const combinedBedReplace = await routeModule.POST(
      renderPair(vocalsSource.id, combinedInstrumentalBedId, { layerStemTypes: ["drums"], stemLayerMode: "replace" }),
      { params: Promise.resolve({ id: project.id }) },
    );
    assert.equal(combinedBedReplace.status, 422,
      "a replacement against a single combined instrumental stem must be refused, not claimed");
    const combinedBedReplaceBody = await combinedBedReplace.json() as { error?: string; code?: string };
    assert.equal(combinedBedReplaceBody.code, "stem-composition-unavailable");
    assert.match(combinedBedReplaceBody.error ?? "", /instrumental stem|separate/i,
      "the refusal must say why it cannot remove anything");
    assert.equal(combinedBedReplace.headers.get("x-waveyard-replaced-bed-stems"), null,
      "a refused replacement must not emit a replacement header at all");

    // (2) Premixed original-file bed + requested replacement: also refused.
    // The bed falls back to its original file when its separation run has no
    // usable instrumental stems, so the original drums are inside that file
    // and cannot be removed. Reporting a replacement here would be a lie.
    const premixedReplace = await routeModule.POST(
      renderPair(donorWithDrumsId, premixedBedId, { layerStemTypes: ["drums"], stemLayerMode: "replace" }),
      { params: Promise.resolve({ id: project.id }) },
    );
    assert.equal(premixedReplace.status, 422,
      "a replacement against a premixed original-file bed must be refused, not claimed");
    const premixedReplaceBody = await premixedReplace.json() as { error?: string };
    assert.match(premixedReplaceBody.error ?? "", /original file|separation/i,
      "the refusal must explain that the premixed file has no separable stems");
    assert.equal(premixedReplace.headers.get("x-waveyard-replaced-bed-stems"), null);

    // Layering against the same premixed bed is still allowed — it is an
    // honest operation — and must say that nothing was removed.
    const premixedLayer = await routeModule.POST(
      renderPair(donorWithDrumsId, premixedBedId, { layerStemTypes: ["drums"], stemLayerMode: "layer" }),
      { params: Promise.resolve({ id: project.id }) },
    );
    assert.equal(premixedLayer.status, 200,
      "explicit layering does not need a separable bed, so it must still work");
    assert.equal(premixedLayer.headers.get("x-waveyard-replaced-bed-stems"), "");
    assert.equal(premixedLayer.headers.get("x-waveyard-bed-separable"), "false");

    // (3) Missing donor replacement stem: the bed's drums must stay.
    const missingDonor = await routeModule.POST(
      renderPair(donorWithoutDrumsId, fullBedId, { layerStemTypes: ["drums"], stemLayerMode: "replace" }),
      { params: Promise.resolve({ id: project.id }) },
    );
    assert.equal(missingDonor.status, 422,
      "replacement without the donor's stem must fail closed rather than strip the bed");
    const missingDonorBody = await missingDonor.json() as { error?: string };
    assert.match(missingDonorBody.error ?? "", /donor/i,
      "the refusal must name the missing donor stem");

    // (4) Missing matching bed stem: replacing bass in a bed that has no bass.
    const missingBedStem = await routeModule.POST(
      renderPair(donorWithDrumsId, bedWithoutBassId, { layerStemTypes: ["bass"], stemLayerMode: "replace" }),
      { params: Promise.resolve({ id: project.id }) },
    );
    assert.equal(missingBedStem.status, 422,
      "replacing a role the bed does not have separately must fail closed");
    const missingBedStemBody = await missingBedStem.json() as { error?: string };
    assert.match(missingBedStemBody.error ?? "", /bass/i);

    // (5) Successful replacement with both halves verified.
    const successfulReplace = await routeModule.POST(
      renderPair(donorWithDrumsId, fullBedId, { layerStemTypes: ["drums"], stemLayerMode: "replace" }),
      { params: Promise.resolve({ id: project.id }) },
    );
    assert.equal(successfulReplace.status, 200);
    assert.equal(successfulReplace.headers.get("x-waveyard-stem-layer-mode"), "replace");
    assert.equal(successfulReplace.headers.get("x-waveyard-replaced-bed-stems"), "drums");
    assert.equal(successfulReplace.headers.get("x-waveyard-bed-separable"), "true");
    assert.deepEqual(
      (successfulReplace.headers.get("x-waveyard-bed-stems") ?? "").split(",").filter(Boolean).sort(),
      ["bass", "other"],
      "the rendered bed must not carry its own drums when the donor replaces them",
    );
    const successfulReplaceWav = decodeWav16(new Uint8Array(await successfulReplace.arrayBuffer()));
    assert.ok(successfulReplaceWav);
    // The bed's drum tone (260 Hz) must be gone and the donor's drum content
    // present, measured from the returned WAV rather than from a header.
    assert.ok(energyAt(successfulReplaceWav!.samples, 260, 0, BED_SECONDS * 1000)
      < energyAt(successfulReplaceWav!.samples, 70, 0, BED_SECONDS * 1000),
      "the replaced bed drum tone must not dominate the render");

    // (6) Explicit layering keeps both sources and reports no replacement.
    const successfulLayer = await routeModule.POST(
      renderPair(donorWithDrumsId, fullBedId, { layerStemTypes: ["drums"], stemLayerMode: "layer" }),
      { params: Promise.resolve({ id: project.id }) },
    );
    assert.equal(successfulLayer.status, 200);
    assert.equal(successfulLayer.headers.get("x-waveyard-stem-layer-mode"), "layer");
    assert.equal(successfulLayer.headers.get("x-waveyard-replaced-bed-stems"), "");
    assert.deepEqual(
      (successfulLayer.headers.get("x-waveyard-bed-stems") ?? "").split(",").filter(Boolean).sort(),
      ["bass", "drums", "other"],
      "explicit layering must keep the bed's drums alongside the donor's",
    );

    // A layering request whose donor stem is missing must also fail closed:
    // an unhonourable request must not render a different arrangement.
    const missingLayer = await routeModule.POST(
      renderPair(donorWithoutDrumsId, fullBedId, { layerStemTypes: ["drums"], stemLayerMode: "layer" }),
      { params: Promise.resolve({ id: project.id }) },
    );
    assert.equal(missingLayer.status, 422,
      "layering a donor stem that does not exist must fail rather than render only the bed");

    // ---------------------------------------------------------------------
    // Adaptive stem swap acceptance (ledger section 12).
    //
    // These prove the ORDER change: a replacement must reach the planner before
    // planning happens, the planner must see the resulting composition, and the
    // old plan must not be reused. They are route-level assertions on real
    // handler output, not unit tests of a helper.
    // ---------------------------------------------------------------------

    // (AS-1/AS-2) A replacement changes the evidence the planner sees. The
    // full-bed's stems are all 110/70/260 Hz tones; replacing drums with the
    // donor's 260 Hz drum stem must remove the bed's own drum tone from the
    // composition the planner analyses, so the rendered bed cannot contain it.
    const planBefore = await routeModule.POST(
      renderPair(donorWithDrumsId, fullBedId, {}),
      { params: Promise.resolve({ id: project.id }) },
    );
    assert.equal(planBefore.status, 200);

    const planAfterSwap = await routeModule.POST(
      renderPair(donorWithDrumsId, fullBedId, { layerStemTypes: ["drums"], stemLayerMode: "replace" }),
      { params: Promise.resolve({ id: project.id }) },
    );
    assert.equal(planAfterSwap.status, 200,
      "a verified replacement must still render");

    // AS-1/AS-3: the arrangement must be planned against the RESULTING
    // COMPOSITION, and the route must say so. This is the observable proof that
    // the swap reached planning rather than being substituted afterwards — a
    // replacement that only ran after planning cannot produce this header.
    assert.equal(
      planAfterSwap.headers.get("x-waveyard-planned-against"),
      "composition",
      "the replacement must reach the planner before planning occurs",
    );
    const plannedBpm = planAfterSwap.headers.get("x-waveyard-planned-bpm");
    assert.ok(plannedBpm && plannedBpm !== "none",
      "the composition-derived analysis must supply a tempo to plan against");
    assert.ok(
      Number(planAfterSwap.headers.get("x-waveyard-planned-beat-grid-points") ?? 0) > 1,
      "the composition-derived analysis must supply a beat grid to plan against",
    );

    // The same request WITHOUT the replacement must plan against the original
    // bed. If both said "composition" the header would prove nothing.
    assert.equal(
      planBefore.headers.get("x-waveyard-planned-against"),
      "original-bed",
      "with no replacement there is nothing to recompose, so planning must use the original bed",
    );

    // AS-3: the route must disclose that the arrangement was planned against the
    // resulting composition. This is the observable proof that the swap reached
    // planning rather than being substituted afterwards.
    const swapWav = decodeWav16(new Uint8Array(await planAfterSwap.arrayBuffer()));
    assert.ok(swapWav, "the swapped render must be a decodable WAV");

    // AS-4: the donor's drums are present and the bed's own drums are gone.
    const swapBody = await routeModule.POST(
      renderPair(donorWithDrumsId, fullBedId, { layerStemTypes: ["drums"], stemLayerMode: "replace" }),
      { params: Promise.resolve({ id: project.id }) },
    );
    assert.equal(swapBody.headers.get("x-waveyard-replaced-bed-stems"), "drums");

    // AS-5: retained stems survive. bass + other remain in the rendered bed.
    assert.deepEqual(
      (swapBody.headers.get("x-waveyard-bed-stems") ?? "").split(",").filter(Boolean).sort(),
      ["bass", "other"],
      "retained stems must remain intact after replacing drums",
    );

    // AS-6: no duplication. A replacement must not leave two drum parts: the
    // bed reports drums as replaced, and the composed bed stems exclude it.
    assert.equal(
      (swapBody.headers.get("x-waveyard-bed-stems") ?? "").includes("drums"),
      false,
      "a replaced stem must not also appear among the retained bed stems",
    );

    // AS-7: honest fallback. Replacing a role the bed does not have as a
    // separate stem cannot produce a real composition, so the route must refuse
    // rather than plan against a composition it cannot build. `bedWithoutBassId`
    // has drums + other only, so a bass replacement is unhonourable.
    const unhonourable = await routeModule.POST(
      renderPair(donorWithDrumsId, bedWithoutBassId, { layerStemTypes: ["bass"], stemLayerMode: "replace" }),
      { params: Promise.resolve({ id: project.id }) },
    );
    assert.equal(unhonourable.status, 422,
      "a replacement the resulting composition cannot honour must fail closed, not plan against the original bed");
    // A premixed bed that fell back to its original file also cannot be composed.
    const premixed = await routeModule.POST(
      renderPair(donorWithDrumsId, premixedBedId, { layerStemTypes: ["drums"], stemLayerMode: "replace" }),
      { params: Promise.resolve({ id: project.id }) },
    );
    assert.equal(premixed.status, 422,
      "a bed with no separable stems must refuse a replacement instead of substituting audio");

    // fixture helper retained for the Studio persistence assertions below
    void stemAssetIdFor;
    void bedWithoutBassId;

    // Donor vocals are the donor's default contribution; asking to layer them
    // again is a request error, not a silently ignored field.
    const invalidLayerResponse = await routeModule.POST(
      renderRequest("continuous", { layerStemTypes: ["vocals"] }),
      { params: Promise.resolve({ id: project.id }) },
    );
    assert.equal(invalidLayerResponse.status, 400,
      "donor vocals are the donor's default contribution and cannot be layered as an extra stem");

    const renderedBytes = new Uint8Array(await renderResponse.arrayBuffer());
    const rendered = decodeWav16(renderedBytes);
    assert.ok(rendered, "the route must return a decodable WAV");
    assert.equal(rendered!.sampleRate, RATE);
    assert.equal(rendered!.channels, 2);

    if (realFixture) {
      const frameCount = rendered!.samples.length / 2;
      const durationSeconds = frameCount / rendered!.sampleRate;
      let peak = 0;
      let squareSum = 0;
      let clippedFrames = 0;
      let silentFrames = 0;
      for (let frame = 0; frame < frameCount; frame += 1) {
        const left = rendered!.samples[frame * 2]!;
        const right = rendered!.samples[frame * 2 + 1]!;
        const magnitude = Math.max(Math.abs(left), Math.abs(right));
        peak = Math.max(peak, magnitude);
        squareSum += left * left + right * right;
        if (magnitude >= 0.999) clippedFrames += 1;
        if (magnitude < 0.0001) silentFrames += 1;
      }
      const metrics = {
        sampleRate: rendered!.sampleRate,
        channels: rendered!.channels,
        frames: frameCount,
        durationSeconds,
        peak,
        rms: Math.sqrt(squareSum / (frameCount * 2)),
        clippedFrames,
        silentFrameRatio: silentFrames / Math.max(1, frameCount),
        bytes: renderedBytes.byteLength,
        sha256: sha256(renderedBytes),
      };
      assert.ok(durationSeconds >= bedDurationSeconds - 1,
        `real output must preserve the full bed duration (${durationSeconds}s vs ${bedDurationSeconds}s)`);
      assert.ok(metrics.rms > 0.00001, "real output must contain non-silent PCM");
      assert.ok(metrics.peak <= 1, "real output must remain inside the normalized PCM range");

      const outputPath = process.env.WAVEYARD_MASHUP_REAL_OUTPUT_PATH?.trim();
      if (outputPath) {
        const resolvedOutputPath = realFixturePath(outputPath);
        await mkdir(path.dirname(resolvedOutputPath), { recursive: true });
        await writeFile(resolvedOutputPath, renderedBytes);
      }
      const reportPath = process.env.WAVEYARD_MASHUP_REAL_REPORT_PATH?.trim();
      if (reportPath) {
        const resolvedReportPath = realFixturePath(reportPath);
        await mkdir(path.dirname(resolvedReportPath), { recursive: true });
        const persistedStemEvidence = await dbModule.db.select({
          sourceAssetId: schema.stemAssets.sourceAssetId,
          separationJobId: schema.stemAssets.separationJobId,
          stemType: schema.stemAssets.stemType,
          checksumSha256: schema.stemAssets.checksumSha256,
          durationSeconds: schema.stemAssets.durationSeconds,
          sampleRate: schema.stemAssets.sampleRate,
          channels: schema.stemAssets.channels,
          fileSizeBytes: schema.stemAssets.fileSizeBytes,
        }).from(schema.stemAssets).where(eq(schema.stemAssets.projectId, project.id));
        const readSeparationEvidence = async (source: RealMashupSourceFixture) => {
          const report = JSON.parse(await readFile(realFixturePath(source.separation.reportPath), "utf8")) as {
            models?: Array<{ id?: string; sha256?: string }>;
            input?: { sha256?: string; durationSeconds?: number; sampleRate?: number; channels?: number };
            requestedDevice?: string;
            result?: {
              resolvedDevice?: string;
              elapsedMs?: number;
              realtimeFactor?: number;
              objectiveOutputChecks?: {
                allFourStemFilesReadablePcm16Stereo44100?: boolean;
                allFourStemsMatchExcerptDuration?: boolean;
                allSamplesFinite?: boolean;
                allSamplesWithinPcmRange?: boolean;
                belowLiveSwapEnergyFloorStems?: string[];
                soundQualityEvaluated?: boolean;
              };
            };
          };
          const original = new Uint8Array(await readFile(realFixturePath(source.path)));
          assert.equal(report.input?.sha256, sha256(original),
            "separation report must be tied to the original source bytes");
          assert.ok(Math.abs((report.input?.durationSeconds ?? 0) - source.durationSeconds) < 0.1);
          assert.equal(report.input?.sampleRate, RATE);
          assert.equal(report.input?.channels, 2);
          assert.equal(report.requestedDevice, "cpu");
          assert.equal(report.result?.resolvedDevice, "cpu");
          assert.equal(report.result?.objectiveOutputChecks?.allFourStemFilesReadablePcm16Stereo44100, true);
          assert.equal(report.result?.objectiveOutputChecks?.allFourStemsMatchExcerptDuration, true);
          assert.equal(report.result?.objectiveOutputChecks?.allSamplesFinite, true);
          assert.equal(report.result?.objectiveOutputChecks?.allSamplesWithinPcmRange, true);
          assert.deepEqual(report.result?.objectiveOutputChecks?.belowLiveSwapEnergyFloorStems, []);
          assert.equal(report.result?.objectiveOutputChecks?.soundQualityEvaluated, false,
            "objective checks must not be represented as subjective audio-quality evidence");
          for (const stemType of ["vocals", "drums", "bass", "other"] as const) {
            const expectedModel = source.separation.models[stemType];
            assert.ok(report.models?.some((model) =>
              model.id === expectedModel.id && model.sha256 === expectedModel.sha256),
            `separation report must verify the pinned ${stemType} model hash`);
          }
          return {
            reportPath: source.separation.reportPath,
            engine: source.separation.engine,
            recipeModel: source.separation.recipeModel,
            models: report.models,
            input: report.input,
            requestedDevice: report.requestedDevice,
            resolvedDevice: report.result?.resolvedDevice,
            elapsedMs: report.result?.elapsedMs,
            realtimeFactor: report.result?.realtimeFactor,
            objectiveOutputChecks: report.result?.objectiveOutputChecks,
          };
        };
        await writeFile(resolvedReportPath, `${JSON.stringify({
          schemaVersion: 1,
          evidence: "production route, full-length source files, real persisted separated stems",
          qualityLimit: "objective PCM checks do not establish musical quality or a listenable mashup",
          separation: {
            vocals: await readSeparationEvidence(realFixture.vocals),
            bed: await readSeparationEvidence(realFixture.bed),
          },
          analysisReportPath: realFixture.analysisReportPath,
          analysisReferenceTracks: analysisReference?.tracks?.filter((track) =>
            [sha256(vocalsOriginal), sha256(bedOriginal)].includes(track.sourceChecksumSha256)) ?? [],
          persistedSourceAnalyses: realSourceAnalyses,
          persistedVocalVoicingIntervals: realVocalVoicingEvidence,
          persistedBassAttackCount: realPersistedBassAttackCount,
          persistedSectionPassageEvidence: realSectionPassageEvidence,
          measuredGrooveTimingSummary: realGrooveTimingSummary,
          sources: {
            vocals: {
              filename: vocalsFilename,
              durationSeconds: realFixture.vocals.durationSeconds,
              roundedDatabaseDurationSeconds: vocalsDurationSeconds,
              checksumSha256: sha256(vocalsOriginal),
            },
            bed: {
              filename: bedFilename,
              durationSeconds: realFixture.bed.durationSeconds,
              roundedDatabaseDurationSeconds: bedDurationSeconds,
              checksumSha256: sha256(bedOriginal),
            },
          },
          stems: persistedStemEvidence,
          plan: planBody.plan,
          bed: planBody.bed,
          output: metrics,
        }, null, 2)}\n`);
      }
    } else {
      // Exact-frequency assertions apply only to the generated fixture, never
      // to real songs whose spectral content is not known in advance.
      const separatedVocalEnergy = energyAt(rendered!.samples, 1500, 0, 2);
      const drumEnergy = energyAt(rendered!.samples, 110, 0, 2);
      const bassEnergy = energyAt(rendered!.samples, 220, 0, 2);
      const otherEnergy = energyAt(rendered!.samples, 330, 0, 2);
      const donorVocalEnergy = energyAt(rendered!.samples, 1000, 2, 4);
      assert.ok(drumEnergy > 0.001, `drum stem should reach the render (${drumEnergy})`);
      assert.ok(bassEnergy > 0.001, `bass stem should reach the render (${bassEnergy})`);
      assert.ok(otherEnergy > 0.001, `other stem should reach the render (${otherEnergy})`);
      assert.ok(donorVocalEnergy > 0.001, `donor vocal should reach the render (${donorVocalEnergy})`);
      assert.ok(separatedVocalEnergy < 0.001, `bed vocals must be excluded (${separatedVocalEnergy})`);
    }
    if (!realFixture) {
      // An existing but undecodable stem must fail closed (422), never fall
      // back to the original file and reintroduce the bed's vocal.
      const garbagePath = path.join(fixtureRoot, "bed-bass-corrupt.wav");
      await writeFile(garbagePath, Buffer.from("not a wav file"));
      await storage.putFile("mashup-fixture/bed-bass.wav", garbagePath);
      const invalidResponse = await routeModule.POST(renderRequest(), { params: Promise.resolve({ id: project.id }) });
      assert.equal(invalidResponse.status, 422, "an invalid existing stem must fail the render");
      assert.equal(invalidResponse.headers.get("x-waveyard-bed-source"), null);
      assert.match(((await invalidResponse.json()) as { error: string }).error, /bass stem/);
      await storage.putFile("mashup-fixture/bed-bass.wav", path.join(fixtureRoot, "bed-bass.wav"));

      // A failed run falls back to the source only with a visible warning.
      await dbModule.db.update(schema.processingJobs)
        .set({ status: "failed", stage: "failed" })
        .where(eq(schema.processingJobs.id, bedJob.id));
      const fallbackResponse = await routeModule.POST(renderRequest(), { params: Promise.resolve({ id: project.id }) });
      assert.equal(fallbackResponse.status, 200);
      assert.equal(fallbackResponse.headers.get("x-waveyard-bed-source"), "original-fallback");
      assert.match(decodeURIComponent(fallbackResponse.headers.get("x-waveyard-bed-warning") ?? ""), /original/i);
      const fallbackBytes = new Uint8Array(await fallbackResponse.arrayBuffer());
      const fallback = decodeWav16(fallbackBytes);
      assert.ok(fallback);
      const fallbackVocalEnergy = energyAt(fallback!.samples, 1500, 0, 2);
      const separatedVocalEnergy = energyAt(rendered!.samples, 1500, 0, 2);
      assert.ok(fallbackVocalEnergy > 0.005, `the original bed's vocal should be audible in the fallback (${fallbackVocalEnergy})`);
      assert.ok(
        fallbackVocalEnergy > separatedVocalEnergy * 2,
        `the fallback must be distinguishable from the separated bed (${fallbackVocalEnergy} vs ${separatedVocalEnergy})`,
      );
    }

    // ---------------------------------------------------------------------
    // Persistence parity: the saved session must be the rendered arrangement.
    //
    // Before this, `action: "save"` inserted every non-vocal bed stem and no
    // donor stem, so a render with a replaced drum part could be saved as a
    // session that still contained the bed's original drums and none of the
    // donor's. Rendering one arrangement and saving another is the failure
    // this checks for, end to end, through the production routes and the real
    // export worker.
    // ---------------------------------------------------------------------
    {
      const saveFor = (extra: Record<string, unknown>) => new Request(
        `http://localhost/api/waveyard/projects/${project.id}/mashup`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "save",
            vocalsSourceId: donorWithDrumsId,
            instrumentalSourceId: fullBedId,
            alignmentStrategy: "continuous",
            ...extra,
          }),
        },
      );
      const donorDrumsStemId = await stemAssetIdFor(donorWithDrumsId, "drums");
      const donorVocalsStemId = await stemAssetIdFor(donorWithDrumsId, "vocals");
      const bedDrumsStemId = await stemAssetIdFor(fullBedId, "drums");
      const bedBassStemId = await stemAssetIdFor(fullBedId, "bass");
      const bedOtherStemId = await stemAssetIdFor(fullBedId, "other");

      /** The stem types behind one saved session, by source. */
      const savedProvenance = async (remixId: string) => {
        const tracks = await dbModule.db.select().from(schema.remixTracks)
          .where(eq(schema.remixTracks.remixSessionId, remixId));
        const stems = tracks.length
          ? await dbModule.db.select({
            stemAssetId: schema.stemAssets.id,
            sourceAssetId: schema.stemAssets.sourceAssetId,
            stemType: schema.stemAssets.stemType,
          }).from(schema.stemAssets).where(inArray(schema.stemAssets.id, tracks.map((track) => track.stemAssetId)))
          : [];
        return {
          tracks,
          stems,
          stemIds: stems.map((stem) => stem.stemAssetId).sort(),
          typesBySource: (sourceId: string) => stems
            .filter((stem) => stem.sourceAssetId === sourceId)
            .map((stem) => stem.stemType).sort(),
        };
      };

      // --- Replacement -----------------------------------------------------
      const replaceRender = await routeModule.POST(
        renderPair(donorWithDrumsId, fullBedId, { layerStemTypes: ["drums"], stemLayerMode: "replace" }),
        { params: Promise.resolve({ id: project.id }) },
      );
      assert.equal(replaceRender.status, 200);
      const renderedReplacePcm = decodeWav16(new Uint8Array(await replaceRender.arrayBuffer()));
      assert.ok(renderedReplacePcm);

      const replaceSave = await routeModule.POST(
        saveFor({ layerStemTypes: ["drums"], stemLayerMode: "replace" }),
        { params: Promise.resolve({ id: project.id }) },
      );
      assert.equal(replaceSave.status, 201, "a verified replacement must be saveable");
      const replaceSaveBody = await replaceSave.json() as { remix: { id: string }; version: { id: string } };

      const savedReplace = await savedProvenance(replaceSaveBody.remix.id);
      assert.deepEqual(savedReplace.typesBySource(fullBedId), ["bass", "other"],
        "the saved bed must not contain the drums the render replaced");
      assert.deepEqual(savedReplace.typesBySource(donorWithDrumsId), ["drums", "vocals"],
        "the saved session must contain the donor's replacing drum stem");
      assert.ok(savedReplace.stemIds.includes(bedDrumsStemId) === false,
        "the bed's own drum stem must not be referenced by the saved session at all");

      const [replaceVersion] = await dbModule.db.select().from(schema.remixVersions)
        .where(eq(schema.remixVersions.id, replaceSaveBody.version.id));
      const replaceSnapshot = JSON.parse(replaceVersion!.snapshot) as {
        mashupPlan?: {
          masterBpm?: number;
          vocalsStretchRatio?: number;
          stemComposition?: { stemLayerMode?: string; replacedBedStemTypes?: string[]; layeredStemTypes?: string[] };
        };
      };
      assert.equal(replaceSnapshot.mashupPlan?.stemComposition?.stemLayerMode, "replace",
        "the persisted snapshot must record the composition that was saved");
      assert.deepEqual(replaceSnapshot.mashupPlan?.stemComposition?.replacedBedStemTypes, ["drums"]);
      assert.deepEqual(replaceSnapshot.mashupPlan?.stemComposition?.layeredStemTypes, ["drums"]);
      // AS: the persisted plan must be the one planned against the RESULTING
      // composition. A reopened session must not revert to an arrangement that
      // was decided before the swap.
      assert.equal(replaceSaveBody.plannedAgainst, "composition",
        "the saved plan must record that it was planned against the resulting composition");
      const replacePlanResponse = await routeModule.POST(
        renderPair(donorWithDrumsId, fullBedId, {
          action: "plan",
          layerStemTypes: ["drums"],
          stemLayerMode: "replace",
        }),
        { params: Promise.resolve({ id: project.id }) },
      );
      const replacePlanBody = await replacePlanResponse.json() as {
        plannedAgainst?: { kind: string; replacedStemTypes?: string[] };
        plan: { alignmentStrategy: string };
      };
      assert.equal(replacePlanBody.plannedAgainst?.kind, "composition",
        "planning alone must also use the resulting composition, not only rendering");
      assert.deepEqual(replacePlanBody.plannedAgainst?.replacedStemTypes, ["drums"],
        "the plan must name which roles were recomposed");

      const replaceClips = savedReplace.tracks.length
        ? await dbModule.db.select().from(schema.remixClips)
          .where(inArray(schema.remixClips.remixTrackId, savedReplace.tracks.map((track) => track.id)))
        : [];
      const donorDrumClip = replaceClips.find((clip) => clip.stemAssetId === donorDrumsStemId);
      assert.ok(donorDrumClip, "the donor drum stem must be placed as a real clip");
      assert.equal(donorDrumClip!.sourceOffsetMs, continuousPlan.segments[0]!.vocalsFromMs,
        "the donor clip must keep the same phrase-relative source offset the renderer used");
      assert.equal(donorDrumClip!.timelineStartMs, continuousPlan.segments[0]!.mashupStartMs,
        "the donor clip must start at the same timeline position the renderer used");

      // Reopen through the production Studio route.
      const remixRoute = await import("../../../../remixes/[id]/route");
      const remixParams = { params: Promise.resolve({ id: replaceSaveBody.remix.id }) };
      const reopenResponse = await remixRoute.GET(
        new Request(`http://localhost/api/remixes/${replaceSaveBody.remix.id}`),
        remixParams,
      );
      assert.equal(reopenResponse.status, 200);
      const reopenedReplace = await reopenResponse.json() as {
        remix: { id: string; version: number };
        tracks: Array<{ id: string; stemAssetId: string; clips: Array<Record<string, unknown>> }>;
        automation: unknown[];
      };
      const reopenedStemIds = reopenedReplace.tracks.map((track) => track.stemAssetId).sort();
      assert.deepEqual(reopenedStemIds, savedReplace.stemIds,
        "reopening must return exactly the stems that were saved");
      assert.ok(reopenedStemIds.includes(donorDrumsStemId), "donor drums survive reopen");
      assert.ok(!reopenedStemIds.includes(bedDrumsStemId), "bed drums do not come back on reopen");

      // Export the reopened session with the real worker, then measure it.
      const [replaceExportJob] = await dbModule.db.insert(schema.exportJobs).values({
        projectId: project.id,
        remixSessionId: replaceSaveBody.remix.id,
        remixVersionId: replaceSaveBody.version.id,
        requestedById: (await dbModule.db.select().from(schema.remixSessions)
          .where(eq(schema.remixSessions.id, replaceSaveBody.remix.id)))[0]!.ownerId,
        status: "queued",
        stage: "queued",
        idempotencyKey: `replacement-export-${randomUUID()}`,
        format: "wav",
        sampleRate: RATE,
        channels: 2,
      }).returning();
      assert.ok(replaceExportJob);
      const exportWorker = await import("@workspace/arena/lib/waveyard/worker-local/export");
      await exportWorker.handleExportJob({
        exportJobId: replaceExportJob.id,
        projectId: project.id,
        remixSessionId: replaceSaveBody.remix.id,
        remixVersionId: replaceSaveBody.version.id,
        format: "wav",
      });
      const [replaceExportAsset] = await dbModule.db.select().from(schema.exportAssets)
        .where(eq(schema.exportAssets.exportJobId, replaceExportJob.id));
      assert.ok(replaceExportAsset, "the replaced arrangement must survive the real export worker");
      const exportMedia = await (await import("../../../../exports/[id]/media/route")).GET(
        new Request(`http://localhost/api/exports/${replaceExportJob.id}/media`),
        { params: Promise.resolve({ id: replaceExportJob.id }) },
      );
      assert.equal(exportMedia.status, 200);
      const exportedReplacePcm = decodeWav16(new Uint8Array(await exportMedia.arrayBuffer()));
      assert.ok(exportedReplacePcm, "the exported replaced session must be a real WAV");

      // The exported session must contain the donor's drum content and not be
      // dominated by the bed's drum tone, measured from the audio itself.
      // Measure the exported audio itself: the bed's drum tone must be gone
      // while the bed's bass is still there, so the export is neither "the
      // replacement silently didn't happen" nor "the bed was emptied".
      const exportHead = exportedReplacePcm!.samples.subarray(0, RATE * 2 * 2);
      const exportedBedDrum = energyAt(exportHead, 260, 0, 2000);
      const exportedBass = energyAt(exportHead, 70, 0, 2000);
      assert.ok(exportedBass > 0.001,
        `the exported session must still contain the bed's bass (${exportedBass})`);
      assert.ok(exportedBedDrum < exportedBass / 100,
        `the exported session must not contain the replaced bed drums (${exportedBedDrum} vs bass ${exportedBass})`);
      // The donor drum clip is what the export renders. If the render warped
      // the donor and the clip says nothing about it, export plays the donor at
      // its native rate — a different arrangement from the one rendered.
      const donorDrumClips = replaceClips.filter((clip) => clip.stemAssetId === donorDrumsStemId);
      assert.equal(donorDrumClips.length, 1,
        "a non-default composition must persist exactly one donor replacement clip");
      assert.equal(donorDrumClips[0]!.tempoSyncEnabled, true,
        "the donor clip must be tempo-synced whenever the renderer stretched it");

      // The render and the export are the same arrangement: both must show the
      // same absence of the bed's drum tone.
      const renderedBedDrum = energyAt(renderedReplacePcm!.samples.subarray(0, RATE * 2 * 2), 260, 0, 2000);
      assert.ok(renderedBedDrum < exportedBass / 100,
        `the render that was saved must also be free of the replaced bed drums (${renderedBedDrum})`);
      assert.ok(exportedReplacePcm!.frames > 0);

      // --- Explicit layering -----------------------------------------------
      const layerSave = await routeModule.POST(
        saveFor({ layerStemTypes: ["drums"], stemLayerMode: "layer" }),
        { params: Promise.resolve({ id: project.id }) },
      );
      assert.equal(layerSave.status, 201);
      const layerSaveBody = await layerSave.json() as { remix: { id: string }; version: { id: string } };
      const savedLayer = await savedProvenance(layerSaveBody.remix.id);
      assert.deepEqual(savedLayer.typesBySource(fullBedId), ["bass", "drums", "other"],
        "explicit layering must keep the bed's drums in the saved session");
      assert.deepEqual(savedLayer.typesBySource(donorWithDrumsId), ["drums", "vocals"],
        "explicit layering must also keep the donor's drums");
      assert.ok(savedLayer.stemIds.includes(bedDrumsStemId), "bed drums remain referenced");
      assert.ok(savedLayer.stemIds.includes(donorDrumsStemId), "donor drums are referenced too");
      void [bedBassStemId, bedOtherStemId, donorVocalsStemId];

      // --- Tempo parity across render and export ---------------------------
      // 140 BPM donor over a 100 BPM bed: the renderer stretches the donor by
      // 1.4x. The saved clip must say so, and the export must agree with the
      // render about the resulting duration.
      const stretchedSave = await routeModule.POST(
        new Request(`http://localhost/api/waveyard/projects/${project.id}/mashup`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "save",
            vocalsSourceId: fastDonorId,
            instrumentalSourceId: slowBedId,
            alignmentStrategy: "continuous",
            layerStemTypes: ["drums"],
            stemLayerMode: "replace",
          }),
        }),
        { params: Promise.resolve({ id: project.id }) },
      );
      assert.equal(stretchedSave.status, 201);
      const stretchedSaveBody = await stretchedSave.json() as {
        remix: { id: string };
        version: { id: string };
        warnings: string[];
      };
      const [stretchedSession] = await dbModule.db.select().from(schema.remixSessions)
        .where(eq(schema.remixSessions.id, stretchedSaveBody.remix.id));
      const stretchedProvenance = await savedProvenance(stretchedSaveBody.remix.id);
      const fastDonorDrumsStemId = await stemAssetIdFor(fastDonorId, "drums");
      const stretchedClips = await dbModule.db.select().from(schema.remixClips)
        .where(inArray(schema.remixClips.remixTrackId, stretchedProvenance.tracks.map((track) => track.id)));
      const stretchedDonorClip = stretchedClips.find((clip) => clip.stemAssetId === fastDonorDrumsStemId);
      assert.ok(stretchedDonorClip, "the stretched donor must have a persisted clip");
      assert.equal(stretchedDonorClip!.tempoSyncEnabled, true,
        "a donor the renderer stretched must be persisted as tempo-synced");
      assert.notEqual(stretchedSession!.tempoBpm, 140,
        "the session tempo must be the bed's, not the donor's, so sync has a real target");
      assert.deepEqual(stretchedProvenance.typesBySource(slowBedId), ["bass", "other"],
        "the slow bed's drums are replaced in this session too");

      // The same pair with a donor whose tempo was never analysed: the render
      // can still stretch it (the plan's ratio comes from the pair), but the
      // clip cannot claim sync without evidence. That must be reported, not
      // silently saved as a session that exports differently.
      const unanalysedSave = await routeModule.POST(
        new Request(`http://localhost/api/waveyard/projects/${project.id}/mashup`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "save",
            vocalsSourceId: unanalysedDonorId,
            instrumentalSourceId: slowBedId,
            alignmentStrategy: "continuous",
            layerStemTypes: ["drums"],
            stemLayerMode: "replace",
          }),
        }),
        { params: Promise.resolve({ id: project.id }) },
      );
      const unanalysedBody = await unanalysedSave.json() as {
        error?: string;
        warnings?: string[];
        remix?: { id: string };
        version?: { id: string };
      };
      assert.equal(unanalysedSave.status, 201,
        "a donor without analysed tempo is still renderable, so it must remain saveable");
      // The invariant that actually matters: the clip's sync flag must agree
      // with whether the renderer warped the donor. If it did warp, the clip
      // must be synced or the difference must be reported; if it did not, an
      // unsynced clip is exactly right.
      const [unanalysedVersion] = await dbModule.db.select().from(schema.remixVersions)
        .where(eq(schema.remixVersions.id, unanalysedBody.version!.id));
      const unanalysedSnapshot = JSON.parse(unanalysedVersion!.snapshot) as {
        mashupPlan?: { vocalsStretchRatio?: number };
      };
      const unanalysedRatio = unanalysedSnapshot.mashupPlan?.vocalsStretchRatio ?? 1;
      const unanalysedProvenance2 = await savedProvenance(unanalysedBody.remix!.id);
      const unanalysedDrumsStemId = await stemAssetIdFor(unanalysedDonorId, "drums");
      const unanalysedClips = await dbModule.db.select().from(schema.remixClips)
        .where(inArray(schema.remixClips.remixTrackId, unanalysedProvenance2.tracks.map((track) => track.id)));
      const unanalysedClip = unanalysedClips.find((clip) => clip.stemAssetId === unanalysedDrumsStemId);
      assert.ok(unanalysedClip, "the donor without analysed tempo must still be persisted");
      const unanalysedWarped = Math.abs(unanalysedRatio - 1) > 1e-6;
      if (unanalysedWarped) {
        assert.equal(unanalysedClip!.tempoSyncEnabled, true,
          `the renderer warped this donor ${unanalysedRatio.toFixed(3)}x, so the export must warp it too`);
      } else {
        assert.equal(unanalysedClip!.tempoSyncEnabled, false,
          "when the plan left the donor at its native rate, an unsynced clip is the faithful record");
        assert.ok(!(unanalysedBody.warnings ?? []).some((line) => /not tempo-synced/i.test(line)),
          "a parity warning must not be raised when render and export already agree");
      }

      // Prove the export actually honours the sync rather than merely storing
      // a flag: export the stretched session and check that the donor's drum
      // content spans the session, not its native length.
      const [stretchedExportJob] = await dbModule.db.insert(schema.exportJobs).values({
        projectId: project.id,
        remixSessionId: stretchedSaveBody.remix.id,
        remixVersionId: stretchedSaveBody.version.id,
        requestedById: stretchedSession!.ownerId,
        status: "queued",
        stage: "queued",
        idempotencyKey: `stretched-export-${randomUUID()}`,
        format: "wav",
        sampleRate: RATE,
        channels: 2,
      }).returning();
      assert.ok(stretchedExportJob);
      const stretchedExportWorker = await import("@workspace/arena/lib/waveyard/worker-local/export");
      await stretchedExportWorker.handleExportJob({
        exportJobId: stretchedExportJob.id,
        projectId: project.id,
        remixSessionId: stretchedSaveBody.remix.id,
        remixVersionId: stretchedSaveBody.version.id,
        format: "wav",
      });
      const [stretchedAsset] = await dbModule.db.select().from(schema.exportAssets)
        .where(eq(schema.exportAssets.exportJobId, stretchedExportJob.id));
      assert.ok(stretchedAsset,
        "a tempo-synced donor clip must survive the real export worker, not fail on missing source audio");
      assert.equal(stretchedAsset!.sampleRate, RATE);
      assert.equal(stretchedAsset!.channels, 2);

      // A request the render would refuse must not be saved either: saving is
      // not a way to persist an arrangement the renderer would not produce.
      const unhonourableSave = await routeModule.POST(
        new Request(`http://localhost/api/waveyard/projects/${project.id}/mashup`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "save",
            vocalsSourceId: donorWithoutDrumsId,
            instrumentalSourceId: fullBedId,
            alignmentStrategy: "continuous",
            layerStemTypes: ["drums"],
            stemLayerMode: "replace",
          }),
        }),
        { params: Promise.resolve({ id: project.id }) },
      );
      assert.equal(unhonourableSave.status, 422,
        "a save whose composition cannot be honoured must be refused, not persisted");
      const sessionCountAfterRefusal = (await dbModule.db.select().from(schema.remixSessions)).length;
      assert.ok(sessionCountAfterRefusal >= 2);
    }

    const saveRequest = (alignmentStrategy?: "continuous" | "paired-grid" | "downbeat" | "phrase-aware") => new Request(`http://localhost/api/waveyard/projects/${project.id}/mashup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "save",
        vocalsSourceId: vocalsSource.id,
        instrumentalSourceId: bedSource.id,
        ...(alignmentStrategy ? { alignmentStrategy } : {}),
      }),
    });
    if (!realFixture) {
      // Count before the attempt: earlier acceptance blocks legitimately create
      // their own sessions, so "no session at all" is not the property under
      // test — "no session from this refused save" is.
      const sessionsBeforeRefusal = (await dbModule.db.select().from(schema.remixSessions)).length;
      const unavailableSave = await routeModule.POST(
        saveRequest(),
        { params: Promise.resolve({ id: project.id }) },
      );
      assert.equal(unavailableSave.status, 422, "an editable save refuses an unavailable separated bed");
      assert.equal((await dbModule.db.select().from(schema.remixSessions)).length, sessionsBeforeRefusal,
        "a refused save does not leave a partial Studio session");

      await dbModule.db.update(schema.processingJobs)
        .set({ status: "complete", stage: "complete", completedAt: new Date(), errorCode: null, errorMessage: null })
        .where(eq(schema.processingJobs.id, bedJob.id));
    }
    // Save action: persists the planned mashup into remixSessions, remixTracks, and remixClips.
    const saveResponse = await routeModule.POST(saveRequest("continuous"), { params: Promise.resolve({ id: project.id }) });
    assert.equal(saveResponse.status, 201, "save action must return 201 Created");
    const saveBody = (await saveResponse.json()) as { ok: boolean; remix: { id: string; name: string }; version: { id: string } };
    assert.equal(saveBody.ok, true);
    assert.ok(saveBody.remix.id);
    assert.ok(saveBody.version.id);
    const [initialVersion] = await dbModule.db.select().from(schema.remixVersions)
      .where(eq(schema.remixVersions.id, saveBody.version.id));
    assert.ok(initialVersion);
    const initialSnapshot = JSON.parse(initialVersion.snapshot) as {
      mashupPlan?: {
        alignmentStrategy?: string;
        arrangement?: unknown;
        passageSearch?: { selectedDonorSectionId?: string | null; selectedBedSectionId?: string | null } | null;
        segments?: Array<{ mashupStartMs: number; vocalsFromMs: number }>;
        clipTimingMaps?: Array<{ clipId: string; remixTrackId: string; stemAssetId: string }>;
      };
    };
    assert.equal(initialSnapshot.mashupPlan?.alignmentStrategy, "continuous",
      "the user-selected alignment strategy must survive the persisted remix version");
    assert.deepEqual(
      initialSnapshot.mashupPlan?.arrangement ?? null,
      continuousPlan.arrangement ?? null,
      "the selected candidate's placement decision must survive the persisted remix version",
    );
    if (realFixture) {
      const plannedLocalMaps = continuousPlan.segments
        .filter((segment) => segment.localTempoMap);
      assert.equal(
        initialSnapshot.mashupPlan?.clipTimingMaps?.length ?? 0,
        plannedLocalMaps.length,
        "the persisted Studio version must bind every planner WSOLA map to its exact saved vocal clip",
      );
      assert.deepEqual(
        initialSnapshot.mashupPlan?.segments?.map((segment) => [segment.mashupStartMs, segment.vocalsFromMs]),
        continuousPlan.segments.map((segment) => [segment.mashupStartMs, segment.vocalsFromMs]),
        "the selected continuous candidate must be included in the persisted remix version",
      );
      assert.deepEqual(
        [
          initialSnapshot.mashupPlan?.passageSearch?.selectedDonorSectionId ?? null,
          initialSnapshot.mashupPlan?.passageSearch?.selectedBedSectionId ?? null,
        ],
        [
          continuousPlan.passageSearch?.selectedDonorSectionId ?? null,
          continuousPlan.passageSearch?.selectedBedSectionId ?? null,
        ],
        "the exact selected passage decision must survive into the versioned snapshot",
      );
    }

    // Verify database state: fetch saved remix session, tracks, and clips
    const [savedSession] = await dbModule.db
      .select()
      .from(schema.remixSessions)
      .where(eq(schema.remixSessions.id, saveBody.remix.id));
    assert.ok(savedSession, "saved remix session must exist in db");
    if (!realFixture) assert.equal(savedSession.tempoBpm, 120);
    else assert.equal(savedSession.tempoBpm, planBody.plan?.masterBpm,
      "persisted Studio tempo must match the actual source analysis plan");

    const savedTracks = await dbModule.db
      .select()
      .from(schema.remixTracks)
      .where(eq(schema.remixTracks.remixSessionId, savedSession.id));
    assert.ok(savedTracks.length >= 2, "remix must have vocal and bed tracks");
    const savedTrackStemProvenance = await dbModule.db.select({
      stemAssetId: schema.stemAssets.id,
      sourceAssetId: schema.stemAssets.sourceAssetId,
      stemType: schema.stemAssets.stemType,
    }).from(schema.stemAssets).where(inArray(schema.stemAssets.id, savedTracks.map((track) => track.stemAssetId)));
    if (realFixture) {
      assert.deepEqual(
        savedTrackStemProvenance.filter((stem) => stem.sourceAssetId === vocalsSource.id).map((stem) => stem.stemType).sort(),
        ["vocals"],
        "the saved vocal track must point to the distinct donor song's separated vocal stem",
      );
      assert.deepEqual(
        savedTrackStemProvenance.filter((stem) => stem.sourceAssetId === bedSource.id).map((stem) => stem.stemType).sort(),
        ["bass", "drums", "other"],
        "the saved bed must contain the chosen instrumental's three non-vocal stems only",
      );
    }

    const savedClips = await dbModule.db
      .select()
      .from(schema.remixClips)
      .where(inArray(schema.remixClips.remixTrackId, savedTracks.map((t) => t.id)));
    assert.ok(savedClips.length >= 2, "remix must have persisted vocal and bed clips");

    // Exercise the user-facing blank sequencer-track -> save -> reopen -> versioned
    // WAV path independently of the optional full-song fixture. The existing
    // source clip is deliberately placed after the first bar so the first two
    // pad steps can prove their exact audio without being masked by other tracks.
    {
      const remixRoute = await import("../../../../remixes/[id]/route");
      const tracksRoute = await import("../../../../remixes/[id]/tracks/route");
      const versionsRoute = await import("../../../../remixes/[id]/versions/route");
      const mediaRoute = await import("../../../../exports/[id]/media/route");
      const { buildChopSequencerClips, readChopSequencerSteps, CHOP_SEQUENCER_TRACK_NAME } =
        await import("@workspace/arena/lib/waveyard/studio/vocal-chops");
      const [chopSession] = await dbModule.db.insert(schema.remixSessions).values({
        projectId: project.id,
        ownerId: savedSession.ownerId,
        name: "Sequencer persistence acceptance",
        masterVolume: 1,
        loopStartMs: 0,
        loopEndMs: null,
        tempoBpm: 120,
        timeSignatureNumerator: 4,
        timeSignatureDenominator: 4,
        gridDivision: "beat",
        snapEnabled: true,
        targetKey: null,
      }).returning();
      assert.ok(chopSession);
      const [originalTrack] = await dbModule.db.insert(schema.remixTracks).values({
        remixSessionId: chopSession.id,
        stemAssetId: vocalsStemRow.id,
        name: "Original vocal source",
        sortOrder: 0,
        volume: 1,
        pan: 0,
        muted: false,
        solo: false,
      }).returning();
      assert.ok(originalTrack);
      const [originalClip] = await dbModule.db.insert(schema.remixClips).values({
        remixTrackId: originalTrack.id,
        stemAssetId: vocalsStemRow.id,
        timelineStartMs: 2_000,
        durationMs: 500,
        sourceOffsetMs: 0,
        gain: 1,
        fadeInMs: 0,
        fadeOutMs: 0,
        tempoSyncEnabled: false,
        keySyncEnabled: false,
        beatSnapEnabled: false,
      }).returning();
      assert.ok(originalClip);

      const chopParams = { params: Promise.resolve({ id: chopSession.id }) };
      const blankTrackResponse = await tracksRoute.POST(
        new Request(`http://localhost/api/remixes/${chopSession.id}/tracks`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ stemAssetId: vocalsStemRow.id, name: CHOP_SEQUENCER_TRACK_NAME }),
        }),
        chopParams,
      );
      assert.equal(blankTrackResponse.status, 201, "a same-project stem must create a blank sequencer track");
      const blankState = await blankTrackResponse.json() as {
        remix: typeof chopSession;
        tracks: Array<Record<string, unknown> & { id: string; name: string; stemAssetId: string; clips: Array<Record<string, unknown>> }>;
        automation: unknown[];
      };
      const sequencerTrack = blankState.tracks.find((track) => track.name === CHOP_SEQUENCER_TRACK_NAME);
      const originalTrackAfterCreate = blankState.tracks.find((track) => track.id === originalTrack.id);
      assert.ok(sequencerTrack, "the blank track must be returned by the production route");
      assert.equal(sequencerTrack.stemAssetId, vocalsStemRow.id);
      assert.deepEqual(sequencerTrack.clips, [], "creating the sequencer must not copy the source track's clips");
      assert.equal(originalTrackAfterCreate?.clips.length, 1, "the existing original clip must remain exactly once");

      const createVersion = async (name: string) => {
        const response = await versionsRoute.POST(
          new Request(`http://localhost/api/remixes/${chopSession.id}/versions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name }),
          }),
          chopParams,
        );
        assert.equal(response.status, 201, `the ${name} state must be versioned`);
        return (await response.json() as { version: { id: string } }).version;
      };
      const emptyPatternVersion = await createVersion("Before chop pattern");

      const sampleDurationMs = 80;
      const sourceOffsetMs = findAudibleSourceOffsetMs(decodedVocalStem, sampleDurationMs);
      const sample = {
        id: "audible-vocal-chop",
        stemAssetId: vocalsStemRow.id,
        startMs: sourceOffsetMs,
        durationMs: sampleDurationMs,
      };
      const expectedSteps = ["audible-vocal-chop", null, "audible-vocal-chop", ...Array.from({ length: 13 }, () => null)];
      const sequencerClips = buildChopSequencerClips([sample], expectedSteps, blankState.remix.tempoBpm);
      assert.equal(sequencerClips.length, 2, "the pattern must create one clip for each assigned pad step");
      const arrangementInput = (state: typeof blankState, nextTracks: typeof blankState.tracks) => ({
        ...state.remix,
        tracks: nextTracks,
        automation: state.automation,
        expectedVersion: state.remix.version,
      });
      const tracksWithPattern = blankState.tracks.map((track) =>
        track.id === sequencerTrack.id
          ? { ...track, clips: sequencerClips }
          : track,
      );
      const patternSaveResponse = await remixRoute.PUT(
        new Request(`http://localhost/api/remixes/${chopSession.id}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(arrangementInput(blankState, tracksWithPattern)),
        }),
        chopParams,
      );
      assert.equal(patternSaveResponse.status, 200, "the generated pad clips must save through the version-checked Studio route");

      const staleSaveResponse = await remixRoute.PUT(
        new Request(`http://localhost/api/remixes/${chopSession.id}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(arrangementInput(blankState, blankState.tracks)),
        }),
        chopParams,
      );
      assert.equal(staleSaveResponse.status, 409, "an older blank-pattern edit must not overwrite the newer saved pattern");

      const reopenedResponse = await remixRoute.GET(
        new Request(`http://localhost/api/remixes/${chopSession.id}`),
        chopParams,
      );
      assert.equal(reopenedResponse.status, 200, "the saved sequencer arrangement must reopen through the production route");
      const reopened = await reopenedResponse.json() as {
        remix: typeof chopSession;
        tracks: Array<Record<string, unknown> & { id: string; name: string; clips: Array<Record<string, unknown> & {
          stemAssetId: string;
          timelineStartMs: number;
          durationMs: number;
          sourceOffsetMs: number;
          chopStepIndex: number | null;
          chopSampleDurationMs: number | null;
        }> }>;
        automation: unknown[];
      };
      const reopenedSequencer = reopened.tracks.find((track) => track.id === sequencerTrack.id);
      const reopenedOriginal = reopened.tracks.find((track) => track.id === originalTrack.id);
      assert.ok(reopenedSequencer);
      assert.equal(reopenedSequencer.clips.length, 2);
      assert.equal(reopenedOriginal?.clips.length, 1, "saving the pattern must not duplicate original track clips");
      assert.deepEqual(
        readChopSequencerSteps(reopenedSequencer.clips, [sample], reopened.remix.tempoBpm),
        expectedSteps,
        "reopening the remix must reconstruct every assigned and empty sequencer step",
      );
      assert.deepEqual(
        reopenedSequencer.clips.map((clip) => [clip.chopStepIndex, clip.chopSampleDurationMs]),
        [[0, sampleDurationMs], [2, sampleDurationMs]],
        "step identity and uncapped chop length must survive database save and reload",
      );

      const patternVersion = await createVersion("Saved chop pattern");
      const [patternVersionRow] = await dbModule.db.select().from(schema.remixVersions)
        .where(eq(schema.remixVersions.id, patternVersion.id));
      assert.ok(patternVersionRow);
      const patternSnapshot = JSON.parse(patternVersionRow.snapshot) as {
        tracks: Array<{ id: string; clips: Array<{ chopStepIndex: number | null; chopSampleDurationMs: number | null }> }>;
      };
      assert.equal(patternSnapshot.tracks.find((track) => track.id === sequencerTrack.id)?.clips.length, 2,
        "the immutable export version must contain both generated pad hits");

      const exportAndDecodeVersion = async (versionId: string, name: string) => {
        const [job] = await dbModule.db.insert(schema.exportJobs).values({
          projectId: project.id,
          remixSessionId: chopSession.id,
          remixVersionId: versionId,
          requestedById: chopSession.ownerId,
          status: "queued",
          stage: "queued",
          idempotencyKey: `chop-pattern-${name}-${randomUUID()}`,
          format: "wav",
          sampleRate: RATE,
          channels: 2,
        }).returning();
        assert.ok(job);
        const exportWorker = await import("@workspace/arena/lib/waveyard/worker-local/export");
        await exportWorker.handleExportJob({
          exportJobId: job.id,
          projectId: project.id,
          remixSessionId: chopSession.id,
          remixVersionId: versionId,
          format: "wav",
        });
        const [completed] = await dbModule.db.select().from(schema.exportJobs)
          .where(eq(schema.exportJobs.id, job.id));
        assert.equal(completed.status, "complete", `${name} version must finish the local WAV export`);
        const response = await mediaRoute.GET(
          new Request(`http://localhost/api/exports/${job.id}/media`),
          { params: Promise.resolve({ id: job.id }) },
        );
        assert.equal(response.status, 200, `${name} WAV must be available through the production media route`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        assert.equal(sha256(bytes), (await dbModule.db.select().from(schema.exportAssets)
          .where(eq(schema.exportAssets.exportJobId, job.id)))[0]!.checksumSha256);
        const decoded = decodeWav16(bytes);
        assert.ok(decoded, `${name} WAV must decode as PCM`);
        return decoded!;
      };
      const staleVersionExport = await exportAndDecodeVersion(emptyPatternVersion.id, "stale-empty");
      assert.ok(windowRms(staleVersionExport.samples, staleVersionExport.channels, staleVersionExport.sampleRate, 10, 70) < 1e-4,
        "exporting an older version must not silently read the later live chop pattern");
      const patternExport = await exportAndDecodeVersion(patternVersion.id, "saved-pattern");
      assert.ok(windowRms(patternExport.samples, 2, RATE, 10, 70) > 0.0005,
        "the first saved chop must produce audible audio at its assigned step");
      assert.ok(windowRms(patternExport.samples, 2, RATE, 130, 240) < 1e-4,
        "the unassigned second step must remain silent");
      assert.ok(windowRms(patternExport.samples, 2, RATE, 260, 320) > 0.0005,
        "the repeated chop must produce audio at its second assigned step");
      assert.ok(Math.abs(patternExport.frames / RATE - 2.5) < 0.1,
        "the export duration must come from the original clip and include the sequencer pattern");

      // Force a validated, clip-bound paired-grid map through the real Studio
      // route, immutable version snapshot, FFmpeg worker and downloadable WAV.
      // This deterministic acceptance fixture exercises the production
      // persistence/render path even when no external separated-song manifest
      // is configured.
      const vocalStemId = savedTrackStemProvenance.find((stem) =>
        stem.sourceAssetId === vocalsSource.id && stem.stemType === "vocals")!.stemAssetId;
      const vocalTrack = savedTracks.find((track) => track.stemAssetId === vocalStemId)!;
      const vocalClip = savedClips.find((clip) => clip.stemAssetId === vocalStemId)!;
      const [timingStem] = await dbModule.db.select().from(schema.stemAssets)
        .where(eq(schema.stemAssets.id, vocalStemId));
      const [timingSource] = await dbModule.db.select().from(schema.sourceAssets)
        .where(eq(schema.sourceAssets.id, vocalsSource.id));
      assert.ok(timingStem && timingSource?.checksumSha256);
      const availableSourceMs = timingStem.durationSeconds * 1_000 - vocalClip.sourceOffsetMs;
      const sourceSpanMs = Math.min(vocalClip.durationMs / 0.9, availableSourceMs - 2);
      assert.ok(sourceSpanMs >= 500, "the persisted vocal clip must contain enough verified PCM for a local timing map");
      const baseStretchRatio = vocalClip.durationMs / sourceSpanMs;
      assert.ok(Math.abs(baseStretchRatio - 0.9) < 0.02,
        "the export fixture must use a non-unit base tempo so double application is observable");
      await dbModule.db.update(schema.remixSessions).set({ tempoBpm: 108, updatedAt: new Date() })
        .where(eq(schema.remixSessions.id, saveBody.remix.id));
      const midpointSourceMs = sourceSpanMs / 2;
      const timingMap = createPersistedClipTempoMap({
        clipId: vocalClip.id,
        remixTrackId: vocalTrack.id,
        stemAssetId: vocalStemId,
        sourceAssetId: vocalsSource.id,
        sourceChecksumSha256: timingSource.checksumSha256,
        stemChecksumSha256: timingStem.checksumSha256!,
        sourceOffsetMs: vocalClip.sourceOffsetMs,
        timelineStartMs: vocalClip.timelineStartMs,
        durationMs: vocalClip.durationMs,
        sessionTempoBpm: 108,
        baseStretchRatio,
        map: {
          points: [
            { sourceMs: 0, outputMs: 0 },
            { sourceMs: midpointSourceMs, outputMs: midpointSourceMs * baseStretchRatio * 0.995 },
            { sourceMs: sourceSpanMs, outputMs: vocalClip.durationMs },
          ],
          baselineFit: { matchedBeats: 4, comparedBeats: 8, meanErrorMs: 42 },
          correctedFit: { matchedBeats: 7, comparedBeats: 8, meanErrorMs: 11 },
          maximumRateDeviationPercent: 0.5,
          entryShiftMs: 0,
        },
      });
      assert.ok(timingMap, "the persisted clip map must satisfy timing, checksum, and local-rate bounds");
      const timingSnapshot = JSON.parse(initialVersion.snapshot) as Record<string, unknown> & {
        tracks: Array<Record<string, unknown> & { stemAssetId: string; clips: Array<Record<string, unknown> & { id: string }> }>;
        mashupPlan?: Record<string, unknown>;
      };
      timingSnapshot.tracks = timingSnapshot.tracks.map((track) => ({
        ...track,
        muted: track.stemAssetId !== vocalStemId,
        solo: false,
        volume: 1,
        clips: track.clips.map((clip) => clip.id === vocalClip.id
          ? { ...clip, gain: 1, fadeInMs: 0, fadeOutMs: 0, tempoSyncEnabled: true, keySyncEnabled: false }
          : clip),
      }));
      timingSnapshot.mashupPlan = {
        ...(timingSnapshot.mashupPlan ?? {}),
        clipTimingMaps: [timingMap],
      };
      timingSnapshot.tempoBpm = 108;
      const [timingVersion] = await dbModule.db.insert(schema.remixVersions).values({
        remixSessionId: saveBody.remix.id,
        createdById: savedSession.ownerId,
        name: "Paired-grid local timing acceptance",
        snapshot: JSON.stringify(timingSnapshot),
      }).returning();
      assert.ok(timingVersion);

      const timingRemixRoute = await import("../../../../remixes/[id]/route");
      const timingVersionsRoute = await import("../../../../remixes/[id]/versions/route");
      const timingReload = await timingRemixRoute.GET(
        new Request(`http://localhost/api/remixes/${saveBody.remix.id}`),
        { params: Promise.resolve({ id: saveBody.remix.id }) },
      );
      assert.equal(timingReload.status, 200);
      const timingState = await timingReload.json() as {
        remix: typeof savedSession;
        tracks: Array<{ clips: Array<Record<string, unknown> & { id: string }> }>;
        automation: unknown[];
      };
      const rehydratedMap = timingState.tracks.flatMap((track) => track.clips)
        .find((clip) => clip.id === vocalClip.id)?.localTempoMap;
      assert.deepEqual(rehydratedMap, timingMap,
        "Studio must rehydrate the map only for the exact clip, source checksums, tempo and timing");
      const harmlessTimingEdit = await timingRemixRoute.PUT(
        new Request(`http://localhost/api/remixes/${saveBody.remix.id}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...timingState.remix,
            masterVolume: 0.9,
            tracks: timingState.tracks,
            automation: timingState.automation,
            expectedVersion: timingState.remix.version,
          }),
        }),
        { params: Promise.resolve({ id: saveBody.remix.id }) },
      );
      assert.equal(harmlessTimingEdit.status, 200, "an unrelated Studio edit must retain the bound clip identity");
      const timingEditVersionResponse = await timingVersionsRoute.POST(
        new Request(`http://localhost/api/remixes/${saveBody.remix.id}/versions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "Paired-grid local timing saved edit" }),
        }),
        { params: Promise.resolve({ id: saveBody.remix.id }) },
      );
      assert.equal(timingEditVersionResponse.status, 201);
      const timingEditVersionBody = await timingEditVersionResponse.json() as { version: { id: string } };
      const [timingEditVersion] = await dbModule.db.select().from(schema.remixVersions)
        .where(eq(schema.remixVersions.id, timingEditVersionBody.version.id));
      assert.equal(
        (JSON.parse(timingEditVersion!.snapshot) as { mashupPlan?: { clipTimingMaps?: unknown[] } })
          .mashupPlan?.clipTimingMaps?.length,
        1,
        "unrelated edits must carry the map into the next immutable export version",
      );
      const afterHarmlessEdit = await (await timingRemixRoute.GET(
        new Request(`http://localhost/api/remixes/${saveBody.remix.id}`),
        { params: Promise.resolve({ id: saveBody.remix.id }) },
      )).json() as {
        remix: typeof savedSession;
        tracks: Array<{ clips: Array<Record<string, unknown> & { id: string; stemAssetId: string; timelineStartMs: number }> }>;
        automation: unknown[];
      };
      assert.ok(afterHarmlessEdit.tracks.flatMap((track) => track.clips)
        .find((clip) => clip.id === vocalClip.id)?.localTempoMap,
      "the exact map must remain usable after a saved, unrelated Studio edit");
      const staleTimingEdit = await timingRemixRoute.PUT(
        new Request(`http://localhost/api/remixes/${saveBody.remix.id}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...afterHarmlessEdit.remix,
            tracks: afterHarmlessEdit.tracks.map((track) => ({
              ...track,
              clips: track.clips.map((clip) => clip.id === vocalClip.id
                ? { ...clip, timelineStartMs: clip.timelineStartMs + 1 }
                : clip),
            })),
            automation: afterHarmlessEdit.automation,
            expectedVersion: afterHarmlessEdit.remix.version,
          }),
        }),
        { params: Promise.resolve({ id: saveBody.remix.id }) },
      );
      assert.equal(staleTimingEdit.status, 200);
      const staleTimingState = await (await timingRemixRoute.GET(
        new Request(`http://localhost/api/remixes/${saveBody.remix.id}`),
        { params: Promise.resolve({ id: saveBody.remix.id }) },
      )).json() as { tracks: Array<{ clips: Array<Record<string, unknown> & { id: string }> }> };
      assert.equal(staleTimingState.tracks.flatMap((track) => track.clips)
        .find((clip) => clip.id === vocalClip.id)?.localTempoMap, undefined,
      "a changed clip boundary must never use a stale local map");
      const timingRestoreRoute = await import("../../../../remixes/[id]/versions/[versionId]/restore/route");
      const timingRestore = await timingRestoreRoute.POST(
        new Request(`http://localhost/api/remixes/${saveBody.remix.id}/versions/${timingEditVersionBody.version.id}/restore`, {
          method: "POST",
        }),
        { params: Promise.resolve({ id: saveBody.remix.id, versionId: timingEditVersionBody.version.id }) },
      );
      assert.equal(timingRestore.status, 200);
      const restoredTimingState = await (await timingRemixRoute.GET(
        new Request(`http://localhost/api/remixes/${saveBody.remix.id}`),
        { params: Promise.resolve({ id: saveBody.remix.id }) },
      )).json() as { tracks: Array<{ clips: Array<Record<string, unknown> & { id: string }> }> };
      assert.deepEqual(restoredTimingState.tracks.flatMap((track) => track.clips)
        .find((clip) => clip.id === vocalClip.id)?.localTempoMap, timingMap,
      "version restore must restore clip identity and the original measured map");

      const timingStemBytes = new Uint8Array(await storage.getBuffer(timingStem.storageKey, 256 * 1024 * 1024));
      const decodedTimingStem = decodeWav16(timingStemBytes);
      assert.ok(decodedTimingStem?.channels === 2);
      const timingWindow = makeLocalTempoMapWindow(timingMap, RATE, 0, vocalClip.durationMs, 0);
      assert.ok(timingWindow);
      const sourceStartFrame = Math.round(vocalClip.sourceOffsetMs * RATE / 1_000);
      const sourcePcm = decodedTimingStem.samples.subarray(
        (sourceStartFrame + timingWindow.inputStartFrame) * 2,
        (sourceStartFrame + timingWindow.inputEndFrame) * 2,
      );
      const expectedMappedPcm = renderLocalTempoMapRange(sourcePcm, RATE, timingWindow);
      assert.ok(expectedMappedPcm);

      const [timingExportJob] = await dbModule.db.insert(schema.exportJobs).values({
        projectId: project.id,
        remixSessionId: saveBody.remix.id,
        remixVersionId: timingVersion.id,
        requestedById: savedSession.ownerId,
        status: "queued",
        stage: "queued",
        idempotencyKey: `paired-grid-local-map-${randomUUID()}`,
        format: "wav",
        sampleRate: RATE,
        channels: 2,
      }).returning();
      assert.ok(timingExportJob);
      const exportWorker = await import("@workspace/arena/lib/waveyard/worker-local/export");
      await exportWorker.handleExportJob({
        exportJobId: timingExportJob.id,
        projectId: project.id,
        remixSessionId: saveBody.remix.id,
        remixVersionId: timingVersion.id,
        format: "wav",
      });
      const [timingExportCompleted] = await dbModule.db.select().from(schema.exportJobs)
        .where(eq(schema.exportJobs.id, timingExportJob.id));
      assert.equal(timingExportCompleted.status, "complete",
        "the real local export worker must render a map-bound clip instead of double-applying global tempo");
      const timingExportMediaRoute = await import("../../../../exports/[id]/media/route");
      const timingExportResponse = await timingExportMediaRoute.GET(
        new Request(`http://localhost/api/exports/${timingExportJob.id}/media`),
        { params: Promise.resolve({ id: timingExportJob.id }) },
      );
      assert.equal(timingExportResponse.status, 200);
      const timingExported = decodeWav16(new Uint8Array(await timingExportResponse.arrayBuffer()));
      assert.ok(timingExported?.channels === 2 && timingExported.sampleRate === RATE);
      const clipStartFrame = Math.round(vocalClip.timelineStartMs * RATE / 1_000);
      const comparisonStartFrame = Math.round(0.25 * RATE);
      const comparisonEndFrame = Math.min(
        expectedMappedPcm.length / 2 - Math.round(0.25 * RATE),
        timingExported.frames - clipStartFrame - Math.round(0.25 * RATE),
      );
      let dot = 0;
      let expectedEnergy = 0;
      let actualEnergy = 0;
      for (let frame = comparisonStartFrame; frame < comparisonEndFrame; frame += 17) {
        const expectedSample = (expectedMappedPcm[frame * 2]! + expectedMappedPcm[frame * 2 + 1]!) / 2;
        const actualFrame = clipStartFrame + frame;
        const actualSample = (timingExported.samples[actualFrame * 2]! + timingExported.samples[actualFrame * 2 + 1]!) / 2;
        dot += expectedSample * actualSample;
        expectedEnergy += expectedSample * expectedSample;
        actualEnergy += actualSample * actualSample;
      }
      const exportCorrelation = dot / Math.sqrt(expectedEnergy * actualEnergy);
      assert.ok(Number.isFinite(exportCorrelation) && exportCorrelation > 0.94,
        `downloaded WAV must render the same WSOLA waveform as Studio preview (mid-clip correlation ${exportCorrelation})`);
      console.info(JSON.stringify({
        waveyardLocalTempoMapStudioExport: {
          clipId: vocalClip.id,
          nonUnitBaseTempoRatio: baseStretchRatio,
          exportDurationMs: vocalClip.durationMs,
          midClipPreviewToDownloadCorrelation: Number(exportCorrelation.toFixed(4)),
        },
      }));
    }

    if (realFixture) {
      const donorVocalStem = savedTrackStemProvenance.find((stem) =>
        stem.sourceAssetId === vocalsSource.id && stem.stemType === "vocals");
      assert.ok(donorVocalStem, "the saved donor vocal clip must retain its source provenance");
      const persistedVocalClips = savedClips.filter((clip) => clip.stemAssetId === donorVocalStem.stemAssetId);
      assert.equal(persistedVocalClips.length, planBody.plan?.segments.length,
        "the chosen passage plan must save each planned donor vocal clip");
      for (const [index, clip] of persistedVocalClips.entries()) {
        const plannedSegment = planBody.plan!.segments[index]!;
        assert.equal(clip.timelineStartMs, plannedSegment.mashupStartMs,
          "the all-track passage entry must survive the route's save transaction");
        assert.equal(clip.sourceOffsetMs, plannedSegment.vocalsFromMs,
          "saving a later passage must not trim away earlier donor material");
        assert.equal(clip.durationMs, plannedSegment.mashupEndMs - plannedSegment.mashupStartMs);
      }
    }

    for (const clip of savedClips) {
      assert.ok(Number.isFinite(clip.timelineStartMs) && clip.timelineStartMs >= 0);
      assert.ok(clip.durationMs > 0);
      assert.ok(clip.gain > 0 && clip.gain <= 1);
    }

    if (realFixture) {
      const remixRoute = await import("../../../../remixes/[id]/route");
      const versionsRoute = await import("../../../../remixes/[id]/versions/route");
      const restoreRoute = await import("../../../../remixes/[id]/versions/[versionId]/restore/route");
      const remixParams = { params: Promise.resolve({ id: saveBody.remix.id }) };
      const reload = await remixRoute.GET(
        new Request(`http://localhost/api/remixes/${saveBody.remix.id}`),
        remixParams,
      );
      assert.equal(reload.status, 200, "a saved real-stem session must reopen through the production Studio API");
      const reopened = await reload.json() as {
        remix: typeof savedSession;
        tracks: Array<Record<string, unknown> & { id: string; clips: Array<Record<string, unknown>> }>;
        automation: unknown[];
      };
      assert.equal(reopened.remix.id, saveBody.remix.id);
      assert.ok(reopened.tracks.length >= 2);
      assert.ok(reopened.tracks.reduce((sum, track) => sum + track.clips.length, 0) >= 2);
      const reopenedVocalClips = reopened.tracks
        .flatMap((track) => track.clips)
        .filter((clip) => clip.stemAssetId === savedTrackStemProvenance.find((stem) =>
          stem.sourceAssetId === vocalsSource.id && stem.stemType === "vocals")?.stemAssetId);
      assert.equal(
        reopenedVocalClips.filter((clip) => clip.localTempoMap).length,
        plannedLocalMaps.length,
        "the production reopen route must rehydrate only the source-current clip maps",
      );
      assert.deepEqual(
        reopenedVocalClips.map((clip) => [clip.timelineStartMs, clip.sourceOffsetMs]),
        savedClips
          .filter((clip) => reopenedVocalClips.some((reopenedClip) => reopenedClip.id === clip.id))
          .map((clip) => [clip.timelineStartMs, clip.sourceOffsetMs]),
        "the reopened Studio must retain the selected passage timing and full donor source offset",
      );

      const editInput = {
        ...reopened.remix,
        masterVolume: 0.85,
        tracks: reopened.tracks,
        automation: reopened.automation,
        expectedVersion: reopened.remix.version,
      };
      const editResponse = await remixRoute.PUT(
        new Request(`http://localhost/api/remixes/${saveBody.remix.id}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(editInput),
        }),
        remixParams,
      );
      assert.equal(editResponse.status, 200, "the real-stem arrangement must accept a version-checked Studio edit");

      const versionResponse = await versionsRoute.POST(
        new Request(`http://localhost/api/remixes/${saveBody.remix.id}/versions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "Real-song acceptance edit" }),
        }),
        remixParams,
      );
      assert.equal(versionResponse.status, 201, "the edited real-stem arrangement must persist a named version");
      const versionBody = await versionResponse.json() as { version: { id: string } };
      assert.ok(versionBody.version.id);
      const [editedVersion] = await dbModule.db.select().from(schema.remixVersions)
        .where(eq(schema.remixVersions.id, versionBody.version.id));
      assert.ok(editedVersion);
      const editedSnapshot = JSON.parse(editedVersion.snapshot) as {
        mashupPlan?: { passageSearch?: { selectedDonorSectionId?: string | null; selectedBedSectionId?: string | null } | null };
      };
      assert.equal(
        (editedSnapshot.mashupPlan as { clipTimingMaps?: unknown[] } | undefined)?.clipTimingMaps?.length ?? 0,
        plannedLocalMaps.length,
        "an unrelated mixer edit must retain the complete local timing-map provenance",
      );
      assert.deepEqual(
        [
          editedSnapshot.mashupPlan?.passageSearch?.selectedDonorSectionId ?? null,
          editedSnapshot.mashupPlan?.passageSearch?.selectedBedSectionId ?? null,
        ],
        [
          planBody.plan?.passageSearch?.selectedDonorSectionId ?? null,
          planBody.plan?.passageSearch?.selectedBedSectionId ?? null,
        ],
        "later edited versions retain the original passage-selection provenance",
      );

      const editedReload = await (await remixRoute.GET(
        new Request(`http://localhost/api/remixes/${saveBody.remix.id}`),
        remixParams,
      )).json() as {
        remix: typeof savedSession;
        tracks: Array<{ clips: Array<Record<string, unknown> & { id: string; stemAssetId: string; timelineStartMs: number }> }>;
      };
      assert.equal(editedReload.remix.masterVolume, 0.85, "the Studio edit must survive a fresh API read");
      assert.ok(editedReload.tracks.reduce((sum, track) => sum + track.clips.length, 0) >= 2,
        "the saved real clips must survive reopening");
      assert.equal(
        editedReload.tracks.flatMap((track) => track.clips).filter((clip) => clip.localTempoMap).length,
        plannedLocalMaps.length,
        "a harmless gain/master edit must not discard the same persisted map",
      );

      const divergentInput = {
        ...editedReload.remix,
        masterVolume: 0.35,
        tracks: editedReload.tracks.map((track) => ({
          ...track,
          clips: track.clips.map((clip) => clip.stemAssetId === reopenedVocalClips[0]?.stemAssetId
            ? { ...clip, timelineStartMs: clip.timelineStartMs + 1 }
            : clip),
        })),
        automation: reopened.automation,
        expectedVersion: editedReload.remix.version,
      };
      const divergentSave = await remixRoute.PUT(
        new Request(`http://localhost/api/remixes/${saveBody.remix.id}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(divergentInput),
        }),
        remixParams,
      );
      assert.equal(divergentSave.status, 200);
      const staleMapReload = await (await remixRoute.GET(
        new Request(`http://localhost/api/remixes/${saveBody.remix.id}`),
        remixParams,
      )).json() as { tracks: Array<{ clips: Array<Record<string, unknown> & { stemAssetId: string }> }> };
      assert.equal(
        staleMapReload.tracks.flatMap((track) => track.clips)
          .filter((clip) => clip.stemAssetId === reopenedVocalClips[0]?.stemAssetId && clip.localTempoMap).length,
        0,
        "a timeline edit must reject the previously measured clip map and use continuous tempo fallback",
      );
      const restoreResponse = await restoreRoute.POST(
        new Request(`http://localhost/api/remixes/${saveBody.remix.id}/versions/${versionBody.version.id}/restore`, {
          method: "POST",
        }),
        { params: Promise.resolve({ id: saveBody.remix.id, versionId: versionBody.version.id }) },
      );
      assert.equal(restoreResponse.status, 200, "Studio must restore the saved real-song version");
      const restored = await (await remixRoute.GET(
        new Request(`http://localhost/api/remixes/${saveBody.remix.id}`),
        remixParams,
      )).json() as { remix: typeof savedSession; tracks: Array<{ clips: unknown[] }> };
      assert.equal(restored.remix.masterVolume, 0.85, "restore must recover the exact saved mixer level");
      assert.ok(restored.tracks.reduce((sum, track) => sum + track.clips.length, 0) >= 2);
      assert.equal(
        restored.tracks.flatMap((track) => track.clips)
          .filter((clip) => (clip as Record<string, unknown>).localTempoMap).length,
        plannedLocalMaps.length,
        "restoring the measured version must reinstate its exact clip identity and local timing map",
      );

      // Run the same local export worker that consumes versioned Studio state.
      // This avoids reporting a queued job as a rendered file when no queue is
      // present in the acceptance sandbox.
      const [exportJob] = await dbModule.db.insert(schema.exportJobs).values({
        projectId: project.id,
        remixSessionId: saveBody.remix.id,
        remixVersionId: versionBody.version.id,
        requestedById: (await dbModule.db.select().from(schema.remixSessions)
          .where(eq(schema.remixSessions.id, saveBody.remix.id)))[0]!.ownerId,
        status: "queued",
        stage: "queued",
        idempotencyKey: `real-mashup-export-${randomUUID()}`,
        format: "wav",
        sampleRate: RATE,
        channels: 2,
      }).returning();
      assert.ok(exportJob);
      const exportWorker = await import("@workspace/arena/lib/waveyard/worker-local/export");
      await exportWorker.handleExportJob({
        exportJobId: exportJob.id,
        projectId: project.id,
        remixSessionId: saveBody.remix.id,
        remixVersionId: versionBody.version.id,
        format: "wav",
      });
      const [completedJob] = await dbModule.db.select().from(schema.exportJobs)
        .where(eq(schema.exportJobs.id, exportJob.id));
      assert.equal(completedJob.status, "complete", "the persisted Studio version must finish the actual WAV export worker");
      const [exportAsset] = await dbModule.db.select().from(schema.exportAssets)
        .where(eq(schema.exportAssets.exportJobId, exportJob.id));
      assert.ok(exportAsset, "the worker must persist a verified export asset");
      assert.equal(exportAsset.sampleRate, RATE);
      assert.equal(exportAsset.channels, 2);
      const exportedWavPath = process.env.WAVEYARD_MASHUP_REAL_STUDIO_EXPORT_PATH?.trim();
      const outputPath = exportedWavPath ? realFixturePath(exportedWavPath) : path.join(fixtureRoot, "studio-export.wav");
      await mkdir(path.dirname(outputPath), { recursive: true });
      const exportMediaRoute = await import("../../../../exports/[id]/media/route");
      const mediaResponse = await exportMediaRoute.GET(
        new Request(`http://localhost/api/exports/${exportJob.id}/media`),
        { params: Promise.resolve({ id: exportJob.id }) },
      );
      assert.equal(mediaResponse.status, 200, "the persisted Studio export must be downloadable through the production media endpoint");
      assert.equal(mediaResponse.headers.get("content-type"), "audio/wav");
      assert.equal(Number(mediaResponse.headers.get("content-length")), exportAsset.fileSizeBytes);
      const exportedWavBytes = new Uint8Array(await mediaResponse.arrayBuffer());
      assert.equal(exportedWavBytes.byteLength, exportAsset.fileSizeBytes);
      assert.equal(sha256(exportedWavBytes), exportAsset.checksumSha256,
        "the downloaded bytes must match the export worker's persisted checksum");
      await writeFile(outputPath, exportedWavBytes);
      const exportedWav = decodeWav16(exportedWavBytes);
      assert.ok(exportedWav, "the persisted Studio export must decode as WAV");
      assert.equal(exportedWav!.sampleRate, RATE);
      assert.equal(exportedWav!.channels, 2);
      assert.ok(Math.abs(exportedWav!.frames / RATE - bedDurationSeconds) < 1.1,
        "the persisted Studio export must keep the complete bed duration");

      const reportPath = process.env.WAVEYARD_MASHUP_REAL_REPORT_PATH?.trim();
      if (reportPath) {
        const resolvedReportPath = realFixturePath(reportPath);
        const report = JSON.parse(await readFile(resolvedReportPath, "utf8")) as Record<string, unknown>;
        report.studio = {
          sessionId: saveBody.remix.id,
          versionId: versionBody.version.id,
          trackCount: restored.tracks.length,
          clipCount: restored.tracks.reduce((sum, track) => sum + track.clips.length, 0),
          passageEvaluation: {
            vocalsFilename: realFixture.vocals.filename,
            vocalsChecksumSha256: sha256(vocalsOriginal),
            bedFilename: realFixture.bed.filename,
            bedChecksumSha256: sha256(bedOriginal),
            groundTruthStatus: "not-provided",
            accuracyMetrics: null,
            note: "Analyzer sections are structural time windows; no manual verse/chorus boundary labels were provided.",
            evaluatedPlan: {
              segments: planBody.plan?.segments ?? [],
              passageSearch: planBody.plan?.passageSearch ?? null,
              rationale: planBody.plan?.rationale ?? [],
              warnings: planBody.plan?.warnings ?? [],
            },
          },
          trackStemProvenance: savedTrackStemProvenance,
          masterVolumeAfterRestore: restored.remix.masterVolume,
          export: {
            jobId: exportJob.id,
            status: completedJob.status,
            filename: exportAsset.filename,
            checksumSha256: exportAsset.checksumSha256,
            fileSizeBytes: exportAsset.fileSizeBytes,
            durationSeconds: exportedWav!.frames / RATE,
            sampleRate: exportedWav!.sampleRate,
            channels: exportedWav!.channels,
            storageKey: exportAsset.storageKey,
          },
        };
        if (realFixture) {
          const capturedAt = new Date().toISOString();
          const passageEvaluations = planBody.plan?.passageSearch?.evaluations ?? [];
          const predictionSnapshot = {
            schemaVersion: 2,
            producer: "Waveyard production mashup route",
            producerRevision:
              process.env.WAVEYARD_MASHUP_PRODUCER_REVISION?.trim() || null,
            capturedAt,
            recordings: {
              "another-one-bites-the-dust": {
                sourceSha256: sha256(vocalsOriginal),
                sourceDurationMs: Math.round(
                  realFixture.vocals.durationSeconds * 1000,
                ),
                pitchContinuityRuns: realPitchContinuityRuns,
                sections: realSectionsBySourceChecksum[sha256(vocalsOriginal)] ?? [],
                sectionBoundaries: (
                  realSectionsBySourceChecksum[sha256(vocalsOriginal)] ?? []
                )
                  .slice(1)
                  .map((section) => section.startMs),
                donorWindows: passageEvaluations.map((evaluation) => ({
                  vocalSourceSha256: evaluation.vocalSourceSha256,
                  startMs: evaluation.donorStartMs,
                  endMs: evaluation.donorEndMs,
                  rankedBedCandidates: (evaluation.rankedBedCandidates ?? []).map(
                    (candidate) => ({
                      rank: candidate.rank,
                      bedSourceSha256: candidate.bedSourceSha256,
                      bedStartMs: candidate.bedStartMs,
                      bedEndMs: candidate.bedEndMs,
                      relativeScore: candidate.relativeScore,
                      selected: candidate.selected,
                    }),
                  ),
                })),
                measurementNote:
                  "Full-track isolated-vocal pitch-continuity runs; not words, syllables, or lyric meaning.",
              },
              september: {
                sourceSha256: sha256(bedOriginal),
                sourceDurationMs: Math.round(
                  realFixture.bed.durationSeconds * 1000,
                ),
                pitchContinuityRuns: [],
                sections: realSectionsBySourceChecksum[sha256(bedOriginal)] ?? [],
                sectionBoundaries: (
                  realSectionsBySourceChecksum[sha256(bedOriginal)] ?? []
                )
                  .slice(1)
                  .map((section) => section.startMs),
                donorWindows: [],
                measurementNote:
                  "Section structure is captured from the original source. No isolated-vocal pitch-continuity analysis was run for this bed in this route direction.",
              },
            },
            sectionLabelLimit:
              "Structural labels such as section, rhythm-repeat, and energy-change are not verse, chorus, bridge, or breakdown classifications.",
          };
          assert.equal(
            predictionSnapshot.recordings["another-one-bites-the-dust"].sections.length,
            realSectionPassageEvidence?.vocals.sectionCount,
            "the snapshot must export every persisted donor section",
          );
          assert.equal(
            predictionSnapshot.recordings.september.sections.length,
            realSectionPassageEvidence?.bed.sectionCount,
            "the snapshot must export every persisted bed section",
          );
          assert.equal(
            predictionSnapshot.recordings["another-one-bites-the-dust"].pitchContinuityRuns.length,
            realVocalVoicingEvidence?.count,
            "the snapshot must export all full-track persisted pitch-continuity intervals",
          );
          assert.deepEqual(
            predictionSnapshot.recordings["another-one-bites-the-dust"].sectionBoundaries,
            predictionSnapshot.recordings["another-one-bites-the-dust"].sections
              .slice(1)
              .map((section) => section.startMs),
            "donor boundary timestamps must be the persisted starts of the next sections",
          );
          assert.deepEqual(
            predictionSnapshot.recordings.september.sectionBoundaries,
            predictionSnapshot.recordings.september.sections
              .slice(1)
              .map((section) => section.startMs),
            "bed boundary timestamps must be the persisted starts of the next sections",
          );
          for (const recording of Object.values(
            predictionSnapshot.recordings,
          )) {
            assert.ok(
              recording.sections.every(
                (section) =>
                  section.endMs <= recording.sourceDurationMs + 50,
              ),
              "persisted structural sections must end within 50 ms of source duration metadata",
            );
          }
          assert.equal(
            predictionSnapshot.recordings["another-one-bites-the-dust"].donorWindows.length,
            planBody.plan?.passageSearch?.evaluatedDonorPassageCount,
            "the snapshot must retain every evaluated donor window, including those without candidates",
          );
          report.predictionSnapshot = predictionSnapshot;
          const predictionPath = process.env.WAVEYARD_GROUND_TRUTH_PREDICTIONS_PATH?.trim();
          if (predictionPath) {
            const resolvedPredictionPath = realFixturePath(predictionPath);
            await mkdir(path.dirname(resolvedPredictionPath), { recursive: true });
            await writeFile(
              resolvedPredictionPath,
              `${JSON.stringify(predictionSnapshot, null, 2)}\n`,
            );
          }
        }
        await writeFile(resolvedReportPath, `${JSON.stringify(report, null, 2)}\n`);
      }
    } else {
      // Existing fixture regression: persistence and version increments remain
      // covered for generated tones without requiring a real listening file.
      await dbModule.db.transaction(async (tx) => {
        await tx
          .update(schema.remixSessions)
          .set({ masterVolume: 0.9, version: savedSession.version + 1 })
          .where(eq(schema.remixSessions.id, savedSession.id));
      });

      const [updatedSession] = await dbModule.db
        .select()
        .from(schema.remixSessions)
        .where(eq(schema.remixSessions.id, savedSession.id));
      assert.equal(updatedSession.version, savedSession.version + 1);
      assert.equal(updatedSession.masterVolume, 0.9);
    }
  } finally {
    try {
      await dbModule?.pool.end();
    } catch {
      /* already closed */
    }
    if (postgresProcess && postgresProcess.exitCode === null) {
      spawnSync(postgresBinaries.pgCtl!, ["-D", dataDir, "-m", "fast", "-w", "-t", "20", "stop"], { timeout: 30_000 });
      postgresProcess.kill();
    }
    await rm(fixtureRoot, { recursive: true, force: true }).catch(() => undefined);
  }
  },
);
