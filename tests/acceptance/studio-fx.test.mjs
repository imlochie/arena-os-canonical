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
    return handler(new Request(url, { method, headers: { host: "localhost", "content-type": "application/json" }, ...(body !== undefined ? { body } : {}) }), { params: Promise.resolve(Object.fromEntries(route.names.map((name, index) => [name, match[index + 1]]))) });
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
  await register(/^\/api\/models$/, [], "models");
  await register(/^\/api\/preferences$/, [], "preferences");
  await register(/^\/api\/orchestrator$/, [], "orchestrator");
  await register(/^\/api\/orchestrator\/([^/]+)$/, ["id"], "orchestrator/[id]");
  await register(/^\/api\/orchestrator\/([^/]+)\/relays$/, ["id"], "orchestrator/[id]/relays");
  await register(/^\/api\/orchestrator\/([^/]+)\/advance$/, ["id"], "orchestrator/[id]/advance");
  await register(/^\/api\/artifacts$/, [], "artifacts");
  await register(/^\/api\/artifacts\/storage$/, [], "artifacts/storage");
  await register(/^\/api\/orchestrator\/relays\/([^/]+)$/, ["relayId"], "orchestrator/relays/[relayId]");
  await register(/^\/api\/orchestrator\/relays\/([^/]+)\/result$/, ["relayId"], "orchestrator/relays/[relayId]/result");
  await register(/^\/api\/artifacts\/([^/]+)\/history$/, ["id"], "artifacts/[id]/history");
  await register(/^\/api\/artifacts\/([^/]+)$/, ["id"], "artifacts/[id]");
  await register(/^\/api\/projects$/, [], "projects");
  await register(/^\/api\/projects\/([^/]+)$/, ["id"], "projects/[id]");
  await register(/^\/api\/projects\/([^/]+)\/artifacts$/, ["id"], "projects/[id]/artifacts");
  for (const route of ["battles", "battles/stream", "collabs", "council", "council/artifacts", "assistants", "templates"]) await register(new RegExp("^/api/" + route + "$"), [], route);
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
  function runRemote() { return spawnSync(path.resolve("waveyard-worker/node_modules/.bin/tsx"), ["--tsconfig", path.resolve("waveyard-worker/tsconfig.json"), "waveyard-worker/apps/worker/test-fixtures/export.ts"], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, LOCAL_STORAGE_PATH: process.env.WAVEYARD_STORAGE_DIR, REMOTE_EXPORT_PAYLOAD: JSON.stringify(payload) }, encoding: "utf8", timeout: 25000 }); }
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


test("Artifact Library real UI edits, downloads immutable history, restores, deletes and recovers work", async (t) => {
  const { artifact } = await api("/api/artifacts", "POST", { title: "Browser history original", body: "Original mission research preserved 🎵" });
  const page = await browser.newPage(); page.setDefaultTimeout(10000); t.after(() => page.close());
  await page.goto(`${origin}/?room=artifacts`); await page.getByText("Browser history original", { exact: true }).click();
  await page.getByRole("button", { name: "Edit artifact", exact: true }).click();
  await page.getByLabel("Artifact title", { exact: true }).fill("Browser history revised"); await page.getByLabel("Artifact content", { exact: true }).fill("New useful work");
  await page.getByRole("button", { name: "Save revision", exact: true }).click(); await expect(page.getByText("Current revision 2", { exact: true })).toBeVisible();
  await page.getByText("Revision 1 · Browser history original", { exact: true }).click();
  const downloadPromise = page.waitForEvent("download"); await page.getByRole("link", { name: "Download revision 1", exact: true }).click();
  assert.equal(await readFile(await (await downloadPromise).path(), "utf8"), "Original mission research preserved 🎵");
  await page.getByRole("button", { name: "Restore revision 1", exact: true }).click(); await expect(page.getByText("Current revision 3", { exact: true })).toBeVisible();
  assert.equal((await api(`/api/artifacts/${artifact.id}`)).artifact.body, "Original mission research preserved 🎵");
  page.once("dialog", (dialog) => dialog.accept()); await page.getByRole("button", { name: "Delete Browser history original", exact: true }).click(); await expect(page.getByText("Browser history original", { exact: true })).toHaveCount(0);
  await page.getByRole("checkbox", { name: /Include deleted artifacts/ }).check(); await page.getByText("Browser history original", { exact: true }).click();
  await page.getByRole("button", { name: "Load revision history", exact: true }).click(); await page.getByText("Revision 1 · Browser history original", { exact: true }).click();
  await page.getByRole("button", { name: "Restore revision 1", exact: true }).click(); await expect(page.getByText("Current revision 5", { exact: true })).toBeVisible();
  await page.reload(); await page.getByText("Browser history original", { exact: true }).click(); await expect(page.getByText("Current revision 5", { exact: true })).toBeVisible();
});

