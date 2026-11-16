/**
 * Production-path test for the automatic-remixes route.
 *
 * The planner's whole-arrangement and bass decisions were previously provable
 * only by handing them evidence in a unit fixture. This drives the REAL route
 * against a REAL PostgreSQL database, so the claim under test is the one that
 * matters: bass pitch written by the real worker reaches the planner through the
 * real loader, it changes the anchor the planner chooses, and stale evidence is
 * reported honestly instead of being silently trusted.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { eq } from "drizzle-orm";

import { encodeWav16 } from "@workspace/arena/lib/waveyard/mixer/synth";

const root = fileURLToPath(new URL("../../../../../../../..", import.meta.url));
const requireFromDb = createRequire(path.join(root, "lib/db/package.json"));
const { Client } = requireFromDb("pg") as typeof import("pg");
const RATE = 22_050;

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

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/**
 * A separated non-vocal stem: the C-major triad that carries the harmony.
 *
 * Separation is the point. In production a bass stem is its own file, so mixing
 * the bass into the chord audio here would test a signal the pipeline never
 * receives and make the tracker's answer meaningless.
 */
/**
 * encodeWav16 takes an INTERLEAVED STEREO buffer. Passing mono here would place
 * consecutive frames in alternating channels, compressing the signal to half its
 * duration and reporting every pitch an octave high -- so the channel duplication
 * is deliberate and load-bearing.
 */
function stereo(mono: Float32Array) {
  const out = new Float32Array(mono.length * 2);
  for (let i = 0; i < mono.length; i += 1) out[i * 2] = out[i * 2 + 1] = mono[i]!;
  return out;
}

function chordStemWav() {
  const mono = new Float32Array(RATE * 8);
  for (let i = 0; i < mono.length; i += 1) {
    const t = i / RATE;
    mono[i] = 0.20 * Math.sin(2 * Math.PI * 130.81 * t)
      + 0.16 * Math.sin(2 * Math.PI * 164.81 * t)
      + 0.16 * Math.sin(2 * Math.PI * 196 * t);
  }
  return encodeWav16(stereo(mono), RATE);
}

/** A separated bass stem holding one sustained pitch. */
function bassStemWav(hz: number) {
  const mono = new Float32Array(RATE * 8);
  for (let i = 0; i < mono.length; i += 1) {
    const t = i / RATE;
    mono[i] = 0.5 * (Math.sin(2 * Math.PI * hz * t) + 0.2 * Math.sin(4 * Math.PI * hz * t));
  }
  return encodeWav16(stereo(mono), RATE);
}

