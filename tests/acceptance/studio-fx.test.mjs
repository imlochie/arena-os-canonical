// Actual UI + actual route handlers + PostgreSQL + queue + FFmpeg + decoded
// download. The input is deliberately synthetic PCM, not model/inference proof.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { expect } from "@playwright/test";
import { eq } from "drizzle-orm";
import { missionPostgres } from "../helpers/mission-postgres.ts";
let f, database, schema, server, browser, origin, root, broker, synth;
const routes = [];
const owner = "00000000-0000-4000-8000-000000000001";
async function register(pattern, names, module) { routes.push({ pattern, names, handlers: await import(`../../src/app/api/${module}/route.ts`) }); }
async function dispatch(url, method = "GET", body) {
  for (const route of routes) {
    const match = url.pathname.match(route.pattern); if (!match) continue;
    const handler = route.handlers[method]; if (!handler) return Response.json({ error: "Method unsupported" }, { status: 405 });
    return handler(new Request(url, { method, headers: { "content-type": "application/json" }, ...(body !== undefined ? { body } : {}) }), { params: Promise.resolve(Object.fromEntries(route.names.map((name, index) => [name, match[index + 1]]))) });
  }
  return Response.json({ error: `No real route in this acceptance harness: ${url.pathname}` }, { status: 404 });
}
before(async () => {
  f = await missionPostgres(); root = await mkdtemp(path.join(tmpdir(), "arena-studio-fx-"));
  process.env.DATABASE_URL = f.url; process.env.WAVEYARD_STORAGE_DIR = path.join(root, "storage"); process.env.WAVEYARD_LOCAL_WORKER = "0"; delete process.env.REDIS_URL;
  database = await import("../../src/db/index.ts"); schema = await import("../../src/db/waveyardSchema.ts"); synth = await import("../../src/lib/waveyard/mixer/synth.ts");
  await register(/^\/api\/waveyard\/projects\/([^/]+)$/, ["id"], "waveyard/projects/[id]");
  await register(/^\/api\/waveyard\/projects\/([^/]+)\/master$/, ["id"], "waveyard/projects/[id]/master");
  await register(/^\/api\/waveyard\/projects\/([^/]+)\/remixes$/, ["id"], "waveyard/projects/[id]/remixes");
  await register(/^\/api\/remixes\/([^/]+)$/, ["id"], "remixes/[id]");
  await register(/^\/api\/remixes\/([^/]+)\/versions$/, ["id"], "remixes/[id]/versions");
  await register(/^\/api\/remixes\/([^/]+)\/versions\/([^/]+)\/restore$/, ["id", "versionId"], "remixes/[id]/versions/[versionId]/restore");
  await register(/^\/api\/remix-versions\/([^/]+)\/exports$/, ["id"], "remix-versions/[id]/exports");
  await register(/^\/api\/exports\/([^/]+)\/media$/, ["id"], "exports/[id]/media");
  await register(/^\/api\/exports\/([^/]+)\/retry$/, ["id"], "exports/[id]/retry");
  await register(/^\/api\/assets\/([^/]+)$/, ["id"], "assets/[id]");
  await register(/^\/api\/assets\/([^/]+)\/waveform$/, ["id"], "assets/[id]/waveform");
  const bundle = await build({ entryPoints: ["tests/acceptance/studio-fx.fixture.tsx"], bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", define: { "process.env": JSON.stringify({ NODE_ENV: "development" }) } });
  server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://fixture");
      if (url.pathname === "/fixture.js") { res.setHeader("content-type", "text/javascript"); return res.end(bundle.outputFiles[0].contents); }
      if (url.pathname.startsWith("/api/")) {
        let body = ""; for await (const chunk of req) body += chunk;
        const response = await dispatch(url, req.method, req.method === "GET" ? undefined : body);
        res.writeHead(response.status, Object.fromEntries(response.headers)); return res.end(Buffer.from(await response.arrayBuffer()));
      }
      res.setHeader("content-type", "text/html"); res.end('<!doctype html><div id="root"></div><script src="/fixture.js"></script>');
    } catch (error) { res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise((resolve) => server.listen(0, "0.0.0.0", resolve)); origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--autoplay-policy=no-user-gesture-required"] });
});
after(async () => { await browser?.close(); await new Promise((resolve) => server ? server.close(resolve) : resolve()); await broker?.drain(30000); await database?.pool.end(); await f?.close(); if (root) await rm(root, { recursive: true, force: true }); });
async function api(url, method = "GET", body) {
  const response = await dispatch(new URL(url, "http://fixture"), method, body === undefined ? undefined : JSON.stringify(body));
  assert.ok(response.ok, `${method} ${url}: ${response.status} ${await response.clone().text()}`); return response.json();
}
async function source(impulse = false) {
  const input = new Float32Array(44100 * 3 * 2);
  for (let frame = 0; frame < input.length / 2; frame++) input[frame * 2] = input[frame * 2 + 1] = 0.2 * Math.sin(2 * Math.PI * 440 * frame / 44100);
  if (impulse) { input.fill(0); input[Math.round(2.9 * 44100) * 2] = input[Math.round(2.9 * 44100) * 2 + 1] = 0.4; }
  const filename = path.join(root, "fx-input.wav"); await writeFile(filename, synth.encodeWav16(input, 44100));
  process.env.WAVEYARD_LOCAL_WORKER = "0";
  const service = await import("../../src/lib/waveyard/library/service.ts");
  const { track } = await service.addTrackFromAudioFile({ ownerId: owner, filePath: filename, filename: "FX synthetic.wav", mimeType: "audio/wav" });
  const [row] = await database.db.select().from(schema.tracks).where(eq(schema.tracks.id, track.id));
  const passthrough = await import("../../src/app/api/stems/passthrough/route.ts");
  const response = await passthrough.POST(new Request("http://fixture/api/stems/passthrough", { method: "POST", body: JSON.stringify({ sourceAssetId: row.sourceAssetId }) }));
  assert.ok(response.ok, await response.clone().text());
  const { remix } = await api(`/api/waveyard/projects/${row.projectId}/remixes`, "POST", { name: "Actual FX workflow" });
  const { getLocalJobBroker } = await import("../../src/lib/waveyard/worker-local/broker.ts");
  const { handleExportJob } = await import("../../src/lib/waveyard/worker-local/export.ts");
  broker = getLocalJobBroker(); broker.register("waveyard-export", handleExportJob); process.env.WAVEYARD_LOCAL_WORKER = "1";
  return { projectId: row.projectId, remixId: remix.id };
}
async function range(locator, value) {
  await locator.evaluate((element, next) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(element, String(next)); element.dispatchEvent(new Event("input", { bubbles: true })); element.dispatchEvent(new Event("change", { bubbles: true })); }, value);
}
async function render(versionId) {
  const { job } = await api(`/api/remix-versions/${versionId}/exports`, "POST", { format: "wav" }); assert.equal(await broker.drain(30000), true);
  const [finished] = await database.db.select().from(schema.exportJobs).where(eq(schema.exportJobs.id, job.id)); assert.equal(finished.status, "complete", finished.errorMessage);
  const response = await dispatch(new URL(`/api/exports/${job.id}/media?download=1`, "http://fixture")); assert.equal(response.status, 200);
  const bytes = new Uint8Array(await response.arrayBuffer()); const decoded = synth.decodeWav16(bytes); assert.ok(decoded); return { decoded, bytes, job };
}
function rms(decoded) { const samples = decoded.samples; let sum = 0, n = 0; for (let frame = 22050; frame < 88200; frame++) { const sample = samples[frame * decoded.channels]; sum += sample * sample; n++; } return Math.sqrt(sum / n); }
test("actual Studio FX rack → saved/reopened chains → immutable version → real decoded WAV reflects track AND master gain", async (t) => {
  const { projectId, remixId } = await source();
  const dryVersion = await api(`/api/remixes/${remixId}/versions`, "POST", { name: "Dry reference" }); const dry = await render(dryVersion.version.id);
  const page = await browser.newPage(); page.setDefaultTimeout(10000); t.after(() => page.close()); const errors = []; page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/?project=${projectId}&remix=${remixId}`); await page.getByTestId("waveyard-mode-studio").click();
  const trackRack = page.locator(".source-stem-group .insert-rack").first(), masterRack = page.getByTestId("insert-rack-master");
  await trackRack.locator("summary").click(); await trackRack.getByRole("combobox", { name: /Add processor/ }).selectOption("gain"); await range(trackRack.getByLabel("gain gainDb", { exact: true }), -6);
  await masterRack.locator("summary").click(); await masterRack.getByRole("combobox", { name: /Add processor/ }).selectOption("gain"); await range(masterRack.getByLabel("gain gainDb", { exact: true }), -6);
  await page.getByRole("button", { name: "Save now", exact: true }).click(); await expect(page.locator(".save-state")).toHaveText("Saved");
  const state = await api(`/api/remixes/${remixId}`); assert.equal(state.tracks[0].inserts[0].params.gainDb, -6); assert.equal(JSON.parse(state.remix.masterInserts)[0].params.gainDb, -6);
  await page.reload(); await page.getByTestId("waveyard-mode-studio").click(); await masterRack.locator("summary").click(); await expect(masterRack.getByLabel("gain gainDb", { exact: true })).toHaveValue("-6");
  await range(masterRack.getByLabel("gain gainDb", { exact: true }), -12);
  await range(masterRack.getByLabel("gain gainDb", { exact: true }), -6);
  page.once("dialog", (dialog) => dialog.accept("FX bounce")); const savedVersion = page.waitForResponse((response) => response.url().endsWith(`/remixes/${remixId}/versions`) && response.request().method() === "POST");
  await page.getByRole("button", { name: "Save version", exact: true }).click(); const { version } = await (await savedVersion).json();
  await page.getByRole("button", { name: "Export WAV · FX bounce", exact: true }).click();
  const downloadLink = page.getByRole("link", { name: "Download WAV · FX bounce", exact: true }); await expect(downloadLink).toBeVisible({ timeout: 20000 });
  const downloadPromise = page.waitForEvent("download"); await downloadLink.click(); const download = await downloadPromise;
  const bytes = new Uint8Array(await readFile(await download.path())); const decoded = synth.decodeWav16(bytes); assert.ok(decoded);
  const processed = { decoded, bytes }; const ratio = rms(processed.decoded) / rms(dry.decoded);
  console.log(JSON.stringify({ kind: "actual-ui-sql-fx-bounce", ratio, expectedRatio: 10 ** (-12 / 20), input: "synthetic PCM, not inference", versionId: version.id }));
  assert.ok(Math.abs(ratio - 10 ** (-12 / 20)) < 0.003, `saved -6 dB track + -6 dB master must attenuate decoded export by 12 dB; actual ratio ${ratio}`);
  if (process.env.ARENA_STUDIO_FX_EVIDENCE_DIR) {
    const { mkdir } = await import("node:fs/promises"); const directory = process.env.ARENA_STUDIO_FX_EVIDENCE_DIR; await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "dry.wav"), dry.bytes); await writeFile(path.join(directory, "processed.wav"), processed.bytes);
    await writeFile(path.join(directory, "result.json"), JSON.stringify({ ratio, expected: 10 ** (-12 / 20), input: "synthetic PCM; not inference", versionId: version.id, scope: "actual Studio component, HTTP handlers, PostgreSQL, local queue, DSP, FFmpeg, native browser download" }, null, 2));
  }
  assert.deepEqual(errors, []);
});

test("Mixer master fader is persisted, undoable, versioned immediately and audible in the user-downloadable export", async (t) => {
  const { projectId, remixId } = await source();
  const initial = await api(`/api/remixes/${remixId}/versions`, "POST", { name: "Fader dry reference" }); const dry = await render(initial.version.id);
  const page = await browser.newPage(); page.setDefaultTimeout(10000); t.after(() => page.close());
  await page.goto(`${origin}/?project=${projectId}&remix=${remixId}`); await page.getByTestId("waveyard-mode-studio").click();
  const master = page.getByRole("slider", { name: "Master volume", exact: true }).last(); await range(master, 0.5);
  await page.getByRole("button", { name: "Undo", exact: true }).click(); await expect(master).toHaveValue("1");
  await page.getByRole("button", { name: "Redo", exact: true }).click(); await expect(master).toHaveValue("0.5");
  page.once("dialog", (dialog) => dialog.accept("Fader immediately versioned"));
  await page.getByRole("button", { name: "Save version", exact: true }).click();
  const exportButton = page.getByRole("button", { name: "Export WAV · Fader immediately versioned", exact: true }); await expect(exportButton).toBeEnabled();
  assert.equal((await api(`/api/remixes/${remixId}`)).remix.masterVolume, 0.5);
  await exportButton.click(); const link = page.getByRole("link", { name: "Download WAV · Fader immediately versioned", exact: true }); await expect(link).toBeVisible({ timeout: 20000 });
  const downloadPromise = page.waitForEvent("download"); await link.click(); const download = await downloadPromise;
  const decoded = synth.decodeWav16(new Uint8Array(await readFile(await download.path())));
  assert.ok(Math.abs(rms(decoded) / rms(dry.decoded) - 0.5) < 0.003);
  await page.reload(); await page.getByTestId("waveyard-mode-studio").click(); await expect(master).toHaveValue("0.5");
  await expect(page.getByRole("link", { name: "Download WAV · Fader immediately versioned", exact: true })).toBeVisible();
});
test("canonical export sums overlapping clips before nonlinear track FX and retains reverb tails", async () => {
  const { remixId } = await source();
  const { makeInsert, processWithChain } = await import("../../src/lib/waveyard/mixer/inserts.ts");
  const state = await api(`/api/remixes/${remixId}`);
  const dryVersion = await api(`/api/remixes/${remixId}/versions`, "POST", { name: "Nonlinear dry reference" }); const dry = await render(dryVersion.version.id);
  const track = state.tracks[0]; const duplicate = { ...track.clips[0] }; delete duplicate.id;
  const chain = [makeInsert("saturator", { drive: 3 })];
  await api(`/api/remixes/${remixId}`, "PUT", { ...state.remix, tracks: [{ ...track, inserts: chain, clips: [...track.clips, duplicate] }], masterInserts: [] });
  const nonlinearVersion = await api(`/api/remixes/${remixId}/versions`, "POST", { name: "Nonlinear summed bus" }); const nonlinear = await render(nonlinearVersion.version.id);
  const expectedInput = Float32Array.from(dry.decoded.samples, (value) => value * 2); const expected = processWithChain(expectedInput, chain, 44100);
  let maxError = 0; for (let index = 4410; index < 88200; index++) maxError = Math.max(maxError, Math.abs(expected[index] - nonlinear.decoded.samples[index]));
  assert.ok(maxError < 0.0003, `nonlinear insert must process the summed bus once; max error ${maxError}`);
  const current = await api(`/api/remixes/${remixId}`);
  await api(`/api/remixes/${remixId}`, "PUT", { ...current.remix, tracks: [{ ...current.tracks[0], inserts: [], clips: [current.tracks[0].clips[0]] }], masterInserts: [makeInsert("reverb", { decaySeconds: 0.4 })] });
  const reverbVersion = await api(`/api/remixes/${remixId}/versions`, "POST", { name: "Actual reverb tail" }); const reverb = await render(reverbVersion.version.id);
  assert.ok(reverb.decoded.samples.length > dry.decoded.samples.length);
  const tail = reverb.decoded.samples.subarray(dry.decoded.samples.length); assert.ok(tail.some((sample) => Math.abs(sample) > 0.0001), "the downloadable WAV contains actual energy after the source ends");
});

test("arrangement audition executes persisted track/master FX and polarity, not dry clips", async (t) => {
  const { projectId, remixId } = await source();
  const { makeInsert } = await import("../../src/lib/waveyard/mixer/inserts.ts");
  const state = await api(`/api/remixes/${remixId}`);
  await api(`/api/remixes/${remixId}`, "PUT", { ...state.remix, tracks: [{ ...state.tracks[0], phaseInverted: true, inserts: [makeInsert("gain", { gainDb: -6 })] }], masterInserts: [makeInsert("gain", { gainDb: -6 })] });
  const page = await browser.newPage(); t.after(() => page.close()); page.setDefaultTimeout(10000);
  await page.addInitScript(() => {
    window.__audition = []; window.__scheduled = [];
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function(...args) { window.__scheduled.push({ samples: Array.from(this.buffer.getChannelData(0)), offset: args[1] ?? 0 }); return start.apply(this, args); };
    const connect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function(destination, ...args) {
      if (destination === this.context.destination && this.context instanceof AudioContext) {
        const tap = this.context.createScriptProcessor(1024, 2, 2);
        tap.onaudioprocess = (event) => { const input = event.inputBuffer.getChannelData(0); window.__audition.push(...input); for (let ch = 0; ch < 2; ch++) event.outputBuffer.copyToChannel(event.inputBuffer.getChannelData(ch), ch); };
        connect.call(this, tap); return connect.call(tap, destination);
      }
      return connect.call(this, destination, ...args);
    };
  });
  await page.goto(`${origin}/?project=${projectId}&remix=${remixId}`); await page.getByTestId("waveyard-mode-studio").click();
  await page.getByRole("button", { name: "Preview arrangement", exact: true }).click();
  await page.waitForFunction(() => window.__audition.length > 44100);
  const measurement = await page.evaluate(() => { const samples = window.__audition.slice(-22050); return { peak: Math.max(...samples), rms: Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length) }; });
  const expectedPeak = 0.2 * Math.SQRT1_2 * 10 ** (-12 / 20);
  console.log(JSON.stringify({ kind: "actual-audition-destination", ...measurement, expectedPeak }));
  assert.ok(Math.abs(measurement.peak - expectedPeak) < 0.001, `actual audible destination must include track and master inserts, measured ${measurement.peak} vs ${expectedPeak}`);
  const saved = await api(`/api/remixes/${remixId}/versions`, "POST", { name: "Audition polarity comparison" });
  const exported = await render(saved.version.id);
  const auditionPcm = await page.evaluate(() => window.__scheduled.at(-1).samples);
  let maxError = 0; for (let frame = 0; frame < 22050; frame++) maxError = Math.max(maxError, Math.abs(auditionPcm[frame] - exported.decoded.samples[frame * 2]));
  assert.ok(maxError < 0.0002, `audition/export polarity and levels agree, max error ${maxError}`);
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.getByRole("button", { name: "Preview arrangement", exact: true })).toBeVisible();
});


test("downloaded delay WAV retains late impulse echoes with bounded feedback decay", async () => {
  const { remixId } = await source(true);
  const { makeInsert } = await import("../../src/lib/waveyard/mixer/inserts.ts");
  const state = await api(`/api/remixes/${remixId}`);
  await api(`/api/remixes/${remixId}`, "PUT", { ...state.remix, tracks: state.tracks, masterInserts: [makeInsert("delay", { delayMs: 250, feedback: 0.5, mix: 1 })] });
  const { version } = await api(`/api/remixes/${remixId}/versions`, "POST", { name: "Late delay impulse" });
  const { decoded } = await render(version.id);
  for (const [seconds, expected] of [[3.15, 0.4 * Math.SQRT1_2], [3.4, 0.2 * Math.SQRT1_2], [3.65, 0.1 * Math.SQRT1_2]]) {
    const sample = decoded.samples[Math.round(seconds * 44100) * 2];
    assert.ok(Math.abs(sample - expected) < 0.0002, `late echo at ${seconds}s: ${sample}, expected ${expected}`);
  }
  assert.ok(decoded.samples.length / 2 / 44100 < 7, "feedback tail is calculated, not an arbitrary 60-second pad");
});

test("isolated remote worker genuinely renders the same nonlinear, polarity and delay/reverb chains; missing asset retry preserves lifecycle", async () => {
  const { spawnSync } = await import("node:child_process");
  const { rename } = await import("node:fs/promises");
  const { randomUUID } = await import("node:crypto");
  const { makeInsert } = await import("../../src/lib/waveyard/mixer/inserts.ts");
  const { projectId, remixId } = await source(true);
  const state = await api(`/api/remixes/${remixId}`); const track = state.tracks[0]; const duplicate = { ...track.clips[0] }; delete duplicate.id;
  await api(`/api/remixes/${remixId}`, "PUT", { ...state.remix, tracks: [{ ...track, phaseInverted: true, inserts: [makeInsert("saturator", { drive: 3 }), makeInsert("delay", { delayMs: 250, feedback: 0.5, mix: 0.5 })], clips: [...track.clips, duplicate] }], masterInserts: [makeInsert("gain", { gainDb: -6 }), makeInsert("reverb", { decaySeconds: 0.3 })] });
  const { version } = await api(`/api/remixes/${remixId}/versions`, "POST", { name: "Actual isolated remote parity" }); const local = await render(version.id);
  const [job] = await database.db.insert(schema.exportJobs).values({ projectId, remixSessionId: remixId, remixVersionId: version.id, requestedById: owner, idempotencyKey: `remote-parity:${randomUUID()}`, status: "queued", stage: "queued", format: "wav", sampleRate: 44100, channels: 2 }).returning();
  const { mkdir, symlink } = await import("node:fs/promises");
  const { requireTool } = await import("../../src/lib/waveyard/ffmpeg.ts");
  const bin = path.join(root, "remote-tools"); await mkdir(bin, { recursive: true });
  for (const name of ["ffmpeg", "ffprobe"]) { const tool = await requireTool(name); await symlink(tool.path, path.join(bin, name)); }
  const payload = { exportJobId: job.id, projectId, remixSessionId: remixId, remixVersionId: version.id, format: "wav" };
  function runRemote() { return spawnSync(path.resolve("waveyard-worker/node_modules/.bin/tsx"), ["--tsconfig", path.resolve("waveyard-worker/tsconfig.json"), "tests/fixtures/remote-export.ts"], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, LOCAL_STORAGE_PATH: process.env.WAVEYARD_STORAGE_DIR, REMOTE_EXPORT_PAYLOAD: JSON.stringify(payload) }, encoding: "utf8", timeout: 25000 }); }
  const [asset] = await database.db.select().from(schema.stemAssets).where(eq(schema.stemAssets.id, track.stemAssetId));
  const filename = path.join(process.env.WAVEYARD_STORAGE_DIR, asset.storageKey);
  await rename(filename, filename + ".interrupted");
  let failed; try { failed = runRemote(); } finally { await rename(filename + ".interrupted", filename); }
  assert.equal(failed.status, 1, failed.stderr);
  const [failure] = await database.db.select().from(schema.exportJobs).where(eq(schema.exportJobs.id, job.id)); assert.equal(failure.status, "failed", failed.stderr);
  assert.deepEqual(await database.db.select().from(schema.exportAssets).where(eq(schema.exportAssets.exportJobId, job.id)), []);
  const succeeded = runRemote(); assert.equal(succeeded.status, 0, succeeded.stderr);
  const [complete] = await database.db.select().from(schema.exportJobs).where(eq(schema.exportJobs.id, job.id)); assert.equal(complete.status, "complete"); assert.equal(complete.attempts, 2);
  const response = await dispatch(new URL(`/api/exports/${job.id}/media?download=1`, "http://fixture")); assert.equal(response.status, 200);
  const remote = synth.decodeWav16(new Uint8Array(await response.arrayBuffer())); assert.equal(remote.samples.length, local.decoded.samples.length);
  let maxError = 0; for (let sample = 0; sample < remote.samples.length; sample++) maxError = Math.max(maxError, Math.abs(remote.samples[sample] - local.decoded.samples[sample]));
  console.log(JSON.stringify({ kind: "actual-local-remote-parity", maxError, frames: remote.samples.length / 2, attempts: complete.attempts }));
  assert.ok(maxError < 0.00015, `same persisted version, actual remote/local jobs max PCM error ${maxError}`);
});