test("live nonlinear arrangement edits replace one graph, immediately version/export current FX, and preserve pause/seek/stop", async (t) => {
  const { projectId, remixId } = await source(); const { makeInsert, processWithChain } = await import("../../src/lib/waveyard/mixer/inserts.ts");
  const state = await api(`/api/remixes/${remixId}`); const track = state.tracks[0]; const duplicate = { ...track.clips[0] }; delete duplicate.id;
  await api(`/api/remixes/${remixId}`, "PUT", { ...state.remix, tracks: [{ ...track, phaseInverted: true, clips: [...track.clips, duplicate], inserts: [makeInsert("saturator", { drive: 3 })] }], masterInserts: [makeInsert("gain", { gainDb: -6 })] });
  const page = await browser.newPage(); page.setDefaultTimeout(10000); t.after(() => page.close());
  await page.addInitScript(() => {
    window.__starts = []; window.__activeSources = new Set(); window.__maxActive = 0;
    const start = AudioBufferSourceNode.prototype.start, stop = AudioBufferSourceNode.prototype.stop;
    AudioBufferSourceNode.prototype.start = function(...args) { window.__starts.push({ samples: Array.from(this.buffer.getChannelData(0)), offset: args[1] ?? 0 }); window.__activeSources.add(this); window.__maxActive = Math.max(window.__maxActive, window.__activeSources.size); this.addEventListener("ended", () => window.__activeSources.delete(this)); return start.apply(this, args); };
    AudioBufferSourceNode.prototype.stop = function(...args) { window.__activeSources.delete(this); return stop.apply(this, args); };
  });
  await page.goto(`${origin}/?project=${projectId}&remix=${remixId}`); await page.getByTestId("waveyard-mode-studio").click();
  await page.getByRole("button", { name: "Preview arrangement", exact: true }).click(); await page.waitForFunction(() => window.__starts.length >= 1);
  const rack = page.getByTestId("insert-rack-master"); await rack.locator("summary").click(); await range(rack.getByLabel("gain gainDb", { exact: true }), -12);
  await page.waitForFunction(() => window.__starts.length >= 2);
  const audition = await page.evaluate(() => window.__starts.at(-1).samples);
  const assetResponse = await dispatch(new URL(`/api/assets/${track.stemAssetId}`, "http://fixture")); const input = synth.decodeWav16(new Uint8Array(await assetResponse.arrayBuffer()));
  const expected = processWithChain(Float32Array.from(input.samples, (sample) => sample * -2 * Math.SQRT1_2), [makeInsert("saturator", { drive: 3 }), makeInsert("gain", { gainDb: -12 })], 44100);
  let maxError = 0; for (let frame = 0; frame < 22050; frame++) maxError = Math.max(maxError, Math.abs(audition[frame] - expected[frame * 2]));
  assert.ok(maxError < 0.0002, `actual audible source processes summed clips and current master, max error ${maxError}`);
  page.once("dialog", (dialog) => dialog.accept("Current live nonlinear settings")); const saved = page.waitForResponse((response) => response.url().endsWith(`/remixes/${remixId}/versions`) && response.request().method() === "POST");
  await page.getByRole("button", { name: "Save version", exact: true }).click(); const { version } = await (await saved).json();
  const output = await render(version.id); let outputError = 0; for (let frame = 0; frame < 22050; frame++) outputError = Math.max(outputError, Math.abs(audition[frame] - output.decoded.samples[frame * 2])); assert.ok(outputError < 0.0002, `live nonlinear/export parity ${outputError}`);
  if (await page.getByRole("button", { name: "Pause arrangement", exact: true }).isVisible()) await page.getByRole("button", { name: "Pause arrangement", exact: true }).click();
  await range(page.getByRole("slider", { name: "Seek project", exact: true }), 0.5); await page.getByRole("button", { name: "Preview arrangement", exact: true }).click();
  await page.waitForFunction(() => Math.abs(window.__starts.at(-1).offset - 0.5) < 0.01);
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  assert.equal(await page.evaluate(() => window.__activeSources.size), 0); assert.equal(await page.evaluate(() => window.__maxActive), 1);
  console.log(JSON.stringify({ kind: "live-edits-nonlinear-export", maxError, outputError, maximumConcurrentSources: 1 }));
});


