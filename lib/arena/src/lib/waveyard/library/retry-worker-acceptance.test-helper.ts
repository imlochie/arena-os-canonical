/**
 * Opt-in UI -> real retry route -> local broker -> pinned ONNX worker ->
 * real library route acceptance. Unrelated panels are explicitly unavailable,
 * never supplied success-shaped fake job data. Library reads use the DB.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { processingJobs, sourceAssets, stemAssets } from "@workspace/db/waveyardSchema";
import type { db as workspaceDb } from "@workspace/db";
import type { Client } from "pg";
import { checksumFile } from "../audio";
import { execTool } from "../ffmpeg";
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

type DeckAcceptanceSnapshot = {
  current: string[];
  next: string[];
  incomingReady: boolean;
  incomingMedia: Array<{
    assetId: string | null;
    readyState: number;
    networkState: number;
    paused: boolean;
    currentTime: number;
    srcProtocol: string | null;
    errorCode: number | null;
  }>;
};

const SAMPLE_DECK_SNAPSHOT_SOURCE = `({ outgoingIds, incomingIds, requireReady }) => {
  const elementsForRole = role =>
    Array.from(document.querySelectorAll('[data-role="' + role + '"] audio'));
  const assetId = audio => {
    const logicalUrl = audio.dataset.waveyardAssetUrl;
    return logicalUrl ? new URL(logicalUrl, location.href).pathname.split('/').pop() || null : null;
  };
  const currentElements = elementsForRole('current');
  const incomingElements = elementsForRole('next');
  const current = currentElements.map(assetId).filter(id => id !== null);
  const next = incomingElements.map(assetId).filter(id => id !== null);
  const incomingReady = incomingElements.length === incomingIds.length
    && incomingElements.every(audio => audio.readyState >= 2);
  const exact = (actual, expected) =>
    actual.length === expected.length && expected.every(id => actual.includes(id));
  const snapshot = {
    current,
    next,
    incomingReady,
    incomingMedia: incomingElements.map(audio => ({
      assetId: assetId(audio),
      readyState: audio.readyState,
      networkState: audio.networkState,
      paused: audio.paused,
      currentTime: audio.currentTime,
      srcProtocol: audio.currentSrc ? new URL(audio.currentSrc, location.href).protocol : null,
      errorCode: audio.error ? audio.error.code : null,
    })),
  };
  if (requireReady && (!exact(current, outgoingIds) || !exact(next, incomingIds) || !incomingReady)) {
    return false;
  }
  return snapshot;
}`;
type DeckSnapshotOptions = {
  outgoingIds: string[];
  incomingIds: string[];
  requireReady: boolean;
};
type DeckSnapshotProbe = (options: DeckSnapshotOptions) => DeckAcceptanceSnapshot | false;
// TSX can inject a module-scoped __name call into callbacks that Playwright
// serializes into Chromium. Build this fixed, test-owned probe as plain
// JavaScript so the browser never depends on the test module's helpers.
const sampleDeck = new Function(`return (${SAMPLE_DECK_SNAPSHOT_SOURCE})`)() as DeckSnapshotProbe;

async function probeAudioInput(filePath: string) {
  const { stdout } = await execTool("ffprobe", [
    "-v", "error", "-select_streams", "a:0",
    "-show_entries", "stream=codec_name,sample_rate,channels",
    "-of", "json", filePath,
  ], { timeoutMs: 30_000 });
  const probe = JSON.parse(stdout) as {
    streams?: Array<{ codec_name?: string; sample_rate?: string; channels?: number }>;
  };
  const stream = probe.streams?.[0];
  assert.ok(stream?.codec_name && stream.sample_rate && stream.channels,
    `ffprobe must identify the audio stream in ${basename(filePath)}`);
  return {
    codec: stream.codec_name,
    sampleRate: Number(stream.sample_rate),
    channels: stream.channels,
  };
}

export async function verifyLibraryRetryWithRealWorker(options: {
  database: typeof workspaceDb;
  client: Client;
  directory: string;
  addTrack: typeof addTrackFromAudioFile;
  recipe?: "kim_vocal_2" | "default-four-stem";
  audioInputPath?: string;
  incomingAudioInputPath?: string;
}) {
  const { database, client, directory, addTrack } = options;
  const fourStem = options.recipe === "default-four-stem";
  const workerTimeout = fourStem ? 570_000 : 150_000;
  const oldEnvironment = {
    ARENA_DESKTOP_MODE: process.env.ARENA_DESKTOP_MODE,
    REDIS_URL: process.env.REDIS_URL,
    WAVEYARD_MODELS_DIR: process.env.WAVEYARD_MODELS_DIR,
    SEPARATION_MODEL: process.env.SEPARATION_MODEL,
    WAVEYARD_LOCAL_WORKER: process.env.WAVEYARD_LOCAL_WORKER,
  };
  // The fixture DB is private local data; initialize the same owner context
  // that the desktop UI routes and the default model resolver use.
  process.env.ARENA_DESKTOP_MODE = "1";
  process.env.WAVEYARD_LOCAL_WORKER = "1";
  delete process.env.REDIS_URL;
  delete process.env.SEPARATION_MODEL;
  // Service-only fixtures use synthetic owners; actual library routes filter
  // by the canonical local user. Seed the identity the real UI will read.
  const { id: ownerId } = await requireUser();
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
    const wavFixturePath = join(directory, `retry-acceptance-${fourStem ? "four-source" : "kim"}.wav`);
    const inputPath = options.audioInputPath
      ? resolve(options.audioInputPath)
      : fourStem ? join(directory, "retry-acceptance-four.mp3") : wavFixturePath;
    if (!options.audioInputPath) {
      const sourcePcm = stemMachineSource(44_100);
      // Both opt-in cases share one disposable DB; distinct PCM avoids making
      // the second intake an intentional checksum-deduplication hit.
      if (fourStem) for (let index = 0; index < sourcePcm.length; index++) sourcePcm[index] *= 0.9;
      await writeFile(wavFixturePath, encodeWav16(sourcePcm, 44_100));
    }
    if (fourStem && !options.audioInputPath) {
      await execTool("ffmpeg", [
        "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
        "-i", wavFixturePath, "-map", "0:a:0", "-c:a", "libmp3lame", "-b:a", "192k", "-ar", "44100",
        inputPath,
      ], { timeoutMs: 30_000 });
    }
    const inputAudio = fourStem ? await probeAudioInput(inputPath) : null;
    if (fourStem) {
      assert.equal(inputAudio?.codec, "mp3", "the compressed four-stem input is actually MP3");
      if (!options.audioInputPath) {
        assert.equal(inputAudio?.sampleRate, 44_100, "the generated fixture is encoded at its pinned 44.1 kHz rate");
        assert.equal(inputAudio?.channels, 2);
      }
    }
    const originalChecksum = await checksumFile(inputPath);
    const intake = await addTrack({
      ownerId,
      filePath: inputPath,
      filename: options.audioInputPath
        ? basename(inputPath)
        : fourStem ? "Fixture - Library retry acceptance.mp3" : "Fixture - Library retry acceptance.wav",
      mimeType: fourStem ? "audio/mpeg" : "audio/wav",
      ...(fourStem ? {} : { model: model.id }),
      device: "cpu",
    });
    let incomingTrack: typeof intake.track | null = null;
    let incomingJobId: string | null = null;
    let incomingSourceId: string | null = null;
    let incomingInputPath: string | null = null;
    let incomingOriginalChecksum: string | null = null;
    let incomingJobIdsBefore: string[] = [];
    assert.equal(intake.separationQueued, false);
    assert.equal(intake.track.stemAvailability.status, "rejected");
    const jobId = intake.track.stemAvailability.retryJobId;
    assert.ok(jobId);
    assert.ok(intake.track.sourceAssetId);
    const [importedSource] = await database.select().from(sourceAssets)
      .where(eq(sourceAssets.id, intake.track.sourceAssetId)).limit(1);
    assert.ok(importedSource, "desktop library intake persists the imported audio source");
    if (fourStem) {
      assert.equal(importedSource.codec, inputAudio?.codec, "the desktop importer preserves the source codec");
      assert.equal(importedSource.mimeType, "audio/mpeg");
      assert.equal(importedSource.sampleRate, inputAudio?.sampleRate,
        "the desktop importer preserves the source sample rate instead of normalizing metadata to the fixture rate");
      assert.equal(importedSource.channels, inputAudio?.channels,
        "the desktop importer preserves the source channel count");
      assert.match(importedSource.originalFilename, /\.mp3$/i);

      const incomingWavPath = join(directory, "retry-acceptance-transition-incoming.wav");
      incomingInputPath = options.incomingAudioInputPath
        ? resolve(options.incomingAudioInputPath)
        : join(directory, "retry-acceptance-transition-incoming.mp3");
      if (!options.incomingAudioInputPath) {
        const incomingPcm = stemMachineSource(44_100);
        for (let index = 0; index < incomingPcm.length; index++) incomingPcm[index] *= 0.71;
        await writeFile(incomingWavPath, encodeWav16(incomingPcm, 44_100));
        await execTool("ffmpeg", [
          "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
          "-i", incomingWavPath, "-map", "0:a:0", "-c:a", "libmp3lame", "-b:a", "192k", "-ar", "44100",
          incomingInputPath,
        ], { timeoutMs: 30_000 });
      }
      const incomingAudio = await probeAudioInput(incomingInputPath);
      assert.equal(incomingAudio.codec, "mp3", "the incoming compressed source is actually MP3");
      if (!options.incomingAudioInputPath) {
        assert.equal(incomingAudio.sampleRate, 44_100, "the generated incoming fixture is encoded at 44.1 kHz");
        assert.equal(incomingAudio.channels, 2);
      }
      incomingOriginalChecksum = await checksumFile(incomingInputPath);
      const incomingIntake = await addTrack({
        ownerId,
        filePath: incomingInputPath,
        filename: options.incomingAudioInputPath
          ? basename(incomingInputPath)
          : "Fixture - Library retry transition incoming.mp3",
        mimeType: "audio/mpeg",
        device: "cpu",
      });
      incomingTrack = incomingIntake.track;
      incomingJobId = incomingTrack.stemAvailability.retryJobId ?? null;
      incomingSourceId = incomingTrack.sourceAssetId ?? null;
      assert.equal(incomingIntake.separationQueued, false);
      assert.equal(incomingTrack.stemAvailability.status, "rejected");
      assert.ok(incomingJobId, "the incoming track has a real rejected job to retry");
      assert.ok(incomingSourceId, "the incoming track has its own persisted source");
      assert.notEqual(incomingSourceId, intake.track.sourceAssetId, "the two transition tracks use distinct source assets");
      assert.notEqual(await checksumFile(incomingInputPath), originalChecksum, "the incoming MP3 differs from the outgoing fixture");
      const [incomingSource] = await database.select().from(sourceAssets)
        .where(eq(sourceAssets.id, incomingSourceId)).limit(1);
      assert.ok(incomingSource);
      assert.equal(incomingSource.codec, incomingAudio.codec);
      assert.equal(incomingSource.sampleRate, incomingAudio.sampleRate,
        "the incoming source record preserves its actual input sample rate");
      assert.equal(incomingSource.channels, incomingAudio.channels,
        "the incoming source record preserves its actual input channel count");
      incomingJobIdsBefore = (await database.select().from(processingJobs)
        .where(eq(processingJobs.sourceAssetId, incomingSourceId))).map(job => job.id);
    }
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
    const retryJobIds = new Set([jobId, ...(incomingJobId ? [incomingJobId] : [])]);
    browser = await chromium.launch({
      executablePath: "/repl/tools/bin/chromium", headless: true,
      args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"],
    });
    const context = await browser.newContext({ serviceWorkers: "block" });
    await installLiveAudioProbe(context);
    let retryRequests = 0;
    let observedSessionId: string | null = null;
    const servedAudioAssets = new Set<string>();
    await context.route("**/api/**", async (route: BrowserRoute) => {
      const request = route.request();
      const url = new URL(request.url());
      const sessionPath = url.pathname.match(/^\/api\/library\/sessions\/([^/]+)(?:\/(state|tracks)(?:\/([^/]+))?)?$/);
      if (sessionPath !== null) observedSessionId = sessionPath[1];
      const assetPath = url.pathname.match(/^\/api\/assets\/([^/]+)$/);
      const retryJobPath = url.pathname.match(/^\/api\/jobs\/([^/]+)\/retry$/);
      let response: Response | undefined;
      if (libraryReads.has(url.pathname) && request.method() === "GET") {
        response = await libraryReads.get(url.pathname)(new Request(url));
      } else if (retryJobPath && retryJobIds.has(retryJobPath[1]) && request.method() === "POST") {
        retryRequests++;
        response = await retryRoute.POST(new Request(url, { method: "POST" }), {
          params: Promise.resolve({ id: retryJobPath[1] }),
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
    const incomingCard = incomingTrack === null ? null : page.getByTestId("library-track").filter({
      has: page.getByTestId(`button-play-${incomingTrack.id}`),
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
    const expectedPasses = (fourStem ? FOUR_STEM_MODELS : [model]).map(spec => spec.id);
    assert.deepEqual(completedPasses, expectedPasses,
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
    let incomingStems: typeof stems = [];
    if (fourStem && incomingTrack !== null && incomingJobId !== null && incomingSourceId !== null && incomingCard !== null) {
      const [incomingRetried] = await Promise.all([
        page.waitForResponse((response: { url(): string; request(): { method(): string } }) =>
          response.url().endsWith(`/api/jobs/${incomingJobId}/retry`) && response.request().method() === "POST"),
        incomingCard.getByRole("button", {
          name: `Retry separation for ${incomingTrack.title}`,
          exact: true,
        }).click({ timeout: 10_000 }),
      ]);
      assert.equal(incomingRetried.status(), 200, "the incoming track uses the real retry route too");
      assert.equal(await activeBroker.drain(workerTimeout), true, "the second pinned CPU separation completes");
      const [incomingCompleted] = await database.select().from(processingJobs)
        .where(eq(processingJobs.id, incomingJobId));
      assert.equal(incomingCompleted.status, "complete", incomingCompleted.errorMessage ?? "incoming job completes");
      assert.equal(incomingCompleted.errorCode, null);
      assert.equal(incomingCompleted.resolvedDevice, "cpu");
      assert.deepEqual(completedPasses, [...expectedPasses, ...expectedPasses],
        "both tracks pass through the same four pinned CPU models");
      const incomingTransitions = await client.query<{ status: string }>(
        "SELECT status FROM retry_acceptance_transitions WHERE job_id = $1", [incomingJobId],
      );
      for (const status of ["queued", "processing", "complete"]) {
        assert.ok(incomingTransitions.rows.some(row => row.status === status),
          `incoming job durably enters ${status}`);
      }
      const incomingJobsAfter = await database.select().from(processingJobs)
        .where(eq(processingJobs.sourceAssetId, incomingSourceId));
      assert.deepEqual(incomingJobsAfter.map(job => job.id).sort(), incomingJobIdsBefore.sort(),
        "retry adds no duplicate job for the incoming source");
      incomingStems = await database.select().from(stemAssets)
        .where(eq(stemAssets.separationJobId, incomingJobId));
      assert.equal(incomingStems.length, 4);
      assert.deepEqual(incomingStems.map(stem => stem.stemType).sort(), ["bass", "drums", "other", "vocals"]);
      for (const stem of incomingStems) {
        const spec = FOUR_STEM_MODELS.find(item => item.id === stem.model);
        assert.ok(spec);
        assert.equal(stem.modelVersion, spec.sha256);
        const filename = getStorage().getLocalPath(stem.storageKey);
        assert.ok(filename && existsSync(filename), "every incoming output is in private storage");
        const { readFile } = await import("node:fs/promises");
        const decoded = decodeWav16(new Uint8Array(await readFile(filename)));
        assert.ok(decoded && decoded.frames > 0 && decoded.sampleRate === 44_100);
      }
    }
    assert.equal(activeBroker.stats().succeeded, fourStem ? 2 : 1,
      "the broker executes one retry per distinct track");
    assert.equal(retryRequests, fourStem ? 2 : 1,
      "the real library submits one retry per distinct track");
    // The existing processing poll must discover real completed state, not a
    // test-supplied success response or a forced page reload.
    await card.getByText(`${stems.length} STEMS`, { exact: true }).waitFor({ timeout: 30_000 });
    assert.equal(await card.getByRole("button", { name: /^Retry separation for/ }).count(), 0);
    if (fourStem) {
      await incomingCard!.getByText(`${incomingStems.length} STEMS`, { exact: true }).waitFor({ timeout: 30_000 });
      assert.equal(await incomingCard!.getByRole("button", { name: /^Retry separation for/ }).count(), 0);
      await card.getByTestId(`button-play-${intake.track.id}`).click();
      const expectedAssets = stems.map(stem => stem.id);
      await page.waitForFunction((ids: string[]) => {
        const audio = [...document.querySelectorAll<HTMLAudioElement>('[data-role="current"] audio')];
        return audio.length === 4 && audio.every(item => item.readyState >= 2)
          && ids.every(id => audio.some(item => {
            const logicalUrl = item.dataset.waveyardAssetUrl;
            return logicalUrl !== undefined
              && new URL(logicalUrl, location.href).pathname.split("/").at(-1) === id;
          }));
      }, expectedAssets, { timeout: 30_000 });
      const play = page.getByTestId("session-play");
      const loaded = await readLiveAudioState(page);
      assert.deepEqual(loaded.map(item => item.assetId).sort(), expectedAssets.sort(),
        "live playback uses the four persisted model outputs, never a passthrough/full-source substitute");
      assert.ok(expectedAssets.every(id => servedAudioAssets.has(id)),
        "every real stem was read through the production private asset route");
      await page.waitForFunction(
        `() => {
          const audio = Array.from(document.querySelectorAll('[data-role="current"] audio'));
          return audio.length === 4 && audio.every(item => !item.paused && item.currentTime > 0.03);
        }`,
        undefined,
        { timeout: 10_000 },
      );
      assert.equal(await play.getAttribute("aria-pressed"), "true",
        "the play control reports active playback for the actual persisted stems");
      await play.click();
      await page.waitForFunction(
        `() => {
          const audio = Array.from(document.querySelectorAll('[data-role="current"] audio'));
          return audio.length === 4 && audio.every(item => item.paused);
        }`,
        undefined,
        { timeout: 5_000 },
      );
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
      const beforePlay = await readLiveAudioState(page);
      assert.ok(beforePlay.every(item => item.paused),
        "stem-isolation checks leave the current track paused before resume");
      assert.equal(await play.getAttribute("aria-pressed"), "false",
        "the play control reports paused state before resume");
      await play.click();
      try {
        await page.waitForFunction(
          `() => {
            const audio = Array.from(document.querySelectorAll('[data-role="current"] audio'));
            return audio.length === 4 && audio.every(item => !item.paused && item.currentTime > 0.03);
          }`,
          undefined,
          { timeout: 5_000 },
        );
      } catch (error) {
        const audioState = await page.locator('[data-role="current"] audio').evaluateAll((elements: HTMLAudioElement[]) =>
          elements.map(audio => ({
            currentTime: audio.currentTime,
            duration: audio.duration,
            paused: audio.paused,
            readyState: audio.readyState,
            networkState: audio.networkState,
            errorCode: audio.error?.code ?? null,
          })),
        ).catch(() => []);
        console.error("Persisted real stems did not start together after the play action", {
          beforePlay,
          audioState,
          playPressed: await play.getAttribute("aria-pressed").catch(() => null),
          playLabel: await play.getAttribute("aria-label").catch(() => null),
          playDisabled: await play.isDisabled().catch(() => null),
          statusMessages: await page.locator('[role="alert"]').allTextContents().catch(() => []),
          pageErrors,
          pageText: (await page.locator("body").innerText().catch(() => "")).slice(-1600),
        });
        throw error;
      }
      await play.click();
      assert.ok((await readLiveAudioState(page)).every(item => item.gain! > 0),
        "restoring all stems keeps every actual stem connected while the outgoing track is paused for preparation");

      const incomingAssets = incomingStems.map(stem => stem.id);
      await page.getByTestId(`button-next-${incomingTrack!.id}`).click();
      // Standby media is normally loaded from a private in-memory Blob URL.
      // Its currentSrc is therefore an ephemeral blob: URL, not the library
      // asset ID. Capture both deck identities and media readiness in the same
      // browser evaluation; separate locator reads can straddle a React deck
      // update and compare different UI states.
      const deckStateAtReady = await page.waitForFunction(
        sampleDeck,
        { outgoingIds: expectedAssets, incomingIds: incomingAssets, requireReady: true },
        { timeout: 30_000 },
      ).then(
        handle => handle.jsonValue() as Promise<DeckAcceptanceSnapshot>,
        () => null,
      );
      const deckStateAtRead = deckStateAtReady ?? await page.waitForFunction(
        sampleDeck,
        { outgoingIds: expectedAssets, incomingIds: incomingAssets, requireReady: false },
        { timeout: 1_000 },
      ).then(handle => handle.jsonValue() as Promise<DeckAcceptanceSnapshot>);
      const deckIdentityReady = deckStateAtReady !== null;
      if (!deckStateAtRead.incomingReady
        || deckStateAtRead.current.length !== expectedAssets.length
        || !expectedAssets.every(id => deckStateAtRead.current.includes(id))
        || deckStateAtRead.next.length !== incomingAssets.length
        || !incomingAssets.every(id => deckStateAtRead.next.includes(id))) {
        assert.ok(observedSessionId, "the real session route was observed for persisted-state diagnostics");
        const allStemRows = await database.select().from(stemAssets);
        const describeStemIds = (ids: string[]) => ids.map(id => {
          const row = allStemRows.find(stem => stem.id === id);
          return row === undefined ? { id, found: false } : {
            id,
            separationJobId: row.separationJobId,
            stemType: row.stemType,
            model: row.model,
          };
        });
        const persistedSession = await page.evaluate(async (sessionId: string) => {
          const response = await fetch(`/api/library/sessions/${sessionId}`, { cache: "no-store" });
          return response.ok ? await response.json() : { status: response.status };
        }, observedSessionId);
        console.error("Persisted Waveyard deck acceptance state did not settle", JSON.stringify({
          expectedOutgoing: expectedAssets,
          expectedIncoming: incomingAssets,
          firstTrackId: intake.track.id,
          secondTrackId: incomingTrack?.id,
          expectedOutgoingRows: describeStemIds(expectedAssets),
          expectedIncomingRows: describeStemIds(incomingAssets),
          actualCurrentRows: describeStemIds(deckStateAtRead.current),
          actualNextRows: describeStemIds(deckStateAtRead.next),
          deckStateAtRead,
          deckIdentityReady,
          persistedTracks: persistedSession?.session?.tracks?.map((item: any) => ({
            id: item.id,
            trackId: item.track?.id,
            title: item.track?.title,
            stemIds: item.stems?.map((stem: any) => stem.id) ?? [],
          })) ?? [],
          pageErrors,
          statusMessages: await page.locator('[role="alert"]').allTextContents().catch(() => []),
        }));
      }
      assert.deepEqual(
        deckStateAtRead.current.sort(),
        [...expectedAssets].sort(),
        "the outgoing deck contains only the first track's real separated assets",
      );
      assert.equal(deckStateAtRead.incomingReady, true,
        "every incoming stem has decodable media before the transition");
      assert.deepEqual(
        deckStateAtRead.next.sort(),
        [...incomingAssets].sort(),
        "the incoming deck contains only the second track's real separated assets",
      );
      assert.ok(incomingAssets.every(id => servedAudioAssets.has(id)),
        "all incoming stems were loaded through the private asset route");

      const fadeLength = page.locator("#sess-fade");
      await fadeLength.press("Home");
      await fadeLength.press("ArrowRight");
      await page.waitForFunction(() =>
        (document.querySelector<HTMLInputElement>("#sess-fade")?.value ?? "") === "0.5",
      );
      await page.getByTestId("session-transition").click();
      await page.waitForFunction(() => {
        const outgoing = [...document.querySelectorAll<HTMLAudioElement>('[data-role="current"] audio')];
        const incoming = [...document.querySelectorAll<HTMLAudioElement>('[data-role="next"] audio')];
        return outgoing.length === 4 && incoming.length === 4
          && outgoing.every(audio => !audio.paused)
          && incoming.every(audio => !audio.paused && audio.currentTime > 0.03);
      }, undefined, { timeout: 5_000 });
      await page.waitForFunction((ids: string[]) => {
        const current = [...document.querySelectorAll<HTMLAudioElement>('[data-role="current"] audio')];
        const actual = current.map(audio => {
          const logicalUrl = audio.dataset.waveyardAssetUrl;
          return logicalUrl ? new URL(logicalUrl, location.href).pathname.split("/").at(-1) : null;
        });
        return current.length === 4 && ids.every(id => actual.includes(id))
          && current.every(audio => !audio.paused && audio.currentTime > 0.03);
      }, incomingAssets, { timeout: 5_000 });
      assert.equal(await page.locator(".wy-now b").innerText(), incomingTrack!.title,
        "the session advances its current title with the incoming real stems");

      const incomingDrums = incomingStems.find(stem => stem.stemType === "drums");
      assert.ok(incomingDrums);
      const isolateIncoming = page.getByTestId("quick-isolate-drums");
      await isolateIncoming.click();
      await page.waitForFunction(() =>
        document.querySelector('[data-testid="quick-isolate-drums"]')?.getAttribute("aria-pressed") === "true",
      );
      const incomingMix = await readLiveAudioState(page);
      assert.deepEqual(incomingMix.map(item => item.assetId).sort(), [...incomingAssets].sort(),
        "the incoming current deck still routes the second track's four persisted assets");
      assert.ok(incomingMix.find(item => item.assetId === incomingDrums.id)?.gain! > 0,
        "the isolated incoming drum stem has a real positive gain");
      assert.ok(incomingMix.filter(item => item.assetId !== incomingDrums.id).every(item => item.gain === 0),
        "isolating the incoming stem mutes only the other incoming stem routes");
      assert.ok(incomingMix.every(item => !item.paused && item.currentTime > 0),
        "the incoming separated track continues playing while isolated");
      await isolateIncoming.click();
      assert.ok((await readLiveAudioState(page)).every(item => item.gain! > 0),
        "restoring the incoming track reconnects all four real stem routes");
    }
    assert.deepEqual(pageErrors, [], "the completed library view has no browser exceptions");
    assert.equal(await checksumFile(inputPath), originalChecksum, "the input audio remains unchanged");
    if (incomingInputPath !== null && incomingOriginalChecksum !== null) {
      assert.equal(await checksumFile(incomingInputPath), incomingOriginalChecksum, "the incoming source remains unchanged");
    }
    return {
      jobId,
      incomingJobId,
      device: completed.resolvedDevice,
      elapsedMs: Date.now() - started,
      stemCount: stems.length,
      incomingStemCount: incomingStems.length,
      inputFormat: fourStem ? "MP3" : "WAV",
      transition: fourStem ? "real stem-set crossfade and incoming isolation" : "not exercised",
    };
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
