import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { expect } from "@playwright/test";
import { eq } from "drizzle-orm";
import { missionPostgres } from "../helpers/mission-postgres.ts";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const originalHash = "4b431d535d235bd81b62f816f08c3f1afb6679d2706d84b3b75903b7df909507";
const rights = "Slow Motion Dream — Steven M Bryant © 2011 / CSoul / AlexBeroza / Robert Siekawitch. CC BY 3.0 https://creativecommons.org/licenses/by/3.0/ . Publisher: https://github.com/deezer/spleeter/blob/c8854001ac8acad34a9bc2bd15f28475541828b1/README.md#note . Modifications: native FLAC conversion and sequential Studio edit; no endorsement.";
const titles = ["Converted music — first", "Converted music — second"];
const artist = "Steven M Bryant / CSoul / AlexBeroza / Robert Siekawitch";

test("full authorised recording → FLAC batch → ZIP → TrackPlayer → reopened session → Studio → independently decoded WAV", {
  timeout: 240000,
}, async t => {
  assert.ok(process.env.ARENA_CONVERSION_REAL_INPUT, "A hash-pinned genuine music input is mandatory; never skip this gate.");
  const original = resolve(process.env.ARENA_CONVERSION_REAL_INPUT);
  assert.equal(sha(await readFile(original)), originalHash);
  assert.equal((await readFile(original)).length, 262867);
  const root = await mkdtemp(join(tmpdir(), "arena-converter-waveyard-"));
  const evidence = process.env.ARENA_CONVERTER_FLOW_EVIDENCE_DIR ? resolve(process.env.ARENA_CONVERTER_FLOW_EVIDENCE_DIR) : join(root, "evidence");
  const receipts = join(evidence, "receipts"), media = join(evidence, "media");
  await mkdir(receipts, { recursive: true }); await mkdir(media, { recursive: true });
  let fixture, database, broker, server, browser, page;
  t.after(async () => {
    if (page) await page.context().tracing.stop({ path: join(media, "browser-trace.zip") }).catch(() => {});
    await browser?.close();
    if (server) await new Promise(resolve => server.close(resolve));
    await broker?.drain(30000); await database?.pool.end(); await fixture?.close();
    await rm(root, { recursive: true, force: true });
  });
  fixture = await missionPostgres();
  process.env.DATABASE_URL = fixture.url;
  process.env.WAVEYARD_STORAGE_DIR = join(root, "private");
  process.env.WAVEYARD_LOCAL_WORKER = "1"; delete process.env.REDIS_URL;
  database = await import("../../src/db/index.ts");
  const schema = await import("../../src/db/waveyardSchema.ts");
  const storage = (await import("../../src/lib/waveyard/storage.ts")).getStorage();
  const engine = await import("../../src/lib/waveyard/conversion/engine.ts");
  broker = (await import("../../src/lib/waveyard/worker-local/broker.ts")).getLocalJobBroker();
  broker.register("waveyard-export", (await import("../../src/lib/waveyard/worker-local/export.ts")).handleExportJob);
  const input = original;
  const routes = [];
  async function register(pattern, names, module) {
    routes.push({ pattern, names, handlers: await import(`../../src/app/api/${module}/route.ts`) });
  }
  await register(/^\/api\/library\/conversions\/archive$/, [], "library/conversions/archive");
  await register(/^\/api\/library\/conversions$/, [], "library/conversions");
  await register(/^\/api\/library\/playlist-imports$/, [], "library/playlist-imports");
  await register(/^\/api\/library\/tunepat$/, [], "library/tunepat");
  await register(/^\/api\/library\/tracks$/, [], "library/tracks");
  await register(/^\/api\/library\/tracks\/([^/]+)$/, ["id"], "library/tracks/[id]");
  await register(/^\/api\/library\/tracks\/([^/]+)\/separation$/, ["id"], "library/tracks/[id]/separation");
  await register(/^\/api\/library\/tracks\/([^/]+)\/played$/, ["id"], "library/tracks/[id]/played");
  for (const part of ["playlists", "queue", "playback-state"]) await register(new RegExp(`^/api/library/${part}$`), [], `library/${part}`);
  await register(/^\/api\/waveyard\/processing-status$/, [], "waveyard/processing-status");
  await register(/^\/api\/waveyard\/separation\/models$/, [], "waveyard/separation/models");
  await register(/^\/api\/waveyard\/separation\/deep\/prepare$/, [], "waveyard/separation/deep/prepare");
  await register(/^\/api\/stems\/passthrough$/, [], "stems/passthrough");
  await register(/^\/api\/library\/sessions$/, [], "library/sessions");
  await register(/^\/api\/library\/sessions\/([^/]+)$/, ["id"], "library/sessions/[id]");
  for (const part of ["tracks", "state", "swaps", "studio-handoff"]) {
    await register(new RegExp(`^/api/library/sessions/([^/]+)/${part}$`), ["id"], `library/sessions/[id]/${part}`);
  }
  await register(/^\/api\/library\/sessions\/([^/]+)\/tracks\/([^/]+)$/, ["id", "itemId"], "library/sessions/[id]/tracks/[itemId]");
  await register(/^\/api\/waveyard\/projects\/([^/]+)$/, ["id"], "waveyard/projects/[id]");
  await register(/^\/api\/waveyard\/projects\/([^/]+)\/remixes$/, ["id"], "waveyard/projects/[id]/remixes");
  await register(/^\/api\/waveyard\/projects\/([^/]+)\/master$/, ["id"], "waveyard/projects/[id]/master");
  await register(/^\/api\/assets\/([^/]+)\/waveform$/, ["id"], "assets/[id]/waveform");
  await register(/^\/api\/assets\/([^/]+)$/, ["id"], "assets/[id]");
  await register(/^\/api\/remixes\/([^/]+)$/, ["id"], "remixes/[id]");
  await register(/^\/api\/remixes\/([^/]+)\/versions$/, ["id"], "remixes/[id]/versions");
  await register(/^\/api\/remix-versions\/([^/]+)\/exports$/, ["id"], "remix-versions/[id]/exports");
  await register(/^\/api\/exports\/([^/]+)\/media$/, ["id"], "exports/[id]/media");
  await register(/^\/api\/exports\/([^/]+)\/retry$/, ["id"], "exports/[id]/retry");
  const bundle = await build({ entryPoints: ["tests/acceptance/converter-waveyard.fixture.tsx"], bundle: true, write: false, platform: "browser", format: "esm", jsx: "automatic", define: { "process.env": JSON.stringify({ NODE_ENV: "development" }) } });
  const worker = await build({ entryPoints: ["src/lib/waveyard/arrangement-pcm.worker.ts"], bundle: true, write: false, platform: "browser", format: "iife" });
  const routeErrors = [], browserErrors = [], assetResponses = [];
  server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://127.0.0.1:${server.address().port}`);
      if (url.pathname === "/fixture.js" || url.pathname.endsWith("/arrangement-pcm.worker.ts")) {
        res.setHeader("content-type", "text/javascript");
        return res.end(url.pathname === "/fixture.js" ? bundle.outputFiles[0].contents : worker.outputFiles[0].contents);
      }
      if (!url.pathname.startsWith("/api/")) {
        res.setHeader("content-type", "text/html");
        return res.end('<!doctype html><div id="root"></div><script type="module" src="/fixture.js"></script>');
      }
      const route = routes.find(route => route.pattern.test(url.pathname));
      assert.ok(route, `No real route registered for ${url.pathname}`);
      const match = url.pathname.match(route.pattern), chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const request = new Request(url, { method: req.method, headers: { ...req.headers, host: "localhost" }, ...(!["GET", "HEAD"].includes(req.method) ? { body: Buffer.concat(chunks) } : {}) });
      const response = await route.handlers[req.method](request, { params: Promise.resolve(Object.fromEntries(route.names.map((name, index) => [name, match[index + 1]]))) });
      if (response.status >= 400) routeErrors.push({ path: url.pathname, status: response.status, error: await response.clone().text() });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) for await (const chunk of response.body) {
        if (!res.write(chunk)) await new Promise(resolve => res.once("drain", resolve));
      }
      res.end();
    } catch (error) {
      routeErrors.push({ path: req.url, error: String(error) });
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(error) }));
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined, args: ["--no-sandbox", "--disable-dev-shm-usage", "--autoplay-policy=no-user-gesture-required"] });
  page = await browser.newPage(); page.setDefaultTimeout(20000);
  await page.context().tracing.start({ screenshots: true, snapshots: true, sources: true });
  page.on("pageerror", error => browserErrors.push(error.message));
  page.on("response", response => { if (/\/api\/assets\/[^/]+$/.test(new URL(response.url()).pathname)) assetResponses.push({ url: new URL(response.url()).pathname, status: response.status() }); });
  await page.addInitScript(() => {
    window.observedAudio = [];
    const Native = window.AudioContext;
    window.AudioContext = class extends Native {
      constructor(...args) {
        super(...args);
        const analysers = [], create = this.createAnalyser.bind(this);
        this.createAnalyser = () => { const node = create(); analysers.push(node); return node; };
        window.observedAudio.push({ context: this, analysers });
      }
    };
    window.audioRms = () => Math.max(0, ...window.observedAudio.flatMap(({ context, analysers }) =>
      context.state === "running" ? analysers.map(node => {
        const pcm = new Float32Array(node.fftSize); node.getFloatTimeDomainData(pcm);
        return Math.sqrt(pcm.reduce((sum, sample) => sum + sample * sample, 0) / pcm.length);
      }) : []));
  });
  try {
    await page.goto(origin);
    const historyResponse = page.waitForResponse(response => response.url() === `${origin}/api/library/conversions` && response.request().method() === "GET");
    await page.getByRole("button", { name: "Import, review & convert music", exact: true }).click();
    assert.equal((await historyResponse).status(), 200);
    for (const index of [0, 1]) {
      await page.getByLabel("Conversion files", { exact: true }).setInputFiles(input);
      await expect(page.getByLabel(`Item ${index + 1} title`, { exact: true })).toBeVisible({ timeout: 30000 });
      for (const [field, value] of Object.entries({ title: titles[index], artist, album: "Authorised conversion flow", track: String(index + 1), lyrics: rights })) {
        await page.getByLabel(`Item ${index + 1} ${field}`, { exact: true }).fill(value);
      }
    }
    await page.getByLabel("Conversion format", { exact: true }).selectOption("flac");
    await page.getByLabel("Conversion PCM bits", { exact: true }).selectOption("16");
    await page.getByLabel("Conversion sample rate", { exact: true }).selectOption("44100");
    await page.getByLabel("Conversion channels", { exact: true }).selectOption("2");
    await page.getByRole("button", { name: "Convert reviewed batch", exact: true }).click();
    for (const title of titles) await expect(page.getByRole("article").filter({ hasText: title })).toContainText("Completed", { timeout: 45000 });
    for (const title of titles) await page.getByRole("article").filter({ hasText: title }).getByRole("checkbox").check();
    const zipDownload = page.waitForEvent("download");
    await page.getByRole("link", { name: "Download selected verified files (ZIP)", exact: true }).click();
    const zip = await zipDownload; assert.equal(await zip.failure(), null);
    const zipPath = join(media, "converted-music.zip"); await zip.saveAs(zipPath);
    const extracted = join(root, "extracted"); await mkdir(extracted);
    const names = JSON.parse(execFileSync("python3", ["-c", "import json,pathlib,sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); root=pathlib.Path(sys.argv[2]).resolve(); assert z.testzip() is None; assert all((root/n).resolve().is_relative_to(root) for n in z.namelist()); print(json.dumps(z.namelist())); z.extractall(root)", zipPath, extracted], { encoding: "utf8" }));
    const manifest = JSON.parse(await readFile(join(extracted, "conversion-manifest.json"), "utf8"));
    assert.equal(manifest.files.length, 2);
    assert.deepEqual(names, [...manifest.files.map(file => file.path), "conversion-manifest.json"]);
    const outputs = [], references = [], published = [], originalAssets = [];
    const historyHttp = await page.request.get(`${origin}/api/library/conversions`);
    assert.equal(historyHttp.status(), 200);
    const history = (await historyHttp.json()).jobs;
    for (const [index, file] of manifest.files.entries()) {
      const filename = join(extracted, file.path), bytes = await readFile(filename), inspection = await engine.inspect(filename);
      const job = history.find(job => job.id === file.conversionId);
      assert.ok(job); assert.equal(job.status, "complete"); assert.equal(job.verification.fullyDecoded, true);
      assert.equal(job.sourceChecksum, originalHash); assert.equal(file.sourceSha256, originalHash);
      assert.equal(job.name, file.path); assert.ok(file.path.includes("/"));
      assert.equal(job.settings.format, "flac"); assert.equal(job.settings.pcmBits, 16);
      assert.equal(job.settings.sampleRate, 44100); assert.equal(job.settings.channels, 2);
      assert.equal(job.verification.checksumSha256, file.outputSha256); assert.equal(job.verification.fileSizeBytes, file.bytes);
      assert.equal(job.outputTrackId, file.outputTrackId);
      assert.ok(file.fullyDecoded);
      const [row] = await database.db.select().from(schema.processingJobs).where(eq(schema.processingJobs.id, job.id));
      const metadata = JSON.parse(row.metadata);
      const [outputSource] = await database.db.select().from(schema.sourceAssets).where(eq(schema.sourceAssets.id, job.outputSourceId));
      const [source] = await database.db.select().from(schema.sourceAssets).where(eq(schema.sourceAssets.id, row.sourceAssetId));
      assert.equal(outputSource.checksumSha256, file.outputSha256); assert.equal(source.checksumSha256, originalHash);
      assert.equal(metadata.outputTrackId, job.outputTrackId); assert.equal(metadata.outputSourceId, job.outputSourceId);
      assert.notEqual(job.outputTrackId, metadata.trackId); assert.notEqual(outputSource.id, source.id);
      assert.equal(sha(await readFile(storage.getLocalPath(outputSource.storageKey))), file.outputSha256);
      published.push({ path: storage.getLocalPath(outputSource.storageKey), sha256: file.outputSha256 });
      originalAssets.push(storage.getLocalPath(source.storageKey));
      assert.equal(bytes.length, file.bytes); assert.equal(sha(bytes), file.outputSha256);
      assert.equal(inspection.tags.title, titles[index]); assert.equal(inspection.tags.artist, artist);
      assert.equal(inspection.tags.album, "Authorised conversion flow"); assert.equal(inspection.tags.track, String(index + 1));
      assert.equal(inspection.tags.lyrics, rights); assert.equal(inspection.sampleRate, 44100); assert.equal(inspection.channels, 2);
      assert.ok(inspection.durationSeconds > 10); assert.equal(inspection.codec, "flac");
      const pcm = join(root, `reference-${index}.f32`);
      await engine.runTool("ffmpeg", ["-v", "error", "-i", filename, "-ar", "44100", "-ac", "2", "-f", "f32le", pcm]);
      const decoded = await readFile(pcm);
      assert.ok(Math.abs(decoded.length / 8 / 44100 - inspection.durationSeconds) < 1 / 44100);
      references.push(decoded); outputs.push({
        ...file, inspection, decodedFrames: decoded.length / 8, decodedPcmSha256: sha(decoded),
        outputSourceId: job.outputSourceId, originalSourceAssetId: source.id,
        originalTrackId: metadata.trackId, settings: job.settings, verification: job.verification,
      });
    }
    // Exercise the real player before the explicit unseparated session bridge.
    const playerAssetStart = assetResponses.length;
    await page.getByRole("article").filter({ hasText: titles[0] }).getByRole("link", { name: "Open in library", exact: true }).click();
    await expect(page.getByTestId("track-player")).toBeVisible();
    assert.equal(new URL(page.url()).pathname, `/waveyard/play/${outputs[0].outputTrackId}`);
    const playerHttp = await page.request.get(`${origin}/api/library/tracks/${outputs[0].outputTrackId}`);
    assert.equal(playerHttp.status(), 200); const playerTrack = (await playerHttp.json()).track;
    assert.equal(playerTrack.id, outputs[0].outputTrackId); assert.equal(playerTrack.source.id, outputs[0].outputSourceId);
    await page.locator(".wplayer-play").click();
    await expect.poll(() => page.evaluate(() => window.audioRms())).toBeGreaterThan(0.001);
    const playerRms = await page.evaluate(() => window.audioRms());
    await expect.poll(() => page.locator("audio").evaluateAll(nodes => Math.max(0, ...nodes.map(node => node.currentTime)))).toBeGreaterThan(0.25);
    await page.locator(".wplayer-play").click();
    assert.ok(assetResponses.slice(playerAssetStart).some(response => response.url === `/api/assets/${outputs[0].outputSourceId}` && [200, 206].includes(response.status)));
    await page.goto(origin);
    const restoredHistory = page.waitForResponse(response => response.url() === `${origin}/api/library/conversions` && response.request().method() === "GET");
    await page.getByRole("button", { name: "Import, review & convert music", exact: true }).click();
    assert.equal((await restoredHistory).status(), 200);
    for (const title of titles) await page.getByRole("article").filter({ hasText: title }).getByRole("checkbox").check();
    await page.getByLabel("Conversion session name", { exact: true }).fill("Real converted music — connected workflow");
    await page.getByRole("button", { name: "Add selected full audio to session", exact: true }).click();
    const sessionLink = page.getByRole("link", { name: "Open session → use existing Send to Studio", exact: true });
    await expect(sessionLink).toBeVisible(); const sessionPath = await sessionLink.getAttribute("href");
    const sessionBefore = await (await page.request.get(`${origin}/api/library/sessions/${sessionPath.split("/").at(-1)}`)).json();
    assert.deepEqual(sessionBefore.session.tracks.map(item => item.track.title), titles);
    assert.deepEqual(sessionBefore.session.tracks.map(item => item.track.id), outputs.map(output => output.outputTrackId));
    assert.ok(sessionBefore.session.tracks.every(item => item.stems.length === 1 && item.stems[0].engine === "passthrough-unseparated"));
    for (const [index, item] of sessionBefore.session.tracks.entries()) {
      const [stem] = await database.db.select().from(schema.stemAssets).where(eq(schema.stemAssets.id, item.stems[0].id));
      assert.equal(stem.sourceAssetId, outputs[index].outputSourceId);
      assert.equal(stem.checksumSha256, outputs[index].outputSha256);
      assert.equal(item.track.durationSeconds, outputs[index].inspection.durationSeconds);
    }
    await sessionLink.click(); await expect(page.getByTestId("session-stage")).toBeVisible();
    await page.getByTestId("session-play").click();
    await expect.poll(() => page.evaluate(() => window.audioRms())).toBeGreaterThan(0.001);
    const sessionRms = await page.evaluate(() => window.audioRms());
    await expect.poll(() => page.locator("audio").evaluateAll(nodes => Math.max(0, ...nodes.map(node => node.currentTime)))).toBeGreaterThan(0.25);
    await page.getByTestId("session-play").click();
    await page.reload(); await expect(page.getByTestId("session-stage")).toBeVisible();
    const reopenedHttp = await page.request.get(`${origin}/api/library/sessions/${sessionBefore.session.id}`);
    assert.equal(reopenedHttp.status(), 200); const reopenedSession = (await reopenedHttp.json()).session;
    assert.deepEqual(reopenedSession.tracks.map(item => ({ id: item.id, trackId: item.track.id, stems: item.stems.map(stem => stem.id) })),
      sessionBefore.session.tracks.map(item => ({ id: item.id, trackId: item.track.id, stems: item.stems.map(stem => stem.id) })));
    await page.getByTestId("session-play").click();
    await expect.poll(() => page.evaluate(() => window.audioRms())).toBeGreaterThan(0.001);
    const reopenedSessionRms = await page.evaluate(() => window.audioRms());
    await expect.poll(() => page.locator("audio").evaluateAll(nodes => Math.max(0, ...nodes.map(node => node.currentTime)))).toBeGreaterThan(0.5);
    await page.getByTestId("session-play").click();
    await page.getByRole("button", { name: "Send to Studio", exact: true }).click();
    const handoffResponse = page.waitForResponse(response => response.url().endsWith("/studio-handoff") && response.request().method() === "POST");
    await page.getByRole("button", { name: "Create sequential Studio edit", exact: true }).click();
    const handoffHttp = await handoffResponse; assert.equal(handoffHttp.status(), 201);
    const { handoff } = await handoffHttp.json();
    await page.getByRole("link", { name: "Open it in the Studio", exact: true }).click();
    await page.getByTestId("waveyard-mode-studio").click();
    await expect(page.getByRole("button", { name: "Save version", exact: true })).toBeEnabled();
    const remixHttp = await page.request.get(`${origin}/api/remixes/${handoff.remixSessionId}`);
    assert.equal(remixHttp.status(), 200); const remix = await remixHttp.json();
    assert.equal(remix.tracks.length, 2);
    const clipDurationsMs = outputs.map(output => Math.floor(output.inspection.durationSeconds * 1000));
    assert.deepEqual(remix.tracks.map(track => track.clips[0].timelineStartMs), [0, clipDurationsMs[0]]);
    assert.equal(remix.remix.masterVolume, 1);
    for (const [index, track] of remix.tracks.entries()) {
      assert.equal(track.clips.length, 1); assert.equal(track.clips[0].durationMs, clipDurationsMs[index]);
      assert.equal(track.clips[0].sourceOffsetMs, 0); assert.equal(track.clips[0].gain, 1);
      assert.equal(track.volume, 1); assert.equal(track.pan, 0);
      assert.equal(track.stemAssetId, sessionBefore.session.tracks[index].stems[0].id);
    }
    page.once("dialog", dialog => dialog.accept("Converted music — verified sequential edit"));
    const versionResponse = page.waitForResponse(response => response.url().endsWith("/versions") && response.request().method() === "POST");
    await page.getByRole("button", { name: "Save version", exact: true }).click();
    const { version } = await (await versionResponse).json();
    await page.getByRole("button", { name: "Export WAV · Converted music — verified sequential edit", exact: true }).click();
    const exportLink = page.getByRole("link", { name: "Download WAV · Converted music — verified sequential edit", exact: true });
    await expect(exportLink).toBeVisible({ timeout: 45000 });
    const exportJobId = (await exportLink.getAttribute("href")).match(/\/exports\/([^/]+)\/media/)[1];
    const wavDownload = page.waitForEvent("download"); await exportLink.click();
    const wav = await wavDownload; assert.equal(await wav.failure(), null);
    const wavPath = join(media, "converted-session-studio.wav"); await wav.saveAs(wavPath);
    const exportInfo = await engine.inspect(wavPath);
    assert.equal(exportInfo.sampleRate, 44100); assert.equal(exportInfo.channels, 2);
    const timelineMs = clipDurationsMs.reduce((sum, value) => sum + value, 0);
    assert.ok(Math.abs(exportInfo.durationSeconds - timelineMs / 1000) <= 1 / 44100);
    const exportPcmPath = join(root, "export.f32");
    await engine.runTool("ffmpeg", ["-v", "error", "-i", wavPath, "-ar", "44100", "-ac", "2", "-f", "f32le", exportPcmPath]);
    const actual = await readFile(exportPcmPath), actualFrames = actual.length / 8;
    const idealTimelineFrames = Math.ceil(timelineMs * 44100 / 1000);
    assert.ok(Math.abs(actualFrames - idealTimelineFrames) <= 1, "Only the documented sub-sample FFmpeg timeline endpoint rounding is allowed.");
    const expected = Buffer.alloc(actual.length);
    const rounding = [];
    for (const [index, reference] of references.entries()) {
      const clip = remix.tracks[index].clips[0];
      const start = Math.trunc(clip.timelineStartMs * 44100 / 1000);
      const frames = Math.round(clip.durationMs * 44100 / 1000);
      const omittedEndpointFrames = reference.length / 8 - frames;
      assert.ok(omittedEndpointFrames >= 0 && omittedEndpointFrames <= 45, "Session's existing whole-millisecond duration floor may omit less than one millisecond, never an arbitrary excerpt.");
      rounding.push({ sourceFrames: reference.length / 8, durationMs: clip.durationMs, timelineStartMs: clip.timelineStartMs, startFrame: start, clipFrames: frames, omittedEndpointFrames });
      // Independent reference, not a call to production mixer/render code:
      // the existing arrangement law is cos/sin equal-power pan, hence -3.01 dB
      // at pan=0. Preserve this explicit mix setting and the full original input.
      for (let frame = 0; frame < frames && start + frame < actualFrames; frame++) {
        for (let channel = 0; channel < 2; channel++) expected.writeFloatLE(
          reference.readFloatLE((frame * 2 + channel) * 4) * Math.SQRT1_2, ((start + frame) * 2 + channel) * 4);
      }
    }
    let maximumError = 0, peak = 0, sumSquares = 0;
    for (let byte = 0; byte < actual.length; byte += 4) {
      const sample = actual.readFloatLE(byte);
      maximumError = Math.max(maximumError, Math.abs(sample - expected.readFloatLE(byte)));
      peak = Math.max(peak, Math.abs(sample)); sumSquares += sample * sample;
    }
    const rms = Math.sqrt(sumSquares / (actual.length / 4));
    console.log(JSON.stringify({ kind: "independent-export-comparison", actualFrames, idealTimelineFrames, rounding, maximumError, peak, rms, arrangementCentrePanGain: Math.SQRT1_2 }));
    assert.ok(peak > 0.01 && rms > 0.001);
    assert.ok(maximumError < 4 / 32768, `Every decoded export sample must match the ordered converted audio and explicit pan law within four 16-bit LSBs (export dither); maximum error ${maximumError}`);
    assert.equal(sha(await readFile(original)), originalHash);
    for (const file of published) assert.equal(sha(await readFile(file.path)), file.sha256);
    for (const file of originalAssets) assert.equal(sha(await readFile(file)), originalHash);
    assert.deepEqual(routeErrors, []); assert.deepEqual(browserErrors, []);
    assert.ok(assetResponses.some(response => response.status === 200 || response.status === 206));
    await page.reload(); await page.getByTestId("waveyard-mode-studio").click();
    await expect(page.getByRole("link", { name: "Download WAV · Converted music — verified sequential edit", exact: true })).toBeVisible();
    await copyFile(original, join(media, "original-authorised-recording.mp3"));
    await page.screenshot({ path: join(receipts, "studio-completed-export.png"), fullPage: true });
    const receipt = {
      scope: "Production ConversionWorkbench, TrackPlayer, SessionExperience and StudioCore; real HTTP handlers, PostgreSQL, native FFmpeg, browser media/Web Audio and downloaded files. Full original uploaded and converted. Isolated component host, not a complete Next.js/Electron launch. No inference, DRM removal, subjective listening or production deployment claim.",
      testedCommit: process.env.GITHUB_SHA ?? null, branch: process.env.GITHUB_REF_NAME ?? null,
      ownerSnapshot: process.env.OWNER_SNAPSHOT ?? null, combinedTree: process.env.TESTED_COMBINED_TREE ?? null,
      originalSha256: originalHash, rights, outputs, sessionId: sessionBefore.session.id,
      player: { trackId: playerTrack.id, sourceAssetId: playerTrack.source.id, rms: playerRms },
      sessionRms, reopenedSessionRms, reopenedSessionIdentityVerified: true, handoff, versionId: version.id, exportJobId,
      zipSha256: sha(await readFile(zipPath)),
      export: { sha256: sha(await readFile(wavPath)), fileSizeBytes: (await readFile(wavPath)).length, inspection: exportInfo, frames: actualFrames, idealTimelineFrames, rounding, peak, rms, centrePanGain: Math.SQRT1_2, decodedPcmSha256: sha(actual), referencePcmSha256: sha(expected), maximumError, tolerance: 4 / 32768 },
      originalAndPublishedOutputsUnchanged: true, routeErrors, browserErrors, assetResponses,
      runtime: { node: process.version, chromium: browser.version() },
    };
    await writeFile(join(receipts, "receipt.json"), JSON.stringify(receipt, null, 2));
    await writeFile(join(receipts, "RIGHTS.txt"), rights);
    console.log(JSON.stringify({ kind: "converter-waveyard-connected-acceptance", ...receipt }));
  } catch (error) {
    await page.screenshot({ path: join(receipts, "failure.png"), fullPage: true }).catch(() => {});
    await writeFile(join(receipts, "failure.json"), JSON.stringify({ error: String(error), browserErrors, routeErrors }, null, 2));
    throw error;
  }
});