test("Project workspace preserves a rejected Artifact draft and retries into a real immutable revision", async (t) => {
  const { projects } = await import("../../src/db/schema.ts");
  const [project] = await database.db.insert(projects).values({ name: "Real project Artifact workflow" }).returning();
  const page = await browser.newPage(); page.setDefaultTimeout(6000); t.after(() => page.close());
  await page.goto(`${origin}/?room=project&project=${project.id}`); await page.getByRole("button", { name: "＋ New artifact", exact: true }).click();
  const draft = "x".repeat(20000) + "KEEP THIS SUFFIX";
  await page.getByPlaceholder("Title…", { exact: true }).fill("Draft retained after refusal"); await page.getByPlaceholder("Markdown body…", { exact: true }).fill(draft);
  await page.getByRole("button", { name: "Save artifact", exact: true }).click(); await expect(page.getByRole("alert")).toContainText("20,000");
  await expect(page.getByPlaceholder("Markdown body…", { exact: true })).toHaveValue(draft); await expect(page.getByPlaceholder("Title…", { exact: true })).toHaveValue("Draft retained after refusal");
  await page.getByPlaceholder("Markdown body…", { exact: true }).fill("Owner explicitly shortened this draft 🎵"); await page.getByRole("button", { name: "Save artifact", exact: true }).click();
  await expect(page.locator("summary").filter({ hasText: "Draft retained after refusal" })).toBeVisible();
  const saved = (await api(`/api/projects/${project.id}/artifacts`)).artifacts; assert.equal(saved.length, 1); assert.equal(saved[0].body, "Owner explicitly shortened this draft 🎵"); assert.equal(saved[0].revision, 1); assert.ok(saved[0].currentRevisionId);
  await page.locator("summary").filter({ hasText: "Draft retained after refusal" }).click();
  const battle = page.locator("details").first().getByRole("link", { name: "⚔️ Battle", exact: true });
  assert.equal(new URL(await battle.getAttribute("href"), origin).searchParams.get("source"), `artifact:${saved[0].id}@${saved[0].currentRevisionId}`);
  await page.getByRole("button", { name: "Edit artifact", exact: true }).click(); await page.getByLabel("Artifact content", { exact: true }).fill("Edited from the actual project workspace"); await page.getByRole("button", { name: "Save revision", exact: true }).click();
  await expect(page.getByText("Current revision 2", { exact: true })).toBeVisible();
  await page.getByText("Revision 1 · Draft retained after refusal", { exact: true }).click();
  const download = page.waitForEvent("download"); await page.getByRole("link", { name: "Download revision 1", exact: true }).click(); assert.equal(await readFile(await (await download).path(), "utf8"), "Owner explicitly shortened this draft 🎵");
  await page.getByRole("button", { name: "Restore revision 1", exact: true }).click(); await expect(page.getByText("Current revision 3", { exact: true })).toBeVisible();
  await page.reload(); await page.locator("summary").filter({ hasText: "Draft retained after refusal" }).click(); await expect(page.getByText("Current revision 3", { exact: true })).toBeVisible();
});


