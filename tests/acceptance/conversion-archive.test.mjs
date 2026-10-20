import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, copyFile, mkdir, link } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { missionPostgres } from "../helpers/mission-postgres.ts";

const owner = "00000000-0000-4000-8000-000000000001";
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
let fixture, directory, pool, service, engine, jobs, storage, broker, archiveRoute, conversionRoute;
before(async () => {
  fixture = await missionPostgres(); directory = await mkdtemp(join(tmpdir(), "arena-archive-acceptance-"));
  process.env.DATABASE_URL = fixture.url; process.env.WAVEYARD_STORAGE_DIR = join(directory, "private");
  process.env.WAVEYARD_LOCAL_WORKER = "1";
  ({ pool } = await import("../../src/db/index.ts"));
  service = await import("../../src/lib/waveyard/library/service.ts");
  engine = await import("../../src/lib/waveyard/conversion/engine.ts");
  jobs = await import("../../src/lib/waveyard/conversion/jobs.ts");
  storage = (await import("../../src/lib/waveyard/storage.ts")).getStorage();
  broker = (await import("../../src/lib/waveyard/worker-local/broker.ts")).getLocalJobBroker();
  archiveRoute = await import("../../src/app/api/library/conversions/archive/route.ts");
  conversionRoute = await import("../../src/app/api/library/conversions/route.ts");
});
after(async () => { await broker?.drain(30000); await pool?.end(); await fixture?.close(); if (directory) await rm(directory, { recursive: true, force: true }); });
const requestArchive = (ids, host = "localhost") => archiveRoute.GET(new Request(`http://localhost/api/library/conversions/archive?ids=${ids.join(",")}`, { headers: { host } }));

test("batch archive is all-or-nothing for ownership, state, corruption, missing files and unsafe aliases", async () => {
  const input = join(directory, "controlled.wav");
  await engine.runTool("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=514:duration=1", input]);
  const source = await service.addTrackFromAudioFile({ ownerId: owner, filePath: input, filename: "controlled.wav", mimeType: "audio/wav", prepareSeparation: false });
  const batch = await jobs.createBatch(owner, randomUUID(), [1, 2].map(index => ({ trackId: source.track.id, tags: { title: `Controlled ${index}` } })), engine.settingsSchema.parse({ format: "flac" }));
  for (const job of batch) await jobs.enqueue(job);
  assert.equal(await broker.drain(30000), true);
  const ids = batch.map(job => job.id), completed = await jobs.ownedJob(owner, ids[1]), metadata = jobs.metadata(completed);
  const path = storage.getLocalPath(metadata.outputKey), bytes = await readFile(path);
  assert.equal((await requestArchive(ids, "foreign.example")).status, 401);
  assert.equal((await requestArchive([ids[0], ids[0]])).status, 400);
  assert.equal((await requestArchive(Array.from({ length: 101 }, () => randomUUID()))).status, 400);
  assert.equal((await requestArchive([randomUUID()])).status, 422);
  await pool.query("UPDATE processing_jobs SET status='publishing' WHERE id=$1", [ids[1]]);
  assert.equal((await requestArchive(ids)).status, 409, "temporary-file receipts are not completion");
  await pool.query("UPDATE processing_jobs SET status='complete' WHERE id=$1", [ids[1]]);
  await writeFile(path, Buffer.alloc(bytes.length));
  const corrupt = await requestArchive(ids);
  assert.equal(corrupt.status, 422); assert.match(corrupt.headers.get("content-type"), /json/);
  await writeFile(path, bytes);
  await link(path, path + ".alias");
  try { assert.equal((await requestArchive(ids)).status, 422); } finally { await rm(path + ".alias"); }
  await rm(path);
  assert.equal((await requestArchive(ids)).status, 422); await writeFile(path, bytes);
  await pool.query("UPDATE processing_jobs SET metadata=jsonb_set(metadata::jsonb,'{name}','\"../escape.flac\"')::text WHERE id=$1", [ids[1]]);
  assert.equal((await requestArchive(ids)).status, 422);
  await pool.query("UPDATE processing_jobs SET metadata=$2 WHERE id=$1", [ids[1], completed.metadata]);
  await pool.query("UPDATE wy_projects SET owner_id=$2 WHERE id=$1", [completed.projectId, randomUUID()]);
  try { assert.equal((await requestArchive(ids)).status, 422); }
  finally { await pool.query("UPDATE wy_projects SET owner_id=$2 WHERE id=$1", [completed.projectId, owner]); }
  const recovered = await requestArchive(ids);
  assert.equal(recovered.status, 200);
  const zip = Buffer.from(await recovered.arrayBuffer());
  assert.equal(zip.readUInt32LE(), 0x04034b50);
  assert.equal(sha(await readFile(path)), sha(bytes), "download never changes the retained output");
});

