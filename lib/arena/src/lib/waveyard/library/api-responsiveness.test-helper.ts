/**
 * Opt-in acceptance against the actual Express app/router over a private HTTP
 * socket and disposable PostgreSQL/storage, not mocked route responses.
 * One-second request budgets include response parsing and event-loop delays.
 */
import assert from "node:assert/strict";
import { copyFile, link, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { openSync, closeSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { processingJobs, stemAssets } from "@workspace/db/waveyardSchema";
import type { db as workspaceDb } from "@workspace/db";
import { checksumFile } from "../audio";
import { encodeWav16 } from "../mixer/synth";
import { requireUser } from "../local-context";
import { findMdxModel } from "../separation/mdx";
import { resetLocalJobBrokerForTests } from "../worker-local/broker";
import { stemMachineSource } from "../worker-local/separation-fixtures";
import type { addTrackFromAudioFile } from "./service";
import { createSession, addTrackToSession } from "./session-service";

const REQUEST_BUDGET_MS = 1_000;
const MODEL_IDS = ["kim_vocal_2", "kuielab_b_drums", "kuielab_b_bass", "kuielab_b_other"];
type PhaseMetrics = { rounds: number; libraryMaxMs: number; sessionMaxMs: number };

export async function verifyApiResponsivenessDuringSeparation(options: {
  database: typeof workspaceDb;
  directory: string;
  addTrack: typeof addTrackFromAudioFile;
  port: number;
}) {
  const { database, directory, addTrack } = options;
  const environmentKeys = ["ARENA_DESKTOP_MODE", "REDIS_URL", "WAVEYARD_MODELS_DIR"];
  const oldEnvironment = new Map(environmentKeys.map(key => [key, process.env[key]]));
  let server: ChildProcess | undefined;
  let stop = false;
  let sampler: Promise<void> | undefined;
  let samplingError: unknown;
  const metrics = new Map<string, PhaseMetrics>();
  const startedAt = performance.now();
  try {
    process.env.ARENA_DESKTOP_MODE = "0";
    delete process.env.REDIS_URL;
    resetLocalJobBrokerForTests();
    const modelsDirectory = join(directory, "api-responsiveness-models");
    await mkdir(modelsDirectory, { recursive: true });
    for (const id of MODEL_IDS) {
      const spec = findMdxModel(id)!;
      const installed = fileURLToPath(new URL(
        `../../../../../../artifacts/api-server/.data/waveyard-models/${spec.file}`, import.meta.url,
      ));
      assert.ok(existsSync(installed), `the opt-in run requires installed ${id} weights`);
      assert.equal(await checksumFile(installed), spec.sha256, `${id} matches the registry pin`);
      try { await link(installed, join(modelsDirectory, spec.file)); }
      catch { await copyFile(installed, join(modelsDirectory, spec.file)); }
    }
    process.env.WAVEYARD_MODELS_DIR = modelsDirectory;
    const apiBundle = fileURLToPath(new URL(
      "../../../../../../artifacts/api-server/dist/index.mjs", import.meta.url,
    ));
    assert.ok(existsSync(apiBundle), "build the API server before running this acceptance");
    const logDirectory = fileURLToPath(new URL("../../../../../../generated-artifacts", import.meta.url));
    await mkdir(logDirectory, { recursive: true });
    const logFile = join(logDirectory, `api-responsiveness-server-${Date.now()}.log`);
    const logFd = openSync(logFile, "w");
    try {
      server = spawn(process.execPath, ["--enable-source-maps", apiBundle], {
        env: {
          ...process.env, ARENA_DESKTOP_MODE: "1", ARENA_WEB_ROOT: directory,
          PORT: String(options.port), WAVEYARD_MODELS_DIR: modelsDirectory,
        },
        stdio: ["ignore", logFd, logFd],
      });
    } finally { closeSync(logFd); }
    let serverError: Error | undefined;
    server.once("error", error => { serverError = error; });
    const origin = `http://127.0.0.1:${options.port}`;
    let ready = false;
    for (let attempt = 0; attempt < 100 && !ready; attempt++) {
      assert.equal(serverError, undefined, `API process failed; see ${logFile}`);
      assert.equal(server.exitCode, null, `API process exited; see ${logFile}`);
      try {
        const response = await fetch(`${origin}/api/library/tracks`, { signal: AbortSignal.timeout(REQUEST_BUDGET_MS) });
        ready = response.status === 200 && Array.isArray((await response.json()).tracks);
      } catch { /* A refused connection is expected until startup recovery finishes. */ }
      if (!ready) await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.ok(ready, `the isolated built API becomes ready; see ${logFile}`);

    const { id: ownerId } = await requireUser();
    const inputPath = join(directory, "api-responsiveness.wav");
    await writeFile(inputPath, encodeWav16(stemMachineSource(88_200), 44_100));
    const intake = await addTrack({
      ownerId, filePath: inputPath, filename: "Fixture - API responsiveness.wav",
      mimeType: "audio/wav", model: "stems_4", requestedDevice: "cpu",
    });
    assert.equal(intake.track.stemAvailability.status, "rejected");
    const jobId = intake.track.stemAvailability.retryJobId;
    assert.ok(jobId);
    const session = await createSession(ownerId, "Real API responsiveness probe");
    await addTrackToSession({ ownerId, sessionId: session.id, trackId: intake.track.id });

    const readPhase = async () => {
      const [job] = await database.select().from(processingJobs).where(eq(processingJobs.id, jobId));
      const metadata = typeof job.metadata === "string" ? JSON.parse(job.metadata) : job.metadata;
      const phase = metadata?.progress?.phase as string | undefined;
      if (phase && /^[1-4]\/4$/.test(phase)) {
        assert.equal(metadata.progress.model, MODEL_IDS[Number(phase[0]) - 1], "the phase names its real pinned model");
      }
      return job.status === "processing" && job.stage === "separating" ? phase : undefined;
    };
    const probe = async (kind: "library" | "session") => {
      const start = performance.now();
      // /api/library is the video shelf. Waveyard's music library is /tracks.
      const path = kind === "library" ? "/api/library/tracks" : "/api/library/sessions";
      const response = await fetch(`${origin}${path}`, { signal: AbortSignal.timeout(REQUEST_BUDGET_MS) });
      assert.equal(response.status, 200, `${path} returns HTTP 200 during separation`);
      const body = await response.json();
      const elapsedMs = performance.now() - start;
      assert.ok(elapsedMs < REQUEST_BUDGET_MS, `${path} took ${elapsedMs.toFixed(1)} ms`);
      if (kind === "library") {
        assert.ok(Array.isArray(body.tracks));
        const track = body.tracks.find((row: { id: string }) => row.id === intake.track.id);
        assert.ok(track, "the separating track remains present in the real library response");
        assert.equal(track.title, intake.track.title);
        assert.ok(typeof track.stemAvailability?.status === "string");
      } else {
        assert.ok(Array.isArray(body.sessions));
        const found = body.sessions.find((row: { id: string }) => row.id === session.id);
        assert.ok(found, "the populated listening session remains present");
        assert.equal(found.name, session.name);
      }
      return elapsedMs;
    };
    await Promise.all([probe("library"), probe("session")]);
    sampler = (async () => {
      while (!stop) {
        try {
          const phaseBefore = await readPhase();
          const [libraryMs, sessionMs] = await Promise.all([probe("library"), probe("session")]);
          const phaseAfter = await readPhase();
          // Do not label startup or a request crossing a model boundary as
          // evidence from a particular inference pass.
          if (phaseBefore && phaseBefore === phaseAfter && /^[1-4]\/4$/.test(phaseBefore)) {
            const sample = metrics.get(phaseBefore) ?? { rounds: 0, libraryMaxMs: 0, sessionMaxMs: 0 };
            sample.rounds++;
            sample.libraryMaxMs = Math.max(sample.libraryMaxMs, libraryMs);
            sample.sessionMaxMs = Math.max(sample.sessionMaxMs, sessionMs);
            metrics.set(phaseBefore, sample);
          }
        } catch (error) { samplingError = error; return; }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    })();
    const retryResponse = await fetch(`${origin}/api/jobs/${jobId}/retry`, {
      method: "POST", signal: AbortSignal.timeout(REQUEST_BUDGET_MS),
    });
    assert.equal(retryResponse.status, 200, "real HTTP routing accepts the original failed job's retry");
    const deadline = Date.now() + 540_000;
    let finalStatus = "";
    while (Date.now() < deadline) {
      assert.equal(server.exitCode, null, `API exited during inference; see ${logFile}`);
      const [current] = await database.select().from(processingJobs).where(eq(processingJobs.id, jobId));
      finalStatus = current.status;
      if (finalStatus === "complete" || finalStatus === "failed") break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(finalStatus, "complete", `the isolated API's real worker completes; see ${logFile}`);
    stop = true;
    await sampler;
    assert.equal(samplingError, undefined, String(samplingError));
    const [job] = await database.select().from(processingJobs).where(eq(processingJobs.id, jobId));
    assert.equal(job.status, "complete", job.errorMessage ?? "the four-model job completes");
    assert.equal(job.resolvedDevice, "cpu");
    const stems = await database.select().from(stemAssets).where(eq(stemAssets.separationJobId, jobId));
    assert.deepEqual(stems.map(stem => stem.stemType).sort(), ["bass", "drums", "other", "vocals"]);
    for (let pass = 1; pass <= 4; pass++) {
      assert.ok((metrics.get(`${pass}/4`)?.rounds ?? 0) >= 2,
        `both HTTP endpoints are repeatedly checked inside model pass ${pass}/4`);
    }
    await Promise.all([probe("library"), probe("session")]);
    return {
      requestBudgetMs: REQUEST_BUDGET_MS, intervalMs: 100,
      elapsedMs: Math.round(performance.now() - startedAt),
      phases: Object.fromEntries(metrics), serverLog: logFile,
    };
  } finally {
    stop = true;
    await sampler;
    resetLocalJobBrokerForTests();
    if (server) {
      if (server.exitCode === null && server.signalCode === null) {
        await new Promise<void>(resolve => {
          const killTimer = setTimeout(() => server!.kill("SIGKILL"), 10_000);
          server!.once("exit", () => { clearTimeout(killTimer); resolve(); });
          server!.kill("SIGTERM");
        });
      }
    }
    for (const [key, value] of oldEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
