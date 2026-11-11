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
import { buildMashupDonorDuckingAutomation } from "@workspace/arena/lib/waveyard/studio/mashup";

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
    const remixStateRoute = await import("../../../../remixes/[id]/route");
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
    const [originalVocalStem] = await dbModule.db.insert(schema.stemAssets).values({
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
    assert.ok(originalVocalStem);

    // A later completed run supersedes the first one. Newer queued/failed/
    // cancelled attempts must not hide it or contribute audio.
    const latestCompletedAt = new Date(Date.now() + 10_000);
    const [latestVocalsJob] = await dbModule.db.insert(schema.processingJobs).values({
      projectId: project.id,
      sourceAssetId: vocalsSource.id,
      type: "separation",
      status: "complete",
      stage: "complete",
      attempts: 1,
      idempotencyKey: `mashup-vocals-latest-${randomUUID()}`,
      model: "test",
      requestedDevice: "cpu",
      createdAt: latestCompletedAt,
      updatedAt: latestCompletedAt,
      completedAt: latestCompletedAt,
    }).returning({ id: schema.processingJobs.id });
    assert.ok(latestVocalsJob);

    const latestVocalStemWav = encodeWav16(tone([750], VOCAL_SECONDS, 0.2), RATE);
    const latestVocalStemPath = path.join(fixtureRoot, "latest-vocals-stem.wav");
    await writeFile(latestVocalStemPath, latestVocalStemWav);
    await storage.putFile("mashup-fixture/latest-vocals-stem.wav", latestVocalStemPath);
    const [latestVocalStem] = await dbModule.db.insert(schema.stemAssets).values({
      projectId: project.id,
      sourceAssetId: vocalsSource.id,
      separationJobId: latestVocalsJob.id,
      stemType: "vocals",
      engine: "demucs",
      model: "test",
      modelVersion: "test",
      storageKey: "mashup-fixture/latest-vocals-stem.wav",
      checksumSha256: sha256(latestVocalStemWav),
      durationSeconds: VOCAL_SECONDS,
      sampleRate: RATE,
      channels: 2,
      codec: "wav",
      format: "wav",
      fileSizeBytes: latestVocalStemWav.length,
      createdAt: latestCompletedAt,
    }).returning({ id: schema.stemAssets.id });
    assert.ok(latestVocalStem);

    const donorStemIds: string[] = [];
    const donorFixtures: Array<[string, number]> = [["drums", 510], ["bass", 610], ["other", 710]];
    for (const [stemType, frequency] of donorFixtures) {
      const wav = encodeWav16(tone([frequency], VOCAL_SECONDS, 0.1), RATE);
      const storageKey = `mashup-fixture/vocal-donor-${stemType}.wav`;
      const filePath = path.join(fixtureRoot, `vocal-donor-${stemType}.wav`);
      await writeFile(filePath, wav);
      await storage.putFile(storageKey, filePath);
      const [stem] = await dbModule.db.insert(schema.stemAssets).values({
        projectId: project.id,
        sourceAssetId: vocalsSource.id,
        separationJobId: latestVocalsJob.id,
        stemType,
        engine: "demucs",
        model: "test",
        modelVersion: "test",
        storageKey,
        checksumSha256: sha256(wav),
        durationSeconds: VOCAL_SECONDS,
        sampleRate: RATE,
        channels: 2,
        codec: "wav",
        format: "wav",
        fileSizeBytes: wav.length,
        createdAt: latestCompletedAt,
      }).returning({ id: schema.stemAssets.id });
      assert.ok(stem);
      donorStemIds.push(stem.id);
    }

    const laterAttempts: Array<{ status: string; frequency: number }> = [
      { status: "queued", frequency: 900 },
      { status: "failed", frequency: 1_100 },
      { status: "cancelled", frequency: 1_300 },
    ];
    const invalidVocalStemIds: string[] = [];
    for (const [index, attempt] of laterAttempts.entries()) {
      const createdAt = new Date(Date.now() + 20_000 + index * 1_000);
      const [job] = await dbModule.db.insert(schema.processingJobs).values({
        projectId: project.id,
        sourceAssetId: vocalsSource.id,
        type: "separation",
        status: attempt.status,
        stage: attempt.status,
        attempts: 1,
        idempotencyKey: `mashup-vocals-${attempt.status}-${randomUUID()}`,
        model: "test",
        requestedDevice: "cpu",
        createdAt,
        updatedAt: createdAt,
      }).returning({ id: schema.processingJobs.id });
      assert.ok(job);
      const wav = encodeWav16(tone([attempt.frequency], VOCAL_SECONDS, 0.2), RATE);
      const storageKey = `mashup-fixture/${attempt.status}-vocals.wav`;
      const filePath = path.join(fixtureRoot, `${attempt.status}-vocals.wav`);
      await writeFile(filePath, wav);
      await storage.putFile(storageKey, filePath);
      const [invalidStem] = await dbModule.db.insert(schema.stemAssets).values({
        projectId: project.id,
        sourceAssetId: vocalsSource.id,
        separationJobId: job.id,
        stemType: "vocals",
        engine: "demucs",
        model: "test",
        modelVersion: "test",
        storageKey,
        checksumSha256: sha256(wav),
        durationSeconds: VOCAL_SECONDS,
        sampleRate: RATE,
        channels: 2,
        codec: "wav",
        format: "wav",
        fileSizeBytes: wav.length,
        createdAt,
      }).returning({ id: schema.stemAssets.id });
      assert.ok(invalidStem);
      invalidVocalStemIds.push(invalidStem.id);
    }

    const bedStems: Array<[string, number]> = [["drums", 110], ["bass", 220], ["other", 330], ["vocals", 1500]];
    for (const [stemType, frequency] of bedStems) {
      const wav = encodeWav16(
        tone([frequency], BED_SECONDS, stemType === "vocals" ? 0.4 : 0.1),
        RATE,
      );
      const storageKey = `mashup-fixture/bed-${stemType}.wav`;
      const filePath = path.join(fixtureRoot, `bed-${stemType}.wav`);
      await writeFile(filePath, wav);
      await storage.putFile(storageKey, filePath);
      await dbModule.db.insert(schema.stemAssets).values({
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
      });
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
      plan?: {
        durationMs: number;
        segments: Array<{ mashupStartMs: number; mashupEndMs: number; crossfadeMs: number }>;
      };
      bed?: { source: string; warning: string };
    };
    assert.ok(planBody.plan, "the route must return the plan used by both render and save");
    assert.equal(planBody.bed?.source, "separated", "the plan must report the separated bed");
    assert.ok(planBody.bed?.warning.length, "the plan must explain leakage honestly");

    // Actual production route render.
    const renderResponse = await routeModule.POST(renderRequest(), { params: Promise.resolve({ id: project.id }) });
    assert.equal(renderResponse.status, 200, "the render route must succeed");
    assert.match(renderResponse.headers.get("content-type") ?? "", /audio\/wav/);
    assert.equal(renderResponse.headers.get("x-waveyard-bed-source"), "separated", "the route must use the synthesized bed");
    const bedStemsHeader = (renderResponse.headers.get("x-waveyard-bed-stems") ?? "").split(",").filter(Boolean).sort();
    assert.deepEqual(bedStemsHeader, ["bass", "drums", "other"], "the bed must be drums + bass + other, not vocals");
    const bedWarning = renderResponse.headers.get("x-waveyard-bed-warning");
    assert.ok(bedWarning, "the route must expose the leakage warning");
    assert.match(decodeURIComponent(bedWarning!), /leakage/i);

    const renderedBytes = new Uint8Array(await renderResponse.arrayBuffer());
    const rendered = decodeWav16(renderedBytes);
    assert.ok(rendered, "the route must return a decodable WAV");
    assert.equal(rendered!.sampleRate, RATE);
    assert.equal(rendered!.channels, 2);

    // The bed's vocal stem (880 Hz) must not be in the rendered bed.
    const separatedVocalEnergy = energyAt(rendered!.samples, 1500, 0, 2);
    const drumEnergy = energyAt(rendered!.samples, 110, 0, 2);
    const bassEnergy = energyAt(rendered!.samples, 220, 0, 2);
    const otherEnergy = energyAt(rendered!.samples, 330, 0, 2);
    assert.ok(drumEnergy > 0.001 && bassEnergy > 0.001 && otherEnergy > 0.001, "the separated bed must include its instrumental stems");
    assert.ok(
      separatedVocalEnergy < 0.01,
      `the separated bed must exclude the bed vocal stem (${separatedVocalEnergy})`,
    );
    // The planner puts the donor vocal after one bed bar when no section
    // analysis exists, so verify the vocal stem in its actual timeline window.
    const chosenVocalEnergy = energyAt(rendered!.samples, 750, 2_100, 3_900);
    assert.ok(chosenVocalEnergy > 0.001, `render must choose the newest completed vocal stem (${chosenVocalEnergy})`);
    for (const { status, frequency } of laterAttempts) {
      assert.ok(
        energyAt(rendered!.samples, frequency, 2_100, 3_900) < 0.0001,
        `a newer ${status} vocal stem must not replace the completed stem`,
      );
    }
    assert.ok(energyAt(rendered!.samples, 510, 100, 1_900) > 0.001, "render must include aligned complementary donor stems");

    // The persisted path must reject bad donor duration just as rendering does.
    const donorDrumsPath = path.join(fixtureRoot, "vocal-donor-drums.wav");
    const misalignedDonor = encodeWav16(tone([510], 1, 0.1), RATE);
    const misalignedDonorPath = path.join(fixtureRoot, "vocal-donor-drums-short.wav");
    await writeFile(misalignedDonorPath, misalignedDonor);
    await storage.putFile("mashup-fixture/vocal-donor-drums.wav", misalignedDonorPath);
    const misalignedRender = await routeModule.POST(renderRequest(), { params: Promise.resolve({ id: project.id }) });
    assert.equal(misalignedRender.status, 422, "render must reject donor PCM that is not aligned with the selected vocal");
    assert.match(((await misalignedRender.json()) as { error: string }).error, /different PCM duration/i);

    const saveRequest = () => new Request(`http://localhost/api/waveyard/projects/${project.id}/mashup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "save",
        vocalsSourceId: vocalsSource.id,
        instrumentalSourceId: bedSource.id,
      }),
    });
    const misalignedSave = await routeModule.POST(saveRequest(), { params: Promise.resolve({ id: project.id }) });
    assert.equal(misalignedSave.status, 422, "save must reject the same invalid donor PCM");
    assert.equal((await dbModule.db.select().from(schema.remixSessions)).length, 0, "invalid donor audio must not create a partial remix");

    const alignedDonor = encodeWav16(tone([510], VOCAL_SECONDS, 0.1), RATE);
    const alignedDonorPath = path.join(fixtureRoot, "vocal-donor-drums-aligned.wav");
    await writeFile(alignedDonorPath, alignedDonor);
    await storage.putFile("mashup-fixture/vocal-donor-drums.wav", alignedDonorPath);

    // The production schema prevents duplicate job/type rows. Temporarily
    // remove that index in this isolated test database to simulate a legacy or
    // manually-corrupted run and prove that both public route actions fail
    // closed instead of silently choosing one row.
    const duplicateDrums = encodeWav16(tone([810], VOCAL_SECONDS, 0.1), RATE);
    const duplicateDrumsPath = path.join(fixtureRoot, "vocal-donor-drums-duplicate.wav");
    await writeFile(duplicateDrumsPath, duplicateDrums);
    await storage.putFile("mashup-fixture/vocal-donor-drums-duplicate.wav", duplicateDrumsPath);
    await dbModule.pool.query('DROP INDEX "stem_assets_job_stem_unique"');
    let duplicateStemId: string | undefined;
    try {
      const [duplicateStem] = await dbModule.db.insert(schema.stemAssets).values({
        projectId: project.id,
        sourceAssetId: vocalsSource.id,
        separationJobId: latestVocalsJob.id,
        stemType: "drums",
        engine: "demucs",
        model: "test",
        modelVersion: "test",
        storageKey: "mashup-fixture/vocal-donor-drums-duplicate.wav",
        checksumSha256: sha256(duplicateDrums),
        durationSeconds: VOCAL_SECONDS,
        sampleRate: RATE,
        channels: 2,
        codec: "wav",
        format: "wav",
        fileSizeBytes: duplicateDrums.length,
        createdAt: latestCompletedAt,
      }).returning({ id: schema.stemAssets.id });
      assert.ok(duplicateStem);
      duplicateStemId = duplicateStem.id;

      const duplicateRender = await routeModule.POST(renderRequest(), { params: Promise.resolve({ id: project.id }) });
      assert.equal(duplicateRender.status, 422, "render must reject duplicate stem types through the production route");
      assert.match(((await duplicateRender.json()) as { error: string }).error, /duplicate drums stems/i);
      const duplicateSave = await routeModule.POST(saveRequest(), { params: Promise.resolve({ id: project.id }) });
      assert.equal(duplicateSave.status, 422, "save must reject duplicate stem types through the production route");
      assert.match(((await duplicateSave.json()) as { error: string }).error, /duplicate drums stems/i);
      assert.equal((await dbModule.db.select().from(schema.remixSessions)).length, 0, "duplicate stems must not create a partial remix");
    } finally {
      if (duplicateStemId) {
        await dbModule.db.delete(schema.stemAssets).where(eq(schema.stemAssets.id, duplicateStemId));
      }
      await dbModule.pool.query(
        'CREATE UNIQUE INDEX "stem_assets_job_stem_unique" ON "stem_assets" ("separation_job_id", "stem_type")',
      );
    }

    // Save while the completed instrumental run is still present.
    const saveResponse = await routeModule.POST(saveRequest(), { params: Promise.resolve({ id: project.id }) });
    assert.equal(saveResponse.status, 201, "save action must return 201 Created");
    const saveBody = (await saveResponse.json()) as { ok: boolean; remix: { id: string; name: string }; version: { id: string } };
    assert.equal(saveBody.ok, true);
    assert.ok(saveBody.remix.id);
    assert.ok(saveBody.version.id);

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
    const savedStemIds = new Set(savedTracks.map((track) => track.stemAssetId));
    assert.ok(savedStemIds.has(latestVocalStem.id), "save must use the newest completed vocal stem");
    assert.ok(!savedStemIds.has(originalVocalStem.id), "superseded completed vocal stems must not be saved");
    for (const invalidStemId of invalidVocalStemIds) {
      assert.ok(!savedStemIds.has(invalidStemId), "pending, failed, and cancelled vocal stems must not be saved");
    }
    for (const donorStemId of donorStemIds) {
      assert.ok(savedStemIds.has(donorStemId), `saved Studio remix must keep donor stem ${donorStemId}`);
    }

    const savedClips = await dbModule.db
      .select()
      .from(schema.remixClips)
      .where(inArray(schema.remixClips.remixTrackId, savedTracks.map((track) => track.id)));
    for (const donorStemId of donorStemIds) {
      const donorTrack = savedTracks.find((track) => track.stemAssetId === donorStemId);
      assert.ok(donorTrack, "each complementary stem must have a persisted track");
      const donorClip = savedClips.find((clip) => clip.remixTrackId === donorTrack.id && clip.stemAssetId === donorStemId);
      assert.ok(donorClip, "each complementary donor track must have a persisted clip");
      assert.equal(donorClip.timelineStartMs, 0);
      assert.equal(donorClip.durationMs, VOCAL_SECONDS * 1000);
      assert.equal(donorClip.tempoSyncEnabled, false, "a 1:1 tempo plan must reopen without an extra transform");
      assert.equal(donorClip.keySyncEnabled, false, "instrumental donor stems must not inherit vocal key shifts");
    }

    const vocalClips = savedClips.filter((clip) => clip.stemAssetId === latestVocalStem.id);
    assert.ok(vocalClips.length > 0, "the saved vocal track must reference the selected completed stem");
    assert.ok(vocalClips.every((clip) => !clip.keySyncEnabled), "a no-shift key plan must reopen without applying a new key transform");

    const reopenedResponse = await remixStateRoute.GET(
      new Request(`http://localhost/api/remixes/${saveBody.remix.id}`, { headers: { host: "localhost" } }),
      { params: Promise.resolve({ id: saveBody.remix.id }) },
    );
    assert.equal(reopenedResponse.status, 200, "the persisted remix must be readable through the Studio route");
    const reopened = await reopenedResponse.json() as {
      tracks: Array<{ stemAssetId: string; clips: Array<{ stemAssetId: string; timelineStartMs: number; durationMs: number }> }>;
      automation: Array<{
        remixTrackId: string;
        parameter: string;
        points: Array<{ timelineMs: number; value: number }>;
      }>;
    };
    for (const donorStemId of donorStemIds) {
      const reopenedTrack = reopened.tracks.find((track) => track.stemAssetId === donorStemId);
      assert.ok(reopenedTrack, "reopened Studio state must retain each complementary donor instrument");
      assert.ok(
        reopenedTrack.clips.some((clip) => clip.stemAssetId === donorStemId),
        "reopened Studio state must retain each complementary donor clip",
      );
      const track = savedTracks.find((candidate) => candidate.stemAssetId === donorStemId);
      assert.ok(track);
      const lane = reopened.automation.find((candidate) =>
        candidate.remixTrackId === track.id && candidate.parameter === "volume",
      );
      assert.ok(lane, "reopened Studio state must retain donor-vocal ducking automation");
      assert.deepEqual(
        lane.points.map(({ timelineMs, value }) => ({ timelineMs, value })),
        buildMashupDonorDuckingAutomation(planBody.plan!).map(({ timelineMs, value }) => ({ timelineMs, value })),
        "persisted automation must reproduce the exact plan envelope used by the renderer",
      );
    }
    const savedVersionSnapshot = JSON.parse(
      (await dbModule.db.select().from(schema.remixVersions).where(eq(schema.remixVersions.id, saveBody.version.id)))[0]!.snapshot,
    ) as { automation: Array<{ remixTrackId: string; parameter: string; points: Array<{ timelineMs: number; value: number }> }> };
    assert.equal(savedVersionSnapshot.automation.length, donorStemIds.length, "the initial saved version must include all donor ducking lanes");

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

    // A failed bed run must be ignored without deleting its rows (saved remixes
    // intentionally retain foreign-key references to the original assets).
    // The route must fall back to the original file and say so.
    await dbModule.db.update(schema.processingJobs)
      .set({ status: "failed", stage: "failed", updatedAt: new Date() })
      .where(eq(schema.processingJobs.id, bedJob.id));
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

    // Simulate studio edit: update masterVolume & track pan via DB transaction, verify version increment
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
