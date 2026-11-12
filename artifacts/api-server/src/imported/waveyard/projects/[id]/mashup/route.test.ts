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
    : "Waveyard synthetic-route fallback and Arena handoff regressions",
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

    if (realFixture && vocalsStemRow) {
      const [{ decodeMonoPcm, detectVocalPitchFrames }, vocalTypes] = await Promise.all([
        import("@workspace/arena/lib/waveyard/worker-local/analysis-engine"),
        import("@workspace/arena/lib/waveyard/types/vocal-analysis"),
      ]);
      const analysisPcm = await decodeMonoPcm(vocalsStemPath);
      const phrases = vocalTypes.segmentVocalPhrases(detectVocalPitchFrames(analysisPcm))
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
      await dbModule.db.insert(schema.vocalPhrases).values(phrases.map((phrase, phraseIndex) => ({
        vocalAnalysisId: vocalAnalysis.id,
        phraseIndex,
        startMs: phrase.startMs,
        endMs: phrase.endMs,
        confidence: phrase.confidence,
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

    const renderRequest = () => new Request(`http://localhost/api/waveyard/projects/${project.id}/mashup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "render",
        vocalsSourceId: vocalsSource.id,
        instrumentalSourceId: bedSource.id,
      }),
    });

    // Plan path reports the authoritative bed source before rendering.
    const planRequest = () => new Request(`http://localhost/api/waveyard/projects/${project.id}/mashup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "plan",
          vocalsSourceId: vocalsSource.id,
          instrumentalSourceId: bedSource.id,
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
        segments: Array<{ mashupStartMs: number; mashupEndMs: number; vocalsFromMs: number; vocalsToMs: number }>;
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
        vocals: Record<string, { status: string; persistence?: string }>;
        bed: Record<string, { status: string; persistence?: string }>;
      };
    };
    if (realFixture) {
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
      const persistedDrumAlignment = planBody.plan.rationale.find((line) => line.includes("voiced-run starts overlap"));
      assert.ok(persistedDrumAlignment, "the plan must report measured vocal-to-groove comparisons");
      assert.match(persistedDrumAlignment, /\d+\/3 voiced-run starts overlap measured drum transients/,
        "the route must report persisted drum events against the unchanged structural entry");
      assert.match(persistedDrumAlignment, /\d+\/3 overlap low-band bass attacks/,
        "the route must report persisted bass events without treating every attack as a preferred vocal onset");
      assert.ok(persistedDrumAlignment.includes("transient coincidences did not move the entry"),
        "the route must not optimize entry timing on transient coincidence without a matching musical passage");
    } else {
      assert.equal(planBody.evidence?.bed.bassAttacks.persistence, "database",
        "the real-track plan must use events persisted by the local bass-analysis worker");
      assert.equal(typeof realPersistedBassAttackCount, "number");
      assert.equal(planBody.plan.vocalsStretchRatio, 1,
        "low-confidence donor tempo must not be presented as verified beat synchronization");
      assert.equal(planBody.plan.vocalsPitchSemitones, 0,
        "low-confidence keys must not trigger an automatic pitch transform");
      assert.ok(planBody.plan.warnings.some((warning) => warning.includes("Automatic tempo stretching withheld")));
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
        realGrooveTimingSummary = planBody.plan.rationale.find((line) => line.includes("voiced-run starts overlap")) ?? null;
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
        assert.ok(rankedPassages.length > 0,
          "the production API must expose the feasible bed rankings used by the whole-track evaluation");
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

    // Actual production route render.
    const renderResponse = await routeModule.POST(renderRequest(), { params: Promise.resolve({ id: project.id }) });
    assert.equal(renderResponse.status, 200, "the render route must succeed");
    assert.match(renderResponse.headers.get("content-type") ?? "", /audio\/wav/);
    assert.equal(renderResponse.headers.get("x-waveyard-bed-source"), "separated", "the route must use the synthesized bed");
    const bedStemsHeader = (renderResponse.headers.get("x-waveyard-bed-stems") ?? "").split(",").filter(Boolean).sort();
    assert.deepEqual(bedStemsHeader, ["bass", "drums", "other"], "the bed must be drums + bass + other, not vocals");
    const bedWarning = renderResponse.headers.get("x-waveyard-bed-warning");
    if (!realFixture) {
      assert.ok(bedWarning, "the route must expose the leakage warning");
      assert.match(decodeURIComponent(bedWarning!), /leakage/i);
    }

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

    const saveRequest = () => new Request(`http://localhost/api/waveyard/projects/${project.id}/mashup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "save",
        vocalsSourceId: vocalsSource.id,
        instrumentalSourceId: bedSource.id,
      }),
    });
    if (!realFixture) {
      const unavailableSave = await routeModule.POST(
        saveRequest(),
        { params: Promise.resolve({ id: project.id }) },
      );
      assert.equal(unavailableSave.status, 422, "an editable save refuses an unavailable separated bed");
      assert.equal((await dbModule.db.select().from(schema.remixSessions)).length, 0,
        "a refused save does not leave a partial Studio session");

      await dbModule.db.update(schema.processingJobs)
        .set({ status: "complete", stage: "complete", completedAt: new Date(), errorCode: null, errorMessage: null })
        .where(eq(schema.processingJobs.id, bedJob.id));
    }
    // Save action: persists the planned mashup into remixSessions, remixTracks, and remixClips.
    const saveResponse = await routeModule.POST(saveRequest(), { params: Promise.resolve({ id: project.id }) });
    assert.equal(saveResponse.status, 201, "save action must return 201 Created");
    const saveBody = (await saveResponse.json()) as { ok: boolean; remix: { id: string; name: string }; version: { id: string } };
    assert.equal(saveBody.ok, true);
    assert.ok(saveBody.remix.id);
    assert.ok(saveBody.version.id);
    if (realFixture) {
      const [initialVersion] = await dbModule.db.select().from(schema.remixVersions)
        .where(eq(schema.remixVersions.id, saveBody.version.id));
      assert.ok(initialVersion);
      const initialSnapshot = JSON.parse(initialVersion.snapshot) as {
        mashupPlan?: {
          passageSearch?: { selectedDonorSectionId?: string | null; selectedBedSectionId?: string | null } | null;
          segments?: Array<{ mashupStartMs: number; vocalsFromMs: number }>;
        };
      };
      assert.deepEqual(
        initialSnapshot.mashupPlan?.segments?.map((segment) => [segment.mashupStartMs, segment.vocalsFromMs]),
        planBody.plan?.segments.map((segment) => [segment.mashupStartMs, segment.vocalsFromMs]),
        "the original passage plan must be included in the persisted remix version",
      );
      assert.deepEqual(
        [
          initialSnapshot.mashupPlan?.passageSearch?.selectedDonorSectionId ?? null,
          initialSnapshot.mashupPlan?.passageSearch?.selectedBedSectionId ?? null,
        ],
        [
          planBody.plan?.passageSearch?.selectedDonorSectionId ?? null,
          planBody.plan?.passageSearch?.selectedBedSectionId ?? null,
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
      )).json() as { remix: typeof savedSession; tracks: Array<{ clips: unknown[] }> };
      assert.equal(editedReload.remix.masterVolume, 0.85, "the Studio edit must survive a fresh API read");
      assert.ok(editedReload.tracks.reduce((sum, track) => sum + track.clips.length, 0) >= 2,
        "the saved real clips must survive reopening");

      const divergentInput = {
        ...editedReload.remix,
        masterVolume: 0.35,
        tracks: editedReload.tracks,
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