test("Orchestrator real UI retains rejected references then queues, dispatches and reopens an immutable Artifact handoff", async (t) => {
  let requests = [];
  const adapter = createServer(async (req, res) => { const chunks = []; for await (const chunk of req) chunks.push(chunk); requests.push(JSON.parse(Buffer.concat(chunks).toString())); res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ choices: [{ message: { content: "Controlled protocol receipt: original immutable evidence received. Not an inference result." } }] })); });
  await new Promise(resolve => adapter.listen(0, "127.0.0.1", resolve)); t.after(() => new Promise(resolve => adapter.close(resolve)));
  const { artifact } = await api("/api/artifacts", "POST", { title: "Browser handoff source", body: "PINNED ORIGINAL BROWSER EVIDENCE 🎵" }); const reference = `artifact:${artifact.id}@${artifact.currentRevisionId}`;
  await api(`/api/artifacts/${artifact.id}`, "PUT", { body: "NEW MUTABLE CONTENT MUST NOT BE SENT", expectedRevision: 1 });
  const { collaboration } = await api("/api/orchestrator", "POST", { title: "Browser immutable handoff", goal: "Inspect original evidence", participants: [{ name: "Controlled local adapter", key: "adapter", kind: "external", trust: "internal", adapterUrl: `http://127.0.0.1:${adapter.address().port}` }] });
  const page = await browser.newPage(); page.setDefaultTimeout(10000); t.after(() => page.close()); await page.goto(`${origin}/?room=orchestrator`);
  await page.getByRole("button", { name: /Browser immutable handoff/ }).click(); await page.getByLabel("Relay target", { exact: true }).selectOption("adapter"); await page.getByPlaceholder("request — what should this participant do?", { exact: true }).fill("Inspect the pinned evidence, not latest.");
  await page.getByLabel("Relay immutable Artifact references", { exact: true }).fill(artifact.id); await page.getByRole("button", { name: "+ Queue relay", exact: true }).click(); await expect(page.getByText(/Bare current references are refused/)).toBeVisible();
  await expect(page.getByLabel("Relay immutable Artifact references", { exact: true })).toHaveValue(artifact.id); await expect(page.getByPlaceholder("request — what should this participant do?", { exact: true })).toHaveValue("Inspect the pinned evidence, not latest.");
  await page.getByLabel("Relay immutable Artifact references", { exact: true }).fill(reference); await page.getByRole("button", { name: "+ Queue relay", exact: true }).click(); await expect(page.getByText("Relay #1 acknowledged (pending); no duplicate was queued.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "▶ Advance", exact: true }).click(); await expect(page.getByText("Controlled protocol receipt: original immutable evidence received. Not an inference result.", { exact: true })).toBeVisible();
  assert.equal(requests.length, 1); assert.match(requests[0].messages[1].content, /PINNED ORIGINAL BROWSER EVIDENCE/); assert.doesNotMatch(requests[0].messages[1].content, /NEW MUTABLE CONTENT MUST NOT BE SENT/);
  await page.reload(); await page.getByRole("button", { name: /Browser immutable handoff/ }).click(); await expect(page.getByLabel("Pinned inputs for relay 1")).toContainText(reference);
  const reopened = (await api(`/api/orchestrator/${collaboration.id}`)).collaboration; assert.deepEqual(reopened.relays[0].contextRefs, [reference]); assert.equal(reopened.relays[0].status, "responded");
  const download = page.waitForEvent("download"); await page.getByRole("link", { name: "Download retained session", exact: true }).click(); const downloaded = JSON.parse(await readFile(await (await download).path(), "utf8")); assert.deepEqual(downloaded.relays[0].contextRefs, [reference]); assert.match(downloaded.relays[0].response, /Controlled protocol receipt/);
  await page.getByRole("button", { name: "■ Close", exact: true }).click(); await expect(page.getByText(/Closed — immutable Artifact revision/)).toBeVisible();
  const archived = (await api(`/api/artifacts/${collaboration.id}`)).artifact; assert.equal(archived.revision, 1); assert.ok(archived.body.includes(reference)); assert.match(archived.body, /Controlled protocol receipt/);
  await page.reload(); await page.getByRole("button", { name: /Browser immutable handoff/ }).click(); await page.getByRole("button", { name: "Retry filing record", exact: true }).click(); await expect(page.getByText(/Closed — immutable Artifact revision/)).toBeVisible(); assert.equal((await api(`/api/artifacts/${collaboration.id}`)).artifact.revision, 1);

});