test("the automatic-remixes route turns worker-produced bass pitch into an anchor decision", async (t) => {
  if (!postgresBinaries.initdb || !postgresBinaries.postgres || !postgresBinaries.pgCtl) {
    t.skip("PostgreSQL binaries are unavailable");
    return;
  }
  if (!process.env.ARENA_FFMPEG_PATH) {
    t.skip("ARENA_FFMPEG_PATH is not configured");
    return;
  }

  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "waveyard-automatic-remix-route-"));
  const dataDir = path.join(fixtureRoot, "data", "postgres");
  const databaseName = "arena_automatic_remix_route_test";
  const databasePassword = "auto-remix-route-test-password";
  const port = await freePort();
  let postgresProcess: ReturnType<typeof spawn> | undefined;

  const startPostgres = async () => {
    await mkdir(dataDir, { recursive: true });
    const passwordFile = path.join(fixtureRoot, ".postgres-password");
    await writeFile(passwordFile, databasePassword, { mode: 0o600 });
    const init = spawnSync(postgresBinaries.initdb, [
      "-D", dataDir, "-U", "arena", "--pwfile", passwordFile, "-E", "UTF8", "--locale", "C", "-A", "scram-sha-256",
    ], { encoding: "utf8", timeout: 120_000 });
    await rm(passwordFile, { force: true });
    if (init.status !== 0) throw new Error(`initdb failed: ${(init.stdout ?? "") + (init.stderr ?? "")}`.slice(0, 2000));

    postgresProcess = spawn(postgresBinaries.postgres, [
      "-D", dataDir, "-p", String(port), "-h", "127.0.0.1", "-F", "-c", "unix_socket_directories=",
    ], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });

    const adminUrl = `postgres://arena:${databasePassword}@127.0.0.1:${port}/postgres`;
    const deadline = Date.now() + 30_000;
    let created = false;
    while (Date.now() < deadline && !created) {
      const client = new Client({ connectionString: adminUrl });
      try {
        await client.connect();
        await client.query(`CREATE DATABASE ${databaseName}`);
        created = true;
      } catch {
        await client.end().catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 150));
      } finally {
        if (created) await client.end();
      }
    }
    if (!created) throw new Error("PostgreSQL did not become ready");

    const client = new Client({ connectionString: `postgres://arena:${databasePassword}@127.0.0.1:${port}/${databaseName}` });
    await client.connect();
    const { migrate } = await import("../../../../../../../../desktop/database.mjs");
    await migrate(client, path.join(root, "lib/arena/desktop-migrations"));
    await client.end();
  };

  try {
    await startPostgres();
    process.env.DATABASE_URL = `postgres://arena:${databasePassword}@127.0.0.1:${port}/${databaseName}`;
    process.env.WAVEYARD_STORAGE_DIR = path.join(fixtureRoot, "waveyard", "storage");
    process.env.NODE_ENV = "test";

    const dbModule = await import("@workspace/db");
    const schema = await import("@workspace/db/waveyardSchema");
    const { LOCAL_OWNER_ID } = await import("@workspace/db/schema");
    const { getStorage } = await import("@workspace/arena/lib/waveyard/storage");
    const bassTypes = await import("@workspace/arena/lib/waveyard/types/bass-analysis");
    const { handleBassAnalysisJob } = await import("@workspace/arena/lib/waveyard/worker-local/stem-analysis");
    const routeModule = await import("./route");
    const storage = getStorage();

    const [project] = await dbModule.db.insert(schema.projects).values({
      ownerId: LOCAL_OWNER_ID, title: "Automatic remix bass evidence", kind: "studio",
    }).returning();

    /**
     * Insert one candidate bed end-to-end: source bytes, a bass stem and a
     * non-vocal stem, a real bass analysis run by the real worker, and the
     * trusted tempo evidence the planner requires before it will act.
     */
    const addCandidate = async (filename: string, bassHz: number) => {
      const bytes = chordStemWav();
      const checksum = sha256(bytes);
      const filePath = path.join(fixtureRoot, `${randomUUID()}.wav`);
      await writeFile(filePath, bytes);
      const bassBytes = bassStemWav(bassHz);
      const bassChecksum = sha256(bassBytes);
      const bassPath = path.join(fixtureRoot, `${randomUUID()}-bass.wav`);
      await writeFile(bassPath, bassBytes);
      const sourceKey = `wy/test/${randomUUID()}/source.wav`;
      await storage.putFile(sourceKey, filePath, "audio/wav");
      const [source] = await dbModule.db.insert(schema.sourceAssets).values({
        projectId: project.id, originalFilename: filename, mimeType: "audio/wav", storageKey: sourceKey,
        checksumSha256: checksum, durationSeconds: 8, sampleRate: RATE, channels: 1,
        codec: "pcm_s16le", fileSizeBytes: bytes.length,
      }).returning();
      const [separation] = await dbModule.db.insert(schema.processingJobs).values({
        projectId: project.id, sourceAssetId: source.id, type: "separation",
        model: "test-local", requestedDevice: "cpu", idempotencyKey: `separation:${source.id}`,
      }).returning();
      const makeStem = async (stemType: string) => {
        const isBass = stemType === "bass";
        const key = `wy/test/${randomUUID()}/${stemType}.wav`;
        await storage.putFile(key, isBass ? bassPath : filePath, "audio/wav");
        return (await dbModule.db.insert(schema.stemAssets).values({
          projectId: project.id, sourceAssetId: source.id, separationJobId: separation.id, stemType,
          engine: "test", model: "test-local", modelVersion: "1", storageKey: key,
          checksumSha256: isBass ? bassChecksum : checksum,
          durationSeconds: 8, sampleRate: RATE, channels: 1, codec: "pcm_s16le", format: "wav",
          fileSizeBytes: isBass ? bassBytes.length : bytes.length,
        }).returning())[0]!;
      };
      const bassStem = await makeStem("bass");
      const otherStem = await makeStem("other");
      const [sourceAnalysis] = await dbModule.db.insert(schema.sourceAnalyses).values({
        projectId: project.id, sourceAssetId: source.id, status: "complete", stage: "complete", attempts: 1,
        idempotencyKey: `analysis:${source.id}`, analysisEngine: "arena-js-dsp", analysisEngineVersion: "1.4.0",
        sourceChecksumSha256: checksum,
        bpm: 120, bpmConfidence: 0.9, musicalKey: "C major", keyConfidence: 0.9,
        beatGrid: JSON.stringify(Array.from({ length: 17 }, (_, index) => index * 500)),
        beatConfidence: 0.9, completedAt: new Date(),
      }).returning();
      // Real structural sections from the real section worker. The planner will
      // not choose an anchor without them, so they must not be faked.
      const { handleSectionAnalysisJob } = await import("@workspace/arena/lib/waveyard/worker-local/sections");
      const sectionTypes = await import("@workspace/arena/lib/waveyard/types/analysis-provenance");
      const [sectionAnalysis] = await dbModule.db.insert(schema.sourceSectionAnalyses).values({
        projectId: project.id, sourceAssetId: source.id, sourceAnalysisId: sourceAnalysis.id,
        status: "queued", stage: "queued", attempts: 0, idempotencyKey: `sections:${source.id}`,
        analysisEngine: sectionTypes.DESKTOP_SECTION_ENGINE,
        analysisEngineVersion: sectionTypes.DESKTOP_SECTION_ENGINE_VERSION,
        sourceChecksumSha256: checksum,
      }).returning();
      await handleSectionAnalysisJob({
        sourceSectionAnalysisId: sectionAnalysis.id, projectId: project.id, sourceAssetId: source.id,
        sourceAnalysisId: sourceAnalysis.id,
        analysisEngine: sectionAnalysis.analysisEngine,
        analysisEngineVersion: sectionAnalysis.analysisEngineVersion,
      }, { db: dbModule.db as never, storage } as never);
      // The bed's own chord analysis, from the non-vocal stem a hybrid keeps.
      const harmonyTypes = await import("@workspace/arena/lib/waveyard/types/stem-harmony-analysis");
      const { handleStemHarmonyAnalysisJob } = await import("@workspace/arena/lib/waveyard/worker-local/stem-analysis");
      const [harmonyJob] = await dbModule.db.insert(schema.stemHarmonyAnalyses).values({
        projectId: project.id, sourceAssetId: source.id, stemAssetId: otherStem.id,
        status: "queued", stage: "queued", idempotencyKey: harmonyTypes.stemHarmonyAnalysisIdempotencyKey(otherStem.id),
        analysisEngine: harmonyTypes.LOCAL_STEM_HARMONY_ANALYSIS_ENGINE,
        analysisEngineVersion: harmonyTypes.LOCAL_STEM_HARMONY_ANALYSIS_ENGINE_VERSION,
        sourceChecksumSha256: checksum, stemChecksumSha256: otherStem.checksumSha256,
      }).returning();
      await handleStemHarmonyAnalysisJob({
        stemHarmonyAnalysisId: harmonyJob.id, projectId: project.id, sourceAssetId: source.id,
        stemAssetId: otherStem.id, analysisEngine: harmonyJob.analysisEngine,
        analysisEngineVersion: harmonyJob.analysisEngineVersion,
      }, { db: dbModule.db as never, storage });
      const [bassJob] = await dbModule.db.insert(schema.bassAnalyses).values({
        projectId: project.id, sourceAssetId: source.id, stemAssetId: bassStem.id,
        idempotencyKey: bassTypes.bassAnalysisIdempotencyKey(bassStem.id),
        analysisEngine: bassTypes.LOCAL_BASS_ANALYSIS_ENGINE,
        analysisEngineVersion: bassTypes.LOCAL_BASS_ANALYSIS_ENGINE_VERSION,
        sourceChecksumSha256: checksum, stemChecksumSha256: bassStem.checksumSha256,
      }).returning();
      await handleBassAnalysisJob({
        bassAnalysisId: bassJob.id, projectId: project.id, sourceAssetId: source.id, stemAssetId: bassStem.id,
        analysisEngine: bassTypes.LOCAL_BASS_ANALYSIS_ENGINE,
        analysisEngineVersion: bassTypes.LOCAL_BASS_ANALYSIS_ENGINE_VERSION,
      }, { db: dbModule.db as never, storage });
      const segments = await dbModule.db.select().from(schema.bassPitchSegments)
        .where(eq(schema.bassPitchSegments.bassAnalysisId, bassJob.id));
      assert.ok(segments.length > 0, `the worker must persist bass pitch for ${filename}`);
      return { source, bassJob, segments };
    };

    // Two beds whose chord analysis says the same thing (C major) but whose own
    // bass says different things. The contradicting bed is offered FIRST, so
    // arrival order alone would keep it.
    const contradicting = await addCandidate("aaa-wrong-bed.wav", 92.5); // F#2: foreign, never resolves
    const corroborating = await addCandidate("zzz-true-bed.wav", 65.41); // C2: the chord root
    assert.notEqual(
      corruptFirstMidi(contradicting.segments), corruptFirstMidi(corroborating.segments),
      "the two beds must genuinely differ in tracked bass pitch",
    );

    const planOnce = async () => {
      const request = new Request(`http://localhost/api/waveyard/projects/${project.id}/automatic-remixes`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ variant: "original" }),
      });
      const response = await routeModule.POST(request, { params: Promise.resolve({ id: project.id }) });
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    };

    const planned = await planOnce();
    assert.equal(planned.status, 201,
      `the route must build a plan: ${JSON.stringify(planned.body).slice(0, 400)}`);
    const provenance = (planned.body.plan as { provenance?: Record<string, unknown> } | undefined)?.provenance;
    assert.ok(provenance, "the plan must expose its provenance");
    assert.equal(provenance!.anchorSourceId, corroborating.source.id,
      "the bed whose own bass corroborates its chords must win the anchor");
    assert.notEqual(provenance!.anchorSourceId, contradicting.source.id,
      "a bed whose bass contradicts its chords must not be chosen");
    assert.ok(String((provenance!.decisions as string[] | undefined)?.join(" ")).includes("bass line corroborates"),
      "the choice must be explainable from the plan");

    // Stale evidence must not be silently trusted. A 1.0.0 row recorded attacks
    // with no pitch, so it is not current evidence at all.
    await dbModule.db.update(schema.bassAnalyses)
      .set({ analysisEngineVersion: "1.0.0" })
      .where(eq(schema.bassAnalyses.id, corroborating.bassJob.id));
    const stale = await planOnce();
    assert.equal(stale.status, 201, "a stale bass analysis must not break the route");
    const staleProvenance = (stale.body.plan as { provenance?: Record<string, unknown> } | undefined)?.provenance;
    assert.ok(!String((staleProvenance!.decisions as string[] | undefined)?.join(" ")).includes("bass line corroborates"),
      "stale bass evidence must not produce a corroboration claim");
    assert.equal(staleProvenance!.anchorSourceId, contradicting.source.id,
      "without current bass evidence the previous ordering must stand unchanged");
  } finally {
    if (postgresProcess) postgresProcess.kill();
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

/** The pitch the tracked segments actually report, as a stable label. */
function corruptFirstMidi(segments: ReadonlyArray<{ midiNote: number }>) {
  return segments.map((segment) => segment.midiNote).join(",");
}
