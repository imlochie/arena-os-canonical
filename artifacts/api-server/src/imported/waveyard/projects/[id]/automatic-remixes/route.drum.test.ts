/**
 * Production-path test for the donor-drum decision in the automatic-remixes route.
 *
 * The drum decision is only worth anything if the REAL route hands the planner
 * REAL drum evidence. This drives the real route against a real PostgreSQL
 * database and runs the real local worker, so the claim under test is the one
 * that matters: drum transients written by the production analysis worker reach
 * the planner through the production loader, they change which drum arrangement
 * the plan carries, and missing evidence is reported as insufficient instead of
 * being resolved into a preference.
 *
 * No listening test has been performed. Nothing here claims the result sounds
 * good; it claims the decision is driven by measured evidence.
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

/** encodeWav16 wants an INTERLEAVED STEREO buffer; mono would halve duration. */
function stereo(mono: Float32Array) {
  const out = new Float32Array(mono.length * 2);
  for (let i = 0; i < mono.length; i += 1) out[i * 2] = out[i * 2 + 1] = mono[i]!;
  return out;
}

/** A chord bed: a sustained C-major triad, so the hybrid has real harmony. */
function chordStemWav(seconds = 8) {
  const mono = new Float32Array(RATE * seconds);
  for (let i = 0; i < mono.length; i += 1) {
    const t = i / RATE;
    mono[i] = 0.20 * Math.sin(2 * Math.PI * 130.81 * t)
      + 0.16 * Math.sin(2 * Math.PI * 164.81 * t)
      + 0.16 * Math.sin(2 * Math.PI * 196 * t);
  }
  return encodeWav16(stereo(mono), RATE);
}

/**
 * A drum part made of audible clicks at chosen beat phases.
 *
 * The clicks are short noise bursts with a sharp attack, so the production
 * transient detector finds them; the phase pattern is what the drum decision
 * actually reads. `bpm` sets the beat period, `phases` are fractions of a beat.
 */
function drumStemWav(input: { bpm: number; phases: number[]; seconds?: number; clickMs?: number }) {
  const seconds = input.seconds ?? 8;
  const beatMs = 60_000 / input.bpm;
  const clickSamples = Math.round(((input.clickMs ?? 12) / 1000) * RATE);
  const mono = new Float32Array(RATE * seconds);
  let seed = 12345;
  const noise = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff - 0.5;
  };
  for (let beat = 0; beat * beatMs < seconds * 1000; beat += 1) {
    for (const phase of input.phases) {
      const at = Math.round(((beat * beatMs + phase * beatMs) / 1000) * RATE);
      for (let i = 0; i < clickSamples && at + i < mono.length; i += 1) {
        // Sharp decay so the attack is unambiguous.
        mono[at + i] = mono[at + i]! + 0.55 * noise() * (1 - i / clickSamples);
      }
      if (at < mono.length) mono[at] = mono[at]! + 0.85;
    }
  }
  return encodeWav16(stereo(mono), RATE);
}

