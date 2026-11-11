/**
 * API-level mashup render acceptance.
 *
 * This is not a helper-only test: it boots the real embedded PostgreSQL
 * cluster, applies the canonical migrations, inserts real source/stem rows
 * and private WAV objects, then calls the production route handler. It
 * proves that the synthesized instrumental bed (drums + bass + other, with
 * the bed's vocal stem excluded) actually reaches renderMashup, and that the
 * original-file fallback is reported honestly.
 */

import test from "node:test";
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
import { and, eq, inArray } from "drizzle-orm";

import { decodeWav16, encodeWav16 } from "@workspace/arena/lib/waveyard/mixer/synth";

const root = fileURLToPath(new URL("../../../../../../../../", import.meta.url));
const requireFromDb = createRequire(path.join(root, "lib/db/package.json"));
const { Client } = requireFromDb("pg") as typeof import("pg");
const RATE = 44_100;
const BED_SECONDS = 4;
const VOCAL_SECONDS = 2;

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

function energyAt(pcm: Float32Array, frequency: number, startSeconds: number, endSeconds: number): number {
  const start = Math.floor(startSeconds * RATE);
  const end = Math.floor(endSeconds * RATE);
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

test("Waveyard API renders mashups and persists Arena handoffs atomically", async (t) => {
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

    const vocalsOriginal = encodeWav16(tone([1000], VOCAL_SECONDS, 0.2), RATE);
    // The bed's original vocal is deliberately loud. If the separated bed were
    // accidentally including the vocal stem, the 880 Hz energy would be large.
    const bedOriginal = encodeWav16(
      mixTones([[110, 0.1], [220, 0.1], [330, 0.1], [1500, 0.4]], BED_SECONDS),
      RATE,
    );
    const vocalsOriginalPath = path.join(fixtureRoot, "vocals-original.wav");
    const bedOriginalPath = path.join(fixtureRoot, "bed-original.wav");
    await writeFile(vocalsOriginalPath, vocalsOriginal);
    await writeFile(bedOriginalPath, bedOriginal);

    const [vocalsSource] = await dbModule.db.insert(schema.sourceAssets).values({
      projectId: project.id,
      originalFilename: "vocals-original.wav",
      mimeType: "audio/wav",
      storageKey: "mashup-fixture/vocals-original.wav",
      checksumSha256: sha256(vocalsOriginal),
      durationSeconds: VOCAL_SECONDS,
      sampleRate: RATE,
      channels: 2,
      codec: "pcm_s16le",
      fileSizeBytes: vocalsOriginal.length,
    }).returning({ id: schema.sourceAssets.id });
    const [bedSource] = await dbModule.db.insert(schema.sourceAssets).values({
      projectId: project.id,
      originalFilename: "bed-original.wav",
      mimeType: "audio/wav",
      storageKey: "mashup-fixture/bed-original.wav",
      checksumSha256: sha256(bedOriginal),
      durationSeconds: BED_SECONDS,
      sampleRate: RATE,
      channels: 2,
      codec: "pcm_s16le",
      fileSizeBytes: bedOriginal.length,
    }).returning({ id: schema.sourceAssets.id });
    assert.ok(vocalsSource && bedSource);

    await storage.putFile("mashup-fixture/vocals-original.wav", vocalsOriginalPath);
    await storage.putFile("mashup-fixture/bed-original.wav", bedOriginalPath);

    const [vocalsJob] = await dbModule.db.insert(schema.processingJobs).values({
      projectId: project.id,
      sourceAssetId: vocalsSource.id,
      type: "separation",
      status: "complete",
      stage: "complete",
      attempts: 1,
      idempotencyKey: `mashup-vocals-${randomUUID()}`,
      model: "test",
      requestedDevice: "cpu",
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
      model: "test",
      requestedDevice: "cpu",
      completedAt: new Date(),
    }).returning({ id: schema.processingJobs.id });
    assert.ok(vocalsJob && bedJob);

    const vocalsStemWav = encodeWav16(tone([1000], VOCAL_SECONDS, 0.2), RATE);
    const vocalsStemPath = path.join(fixtureRoot, "vocals-stem.wav");
    await writeFile(vocalsStemPath, vocalsStemWav);
    await storage.putFile("mashup-fixture/vocals-stem.wav", vocalsStemPath);
    const [completedVocalsStem] = await dbModule.db.insert(schema.stemAssets).values({
      projectId: project.id,
      sourceAssetId: vocalsSource.id,
      separationJobId: vocalsJob.id,
      stemType: "vocals",
      engine: "demucs",
      model: "test",
      modelVersion: "test",
      storageKey: "mashup-fixture/vocals-stem.wav",
      checksumSha256: sha256(vocalsStemWav),
      durationSeconds: VOCAL_SECONDS,
      sampleRate: RATE,
      channels: 2,
      codec: "wav",
      format: "wav",
      fileSizeBytes: vocalsStemWav.length,
    }).returning({ id: schema.stemAssets.id });

    // A newer active attempt must not make the last completed donor disappear
    // from the save/render workflow.
    const [pendingVocalsJob] = await dbModule.db.insert(schema.processingJobs).values({
      projectId: project.id,
      sourceAssetId: vocalsSource.id,
      type: "separation",
      status: "running",
      stage: "separating",
      attempts: 1,
      idempotencyKey: `mashup-vocals-pending-${randomUUID()}`,
      model: "test",
      requestedDevice: "cpu",
      startedAt: new Date(),
      createdAt: new Date(Date.now() + 60_000),
    }).returning({ id: schema.processingJobs.id });
    const [pendingVocalsStem] = await dbModule.db.insert(schema.stemAssets).values({
      projectId: project.id,
      sourceAssetId: vocalsSource.id,
      separationJobId: pendingVocalsJob.id,
      stemType: "vocals",
      engine: "demucs",
      model: "test",
      modelVersion: "test",
      storageKey: "mashup-fixture/vocals-pending.wav",
      checksumSha256: "b".repeat(64),
      durationSeconds: VOCAL_SECONDS,
      sampleRate: RATE,
      channels: 2,
      codec: "wav",
      format: "wav",
      fileSizeBytes: vocalsStemWav.length,
      createdAt: new Date(Date.now() + 60_000),
    }).returning({ id: schema.stemAssets.id });
    assert.ok(completedVocalsStem && pendingVocalsStem);

    const bedStems: Array<[string, number]> = [["drums", 110], ["bass", 220], ["other", 330], ["vocals", 1500]];
    const bedStemIds: string[] = [];
    for (const [stemType, frequency] of bedStems) {
      const wav = encodeWav16(
        tone([frequency], BED_SECONDS, stemType === "vocals" ? 0.4 : 0.1),
        RATE,
      );
      const storageKey = `mashup-fixture/bed-${stemType}.wav`;
      const filePath = path.join(fixtureRoot, `bed-${stemType}.wav`);
      await writeFile(filePath, wav);
      await storage.putFile(storageKey, filePath);
      const [stem] = await dbModule.db.insert(schema.stemAssets).values({
        projectId: project.id,
        sourceAssetId: bedSource.id,
        separationJobId: bedJob.id,
        stemType,
        engine: "demucs",
        model: "test",
        modelVersion: "test",
        storageKey,
        checksumSha256: sha256(wav),
        durationSeconds: BED_SECONDS,
        sampleRate: RATE,
        channels: 2,
        codec: "wav",
        format: "wav",
        fileSizeBytes: wav.length,
      }).returning({ id: schema.stemAssets.id });
      assert.ok(stem);
      if (stemType !== "vocals") bedStemIds.push(stem.id);
    }

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
        completedAt: new Date(),
      });
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
    const planResponse = await routeModule.POST(
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
    assert.equal(planResponse.status, 200);
    const planBody = await planResponse.json() as {
      bed?: { source: string; warning: string };
      plan?: { durationMs?: number; segments?: Array<{ mashupStartMs: number; mashupEndMs: number; vocalsFromMs: number; vocalsToMs: number }> };
    };
    assert.equal(planBody.bed?.source, "separated", "the plan must report the separated bed");
    assert.ok(planBody.bed?.warning.length, "the plan must explain leakage honestly");
    assert.equal(planBody.plan?.durationMs, BED_SECONDS * 1000);
    assert.deepEqual(planBody.plan?.segments?.map((segment) => [
      segment.mashupStartMs,
      segment.mashupEndMs,
      segment.vocalsFromMs,
      segment.vocalsToMs,
    ]), [[2_000, 4_000, 0, 2_000]], "the voice must be arranged only in the planned second half");

    // Actual production route render.
    const renderResponse = await routeModule.POST(renderRequest(), { params: Promise.resolve({ id: project.id }) });
    assert.equal(renderResponse.status, 200, "the render route must succeed");
    assert.match(renderResponse.headers.get("content-type") ?? "", /audio\/wav/);
    assert.equal(renderResponse.headers.get("x-waveyard-bed-source"), "separated", "the route must use the synthesized bed");
    const initialRenderWarnings = decodeURIComponent(renderResponse.headers.get("x-waveyard-warning") ?? "");
    assert.doesNotMatch(initialRenderWarnings, /donor vocal uses the original/i,
      "a valid separated donor vocal must not fall back to the original source");
    assert.match(
      initialRenderWarnings,
      /donor.*complement|complement.*donor/i,
      "the absent optional donor complements must be omitted with an explicit warning",
    );

    // A complementary donor stem must be selected from the same completed run
    // as the selected vocal stem. Older completed, running, failed, cancelled,
    // and malformed rows are deliberately present as distractors.
    const priorDonorJob = (await dbModule.db.insert(schema.processingJobs).values({
      projectId: project.id,
      sourceAssetId: vocalsSource.id,
      type: "separation",
      status: "complete",
      stage: "complete",
      attempts: 1,
      idempotencyKey: `mashup-vocals-prior-${randomUUID()}`,
      model: "test",
      requestedDevice: "cpu",
      createdAt: new Date(Date.now() - 120_000),
      completedAt: new Date(Date.now() - 120_000),
    }).returning({ id: schema.processingJobs.id }))[0]!;
    const failedDonorJob = (await dbModule.db.insert(schema.processingJobs).values({
      projectId: project.id,
      sourceAssetId: vocalsSource.id,
      type: "separation",
      status: "failed",
      stage: "failed",
      attempts: 1,
      idempotencyKey: `mashup-vocals-failed-${randomUUID()}`,
      model: "test",
      requestedDevice: "cpu",
      completedAt: new Date(),
    }).returning({ id: schema.processingJobs.id }))[0]!;
    const cancelledDonorJob = (await dbModule.db.insert(schema.processingJobs).values({
      projectId: project.id,
      sourceAssetId: vocalsSource.id,
      type: "separation",
      status: "cancelled",
      stage: "cancelled",
      attempts: 1,
      idempotencyKey: `mashup-vocals-cancelled-${randomUUID()}`,
      model: "test",
      requestedDevice: "cpu",
    }).returning({ id: schema.processingJobs.id }))[0]!;
    const supersededDonorJob = (await dbModule.db.insert(schema.processingJobs).values({
      projectId: project.id,
      sourceAssetId: vocalsSource.id,
      type: "separation",
      status: "superseded",
      stage: "superseded",
      attempts: 1,
      idempotencyKey: `mashup-vocals-superseded-${randomUUID()}`,
      model: "test",
      requestedDevice: "cpu",
    }).returning({ id: schema.processingJobs.id }))[0]!;

    const addDonorStem = async (
      jobId: string,
      stemType: string,
      frequency: number,
      options: { malformed?: boolean } = {},
    ) => {
      const bytes = options.malformed
        ? Buffer.from("not a wav file")
        : encodeWav16(tone([frequency], VOCAL_SECONDS, 0.1), RATE);
      const storageKey = `mashup-fixture/donor-${jobId}-${stemType}.wav`;
      const filePath = path.join(fixtureRoot, `donor-${jobId}-${stemType}.wav`);
      await writeFile(filePath, bytes);
      await storage.putFile(storageKey, filePath);
      const [stem] = await dbModule.db.insert(schema.stemAssets).values({
        projectId: project.id,
        sourceAssetId: vocalsSource.id,
        separationJobId: jobId,
        stemType,
        engine: "demucs",
        model: "test",
        modelVersion: "test",
        storageKey,
        checksumSha256: sha256(bytes),
        durationSeconds: VOCAL_SECONDS,
        sampleRate: RATE,
        channels: 2,
        codec: "wav",
        format: "wav",
        fileSizeBytes: bytes.length,
      }).returning({ id: schema.stemAssets.id });
      assert.ok(stem);
      return stem;
    };

    const [selectedDonorGuitar] = await Promise.all([
      addDonorStem(vocalsJob.id, "guitar", 660),
      addDonorStem(vocalsJob.id, "piano", 4400, { malformed: true }),
      addDonorStem(priorDonorJob.id, "other", 1200),
      addDonorStem(pendingVocalsJob.id, "bass", 2200),
      addDonorStem(failedDonorJob.id, "percussion", 2800),
      addDonorStem(failedDonorJob.id, "vocals", 1700),
      addDonorStem(cancelledDonorJob.id, "strings", 3400),
      addDonorStem(supersededDonorJob.id, "synth", 4000),
    ]);
    assert.ok(selectedDonorGuitar);

    const donorRenderResponse = await routeModule.POST(renderRequest(), { params: Promise.resolve({ id: project.id }) });
    assert.equal(donorRenderResponse.status, 200, "invalid optional donor complements must not fail the primary render");
    const donorRenderWarnings = decodeURIComponent(donorRenderResponse.headers.get("x-waveyard-warning") ?? "");
    assert.doesNotMatch(donorRenderWarnings, /donor vocal uses the original/i,
      "invalid optional complements must not force donor-vocal fallback");
    assert.match(
      donorRenderWarnings,
      /donor|complement|piano/i,
      "omitted malformed donor complements must be reported",
    );
    const bedStemsHeader = (renderResponse.headers.get("x-waveyard-bed-stems") ?? "").split(",").filter(Boolean).sort();
    assert.deepEqual(bedStemsHeader, ["bass", "drums", "other"], "the bed must be drums + bass + other, not vocals");
    const bedWarning = donorRenderResponse.headers.get("x-waveyard-bed-warning");
    assert.ok(bedWarning, "the route must expose the leakage warning");
    assert.match(decodeURIComponent(bedWarning!), /leakage/i);

    const renderedBytes = new Uint8Array(await donorRenderResponse.arrayBuffer());
    const rendered = decodeWav16(renderedBytes);
    assert.ok(rendered, "the route must return a decodable WAV");
    assert.equal(rendered!.sampleRate, RATE);
    assert.equal(rendered!.channels, 2);

    // Verify the separated bed contributes every intended stem and excludes
    // the bed's 1500 Hz vocal stem while the planned lead-vocal passage is
    // distinguishable from leakage and PCM quantization.
    const separatedVocalEnergy = energyAt(rendered!.samples, 1500, 0, 2);
    const drumEnergy = energyAt(rendered!.samples, 110, 0, 2);
    const bassEnergy = energyAt(rendered!.samples, 220, 0, 2);
    const otherEnergy = energyAt(rendered!.samples, 330, 0, 2);
    const selectedDonorInstrumentEnergy = energyAt(rendered!.samples, 660, 0, 2);
    const priorRunEnergy = energyAt(rendered!.samples, 1200, 0, 2);
    const runningRunEnergy = energyAt(rendered!.samples, 2200, 0, 2);
    const failedRunEnergy = energyAt(rendered!.samples, 2800, 0, 2);
    const cancelledRunEnergy = energyAt(rendered!.samples, 3400, 0, 2);
    const supersededRunEnergy = energyAt(rendered!.samples, 4000, 0, 2);
    const malformedDonorEnergy = energyAt(rendered!.samples, 4400, 0, 2);
    const nonSelectedVocalEnergy = energyAt(rendered!.samples, 1700, 0, 2);
    const earlyVocalEnergy = energyAt(rendered!.samples, 1000, 0, 2);
    const donorVocalEnergy = energyAt(rendered!.samples, 1000, 2, 4);
    const vocalStemEnergy = energyAt(decodeWav16(vocalsStemWav)!.samples, 1000, 0, 2);
    assert.ok(drumEnergy > 0.005, `separated bed render must contain drums (${drumEnergy})`);
    assert.ok(bassEnergy > 0.005, `separated bed render must contain bass (${bassEnergy})`);
    assert.ok(otherEnergy > 0.005, `separated bed render must contain other (${otherEnergy})`);
    assert.ok(selectedDonorInstrumentEnergy > 0.005,
      `render must include a valid donor instrument from the selected completed run (${selectedDonorInstrumentEnergy})`);
    assert.ok(priorRunEnergy < 0.001, `older completed donor runs must be excluded (${priorRunEnergy})`);
    assert.ok(runningRunEnergy < 0.001, `running donor runs must be excluded (${runningRunEnergy})`);
    assert.ok(failedRunEnergy < 0.001, `failed donor runs must be excluded (${failedRunEnergy})`);
    assert.ok(cancelledRunEnergy < 0.001, `cancelled donor runs must be excluded (${cancelledRunEnergy})`);
    assert.ok(supersededRunEnergy < 0.001, `superseded donor runs must be excluded (${supersededRunEnergy})`);
    assert.ok(malformedDonorEnergy < 0.001, `malformed optional donor stems must be omitted (${malformedDonorEnergy})`);
    assert.ok(nonSelectedVocalEnergy < 0.001, `non-authoritative donor vocals must not leak (${nonSelectedVocalEnergy})`);
    assert.ok(separatedVocalEnergy < 0.001,
      `separated bed render must exclude the bed's vocal stem (${separatedVocalEnergy})`);
    assert.ok(earlyVocalEnergy < 0.001,
      `the lead vocal must not appear before its planned passage (${earlyVocalEnergy})`);
    assert.ok(donorVocalEnergy > vocalStemEnergy * 0.8,
      `render must retain the intended lead-vocal donor during its arranged passage (${donorVocalEnergy})`);
    // An existing but undecodable stem must fail closed (422), never fall back
    // to the original file, which would silently reintroduce the bed's vocal.
    const garbagePath = path.join(fixtureRoot, "bed-bass-corrupt.wav");
    await writeFile(garbagePath, Buffer.from("not a wav file"));
    await storage.putFile("mashup-fixture/bed-bass.wav", garbagePath);
    const invalidResponse = await routeModule.POST(renderRequest(), { params: Promise.resolve({ id: project.id }) });
    assert.equal(invalidResponse.status, 422, "an invalid existing stem must fail the render");
    assert.equal(invalidResponse.headers.get("x-waveyard-bed-source"), null);
    assert.match(((await invalidResponse.json()) as { error: string }).error, /bass stem/);
    await storage.putFile("mashup-fixture/bed-bass.wav", path.join(fixtureRoot, "bed-bass.wav"));

    // Save while the completed separation run is still present: editable Studio
    // remixes require persisted donor and bed stems, not merely source audio.
    const saveRequest = new Request(`http://localhost/api/waveyard/projects/${project.id}/mashup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "save",
        vocalsSourceId: vocalsSource.id,
        instrumentalSourceId: bedSource.id,
      }),
    });
    const saveResponse = await routeModule.POST(saveRequest, { params: Promise.resolve({ id: project.id }) });
    assert.equal(saveResponse.status, 201, "save action must return 201 Created");
    const saveBody = (await saveResponse.json()) as {
      ok: boolean;
      warnings?: string[];
      remix: { id: string; name: string };
      version: { id: string };
    };
    assert.equal(saveBody.ok, true);
    assert.ok(saveBody.remix.id);
    assert.ok(saveBody.version.id);
    assert.match(
      (saveBody.warnings ?? []).join(" "),
      /donor|complement|piano/i,
      "save must report optional donor complements omitted for missing or malformed PCM",
    );

    const [savedSession] = await dbModule.db
      .select()
      .from(schema.remixSessions)
      .where(eq(schema.remixSessions.id, saveBody.remix.id));
    assert.ok(savedSession, "saved remix session must exist in db");
    assert.equal(savedSession.tempoBpm, 120);

    const savedTracks = await dbModule.db
      .select()
      .from(schema.remixTracks)
      .where(eq(schema.remixTracks.remixSessionId, savedSession.id));
    assert.ok(savedTracks.length >= 2, "remix must have vocal and bed tracks");
    const savedStemIds = savedTracks.map((track) => track.stemAssetId).filter((id): id is string => id !== null).sort();
    const expectedSavedStemIds = [completedVocalsStem.id, selectedDonorGuitar.id, ...bedStemIds].sort();
    assert.deepEqual(
      savedStemIds,
      expectedSavedStemIds,
      "saved tracks must contain exactly the selected donor vocal, its valid same-run complement, and rendered bed stems",
    );
    assert.ok(
      savedTracks.some((track) => track.stemAssetId === completedVocalsStem.id),
      "the remix must use the last completed vocal stem while a newer attempt is still running",
    );
    assert.ok(
      !savedTracks.some((track) => track.stemAssetId === pendingVocalsStem.id),
      "an unfinished vocal stem must never be persisted into the remix",
    );

    const savedClips = await dbModule.db
      .select()
      .from(schema.remixClips)
      .where(inArray(schema.remixClips.remixTrackId, savedTracks.map((t) => t.id)));
    assert.ok(savedClips.length >= 2, "remix must have persisted vocal and bed clips");
    const savedClipStemIds = [...new Set(savedClips.map((clip) => clip.stemAssetId).filter((id): id is string => id !== null))].sort();
    assert.deepEqual(savedClipStemIds, expectedSavedStemIds,
      "saved clips must point to exactly the assets represented by the rendered donor and bed stems");
    const selectedInstrumentTrack = savedTracks.find((track) => track.stemAssetId === selectedDonorGuitar.id);
    assert.ok(selectedInstrumentTrack, "the rendered donor complement must be persisted as an editable track");
    const selectedInstrumentClip = savedClips.find((clip) => clip.remixTrackId === selectedInstrumentTrack.id);
    assert.ok(selectedInstrumentClip, "the rendered donor complement must have a persisted clip");
    assert.equal(selectedInstrumentClip.tempoSyncEnabled, false, "instrument clips must retain native tempo");
    assert.equal(selectedInstrumentClip.keySyncEnabled, false, "instrument clips must retain native key");

    for (const clip of savedClips) {
      assert.ok(Number.isFinite(clip.timelineStartMs) && clip.timelineStartMs >= 0);
      assert.ok(clip.durationMs > 0);
      assert.ok(clip.gain > 0 && clip.gain <= 1);
    }

    // Simulate a Studio edit and verify the persisted version advances.
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

    // The fallback check removes the separation job, which cascades to its
    // stems. Remove the already-verified saved remix first because its clips
    // correctly retain foreign keys to those stems.
    await dbModule.db.delete(schema.remixVersions)
      .where(eq(schema.remixVersions.remixSessionId, savedSession.id));
    await dbModule.db.delete(schema.remixClips)
      .where(inArray(schema.remixClips.remixTrackId, savedTracks.map((track) => track.id)));
    await dbModule.db.delete(schema.remixTracks)
      .where(eq(schema.remixTracks.remixSessionId, savedSession.id));
    await dbModule.db.delete(schema.remixSessions)
      .where(eq(schema.remixSessions.id, savedSession.id));

    // Remove the separation run: the route must fall back to the original
    // file and say so, and the original bed's vocal must become audible.
    await dbModule.db.delete(schema.processingJobs).where(eq(schema.processingJobs.id, bedJob.id));
    const fallbackResponse = await routeModule.POST(renderRequest(), { params: Promise.resolve({ id: project.id }) });
    assert.equal(fallbackResponse.status, 200);
    assert.equal(fallbackResponse.headers.get("x-waveyard-bed-source"), "original-fallback");
    assert.match(decodeURIComponent(fallbackResponse.headers.get("x-waveyard-bed-warning") ?? ""), /original/i);
    const fallbackBytes = new Uint8Array(await fallbackResponse.arrayBuffer());
    const fallback = decodeWav16(fallbackBytes);
    assert.ok(fallback);
    const fallbackVocalEnergy = energyAt(fallback!.samples, 1500, 0, 2);
    assert.ok(fallbackVocalEnergy > 0.005, `the original bed's vocal should be audible in the fallback (${fallbackVocalEnergy})`);
    assert.ok(
      fallbackVocalEnergy > separatedVocalEnergy * 2,
      `the fallback must be distinguishable from the separated bed (${fallbackVocalEnergy} vs ${separatedVocalEnergy})`,
    );

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
});