test("Studio Save version survives an in-flight autosave echo but never overwrites a genuinely newer edit", { timeout: 45000 }, async (t) => {
  for (const interveningEdit of [false, true]) {
    const { projectId, remixId } = await source(); const page = await browser.newPage(); page.setDefaultTimeout(10000);
    let release; const held = new Promise(resolve => { release = resolve; }); let started; const firstPut = new Promise(resolve => { started = resolve; }); let puts = 0;
    t.after(async () => { release(); await page.close(); });
    await page.route(`**/api/remixes/${remixId}`, async (route) => { if (route.request().method() === "PUT" && puts++ === 0) { const response = await route.fetch(); started(); await held; await route.fulfill({ response }); } else await route.continue(); });
    await page.goto(`${origin}/?project=${projectId}&remix=${remixId}`); await page.getByTestId("waveyard-mode-studio").click();
    const master = page.getByRole("slider", { name: "Master volume", exact: true }).last(); await range(master, 0.42); await firstPut;
    const intended = interveningEdit ? 0.31 : 0.42; if (interveningEdit) await range(master, intended);
    page.once("dialog", dialog => dialog.accept("Save during autosave acknowledgement")); await page.getByRole("button", { name: "Save version", exact: true }).click(); release();
    await expect.poll(async () => (await api(`/api/remixes/${remixId}/versions`)).versions.length, { timeout: 5000 }).toBe(1);
    const { versions } = await api(`/api/remixes/${remixId}/versions`); const snapshot = await database.db.select().from(schema.remixVersions).where(eq(schema.remixVersions.id, versions[0].id)); const state = typeof snapshot[0].snapshot === "string" ? JSON.parse(snapshot[0].snapshot) : snapshot[0].snapshot; assert.equal(state.masterVolume, intended); await expect(master).toHaveValue(String(intended));
    t.diagnostic(`Held real autosave acknowledgement; intervening edit=${interveningEdit}; immutable version master=${state.masterVolume}`);
  }
});


