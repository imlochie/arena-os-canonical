/**
 * Opt-in UI -> real retry route -> local broker -> pinned ONNX worker ->
 * real library route acceptance. Unrelated panels are explicitly unavailable,
 * never supplied success-shaped fake job data. Library reads use the DB.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
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
import { FOUR_STEM_MODELS, stagePinnedModels } from "../worker-local/pinned-models.test-helper";
import type { addTrackFromAudioFile } from "./service";
import { requireUser } from "../local-context";
import { installLiveAudioProbe, readLiveAudioState } from "./live-controls-during-separation.test-helper";

type BrowserRoute = {
  request(): { url(): string; method(): string; postData(): string | null; headers(): Record<string, string> };
  fulfill(input: { status?: number; json?: unknown; headers?: Record<string, string>; body?: string | Buffer }): Promise<void>;
};

export async function verifyLibraryRetryWithRealWorker(options: {
  database: typeof workspaceDb;
  client: Client;
  directory: string;
  addTrack: typeof addTrackFromAudioFile;
  recipe?: "kim_vocal_2" | "default-four-stem";
}) {
  const { database, client, directory, addTrack } = options;
  const fourStem = options.recipe === "default-four-stem";
  const workerTimeout = fourStem ? 570_000 : 150_000;
  // Service-only fixtures use synthetic owners; actual library routes filter
  // by the canonical local user. Seed the identity the real UI will read.
  const { id: ownerId } = await requireUser();
  const oldEnvironment = {
    ARENA_DESKTOP_MODE: process.env.ARENA_DESKTOP_MODE,
    REDIS_URL: process.env.REDIS_URL,
    WAVEYARD_MODELS_DIR: process.env.WAVEYARD_MODELS_DIR,
    SEPARATION_MODEL: process.env.SEPARATION_MODEL,
    WAVEYARD_LOCAL_WORKER: process.env.WAVEYARD_LOCAL_WORKER,
  };
  const requireBrowser = createRequire(new URL("../../../../../../artifacts/api-server/package.json", import.meta.url));
  const { chromium } = requireBrowser("playwright-core");
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const broker = getLocalJobBroker();
  const started = Date.now();
  try {
    // Reproduce an actual rejected queue handoff, not a fabricated failed row.
    process.env.ARENA_DESKTOP_MODE = "1";
    process.env.WAVEYARD_LOCAL_WORKER = "1";
    delete process.env.REDIS_URL;
    delete process.env.SEPARATION_MODEL;
    resetLocalJobBrokerForTests();
    const model = findMdxModel("kim_vocal_2")!;
    const installedDirectory = fileURLToPath(new URL(
      "../../../../../../artifacts/api-server/.data/waveyard-models/", import.meta.url,
    ));
    const modelsDirectory = join(directory, `retry-acceptance-models-${fourStem ? "four" : "kim"}`);
    await stagePinnedModels(installedDirectory, modelsDirectory, fourStem ? FOUR_STEM_MODELS : [model]);
    process.env.WAVEYARD_MODELS_DIR = modelsDirectory;
    const inputPath = join(directory, `retry-acceptance-${fourStem ? "four" : "kim"}.wav`);
    const sourcePcm = stemMachineSource(44_100);
    // Both opt-in cases share one disposable DB; distinct PCM avoids making
    // the second intake an intentional checksum-deduplication hit.
    if (fourStem) for (let index = 0; index < sourcePcm.length; index++) sourcePcm[index] *= 0.9;
    await writeFile(inputPath, encodeWav16(sourcePcm, 44_100));
    const originalChecksum = await checksumFile(inputPath);
    const intake = await addTrack({
      ownerId, filePath: inputPath, filename: "Fixture - Library retry acceptance.wav",
      mimeType: "audio/wav", ...(fourStem ? {} : { model: model.id }), device: "cpu",
    });
    assert.equal(intake.separationQueued, false);
    assert.equal(intake.track.stemAvailability.status, "rejected");
    const jobId = intake.track.stemAvailability.retryJobId;
    assert.ok(jobId);
    assert.ok(intake.track.sourceAssetId);
    const jobsBefore = await database.select().from(processingJobs)
      .where(eq(processingJobs.sourceAssetId, intake.track.sourceAssetId));
    assert.equal(jobsBefore.find(job => job.id === jobId)?.status, "failed");
    assert.equal(jobsBefore.find(job => job.id === jobId)?.model, fourStem ? "stems_4" : model.id,
      "desktop intake with no model override selects the actual default four-stem recipe");
    assert.ok(getLocalJobBroker().stats().rejected > 0, "missing registered executors reject the original handoff");

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
    const completedPasses: string[] = [];
    activeBroker.register(SEPARATION_QUEUE, payload => handleSeparationJob(payload, {
      db: database,
      // As in the real four-model acceptance, this fires after the native
      // worker exits and releases its session, before the next pass starts.
      onInferenceTiming: (modelId) => completedPasses.push(modelId),
    }));
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
    const sessionsRoute = await import(new URL(
      "../../../../../../artifacts/api-server/src/imported/library/sessions/route.ts", import.meta.url,
    ).href);
    const assetsRoute = await import(new URL(
      "../../../../../../artifacts/api-server/src/imported/assets/[id]/route.ts", import.meta.url,
    ).href);
    browser = await chromium.launch({
      executablePath: "/repl/tools/bin/chromium", headless: true,
      args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"],
    });
    const context = await browser.newContext({ serviceWorkers: "block" });
    await installLiveAudioProbe(context);
    let retryRequests = 0;
    const servedAudioAssets = new Set<string>();
    await context.route("**/api/**", async (route: BrowserRoute) => {
      const request = route.request();
      const url = new URL(request.url());
      const sessionPath = url.pathname.match(/^\/api\/library\/sessions\/([^/]+)(?:\/(state|tracks)(?:\/([^/]+))?)?$/);
      const assetPath = url.pathname.match(/^\/api\/assets\/([^/]+)$/);
      let response: Response | undefined;
      if (libraryReads.has(url.pathname) && request.method() === "GET") {
        response = await libraryReads.get(url.pathname)(new Request(url));
      } else if (url.pathname === `/api/jobs/${jobId}/retry` && request.method() === "POST") {
        retryRequests++;
        response = await retryRoute.POST(new Request(url, { method: "POST" }), {
          params: Promise.resolve({ id: jobId }),
        });
      } else if (fourStem && url.pathname === "/api/library/sessions" && request.method() === "POST") {
        response = await sessionsRoute.POST(new Request(url, {
          method: "POST", headers: request.headers(), body: request.postData(),
        }));
      } else if (fourStem && sessionPath) {
        const [, id, kind, itemId] = sessionPath;
        const suffix = kind ? `/${kind}${itemId ? "/[itemId]" : ""}` : "";
        const handler = await import(new URL(
          `../../../../../../artifacts/api-server/src/imported/library/sessions/[id]${suffix}/route.ts`, import.meta.url,
        ).href);
        const method = request.method();
        if (handler[method]) response = await handler[method](new Request(url, {
          method, headers: request.headers(), ...(method === "GET" ? {} : { body: request.postData() }),
        }), { params: Promise.resolve({ id, itemId }) });
      } else if (fourStem && assetPath && request.method() === "GET") {
        response = await assetsRoute.GET(new Request(url, { headers: request.headers() }), {
          params: Promise.resolve({ id: assetPath[1] }),
        });
        if (response.ok) servedAudioAssets.add(assetPath[1]);
      }
      if (response) {
        await route.fulfill({
          status: response.status, headers: Object.fromEntries(response.headers),
          body: assetPath ? Buffer.from(await response.arrayBuffer()) : await response.text(),
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
    assert.equal(await activeBroker.drain(workerTimeout), true, "the real CPU worker finishes the retried job");
    const [completed] = await database.select().from(processingJobs).where(eq(processingJobs.id, jobId));
    assert.equal(completed.status, "complete", completed.errorMessage ?? "the original job completes");
    assert.equal(completed.errorCode, null);
    assert.equal(completed.resolvedDevice, "cpu");
    assert.deepEqual(completedPasses, (fourStem ? FOUR_STEM_MODELS : [model]).map(spec => spec.id),
      "every pinned model pass releases sequentially through the production worker");
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
    assert.equal(stems.length, fourStem ? 4 : 2);
    assert.deepEqual(stems.map(stem => stem.stemType).sort(),
      (fourStem ? ["vocals", "drums", "bass", "other"] : ["vocals", "instrumental"]).sort(),
      "exactly one output exists for every required stem type");
    for (const stem of stems) {
      const spec = (fourStem ? FOUR_STEM_MODELS : [model]).find(item => item.id === stem.model);
      assert.ok(spec);
      assert.equal(stem.modelVersion, spec.sha256, "persisted output identifies its pinned model");
      const filename = getStorage().getLocalPath(stem.storageKey);
      assert.ok(filename && existsSync(filename), "each output exists in private storage");
      const { readFile } = await import("node:fs/promises");
      const decoded = decodeWav16(new Uint8Array(await readFile(filename)));
      assert.ok(decoded && decoded.frames > 0 && decoded.sampleRate === 44_100, "each stem is a decodable WAV");
    }
    // The existing processing poll must discover real completed state, not a
    // test-supplied success response or a forced page reload.
    await card.getByText(`${stems.length} STEMS`, { exact: true }).waitFor({ timeout: 30_000 });
    assert.equal(await card.getByRole("button", { name: /^Retry separation for/ }).count(), 0);
    if (fourStem) {
      await card.getByTestId(`button-play-${intake.track.id}`).click();
      const expectedAssets = stems.map(stem => stem.id);
      await page.waitForFunction((ids: string[]) => {
        const audio = [...document.querySelectorAll<HTMLAudioElement>('[data-role="current"] audio')];
        return audio.length === 4 && audio.every(item => item.readyState >= 2)
          && ids.every(id => audio.some(item => new URL(item.currentSrc || item.src).pathname.endsWith(`/${id}`)));
      }, expectedAssets, { timeout: 30_000 });
      const play = page.getByTestId("session-play");
      if (await play.getAttribute("aria-pressed") === "true") await play.click();
      const loaded = await readLiveAudioState(page);
      assert.deepEqual(loaded.map(item => item.assetId).sort(), expectedAssets.sort(),
        "live playback uses the four persisted model outputs, never a passthrough/full-source substitute");
      assert.ok(expectedAssets.every(id => servedAudioAssets.has(id)),
        "every real stem was read through the production private asset route");
      for (const stem of stems) {
        const isolate = page.getByTestId(`quick-isolate-${stem.stemType}`);
        await isolate.click();
        await page.waitForFunction((id: string) =>
          document.querySelector(`[data-testid="quick-isolate-${id}"]`)?.getAttribute("aria-pressed") === "true",
        stem.stemType);
        const state = await readLiveAudioState(page);
        assert.ok(state.find(item => item.assetId === stem.id)?.gain! > 0, `${stem.stemType} has a real audible gain route`);
        assert.ok(state.filter(item => item.assetId !== stem.id).every(item => item.gain === 0),
          `isolating ${stem.stemType} mutes the other three real stem routes`);
        await isolate.click();
      }
      await play.click();
      await page.waitForFunction(() => {
        const audio = [...document.querySelectorAll<HTMLAudioElement>('[data-role="current"] audio')];
        return audio.length === 4 && audio.every(item => !item.paused && item.currentTime > 0.03);
      }, undefined, { timeout: 5_000 });
      await play.click();
      assert.ok((await readLiveAudioState(page)).every(item => item.gain! > 0),
        "restoring all stems keeps every actual stem connected");
    }
    assert.deepEqual(pageErrors, [], "the completed library view has no browser exceptions");
    assert.equal(await checksumFile(inputPath), originalChecksum, "the input audio remains unchanged");
    return { jobId, device: completed.resolvedDevice, elapsedMs: Date.now() - started, stemCount: stems.length };
  } finally {
    await browser?.close();
    await broker.drain(workerTimeout);
    await getLocalJobBroker().drain(workerTimeout);
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
