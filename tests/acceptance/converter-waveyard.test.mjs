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
import { missionPostgres } from "../helpers/mission-postgres.ts";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const originalHash = "4b431d535d235bd81b62f816f08c3f1afb6679d2706d84b3b75903b7df909507";
const rights = "Slow Motion Dream — Steven M Bryant © 2011 / CSoul / AlexBeroza / Robert Siekawitch. CC BY 3.0 https://creativecommons.org/licenses/by/3.0/ . Publisher: https://github.com/deezer/spleeter/blob/c8854001ac8acad34a9bc2bd15f28475541828b1/README.md#note . Modifications: ten-second excerpt, native FLAC conversion and sequential Studio edit; no endorsement.";
const titles = ["Converted music — first", "Converted music — second"];
const artist = "Steven M Bryant / CSoul / AlexBeroza / Robert Siekawitch";

test("genuine authorised music → reviewed FLAC batch → ZIP → audible session → Studio → independently decoded WAV", {
  timeout: 240000,
}, async t => {
  assert.ok(process.env.ARENA_CONVERSION_REAL_INPUT, "A hash-pinned genuine music input is mandatory; never skip this gate.");
  const original = resolve(process.env.ARENA_CONVERSION_REAL_INPUT);
  assert.equal(sha(await readFile(original)), originalHash);
  const root = await mkdtemp(join(tmpdir(), "arena-converter-waveyard-"));
  const evidence = process.env.ARENA_CONVERTER_FLOW_EVIDENCE_DIR ? resolve(process.env.ARENA_CONVERTER_FLOW_EVIDENCE_DIR) : join(root, "evidence");
  const receipts = join(evidence, "receipts"), media = join(evidence, "media");
  await mkdir(receipts, { recursive: true }); await mkdir(media, { recursive: true });
  let fixture, database, broker, server, browser, page;
  t.after(async () => {
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
  const engine = await import("../../src/lib/waveyard/conversion/engine.ts");
  broker = (await import("../../src/lib/waveyard/worker-local/broker.ts")).getLocalJobBroker();
  broker.register("waveyard-export", (await import("../../src/lib/waveyard/worker-local/export.ts")).handleExportJob);
  const input = join(root, "authorised-ten-second-music.wav");
  await engine.runTool("ffmpeg", ["-v", "error", "-i", original, "-t", "10", "-ar", "44100", "-ac", "2", "-c:a", "pcm_s16le", input]);
  const inputHash = sha(await readFile(input));
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
    const outputs = [], references = [];
    for (const [index, file] of manifest.files.entries()) {
      const filename = join(extracted, file.path), bytes = await readFile(filename), inspection = await engine.inspect(filename);
      assert.equal(bytes.length, file.bytes); assert.equal(sha(bytes), file.outputSha256);
      assert.equal(inspection.tags.title, titles[index]); assert.equal(inspection.tags.artist, artist);
      assert.equal(inspection.tags.album, "Authorised conversion flow"); assert.equal(inspection.tags.track, String(index + 1));
      assert.equal(inspection.tags.lyrics, rights); assert.equal(inspection.sampleRate, 44100); assert.equal(inspection.channels, 2);
      assert.equal(inspection.durationSeconds, 10); assert.equal(inspection.codec, "flac");
      const pcm = join(root, `reference-${index}.f32`);
      await engine.runTool("ffmpeg", ["-v", "error", "-i", filename, "-ar", "44100", "-ac", "2", "-f", "f32le", pcm]);
      const decoded = await readFile(pcm); assert.equal(decoded.length, 441000 * 2 * 4);
      references.push(decoded); outputs.push({ ...file, inspection, decodedPcmSha256: sha(decoded) });
    }
    await page.getByLabel("Conversion session name", { exact: true }).fill("Real converted music — connected workflow");
    await page.getByRole("button", { name: "Add selected full audio to session", exact: true }).click();
    const sessionLink = page.getByRole("link", { name: "Open session → use existing Send to Studio", exact: true });
    await expect(sessionLink).toBeVisible(); const sessionPath = await sessionLink.getAttribute("href");
    const sessionBefore = await (await page.request.get(`${origin}/api/library/sessions/${sessionPath.split("/").at(-1)}`)).json();
    assert.deepEqual(sessionBefore.session.tracks.map(item => item.track.title), titles);
    assert.ok(sessionBefore.session.tracks.every(item => item.stems.length === 1 && item.stems[0].engine === "passthrough-unseparated"));
    await sessionLink.click(); await expect(page.getByTestId("session-stage")).toBeVisible();
    await page.getByTestId("session-play").click();
    await expect.poll(() => page.evaluate(() => window.audioRms())).toBeGreaterThan(0.001);
    const sessionRms = await page.evaluate(() => window.audioRms());
    await expect.poll(() => page.locator("audio").evaluateAll(nodes => Math.max(0, ...nodes.map(node => node.currentTime)))).toBeGreaterThan(0.25);
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
    assert.deepEqual(remix.tracks.map(track => track.clips[0].timelineStartMs), [0, 10000]);
    assert.ok(remix.tracks.every(track => track.clips.length === 1 && track.clips[0].durationMs === 10000));
    page.once("dialog", dialog => dialog.accept("Converted music — verified sequential edit"));
    const versionResponse = page.waitForResponse(response => response.url().endsWith("/versions") && response.request().method() === "POST");
    await page.getByRole("button", { name: "Save version", exact: true }).click();
    const { version } = await (await versionResponse).json();
    await page.getByRole("button", { name: "Export WAV · Converted music — verified sequential edit", exact: true }).click();
    const exportLink = page.getByRole("link", { name: "Download WAV · Converted music — verified sequential edit", exact: true });
    await expect(exportLink).toBeVisible({ timeout: 45000 });
    const wavDownload = page.waitForEvent("download"); await exportLink.click();
    const wav = await wavDownload; assert.equal(await wav.failure(), null);
    const wavPath = join(media, "converted-session-studio.wav"); await wav.saveAs(wavPath);
    const exportInfo = await engine.inspect(wavPath);
    assert.equal(exportInfo.sampleRate, 44100); assert.equal(exportInfo.channels, 2); assert.equal(exportInfo.durationSeconds, 20);
    const exportPcmPath = join(root, "export.f32");
    await engine.runTool("ffmpeg", ["-v", "error", "-i", wavPath, "-ar", "44100", "-ac", "2", "-f", "f32le", exportPcmPath]);
    const actual = await readFile(exportPcmPath), expected = Buffer.concat(references);
    assert.equal(actual.length, expected.length, "Complete twenty-second stereo export, no dropped or extra frames.");
    let maximumError = 0;
    for (let byte = 0; byte < actual.length; byte += 4) maximumError = Math.max(maximumError, Math.abs(actual.readFloatLE(byte) - expected.readFloatLE(byte)));
    assert.ok(maximumError < 4 / 32768, `Every decoded export sample must match the ordered converted audio within four 16-bit LSBs (export dither); maximum error ${maximumError}`);
    assert.equal(sha(await readFile(original)), originalHash); assert.equal(sha(await readFile(input)), inputHash);
    assert.deepEqual(routeErrors, []); assert.deepEqual(browserErrors, []);
    assert.ok(assetResponses.some(response => response.status === 200 || response.status === 206));
    await page.reload(); await page.getByTestId("waveyard-mode-studio").click();
    await expect(page.getByRole("link", { name: "Download WAV · Converted music — verified sequential edit", exact: true })).toBeVisible();
    await copyFile(input, join(media, "authorised-ten-second-music.wav"));
    await page.screenshot({ path: join(receipts, "studio-completed-export.png"), fullPage: true });
    const receipt = {
      scope: "Production ConversionWorkbench, SessionExperience and StudioCore components; real HTTP handlers, PostgreSQL, native FFmpeg conversion/export, browser media/Web Audio and actual downloaded files. Isolated component host, not a complete Next.js/Electron launch. No inference, DRM removal, subjective listening or production deployment claim.",
      originalSha256: originalHash, excerptSha256: inputHash, rights, outputs, sessionId: sessionBefore.session.id,
      sessionRms, handoff, versionId: version.id, zipSha256: sha(await readFile(zipPath)),
      export: { sha256: sha(await readFile(wavPath)), inspection: exportInfo, frames: actual.length / 8, decodedPcmSha256: sha(actual), referencePcmSha256: sha(expected), maximumError, tolerance: 4 / 32768 },
      originalAndExcerptUnchanged: true, routeErrors, browserErrors, assetResponses,
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