for (const [room, endpoint, field, operation, button] of [["battle", "battles/stream", "prompt", "battle", /Start battle/], ["collab", "collabs", "challenge", "collab", /Run .*Council|Run .*council/], ["council", "council", "material", "run", /Convene the/]]) {
  test(`actual ${room} interface sends the selected immutable reference and server execution ignores edited preview`, async (t) => {
    const { artifact } = await api("/api/artifacts", "POST", { title: `Pinned ${room} input`, body: "ORIGINAL TRUSTED BROWSER INPUT 🎵" }); const source = `artifact:${artifact.id}@${artifact.currentRevisionId}`;
    await api(`/api/artifacts/${artifact.id}`, "PUT", { body: "LATER MUTABLE CONTENT", expectedRevision: 1 });
    const page = await browser.newPage(); page.setDefaultTimeout(10000); t.after(() => page.close()); await page.addInitScript(() => localStorage.setItem("af_local_mode", "1"));
    await page.goto(`${origin}/?room=${room}&${field}=CLIENT%20PREVIEW&source=${encodeURIComponent(source)}`);
    await expect(page.getByRole("button", { name: "Clear reference and use edited text", exact: true })).toBeVisible();
    await page.locator("textarea").first().fill("EDITED CLIENT PREVIEW MUST NOT OVERRIDE");
    const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === `/api/${endpoint}` && response.request().method() === "POST"); await page.getByRole("button", { name: button }).first().click(); const response = await responsePromise;
    assert.equal(response.request().postDataJSON().source, source); assert.ok(response.ok(), await response.text());
    const data = endpoint.endsWith("stream") ? (await response.text()).split("\n\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6))).find(event => event.type === "battle") : await response.json();
    assert.equal(data[operation][field], artifact.body); assert.equal(data[operation].inputReference.revisionId, artifact.currentRevisionId);
    const table = room === "battle" ? (await import("../../src/db/schema.ts")).battles : room === "collab" ? (await import("../../src/db/schema.ts")).collabs : (await import("../../src/db/schema.ts")).councilRuns;
    const [stored] = await database.db.select().from(table).where(eq(table.id, data[operation].id)); assert.equal(stored[field], artifact.body); assert.equal(stored.inputReference.reference, source);
    if (room === "collab") {
      // Real outgoing controls explicitly snapshot mutable room output, then
      // navigate into the next real room with the acknowledged revision.
      await page.getByRole("button", { name: "Save & send → 🧠 Council", exact: true }).first().click();
      await page.waitForURL(url => url.pathname === "/council"); const selected = new URL(page.url()).searchParams.get("source"); const savedArtifact = (await api(`/api/artifacts/${selected.slice(9).split("@")[0]}`)).artifact;
      assert.equal(new URL(page.url()).searchParams.get("source"), `artifact:${savedArtifact.id}@${savedArtifact.currentRevisionId}`);
      const councilExecution = page.waitForResponse(response => new URL(response.url()).pathname === "/api/council" && response.request().method() === "POST"); await page.getByRole("button", { name: /Convene the/ }).first().click(); const council = await (await councilExecution).json(); assert.equal(council.run.material, savedArtifact.body); assert.equal(council.run.inputReference.revisionId, savedArtifact.currentRevisionId);
      await page.getByRole("button", { name: "Save & send → ⚔️ Arena", exact: true }).first().click(); await page.waitForURL(url => url.pathname === "/"); const selectedBattle = new URL(page.url()).searchParams.get("source"); const snapshotArtifact = (await api(`/api/artifacts/${selectedBattle.slice(9).split("@")[0]}`)).artifact;
      const battleExecution = page.waitForResponse(response => new URL(response.url()).pathname === "/api/battles/stream" && response.request().method() === "POST"); await page.getByRole("button", { name: /Start battle/ }).first().click(); const battleEvents = (await (await battleExecution).text()).split("\n\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6))); const battle = battleEvents.find(event => event.type === "battle").battle; assert.equal(battle.prompt, snapshotArtifact.body); assert.equal(battle.inputReference.revisionId, snapshotArtifact.currentRevisionId);
    }

  });
}

test("actual Library reconciles retained private bytes into a verified Artifact, downloads the complete Unicode file and restores it after an explicit inline edit", async t => {
  const { writeArtifactObject } = await import("../../src/lib/artifact-objects.ts");
  const content = "RETAINED USEFUL WORK 🎵 中文 café\n".repeat(1500) + "IMPORTANT FULL CONTENT SUFFIX";
  const object = await writeArtifactObject(owner, content);
  const page = await browser.newPage(); page.setDefaultTimeout(12000); t.after(() => page.close());
  await page.goto(`${origin}/?room=artifacts`); await page.getByRole("button", { name: "Inspect retained private content", exact: true }).click();
  const row = page.getByText(object.sha256, { exact: true }).locator(".."); await expect(row).toContainText("unbound");
  const saved = page.waitForResponse(response => new URL(response.url()).pathname === "/api/artifacts/storage" && response.request().method() === "POST"); await row.getByRole("button", { name: "Recover as Artifact (unknown origin)", exact: true }).click(); const response = await saved; assert.equal(response.status(), 201); const { artifact } = await response.json(); assert.equal(artifact.sourceType, "recovered-object");
  await page.locator("summary").filter({ hasText: artifact.title }).first().click();
  const history = page.getByRole("region", { name: `History of ${artifact.title}`, exact: true }); await expect(history).toBeVisible();
  let transfer = page.waitForEvent("download"); await history.getByRole("link", { name: "Download complete immutable content", exact: true }).click(); assert.equal(await readFile(await (await transfer).path(), "utf8"), content);
  await history.getByRole("button", { name: "Edit artifact", exact: true }).click(); await history.getByRole("textbox", { name: "Artifact content", exact: true }).fill("An explicit newer inline note; the original file must survive."); await history.getByRole("button", { name: "Save revision", exact: true }).click(); await expect(history).toContainText("Current revision 2");
  await history.getByRole("button", { name: "Load revision history", exact: true }).click(); await history.locator("summary").filter({ hasText: "Revision 1 ·" }).click(); await history.getByRole("button", { name: "Restore revision 1", exact: true }).click(); await expect(history).toContainText("Current revision 3");
  transfer = page.waitForEvent("download"); await history.getByRole("link", { name: "Download complete immutable content", exact: true }).click(); assert.equal(await readFile(await (await transfer).path(), "utf8"), content);
});
