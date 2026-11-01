/**
 * Opt-in UI -> real retry route -> local broker -> pinned ONNX worker ->
 * real library route acceptance. Unrelated panels are explicitly unavailable,
 * never supplied success-shaped fake job data. Library reads use the DB.
 */
import assert from "node:assert/strict";
import { copyFile, link, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { processingJobs, stemAssets } from "@workspace/db/waveyardSchema";
import type { db as workspaceDb } from "@workspace/db";
import type { Client } from "pg";
import { checksumFile } from "../audio";
import { encodeWav16, decodeWav16 } from "../mixer/synth";
import { findMdxModel } from "../separation/mdx";
import { SEPARATION_QUEUE } from "../queue";
import { getStorage } from "../storage";
import { getLocalJobBroker, resetLocalJobBrokerForTests } from "../worker-local/broker";
import { handleSeparationJob } from "../worker-local/separation";
import { stemMachineSource } from "../worker-local/separation-fixtures";
import type { addTrackFromAudioFile } from "./service";
import { requireUser } from "../local-context";

type BrowserRoute = {
  request(): { url(): string; method(): string; postData(): string | null };
  fulfill(input: { status?: number; json?: unknown; headers?: Record<string, string>; body?: string }): Promise<void>;
};

export async function verifyLibraryRetryWithRealWorker(options: {
  database: typeof workspaceDb;
  client: Client;
  directory: string;
  addTrack: typeof addTrackFromAudioFile;
}) {
  const { database, client, directory, addTrack } = options;
  // Service-only fixtures use synthetic owners; actual library routes filter
  // by the canonical local user. Seed the identity the real UI will read.
  const { id: ownerId } = await requireUser();
  const oldEnvironment = {
    ARENA_DESKTOP_MODE: process.env.ARENA_DESKTOP_MODE,
    REDIS_URL: process.env.REDIS_URL,
    WAVEYARD_MODELS_DIR: process.env.WAVEYARD_MODELS_DIR,
  };
  const requireBrowser = createRequire(new URL("../../../../../../artifacts/api-server/package.json", import.meta.url));
  const { chromium } = requireBrowser("playwright-core");
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const broker = getLocalJobBroker();
  const started = Date.now();
  try {
    // Reproduce an actual rejected queue handoff, not a fabricated failed row.
    process.env.ARENA_DESKTOP_MODE = "0";
    delete process.env.REDIS_URL;
    resetLocalJobBrokerForTests();
    const model = findMdxModel("kim_vocal_2")!;
    const installed = fileURLToPath(new URL(
      `../../../../../../artifacts/api-server/.data/waveyard-models/${model.file}`, import.meta.url,
    ));
    assert.ok(existsSync(installed), "install the registry-pinned Kim model before running this opt-in acceptance");
    assert.equal(await checksumFile(installed), model.sha256, "real inference uses only the checksum-pinned model");
    const modelsDirectory = join(directory, "retry-acceptance-models");
    await mkdir(modelsDirectory, { recursive: true });
    try { await link(installed, join(modelsDirectory, model.file)); }
    catch { await copyFile(installed, join(modelsDirectory, model.file)); }
    process.env.WAVEYARD_MODELS_DIR = modelsDirectory;
    const inputPath = join(directory, "retry-acceptance.wav");
    await writeFile(inputPath, encodeWav16(stemMachineSource(44_100), 44_100));
    const originalChecksum = await checksumFile(inputPath);
    const intake = await addTrack({
      ownerId, filePath: inputPath, filename: "Fixture - Library retry acceptance.wav",
      mimeType: "audio/wav", model: model.id, requestedDevice: "cpu",
    });
    assert.equal(intake.separationQueued, false);
    assert.equal(intake.track.stemAvailability.status, "rejected");
    const jobId = intake.track.stemAvailability.retryJobId;
    assert.ok(jobId);
    assert.ok(intake.track.sourceAssetId);
    const jobsBefore = await database.select().from(processingJobs)
      .where(eq(processingJobs.sourceAssetId, intake.track.sourceAssetId));
    assert.equal(jobsBefore.find(job => job.id === jobId)?.status, "failed");

    // Record durable transitions, so a fast worker cannot evade a polling assertion.
    await client.query(`
      CREATE TABLE retry_acceptance_transitions (job_id uuid, status text);
      CREATE FUNCTION record_retry_acceptance_transition() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO retry_acceptance_transitions VALUES (NEW.id, NEW.status);
        RETURN NEW;
      END $$;
      CREATE TRIGGER retry_acceptance_transition AFTER UPDATE OF status ON processing_jobs
      FOR EACH ROW EXECUTE FUNCTION record_retry_acceptance_transition();
    `);
    process.env.ARENA_DESKTOP_MODE = "1";
    const activeBroker = getLocalJobBroker();
    activeBroker.register(SEPARATION_QUEUE, payload => handleSeparationJob(payload, { db: database }));
    const retryRoute = await import(new URL(
      "../../../../../../artifacts/api-server/src/imported/jobs/[id]/retry/route.ts", import.meta.url,
    ).href);
    const libraryReads = new Map(await Promise.all(
      ["tracks", "queue", "playback-state", "playlists", "collections", "sessions"].map(async name => {
        const handler = await import(new URL(
          `../../../../../../artifacts/api-server/src/imported/library/${name}/route.ts`, import.meta.url,
        ).href);
        return [`/api/library/${name}`, handler.GET] as const;
      }),
    ));
    browser = await chromium.launch({ executablePath: "/repl/tools/bin/chromium", headless: true, args: ["--no-sandbox"] });
    const context = await browser.newContext();
    let retryRequests = 0;
    await context.route("**/api/**", async (route: BrowserRoute) => {
      const request = route.request();
      const url = new URL(request.url());
      let response: Response | undefined;
      if (libraryReads.has(url.pathname) && request.method() === "GET") {
        response = await libraryReads.get(url.pathname)(new Request(url));
      } else if (url.pathname === `/api/jobs/${jobId}/retry` && request.method() === "POST") {
        retryRequests++;
        response = await retryRoute.POST(new Request(url, { method: "POST" }), {
          params: Promise.resolve({ id: jobId }),
        });
      }
      if (response) {
        await route.fulfill({
          status: response.status, headers: Object.fromEntries(response.headers), body: await response.text(),
        });
      } else if (request.method() === "GET") {
        await route.fulfill({ status: 503, json: { error: "Unrelated panel unavailable in isolated acceptance." } });
      } else {
        await route.fulfill({ status: 403, json: { error: "Unrelated mutation blocked by isolated acceptance." } });
      }
    });
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (error: Error) => pageErrors.push(error.message));
    page.on("console", async (message: { type(): string; args(): Array<{ evaluate(fn: (value: unknown) => unknown): Promise<unknown> }> }) => {
      if (message.type() !== "error") return;
      for (const argument of message.args()) {
        const stack = await argument.evaluate(value =>
          value instanceof Error ? value.stack : null).catch(() => null);
        if (stack) console.error("Acceptance browser error:", stack);
      }
    });
    await page.goto("http://localhost:80/waveyard", { waitUntil: "domcontentloaded" });
    const card = page.getByTestId("library-track").filter({
      has: page.getByTestId(`button-play-${intake.track.id}`),
    });
    const [retried] = await Promise.all([
      page.waitForResponse((response: { url(): string; request(): { method(): string } }) =>
        response.url().endsWith(`/api/jobs/${jobId}/retry`) && response.request().method() === "POST"),
      card.getByRole("button", { name: `Retry separation for ${intake.track.title}`, exact: true }).click({ timeout: 10_000 }),
    ]).catch(async error => {
      console.error("Isolated retry acceptance browser state:", {
        pageErrors, text: (await page.locator("body").innerText()).slice(-2600),
      });
      throw error;
    });
    assert.equal(retried.status(), 200, "the actual retry route accepts the library action");
    assert.equal(await activeBroker.drain(150_000), true, "the real CPU worker finishes the retried job");
    const [completed] = await database.select().from(processingJobs).where(eq(processingJobs.id, jobId));
    assert.equal(completed.status, "complete", completed.errorMessage ?? "the original job completes");
    assert.equal(completed.errorCode, null);
    assert.equal(completed.resolvedDevice, "cpu");
    const transitions = await client.query<{ status: string }>(
      "SELECT status FROM retry_acceptance_transitions WHERE job_id = $1", [jobId],
    );
    for (const status of ["queued", "processing", "complete"]) {
      assert.ok(transitions.rows.some(row => row.status === status), `original job durably enters ${status}`);
    }
    const jobsAfter = await database.select().from(processingJobs)
      .where(eq(processingJobs.sourceAssetId, intake.track.sourceAssetId));
    assert.deepEqual(jobsAfter.map(job => job.id).sort(), jobsBefore.map(job => job.id).sort(),
      "retry creates no duplicate durable job, including waveform jobs");
    assert.equal(activeBroker.stats().succeeded, 1, "the broker executes exactly one retry");
    assert.equal(retryRequests, 1, "the library submits exactly one retry request");
    const stems = await database.select().from(stemAssets).where(eq(stemAssets.separationJobId, jobId));
    assert.equal(stems.length, 2, "the real Kim model persists vocals and instrumental outputs");
    for (const stem of stems) {
      const filename = getStorage().getLocalPath(stem.storageKey);
      assert.ok(filename && existsSync(filename), "each output exists in private storage");
      const { readFile } = await import("node:fs/promises");
      const decoded = decodeWav16(new Uint8Array(await readFile(filename)));
      assert.ok(decoded && decoded.frames > 0 && decoded.sampleRate === 44_100, "each stem is a decodable WAV");
    }
    // The existing processing poll must discover real completed state, not a
    // test-supplied success response or a forced page reload.
    await card.getByText("2 STEMS", { exact: true }).waitFor({ timeout: 30_000 });
    assert.equal(await card.getByRole("button", { name: /^Retry separation for/ }).count(), 0);
    assert.deepEqual(pageErrors, [], "the completed library view has no browser exceptions");
    assert.equal(await checksumFile(inputPath), originalChecksum, "the input audio remains unchanged");
    return { jobId, device: completed.resolvedDevice, elapsedMs: Date.now() - started, stemCount: stems.length };
  } finally {
    await browser?.close();
    await broker.drain(150_000);
    await getLocalJobBroker().drain(150_000);
    resetLocalJobBrokerForTests();
    await client.query(`
      DROP TRIGGER IF EXISTS retry_acceptance_transition ON processing_jobs;
      DROP FUNCTION IF EXISTS record_retry_acceptance_transition();
      DROP TABLE IF EXISTS retry_acceptance_transitions;
    `);
    for (const [key, value] of Object.entries(oldEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
