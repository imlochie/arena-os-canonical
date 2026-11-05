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
import { and, eq } from "drizzle-orm";

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
  const bundled = path.join(root, "node_modules", "@embedded-postgres", platform, "native", "bin", `${name}${extension}`);
  if (existsSync(bundled)) return bundled;
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

test("API render uses the synthesized separated bed and reports the original-file fallback", async (t) => {
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
    dbModule = await import("@workspace/db");
    const schema = await import("@workspace/db/waveyardSchema");
    const { LOCAL_OWNER_ID } = await import("@workspace/db/schema");
    const { getStorage } = await import("@workspace/arena/lib/waveyard/storage");
    const storage = getStorage();

    const [project] = await dbModule.db.insert(schema.projects).values({
      ownerId: LOCAL_OWNER_ID,
      title: "Mashup route fixture",
      kind: "studio",
    }).returning({ id: schema.projects.id });
    assert.ok(project);

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
    await dbModule.db.insert(schema.stemAssets).values({
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
    });

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
    const planBody = await planResponse.json() as { bed?: { source: string; warning: string } };
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
    const donorVocalEnergy = energyAt(rendered!.samples, 1000, 2, 4);
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