test("genuine music browser import → converted batch → ZIP download → independent extraction, metadata and full decode", {
  skip: !process.env.ARENA_CONVERSION_REAL_INPUT, timeout: 180000,
}, async t => {
  const input = resolve(process.env.ARENA_CONVERSION_REAL_INPUT);
  assert.equal(sha(await readFile(input)), "4b431d535d235bd81b62f816f08c3f1afb6679d2706d84b3b75903b7df909507");
  const rights = "Slow Motion Dream — Steven M Bryant © 2011 / CSoul / AlexBeroza / Robert Siekawitch. CC BY 3.0 https://creativecommons.org/licenses/by/3.0/ . Publisher evidence: https://github.com/deezer/spleeter/blob/c8854001ac8acad34a9bc2bd15f28475541828b1/README.md#note . Modifications: native FLAC conversion, packaging; no endorsement. This is genuine music, not inference/separation acceptance.";
  const { build } = await import("esbuild"), { createServer } = await import("node:http");
  const { chromium } = await import("playwright-core"), { expect } = await import("@playwright/test");
  const trackRoute = await import("../../src/app/api/library/tracks/route.ts");
  const bundle = await build({ stdin: { contents: 'import React from "react";import{createRoot}from"react-dom/client";import ConversionWorkbench from"./src/components/waveyard/library/ConversionWorkbench";createRoot(document.getElementById("root")).render(<ConversionWorkbench/>);', loader: "tsx", resolveDir: process.cwd() }, bundle: true, write: false, platform: "browser", format: "esm", jsx: "automatic", define: { "process.env": "{}" } });
  const server = createServer(async (req, res) => {
    try {
      if (req.url === "/fixture.js") { res.setHeader("content-type", "text/javascript"); return res.end(bundle.outputFiles[0].contents); }
      if (req.url.startsWith("/api/")) {
        const body = []; for await (const chunk of req) body.push(chunk);
        const url = new URL(req.url, `http://127.0.0.1:${server.address().port}`);
        const request = new Request(url, { method: req.method, headers: { ...req.headers, host: "localhost" }, ...(req.method !== "GET" ? { body: Buffer.concat(body) } : {}) });
        const handler = url.pathname === "/api/library/conversions/archive" ? archiveRoute : url.pathname === "/api/library/conversions" ? conversionRoute : url.pathname === "/api/library/tracks" ? trackRoute : null;
        const response = handler ? await handler[req.method](request) : Response.json({ error: "Unknown route" }, { status: 404 });
        res.writeHead(response.status, Object.fromEntries(response.headers));
        if (!response.body) return res.end();
        for await (const chunk of response.body) { if (!res.write(chunk)) await new Promise(resolve => res.once("drain", resolve)); }
        return res.end();
      }
      res.setHeader("content-type", "text/html"); res.end('<div id="root"></div><script type="module" src="/fixture.js"></script>');
    } catch (error) { res.statusCode = 500; res.end(String(error)); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const page = await browser.newPage(), browserErrors = []; page.on("pageerror", error => browserErrors.push(error.message));
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByRole("button", { name: "Import, review & convert music", exact: true }).click();
    for (const index of [1, 2]) {
      await page.getByLabel("Conversion files", { exact: true }).setInputFiles(input);
      await expect(page.getByLabel(`Item ${index} title`, { exact: true })).toBeVisible();
      await page.getByLabel(`Item ${index} title`, { exact: true }).fill(`Slow Motion Dream — archive ${index}`);
      await page.getByLabel(`Item ${index} artist`, { exact: true }).fill("Steven M Bryant / CSoul / AlexBeroza / Robert Siekawitch");
      await page.getByLabel(`Item ${index} album`, { exact: true }).fill("Slow Motion Dream — CC BY 3.0");
      await page.getByLabel(`Item ${index} track`, { exact: true }).fill(String(index));
      await page.getByLabel(`Item ${index} lyrics`, { exact: true }).fill(rights);
    }
    await page.getByRole("button", { name: "Convert reviewed batch", exact: true }).click();
    for (const index of [1, 2]) await expect(page.getByRole("article").filter({ hasText: `Slow Motion Dream — archive ${index}` })).toContainText("Completed", { timeout: 30000 });
    // History includes the controlled preceding test: select this genuine batch only.
    for (const index of [1, 2]) await page.getByRole("article").filter({ hasText: `Slow Motion Dream — archive ${index}` }).getByRole("checkbox").check();
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("link", { name: "Download selected verified files (ZIP)", exact: true }).click();
    const download = await downloadPromise; assert.equal(await download.failure(), null);
    assert.equal(download.suggestedFilename(), "arena-converted-music.zip");
    const zip = join(directory, "real-music-batch.zip"); await download.saveAs(zip);
    const extracted = join(directory, "extracted"); await mkdir(extracted);
    const names = JSON.parse(execFileSync("python3", ["-c", "import json,sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(json.dumps(z.namelist())); z.extractall(sys.argv[2])", zip, extracted], { encoding: "utf8" }));
    const manifest = JSON.parse(await readFile(join(extracted, "conversion-manifest.json"), "utf8"));
    assert.equal(manifest.files.length, 2); assert.deepEqual(names, [...manifest.files.map(file => file.path), "conversion-manifest.json"]);
    const outputEvidence = [];
    for (const [index, file] of manifest.files.entries()) {
      assert.ok(file.path.includes("/"), "naming-template folder structure survives extraction");
      const output = join(extracted, file.path), bytes = await readFile(output), metadata = await engine.inspect(output);
      assert.equal(bytes.length, file.bytes); assert.equal(sha(bytes), file.outputSha256);
      assert.equal(metadata.tags.title, `Slow Motion Dream — archive ${index + 1}`);
      assert.equal(metadata.tags.artist, "Steven M Bryant / CSoul / AlexBeroza / Robert Siekawitch");
      assert.equal(metadata.tags.album, "Slow Motion Dream — CC BY 3.0");
      assert.equal(metadata.tags.track, String(index + 1)); assert.equal(metadata.tags.lyrics, rights);
      await engine.runTool("ffmpeg", ["-v", "error", "-i", output, "-map", "0:a:0", "-f", "null", "-"]);
      outputEvidence.push({ ...file, tags: metadata.tags, durationSeconds: metadata.durationSeconds, independentFullDecode: true });
    }
    assert.equal(sha(await readFile(input)), "4b431d535d235bd81b62f816f08c3f1afb6679d2706d84b3b75903b7df909507");
    assert.deepEqual(browserErrors, []);
    const evidence = { scope: "Actual ConversionWorkbench browser upload/review/native conversion/private publication/history/selection/download, Python zipfile CRC/extraction, SHA256 and FFmpeg full decode. No genuine inference, Electron, Windows or subjective listening claim.", sourceSha256: sha(await readFile(input)), outputs: outputEvidence, zipSha256: sha(await readFile(zip)), originalUnchanged: true, browserErrors };
    if (process.env.ARENA_ARCHIVE_EVIDENCE_DIR) {
      const out = resolve(process.env.ARENA_ARCHIVE_EVIDENCE_DIR); await mkdir(out, { recursive: true });
      await copyFile(zip, join(out, "real-music-batch.zip")); await writeFile(join(out, "receipt.json"), JSON.stringify(evidence, null, 2));
      await writeFile(join(out, "RIGHTS.txt"), rights); await page.screenshot({ path: join(out, "batch-download.png"), fullPage: true });
    }
    console.log(JSON.stringify(evidence));
  } finally { await page.close(); await browser.close(); }
});