test("the automatic-remixes route turns worker-produced drum transients into a drum decision", async (t) => {
  if (!postgresBinaries.initdb || !postgresBinaries.postgres || !postgresBinaries.pgCtl) {
    t.skip("PostgreSQL binaries are unavailable");
    return;
  }
  if (!process.env.ARENA_FFMPEG_PATH) {
    t.skip("ARENA_FFMPEG_PATH is not configured");
    return;
  }

  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "waveyard-drum-route-"));
  const dataDir = path.join(fixtureRoot, "data", "postgres");
  const databaseName = "arena_drum_route_test";
  const databasePassword = "drum-route-test-password";
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
    const drumTypes = await import("@workspace/arena/lib/waveyard/types/drum-analysis");
    const { handleDrumAnalysisJob } = await import("@workspace/arena/lib/waveyard/worker-local/stem-analysis");
    const routeModule = await import("./route");
    const storage = getStorage();

    const [project] = await dbModule.db.insert(schema.projects).values({
      ownerId: LOCAL_OWNER_ID, title: "Donor drum decision", kind: "studio",
    }).returning();

    /**
     * One candidate source, end to end: real bytes, a real drum stem analysed by
     * the real worker, real structural sections and real bed harmony. When
     * `drum` is null the drum stem exists but is left unanalysed, which is the
     * "evidence was never measured" case.
     */
    const addSource = async (input: {
      filename: string;
      bpm: number;
      drum: { phases: number[]; clickMs?: number } | null;
      drumBpm?: number;
    }) => {
      const chordBytes = chordStemWav();
      const checksum = sha256(chordBytes);
      const chordPath = path.join(fixtureRoot, `${randomUUID()}.wav`);
      await writeFile(chordPath, chordBytes);
      const sourceKey = `wy/test/${randomUUID()}/source.wav`;
      await storage.putFile(sourceKey, chordPath, "audio/wav");
      const [source] = await dbModule.db.insert(schema.sourceAssets).values({
        projectId: project.id, originalFilename: input.filename, mimeType: "audio/wav", storageKey: sourceKey,
        checksumSha256: checksum, durationSeconds: 8, sampleRate: RATE, channels: 1,
        codec: "pcm_s16le", fileSizeBytes: chordBytes.length,
      }).returning();
      const [separation] = await dbModule.db.insert(schema.processingJobs).values({
        projectId: project.id, sourceAssetId: source.id, type: "separation",
        model: "test-local", requestedDevice: "cpu", idempotencyKey: `separation:${source.id}`,
      }).returning();
      const makeStem = async (stemType: string, bytes: Uint8Array, filePath: string) => {
        const key = `wy/test/${randomUUID()}/${stemType}.wav`;
        await storage.putFile(key, filePath, "audio/wav");
        return (await dbModule.db.insert(schema.stemAssets).values({
          projectId: project.id, sourceAssetId: source.id, separationJobId: separation.id, stemType,
          engine: "test", model: "test-local", modelVersion: "1", storageKey: key,
          checksumSha256: sha256(bytes),
          durationSeconds: 8, sampleRate: RATE, channels: 1, codec: "pcm_s16le", format: "wav",
          fileSizeBytes: bytes.length,
        }).returning())[0]!;
      };
      const drumBytes = input.drum
        ? drumStemWav({ bpm: input.drumBpm ?? input.bpm, phases: input.drum.phases, clickMs: input.drum.clickMs })
        : chordStemWav();
      const drumPath = path.join(fixtureRoot, `${randomUUID()}-drums.wav`);
      await writeFile(drumPath, drumBytes);
      const drumStem = await makeStem("drums", drumBytes, drumPath);
      const otherStem = await makeStem("other", chordBytes, chordPath);
      const beatGrid = JSON.stringify(Array.from({ length: 33 }, (_, index) => Math.round(index * (60_000 / input.bpm))));
      const [sourceAnalysis] = await dbModule.db.insert(schema.sourceAnalyses).values({
        projectId: project.id, sourceAssetId: source.id, status: "complete", stage: "complete", attempts: 1,
        idempotencyKey: `analysis:${source.id}`, analysisEngine: "arena-js-dsp", analysisEngineVersion: "1.4.0",
        sourceChecksumSha256: checksum,
        bpm: input.bpm, bpmConfidence: 0.9, musicalKey: "C major", keyConfidence: 0.9,
        beatGrid, beatConfidence: 0.9, completedAt: new Date(),
      }).returning();
      // A real isolated vocal stem, so the hybrid has a donor part to carry and
      // the passage check is not starved of a featured stem.
      const vocalBytes = chordStemWav();
      const vocalPath = path.join(fixtureRoot, `${randomUUID()}-vocals.wav`);
      await writeFile(vocalPath, vocalBytes);
      const vocalStem = await makeStem("vocals", vocalBytes, vocalPath);
      const vocalTypes = await import("@workspace/arena/lib/waveyard/types/vocal-analysis");
      const { handleVocalAnalysisJob } = await import("@workspace/arena/lib/waveyard/worker-local/stem-analysis");
      const [vocalJob] = await dbModule.db.insert(schema.vocalAnalyses).values({
        projectId: project.id, sourceAssetId: source.id, stemAssetId: vocalStem.id,
        status: "queued", stage: "queued", idempotencyKey: `vocal:${vocalStem.id}`,
        analysisEngine: vocalTypes.LOCAL_VOCAL_ANALYSIS_ENGINE,
        analysisEngineVersion: vocalTypes.LOCAL_VOCAL_ANALYSIS_ENGINE_VERSION,
        sourceChecksumSha256: checksum, stemChecksumSha256: vocalStem.checksumSha256,
      }).returning();
      await handleVocalAnalysisJob({
        vocalAnalysisId: vocalJob.id, projectId: project.id, sourceAssetId: source.id,
        stemAssetId: vocalStem.id, analysisEngine: vocalJob.analysisEngine,
        analysisEngineVersion: vocalJob.analysisEngineVersion,
      }, { db: dbModule.db as never, storage });
      const [vocalDone] = await dbModule.db.select().from(schema.vocalAnalyses).where(eq(schema.vocalAnalyses.id, vocalJob.id));
      assert.equal(vocalDone!.status, "complete", `the vocal worker must complete for ${input.filename}`);

      // Section analysis must be provisioned AFTER the vocal analysis: the vocal
      // handler deliberately re-provisions sections (that is real production
      // behaviour), and without a queue a re-provisioned row is marked
      // queue_unavailable. Running sections last leaves the current, complete
      // row the planner requires.
      const { handleSectionAnalysisJob } = await import("@workspace/arena/lib/waveyard/worker-local/sections");
      const sectionTypes = await import("@workspace/arena/lib/waveyard/types/analysis-provenance");
      // The vocal handler already provisioned this row; reuse it rather than
      // inserting a second one (source_asset_id is unique).
      const [sectionAnalysis] = await dbModule.db.update(schema.sourceSectionAnalyses).set({
        status: "queued", stage: "queued", attempts: 0,
        analysisEngine: sectionTypes.DESKTOP_SECTION_ENGINE,
        analysisEngineVersion: sectionTypes.DESKTOP_SECTION_ENGINE_VERSION,
        errorCode: null, errorMessage: null, completedAt: null,
      }).where(eq(schema.sourceSectionAnalyses.sourceAssetId, source.id)).returning();
      await handleSectionAnalysisJob({
        sourceSectionAnalysisId: sectionAnalysis.id, projectId: project.id, sourceAssetId: source.id,
        sourceAnalysisId: sourceAnalysis.id,
        analysisEngine: sectionAnalysis.analysisEngine,
        analysisEngineVersion: sectionAnalysis.analysisEngineVersion,
      }, { db: dbModule.db as never, storage } as never);
      // Bed harmony from the non-vocal stem a hybrid keeps.
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

      let drumAnalysisId: string | null = null;
      if (input.drum) {
        const [drumJob] = await dbModule.db.insert(schema.drumAnalyses).values({
          projectId: project.id, sourceAssetId: source.id, stemAssetId: drumStem.id,
          idempotencyKey: drumTypes.drumAnalysisIdempotencyKey(drumStem.id),
          analysisEngine: drumTypes.LOCAL_DRUM_ANALYSIS_ENGINE,
          analysisEngineVersion: drumTypes.LOCAL_DRUM_ANALYSIS_ENGINE_VERSION,
          sourceChecksumSha256: checksum, stemChecksumSha256: drumStem.checksumSha256,
        }).returning();
        await handleDrumAnalysisJob({
          drumAnalysisId: drumJob.id, projectId: project.id, sourceAssetId: source.id, stemAssetId: drumStem.id,
          analysisEngine: drumTypes.LOCAL_DRUM_ANALYSIS_ENGINE,
          analysisEngineVersion: drumTypes.LOCAL_DRUM_ANALYSIS_ENGINE_VERSION,
        }, { db: dbModule.db as never, storage });
        const events = await dbModule.db.select().from(schema.drumEvents)
          .where(eq(schema.drumEvents.drumAnalysisId, drumJob.id));
        assert.ok(events.length > 0, `the worker must persist drum transients for ${input.filename}`);
        drumAnalysisId = drumJob.id;
      }
      return { source, drumStem, vocalStem, drumAnalysisId };
    };

    // The bed plays the downbeat pulse; the donor is a percussion part on the
    // offbeats only, so its measured attacks fill positions the bed leaves
    // empty. That is the layer case: keeping both adds something.
    const bed = await addSource({ filename: "bed.wav", bpm: 120, drum: { phases: [0] } });
    const donor = await addSource({ filename: "donor.wav", bpm: 120, drum: { phases: [0.5] } });

    const planOnce = async (constraints: Record<string, unknown>) => {
      const request = new Request(`http://localhost/api/waveyard/projects/${project.id}/automatic-remixes`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(constraints),
      });
      const response = await routeModule.POST(request, { params: Promise.resolve({ id: project.id }) });
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    };

    const planned = await planOnce({
      variant: "hybrid",
      anchorSourceId: bed.source.id,
      drumsStemId: donor.drumStem.id,
    });
    assert.equal(planned.status, 201,
      `the route must build a hybrid plan: ${JSON.stringify(planned.body).slice(0, 600)}`);
    const provenance = (planned.body.plan as { provenance?: Record<string, unknown> } | undefined)?.provenance;
    assert.ok(provenance, "the plan must expose its provenance");
    const decisions = provenance!.drumBedDecisions as Array<Record<string, unknown>> | undefined;
    assert.ok(decisions?.length, "the plan must expose the drum decision it made");

    // The loader must deliver measured evidence, not the absence of it.
    assert.notEqual(decisions![0]!.outcome, "unavailable",
      `production-loaded evidence must be sufficient to decide: ${String(decisions![0]!.reason)}`);
    assert.ok(decisions![0]!.measurements, "a measured decision must carry measurements");
    const measurements = decisions![0]!.measurements as Record<string, unknown>;
    assert.ok(Number(measurements.comparedOnsets) > 0, "the decision must rest on compared transients");
    assert.ok(Number(measurements.complementaryOnsets) > 0,
      "the offbeat-adding donor must be measured as filling positions the bed leaves empty");

    // The outcome must actually change what was SAVED, not just what is reported.
    // The persisted session is the arrangement the listener gets, so the claim is
    // checked against the database rather than the response JSON.
    const savedTracks = async () => {
      const sessions = await dbModule.db.select().from(schema.remixSessions)
        .where(eq(schema.remixSessions.projectId, project.id));
      const latest = sessions.sort((left, right) =>
        (right.createdAt?.getTime() ?? 0) - (left.createdAt?.getTime() ?? 0))[0];
      if (!latest) return [] as Array<{ stemAssetId: string; stemType: string }>;
      const rows = await dbModule.db.select({
        stemAssetId: schema.remixTracks.stemAssetId,
        stemType: schema.stemAssets.stemType,
      }).from(schema.remixTracks)
        .innerJoin(schema.stemAssets, eq(schema.stemAssets.id, schema.remixTracks.stemAssetId))
        .where(eq(schema.remixTracks.remixSessionId, latest.id));
      return rows;
    };
    const drumTracks = (await savedTracks()).filter((track) => track.stemType === "drums").map((track) => track.stemAssetId);
    assert.deepEqual([...drumTracks].sort(), [bed.drumStem.id, donor.drumStem.id].sort(),
      "layering must produce two real drum tracks in the saved plan");

    // Stale engine evidence must not be silently trusted: an analysis row from a
    // different engine measured something else and must stop the decision.
    await dbModule.db.update(schema.drumAnalyses)
      .set({ analysisEngineVersion: "0.0.1" })
      .where(eq(schema.drumAnalyses.id, donor.drumAnalysisId!));
    const stale = await planOnce({
      variant: "hybrid",
      anchorSourceId: bed.source.id,
      drumsStemId: donor.drumStem.id,
    });
    assert.equal(stale.status, 201, "a stale drum analysis must not break the route");
    const staleDecisions = ((stale.body.plan as { provenance?: Record<string, unknown> } | undefined)
      ?.provenance?.drumBedDecisions) as Array<Record<string, unknown>> | undefined;
    assert.equal(staleDecisions?.[0]?.outcome, "unavailable",
      "evidence from a non-current engine must resolve to insufficient evidence");
    assert.deepEqual((await savedTracks()).filter((track) => track.stemType === "drums").map((track) => track.stemAssetId),
      [bed.drumStem.id],
      "with no current donor drum evidence the bed must keep its own drums");
  } finally {
    if (postgresProcess) postgresProcess.kill();
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
