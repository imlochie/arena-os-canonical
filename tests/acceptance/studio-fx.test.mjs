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
let catalogueProviderHandler;
const routes = [];
const owner = "00000000-0000-4000-8000-000000000001";
async function register(pattern, names, module) { routes.push({ pattern, names, handlers: await import(`../../src/app/api/${module}/route.ts`) }); }
async function dispatch(url, method = "GET", body, headers = {}) {
  for (const route of routes) {
    const match = url.pathname.match(route.pattern); if (!match) continue;
    const handler = route.handlers[method]; if (!handler) return Response.json({ error: "Method unsupported" }, { status: 405 });
    return handler(new Request(url, { method, headers: { host: "localhost", "content-type": "application/json", ...headers }, ...(body !== undefined ? { body } : {}) }), { params: Promise.resolve(Object.fromEntries(route.names.map((name, index) => [name, match[index + 1]]))) });
  }
  return Response.json({ error: `No real route in this acceptance harness: ${url.pathname}` }, { status: 404 });
}
before(async () => {
  f = await missionPostgres(); root = await mkdtemp(path.join(tmpdir(), "arena-studio-fx-"));
  process.env.DATABASE_URL = f.url; process.env.WAVEYARD_STORAGE_DIR = path.join(root, "storage"); process.env.WAVEYARD_LOCAL_WORKER = "0"; delete process.env.REDIS_URL;
  database = await import("../../src/db/index.ts"); schema = await import("../../src/db/waveyardSchema.ts"); synth = await import("../../src/lib/waveyard/mixer/synth.ts");
  await register(/^\/api\/library\/catalogue$/, [], "library/catalogue");
  await register(/^\/api\/library\/catalogue\/([^/]+)$/, ["id"], "library/catalogue/[id]");
  await register(/^\/api\/waveyard\/separation\/models$/, [], "waveyard/separation/models");
  await register(/^\/api\/waveyard\/separation\/models\/([^/]+)\/import$/, ["id"], "waveyard/separation/models/[id]/import");
  await register(/^\/api\/library\/queue$/, [], "library/queue");
  await register(/^\/api\/library\/playlists$/, [], "library/playlists");
  await register(/^\/api\/library\/playback-state$/, [], "library/playback-state");
  await register(/^\/api\/library\/tracks$/,  [], "library/tracks");
  await register(/^\/api\/library\/tracks\/([^/]+)$/, ["id"], "library/tracks/[id]");
  await register(/^\/api\/library\/sessions$/, [], "library/sessions");
  await register(/^\/api\/library\/sessions\/([^/]+)$/, ["id"], "library/sessions/[id]");
  for (const part of ["tracks", "swaps", "state", "studio-handoff"]) await register(new RegExp("^/api/library/sessions/([^/]+)/" + part + "$"), ["id"], `library/sessions/[id]/${part}`);
  await register(/^\/api\/library\/sessions\/([^/]+)\/tracks\/([^/]+)$/, ["id", "itemId"], "library/sessions/[id]/tracks/[itemId]");
  await register(/^\/api\/waveyard\/projects\/([^/]+)$/, ["id"], "waveyard/projects/[id]");
  await register(/^\/api\/waveyard\/projects\/([^/]+)\/master$/, ["id"], "waveyard/projects/[id]/master");
  await register(/^\/api\/waveyard\/projects\/([^/]+)\/remixes$/, ["id"], "waveyard/projects/[id]/remixes");
  await register(/^\/api\/remixes\/([^/]+)$/, ["id"], "remixes/[id]");
  await register(/^\/api\/remixes\/([^/]+)\/versions$/, ["id"], "remixes/[id]/versions");
  await register(/^\/api\/remixes\/([^/]+)\/versions\/([^/]+)\/restore$/, ["id", "versionId"], "remixes/[id]/versions/[versionId]/restore");
  await register(/^\/api\/remix-versions\/([^/]+)\/exports$/, ["id"], "remix-versions/[id]/exports");
  await register(/^\/api\/exports\/([^/]+)\/media$/, ["id"], "exports/[id]/media");
  await register(/^\/api\/exports\/([^/]+)\/retry$/, ["id"], "exports/[id]/retry");
  await register(/^\/api\/assets\/([^/]+)\/audition$/, ["id"], "assets/[id]/audition");
  await register(/^\/api\/assets\/([^/]+)$/, ["id"], "assets/[id]");
  await register(/^\/api\/assets\/([^/]+)\/waveform$/, ["id"], "assets/[id]/waveform");
  await register(/^\/api\/arcade$/, [], "arcade");
  await register(/^\/api\/arcade\/attempts$/, [], "arcade/attempts");
  await register(/^\/api\/arcade\/([^/]+)$/, ["id"], "arcade/[id]");
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
  const bundle = await build({ entryPoints: ["tests/acceptance/studio-fx.fixture.tsx"], bundle: true, write: false, platform: "browser", format: "esm", jsx: "automatic", define: { "process.env": JSON.stringify({ NODE_ENV: "development" }) } });
  const workerBundle = await build({ entryPoints: ["src/lib/waveyard/arrangement-pcm.worker.ts"], bundle: true, write: false, platform: "browser", format: "iife" });
  server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://fixture");
      if (url.pathname.startsWith("/archive-controlled/") && catalogueProviderHandler) {
        const response = catalogueProviderHandler(url); res.writeHead(response.status, Object.fromEntries(response.headers));return res.end(Buffer.from(await response.arrayBuffer()));
      }
      if (url.pathname === "/arrangement-pcm.worker.ts") { res.setHeader("content-type", "text/javascript"); return res.end(workerBundle.outputFiles[0].contents); }
      if (url.pathname === "/fixture.js") { res.setHeader("content-type", "text/javascript"); return res.end(bundle.outputFiles[0].contents); }
      if (url.pathname.startsWith("/api/")) {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const response = await dispatch(url, req.method, req.method === "GET" ? undefined : Buffer.concat(chunks), { "content-type": req.headers["content-type"] ?? "application/json" });
        res.writeHead(response.status, Object.fromEntries(response.headers)); return res.end(Buffer.from(await response.arrayBuffer()));
      }
      res.setHeader("content-type", "text/html"); res.end('<!doctype html><div id="root"></div><script type="module" src="/fixture.js"></script>');
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
async function source(impulse = false, seconds = 3, frequency = 440) {
  const input = new Float32Array(44100 * seconds * 2);
  for (let frame = 0; frame < input.length / 2; frame++) input[frame * 2] = input[frame * 2 + 1] = 0.2 * Math.sin(2 * Math.PI * frequency * frame / 44100);
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
  return { projectId: row.projectId, remixId: remix.id, trackId: track.id };
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
    AudioBufferSourceNode.prototype.start = function(...args) { window.__starts.push({ samples: Array.from(this.buffer.getChannelData(0)), offset: args[1] ?? 0, loop: this.loop }); window.__activeSources.add(this); window.__maxActive = Math.max(window.__maxActive, window.__activeSources.size); this.addEventListener("ended", () => window.__activeSources.delete(this)); return start.apply(this, args); };
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
  const beforeLoop = await page.evaluate(() => window.__starts.length);
  await page.getByRole("button", { name: "Toggle loop", exact: true }).click();
  await page.waitForFunction(count => window.__starts.length > count && window.__starts.at(-1).loop, beforeLoop);
  const beforeUnloop = await page.evaluate(() => window.__starts.length);
  await page.getByRole("button", { name: "Toggle loop", exact: true }).click();
  await page.waitForFunction(count => window.__starts.length > count && !window.__starts.at(-1).loop, beforeUnloop);
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
  const artifactSchema = await import("../../src/db/schema.ts");
  const [currentRevision] = await database.db.select().from(artifactSchema.artifactRevisions).where(eq(artifactSchema.artifactRevisions.artifactId, artifact.id)).orderBy((await import("drizzle-orm")).desc(artifactSchema.artifactRevisions.revision)).limit(1);
  await database.db.update(artifactSchema.artifactRevisions).set({ snapshot: { ...currentRevision.snapshot, ownerId: "foreign-owner" } }).where(eq(artifactSchema.artifactRevisions.id, currentRevision.id));
  try {
    await page.getByRole("button", { name: "Inspect retained private content", exact: true }).click();
    await expect(row).toContainText("uncertain"); await expect(row).toContainText("Metadata disagreement");
    await expect(row.getByRole("button", { name: "Recover as Artifact (unknown origin)", exact: true })).toHaveCount(0);
  } finally { await database.db.update(artifactSchema.artifactRevisions).set({ snapshot: currentRevision.snapshot }).where(eq(artifactSchema.artifactRevisions.id, currentRevision.id)); }

});

// Mandate7: real Studio controls -> local canonical clip filters -> browser
// worker DSP -> actual scheduled signal -> immutable save/reopen/export.
test("tempo and key audition changes audible pitch/timing, rejects missing analysis and survives edits, seek and reopen", async (t) => {
  const { projectId, remixId } = await source();
  const initial = await api(`/api/remixes/${remixId}`); const track = initial.tracks[0], stemId = track.stemAssetId;
  const [stem] = await database.db.select().from(schema.stemAssets).where(eq(schema.stemAssets.id, stemId));
  const [original] = await database.db.select().from(schema.sourceAssets).where(eq(schema.sourceAssets.id, stem.sourceAssetId));
  const settings = { sourceOffsetMs: 200, durationMs: 1000, sampleRate: 44100, tempoBpm: 120, targetKey: "B major", tempoSyncEnabled: true, keySyncEnabled: true };
  const auditionUrl = new URL(`/api/assets/${stemId}/audition`, "http://fixture");
  const missing = await dispatch(auditionUrl, "POST", JSON.stringify(settings)); assert.equal(missing.status, 422); assert.match((await missing.json()).error, /complete analysis/);
  await database.db.insert(schema.sourceAnalyses).values({ projectId, sourceAssetId: stem.sourceAssetId, status: "complete", stage: "complete", idempotencyKey: `sync:${stemId}`, analysisEngine: "deterministic-fixture", analysisEngineVersion: "1", sourceChecksumSha256: original.checksumSha256, bpm: 60, musicalKey: "A major" }).onConflictDoUpdate({ target: schema.sourceAnalyses.sourceAssetId, set: { status: "complete", bpm: 60, musicalKey: "A major", sourceChecksumSha256: original.checksumSha256 } });
  const invalid = await dispatch(auditionUrl, "POST", JSON.stringify({ ...settings, sampleRate: 123 })); assert.equal(invalid.status, 400);
  await api(`/api/remixes/${remixId}`, "PUT", { ...initial.remix, tempoBpm: 120, targetKey: "B major", tracks: [{ ...track, phaseInverted: true, clips: [{ ...track.clips[0], timelineStartMs: 500, durationMs: 1000, sourceOffsetMs: 200, tempoSyncEnabled: true, keySyncEnabled: false }] }] });
  const page = await browser.newPage(); t.after(() => page.close()); page.setDefaultTimeout(15000);
  await page.addInitScript(() => { window.__scheduled = []; const start = AudioBufferSourceNode.prototype.start; AudioBufferSourceNode.prototype.start = function(...args) { window.__scheduled.push({ samples: Array.from(this.buffer.getChannelData(0)), sampleRate: this.buffer.sampleRate, offset: args[1] ?? 0 }); return start.apply(this, args); }; });
  await page.goto(`${origin}/?project=${projectId}&remix=${remixId}`); await page.getByTestId("waveyard-mode-studio").click();
  await page.getByRole("button", { name: "Preview arrangement", exact: true }).click(); await page.waitForFunction(() => window.__scheduled.length > 0);
  function frequency(samples, sr, start = 0.65, end = 1.3) { let crossings = 0; const from = Math.round(start * sr), to = Math.round(end * sr); for (let i = from + 1; i < to; i++) if (samples[i - 1] <= 0 && samples[i] > 0) crossings++; return crossings / ((to - from) / sr); }
  let scheduled = await page.evaluate(() => window.__scheduled.at(-1)); assert.equal(scheduled.samples.length, 66150); assert.ok(Math.abs(frequency(scheduled.samples, scheduled.sampleRate) - 440) < 2);
  assert.ok(scheduled.samples.slice(0, 22050).every(sample => sample === 0), "timeline start retained while source is stretched");
  await page.getByRole("button", { name: "Pause arrangement", exact: true }).click();
  // Select the actual timeline clip, not an unrelated inspector instance.
  await page.getByRole("button", { name: "Select track", exact: true }).first().click();
  await page.getByRole("checkbox", { name: "Key sync", exact: true }).check();
  await page.getByRole("button", { name: "Preview arrangement", exact: true }).click(); await page.waitForFunction(() => window.__scheduled.length >= 2);
  scheduled = await page.evaluate(() => window.__scheduled.at(-1)); assert.ok(Math.abs(frequency(scheduled.samples, scheduled.sampleRate) - 440 * 2 ** (2 / 12)) < 2, "key shift changes pitch without changing duration"); assert.equal(scheduled.samples.length, 66150);
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  page.once("dialog", dialog => dialog.accept("Audible tempo and key"));
  const savedResponse = page.waitForResponse(response => response.url().endsWith(`/api/remixes/${remixId}/versions`) && response.request().method() === "POST");
  await page.getByRole("button", { name: "Save version", exact: true }).click(); const saved = await savedResponse; assert.equal(saved.status(), 201); const { version } = await saved.json();
  const state = await api(`/api/remixes/${remixId}`); assert.equal(state.tracks[0].clips[0].keySyncEnabled, true);
  const exported = await render(version.id);
  let error = 0; for (let frame = 0; frame < scheduled.samples.length; frame++) error = Math.max(error, Math.abs(scheduled.samples[frame] - exported.decoded.samples[frame * 2])); assert.ok(error < 0.0003, `browser vs canonical export PCM error ${error}`);
  await page.reload(); await page.getByTestId("waveyard-mode-studio").click(); await page.getByRole("button", { name: "Preview arrangement", exact: true }).click(); await page.waitForFunction(() => window.__scheduled.length > 0); const reopened = await page.evaluate(() => window.__scheduled.at(-1)); assert.deepEqual(reopened.samples, scheduled.samples);
  console.log(JSON.stringify({ kind: "tempo-key-real-audition-export", frames: scheduled.samples.length, frequencyHz: frequency(scheduled.samples, scheduled.sampleRate), expectedHz: 440 * 2 ** (2 / 12), maxPcmError: error, versionId: version.id }));
  await database.db.update(schema.sourceAnalyses).set({ sourceChecksumSha256: "0".repeat(64) }).where(eq(schema.sourceAnalyses.sourceAssetId, stem.sourceAssetId));
  const stale = await dispatch(new URL(`/api/assets/${stemId}/audition`, "http://fixture"), "POST", JSON.stringify({ sourceOffsetMs: 200, durationMs: 1000, tempoSyncEnabled: true, keySyncEnabled: true, tempoBpm: 120, targetKey: "B major", sampleRate: 44100 }));
  assert.equal(stale.status, 422); assert.match((await stale.json()).error, /current source/);
  const staleVersion = await api(`/api/remixes/${remixId}/versions`, "POST", { name: "Reject stale analysis" });
  const { job: rejectedJob } = await api(`/api/remix-versions/${staleVersion.version.id}/exports`, "POST", { format: "wav" });
  assert.equal(await broker.drain(30000), true);
  const [rejected] = await database.db.select().from(schema.exportJobs).where(eq(schema.exportJobs.id, rejectedJob.id));
  assert.equal(rejected.status, "failed"); assert.equal(rejected.errorCode, "tempo_sync_analysis_missing");
  const retained = await dispatch(new URL(`/api/exports/${exported.job.id}/media?download=1`, "http://fixture"));
  assert.equal(retained.status, 200); assert.deepEqual(new Uint8Array(await retained.arrayBuffer()), exported.bytes, "published export stays immutable when source analysis changes");

});

test("large canonical preparation remains interactive, caches replay and uses the latest edited mix without redecoding", async (t) => {
  const { remixId } = await source(false, 90); const initial = await api(`/api/remixes/${remixId}`); const { makeInsert } = await import("../../src/lib/waveyard/mixer/inserts.ts");
  const page = await browser.newPage(); t.after(() => page.close()); await page.goto(`${origin}/?room=preparation`);
  for (const [count, seconds] of [[4, 15], [16, 90], [32, 90]]) {
    const state = { ...initial.remix, tracks: Array.from({ length: count }, (_, i) => ({ ...initial.tracks[0], id: String(i), volume: 1 / count, inserts: [makeInsert("saturator", { drive: 3 })], clips: [{ ...initial.tracks[0].clips[0], durationMs: seconds * 1000 }] })) };
    const result = await page.evaluate(state => window.measurePreparation(state), state);
    console.log(JSON.stringify({ kind: "studio-worker-preparation", tracks: count, seconds, ...result }));
    // Numeric, explicitly synthetic metrics only: accessible from GitHub check
    // annotations without exposing arbitrary tool output or private assertions.
    console.log(`::notice title=Studio synthetic preparation::${JSON.stringify({tracks:count,seconds,readyMs:result.readyMs,editMs:result.editMs,replayMs:result.replayMs,maximumGapMs:result.maximumGapMs,verificationMs:result.verificationMs,latestEditError:result.latestEditError,frames:result.frames})}`);
    assert.equal(result.frames, seconds * 44100); assert.ok(result.ticks > 5, "UI timer remains schedulable while DSP runs"); assert.ok(result.maximumGapMs < 250, `main-thread stall ${result.maximumGapMs}ms`); assert.ok(result.replayMs < 20); assert.equal(result.latestEditError, 0);
  }
});

test("real preparation cancellation recovers from encoded sources and releases workspace caches/workers", async (t) => {
  const { remixId } = await source(false, 15); const initial = await api(`/api/remixes/${remixId}`); const { makeInsert } = await import("../../src/lib/waveyard/mixer/inserts.ts");
  const state = { ...initial.remix, tracks: Array.from({ length: 4 }, (_, i) => ({ ...initial.tracks[0], id: String(i), volume: 0.25, inserts: [makeInsert("saturator", { drive: 3 })], clips: [{ ...initial.tracks[0].clips[0], durationMs: 15000 }] })) };
  const page = await browser.newPage(); t.after(() => page.close()); await page.goto(`${origin}/?room=preparation`);
  const result = await page.evaluate(state => window.verifyPreparationLifecycle(state), state);
  const variant = process.env.ARENA_MEMORY_VARIANT ?? process.env.ARENA_MEMORY_CANDIDATE ?? "baseline";
  console.log(JSON.stringify({ kind: "real-worker-cancel-cache-dispose", implementation: variant, ...result }));
  assert.equal(result.cancelled, "AbortError"); assert.equal(result.latestError, 0); assert.equal(result.replaySame, true);
  assert.equal(result.coldFetches, 1); assert.equal(result.afterEditFetches, 1); assert.equal(result.reopenedFetches, 2);
  if (["encoded-recovery", "prototype2", "prototype3", "prototype4"].includes(variant)) {
    assert.equal(result.initialDiagnostics.decodedBytes, 0);
    assert.ok(result.initialDiagnostics.encodedRecoveryBytes > 0);
    assert.equal(result.recoveredDiagnostics.decodedBytes, 0);
    assert.equal(result.recoveredDiagnostics.encodedRecoveryBytes, result.initialDiagnostics.encodedRecoveryBytes);
  } else {
    const decodedBytes = 44100 * 2 * 4;
    assert.equal(result.initialDiagnostics.decodedBytes, decodedBytes);
    assert.equal(result.recoveredDiagnostics.decodedBytes, decodedBytes);
  }
  if (variant === "prototype3") {
    assert.equal(result.initialDiagnostics.sourceBytes, 44100 * 2 * 4);
    assert.equal(result.recoveredDiagnostics.sourceBytes, 44100 * 2 * 4);
    assert.equal(result.initialDiagnostics.workerSourcesEvicted, false);
  }
  if (variant === "prototype4") {
    assert.equal(result.initialDiagnostics.sourceBytes, 0);
    assert.equal(result.recoveredDiagnostics.sourceBytes, 0);
    assert.equal(result.initialDiagnostics.workerSourcesEvicted, true);
    assert.equal(result.initialDiagnostics.evictedSourceBytes, 44100 * 2 * 4);
  }
  assert.equal(result.disposedDiagnostics.encodedRecoveryBytes, 0);
  assert.equal(result.disposedWorkers.created, result.disposedWorkers.terminated); assert.equal(result.disposedWorkers.created, 2);
});

test("per-asset source revision replaces stale stereo PCM without reloading an unrelated source", async (t) => {
  const arrangements = [];
  for (const frequency of [220, 440]) {
    const { remixId } = await source(false, 1, frequency);
    const initial = await api(`/api/remixes/${remixId}`); arrangements.push(initial);
  }
  const state = { ...arrangements[0].remix, tracks: arrangements.flatMap(item => item.tracks) };
  const page = await browser.newPage(); t.after(() => page.close()); await page.goto(`${origin}/?room=preparation`);
  const result = await page.evaluate(state => window.verifyPreparationSourceRevision(state), state);
  assert.notEqual(result.before, result.after);
  assert.equal(result.firstFetches, 2); assert.equal(result.neighborFetches, 1); assert.equal(result.replaySame, true);
});

test("real Chromium structured-clone failure recovers without orphaned rejections or redundant source fetches", async (t) => {
  const { remixId } = await source(false, 1);
  const initial = await api(`/api/remixes/${remixId}`);
  const page = await browser.newPage(); t.after(() => page.close()); await page.goto(`${origin}/?room=preparation`);
  const result = await page.evaluate(state => window.verifyPreparationCloneFailure(state), { ...initial.remix, tracks: initial.tracks });
  assert.equal(result.failure, "DataCloneError"); assert.equal(result.frames, 44100);
  assert.equal(result.fetches, 1); assert.deepEqual(result.unhandled, []);
});

test("controlled Worker error during a source endpoint outage recovers from its local owner", async (t) => {
  const { remixId } = await source(false, 1);
  const initial = await api(`/api/remixes/${remixId}`);
  const page = await browser.newPage(); t.after(() => page.close()); await page.goto(`${origin}/?room=preparation`);
  const variant = process.env.ARENA_MEMORY_VARIANT ?? process.env.ARENA_MEMORY_CANDIDATE ?? "baseline";
  const result = await page.evaluate(input => window.verifyWorkerErrorDuringOutage(input.state, input.expectWorkerEviction),
    { state: { ...initial.remix, tracks: initial.tracks }, expectWorkerEviction: ["prototype3", "prototype4"].includes(variant) });
  console.log(JSON.stringify({ kind: "controlled-worker-error-recovery", implementation: variant, ...result }));
  assert.equal(result.fetches, 1); assert.equal(result.outageFetches, 0);
  assert.equal(result.firstFrames, 44100); assert.equal(result.recoveredFrames, 44100); assert.ok(result.outputError < 1e-7);
  if (["encoded-recovery", "prototype2", "prototype3", "prototype4"].includes(variant)) {
    assert.ok(result.recoveredDiagnostics.encodedRecoveryBytes > 0);
  } else {
    assert.ok(result.recoveredDiagnostics.decodedBytes > 0);
  }
  assert.equal(result.idleDiagnostics.sourceBytes, ["prototype3", "prototype4"].includes(variant) ? 0 : 44100 * 2 * 4);
  if (["prototype3", "prototype4"].includes(variant)) assert.equal(result.idleDiagnostics.workerSourcesEvicted, true);
});

test("removing a track releases its obsolete recovery owners and reuses the remaining local source", async (t) => {
  const first = await source(false, 1, 220), second = await source(false, 1, 440);
  const firstState = await api(`/api/remixes/${first.remixId}`), secondState = await api(`/api/remixes/${second.remixId}`);
  const state = { ...firstState.remix, tracks: [firstState.tracks[0], secondState.tracks[0]] };
  const page = await browser.newPage(); t.after(() => page.close()); await page.goto(`${origin}/?room=preparation`);
  const result = await page.evaluate(state => window.verifyRemovedTrackRecovery(state), state);
  assert.equal(result.singleHash, result.removedHash);
  assert.notEqual(result.pairHash, result.removedHash);
  assert.equal(result.removalFetches, 0);
  assert.equal(result.removedFrames, 44100);
  const variant = process.env.ARENA_MEMORY_VARIANT ?? process.env.ARENA_MEMORY_CANDIDATE ?? "baseline";
  if (["encoded-recovery", "prototype2", "prototype3", "prototype4"].includes(variant)) {
    assert.ok(result.removedDiagnostics.encodedRecoveryBytes < result.pairDiagnostics.encodedRecoveryBytes);
    assert.equal(result.removedDiagnostics.decodedBytes, 0);
  } else {
    assert.equal(result.removedDiagnostics.decodedBytes, 44100 * 2 * 4);
  }
  assert.equal(result.removedDiagnostics.sourceBytes, variant === "prototype4" ? 0 : 44100 * 2 * 4);
  if (variant === "prototype4") assert.equal(result.removedDiagnostics.workerSourcesEvicted, true);
});

test("large encoded recovery sources retain decoded PCM instead of worsening ownership", async (t) => {
  const { remixId } = await source(false, 1);
  const initial = await api(`/api/remixes/${remixId}`);
  const page = await browser.newPage(); t.after(() => page.close()); await page.goto(`${origin}/?room=preparation`);
  const variant = process.env.ARENA_MEMORY_VARIANT ?? process.env.ARENA_MEMORY_CANDIDATE ?? "baseline";
  const result = await page.evaluate(input => window.verifyRecoveryBudgetFallback(input.state, input.expectWorkerEviction),
    { state: { ...initial.remix, tracks: initial.tracks }, expectWorkerEviction: ["prototype3", "prototype4"].includes(variant) });
  assert.equal(result.frames, 44100);
  assert.equal(result.fetches, 1);
  assert.equal(result.diagnostics.encodedRecoveryBytes ?? 0, 0);
  assert.equal(result.diagnostics.decodedBytes, 44100 * 2 * 4);
  assert.equal(result.diagnostics.sourceBytes, ["prototype3", "prototype4"].includes(variant) ? 0 : 44100 * 2 * 4);
  if (["prototype3", "prototype4"].includes(variant)) assert.equal(result.diagnostics.workerSourcesEvicted, true);
});

test("warm preparation cancellation recovers from retained audio while its source endpoint is unavailable", async (t) => {
  const { remixId } = await source(false, 1);
  const initial = await api(`/api/remixes/${remixId}`);
  const state = { ...initial.remix, tracks: initial.tracks };
  const page = await browser.newPage(); t.after(() => page.close()); await page.goto(`${origin}/?room=preparation`);
  const result = await page.evaluate(state => window.verifyPreparationLifecycle(state, true), state);
  const variant = process.env.ARENA_MEMORY_VARIANT ?? process.env.ARENA_MEMORY_CANDIDATE ?? "baseline";
  console.log(JSON.stringify({ kind: "warm-cancel-local-recovery", implementation: variant, ...result }));
  assert.equal(result.cancelled, "AbortError"); assert.equal(result.latestError, 0);
  assert.equal(result.afterEditFetches, 1); assert.equal(result.replaySame, true);
  if (["encoded-recovery", "prototype2", "prototype3", "prototype4"].includes(variant)) {
    assert.equal(result.initialDiagnostics.decodedBytes, 0);
    assert.ok(result.initialDiagnostics.encodedRecoveryBytes > 0);
    assert.equal(result.recoveredDiagnostics.decodedBytes, 0);
    assert.ok(result.recoveredDiagnostics.encodedRecoveryBytes > 0);
  } else {
    const decodedBytes = 44100 * 2 * 4;
    assert.equal(result.initialDiagnostics.decodedBytes, decodedBytes);
    assert.equal(result.recoveredDiagnostics.decodedBytes, decodedBytes);
  }
});

test("Arcade real catalogue outage never erases acknowledged games or preview; retry/reopen retains exact playable bytes and enforces deletion ownership", async t => {
  const prompt = "snake — outage recovery acceptance";
  const { game } = await api("/api/arcade", "POST", { prompt, gameType: "snake" });
  assert.match(game.engine, /verified|remix/);
  const page = await browser.newPage(); t.after(() => page.close());
  await page.goto(`${origin}/?room=arcade`);
  const entry = page.getByRole("button").filter({ has: page.getByText(prompt, { exact: true }) });
  await expect(entry).toBeVisible(); await entry.click();
  const preview = page.locator("iframe"); await expect(preview).toHaveAttribute("srcdoc", game.code);
  await expect(page.frameLocator("iframe").locator("canvas")).toBeVisible();
  await database.pool.query("ALTER TABLE arcade_games RENAME TO unavailable_arcade_games");
  try {
    const failed = await dispatch(new URL("/api/arcade?limit=30", "http://fixture")); assert.equal(failed.status, 503); assert.equal((await failed.json()).games, undefined);
    await page.getByRole("button", { name: "Refresh game library", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("Game library unavailable"); await expect(entry).toBeVisible();
    await expect(preview).toHaveAttribute("srcdoc", game.code); await expect(page.getByText("No games yet — forge the first.", { exact: true })).toHaveCount(0);
    await page.reload(); await expect(page.getByRole("alert")).toContainText("Game library unavailable");
    await expect(page.getByText("No games yet — forge the first.", { exact: true })).toHaveCount(0);
  } finally { await database.pool.query("ALTER TABLE unavailable_arcade_games RENAME TO arcade_games"); }
  await page.getByRole("button", { name: "Retry game library", exact: true }).click(); await expect(entry).toBeVisible(); await expect(page.getByRole("alert")).toHaveCount(0); await entry.click();
  await expect(preview).toHaveAttribute("srcdoc", game.code);
  await f.stop(); await f.start(); await page.reload(); await expect(entry).toBeVisible(); await entry.click(); await expect(preview).toHaveAttribute("srcdoc", game.code);
  const store = await import("../../src/lib/arcadeStore.ts"); const foreign = await store.insertArcadeGame(database.db, { prompt: "Foreign playable game", gameType: "snake", engine: game.engine, code: game.code, ownerId: "foreign-owner" });
  const denied = await dispatch(new URL(`/api/arcade/${foreign.id}`, "http://fixture"), "DELETE"); assert.equal(denied.status, 403);
  assert.equal((await api(`/api/arcade/${foreign.id}`)).game.code, game.code);
  assert.equal((await api(`/api/arcade/${game.id}`)).game.code, game.code);
});

test("mixed-tempo library handoff auditions and exports the same owned immutable references locally and in the real isolated worker", async t => {
  const first = await source(false, 3), second = await source(false, 4);
  const sessions = await import("../../src/lib/waveyard/library/session-service.ts");
  const session = await sessions.createSession(owner, "Mixed BPM/key reference export");
  await sessions.addTrackToSession({ ownerId: owner, sessionId: session.id, trackId: first.trackId });
  await sessions.addTrackToSession({ ownerId: owner, sessionId: session.id, trackId: second.trackId });
  const { projectId, remixSessionId: remixId } = await sessions.sendSessionToStudio(owner, session.id);
  const initial = await api(`/api/remixes/${remixId}`); assert.equal(initial.tracks.length, 2);
  const stems = [];
  for (const [index, lane] of initial.tracks.entries()) {
    const [stem] = await database.db.select().from(schema.stemAssets).where(eq(schema.stemAssets.id, lane.stemAssetId)); stems.push(stem);
    const [original] = await database.db.select().from(schema.sourceAssets).where(eq(schema.sourceAssets.id, stem.sourceAssetId));
    const analysed = { projectId: original.projectId, sourceAssetId: original.id, status: "complete", stage: "complete", idempotencyKey: `mixed-sync:${original.id}`, analysisEngine: "deterministic-fixture", analysisEngineVersion: "1", sourceChecksumSha256: original.checksumSha256, bpm: index ? 120 : 60, musicalKey: index ? "C major" : "A major" };
    await database.db.insert(schema.sourceAnalyses).values(analysed).onConflictDoUpdate({ target: schema.sourceAnalyses.sourceAssetId, set: analysed });
  }
  await api(`/api/remixes/${remixId}`, "PUT", { ...initial.remix, tempoBpm: 120, targetKey: "B major", tracks: initial.tracks.map((track, index) => ({ ...track, phaseInverted: Boolean(index), clips: [{ ...track.clips[0], timelineStartMs: index ? 1700 : 500, sourceOffsetMs: 200, durationMs: 800, tempoSyncEnabled: true, keySyncEnabled: true }] })) });
  const { version } = await api(`/api/remixes/${remixId}/versions`, "POST", { name: "Owned mixed source tempos/keys" });
  const local = await render(version.id);
  const page = await browser.newPage(); t.after(() => page.close());
  await page.addInitScript(() => { window.__mix = null; const start = AudioBufferSourceNode.prototype.start; AudioBufferSourceNode.prototype.start = function(...args) { window.__mix = Array.from(this.buffer.getChannelData(0)); return start.apply(this, args); }; });
  await page.goto(`${origin}/?project=${projectId}&remix=${remixId}`); await page.getByTestId("waveyard-mode-studio").click(); await page.getByRole("button", { name: "Preview arrangement", exact: true }).click(); await page.waitForFunction(() => window.__mix !== null);
  const audition = await page.evaluate(() => window.__mix); assert.equal(audition.length, 110250);
  function frequency(from, to) { let crossings = 0; for (let i = Math.round(from * 44100) + 1; i < Math.round(to * 44100); i++) if (audition[i - 1] <= 0 && audition[i] > 0) crossings++; return crossings / (to - from); }
  assert.ok(Math.abs(frequency(0.6, 1.1) - 440 * 2 ** (2 / 12)) < 2);
  assert.ok(Math.abs(frequency(1.8, 2.3) - 440 * 2 ** (-1 / 12)) < 2);
  assert.ok(audition.slice(1.31 * 44100, 1.69 * 44100).every(value => value === 0));
  let browserError = 0; for (let frame = 0; frame < audition.length; frame++) browserError = Math.max(browserError, Math.abs(audition[frame] - local.decoded.samples[frame * 2])); assert.ok(browserError < 0.0003, `mixed-source browser/local parity ${browserError}`);
  const { spawnSync } = await import("node:child_process"), { randomUUID } = await import("node:crypto"), { symlink } = await import("node:fs/promises"), { requireTool } = await import("../../src/lib/waveyard/ffmpeg.ts");
  const bin = await mkdtemp(path.join(root, "mixed-export-tools-")); for (const name of ["ffmpeg", "ffprobe"]) await symlink((await requireTool(name)).path, path.join(bin, name));
  async function remote() {
    const [job] = await database.db.insert(schema.exportJobs).values({ projectId, remixSessionId: remixId, remixVersionId: version.id, requestedById: owner, idempotencyKey: `mixed-remote:${randomUUID()}`, status: "queued", stage: "queued", format: "wav", sampleRate: 44100, channels: 2 }).returning();
    const payload = { exportJobId: job.id, projectId, remixSessionId: remixId, remixVersionId: version.id, format: "wav" };
    const child = spawnSync(path.resolve("waveyard-worker/node_modules/.bin/tsx"), ["--tsconfig", path.resolve("waveyard-worker/tsconfig.json"), "waveyard-worker/apps/worker/test-fixtures/export.ts"], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, LOCAL_STORAGE_PATH: process.env.WAVEYARD_STORAGE_DIR, REMOTE_EXPORT_PAYLOAD: JSON.stringify(payload) }, encoding: "utf8", timeout: 25000 });
    const [finished] = await database.db.select().from(schema.exportJobs).where(eq(schema.exportJobs.id, job.id)); return { job: finished, child };
  }
  const actual = await remote(); assert.equal(actual.child.status, 0, actual.child.stderr); assert.equal(actual.job.status, "complete");
  const media = await dispatch(new URL(`/api/exports/${actual.job.id}/media?download=1`, "http://fixture")); assert.equal(media.status, 200); const decoded = synth.decodeWav16(new Uint8Array(await media.arrayBuffer())); assert.equal(decoded.samples.length, local.decoded.samples.length);
  let workerError = 0; for (let i = 0; i < decoded.samples.length; i++) workerError = Math.max(workerError, Math.abs(decoded.samples[i] - local.decoded.samples[i])); assert.ok(workerError < 0.00015, `mixed-source actual worker/local parity ${workerError}`);
  await database.db.update(schema.sourceAnalyses).set({ sourceChecksumSha256: "0".repeat(64) }).where(eq(schema.sourceAnalyses.sourceAssetId, stems[1].sourceAssetId));
  const stale = await remote(); assert.equal(stale.child.status, 1); assert.equal(stale.job.status, "failed"); assert.equal(stale.job.errorCode, "tempo_sync_analysis_missing");
  const originalProject = stems[1].projectId; await database.db.update(schema.projects).set({ ownerId: "00000000-0000-4000-8000-000000000002" }).where(eq(schema.projects.id, originalProject));
  try { const foreign = await remote(); assert.equal(foreign.child.status, 1); assert.equal(foreign.job.errorCode, "asset_missing"); } finally { await database.db.update(schema.projects).set({ ownerId: owner }).where(eq(schema.projects.id, originalProject)); }
  console.log(JSON.stringify({ kind: "mixed-source-real-browser-local-worker", sourceBpms: [60, 120], frames: audition.length, browserError, workerError, immutableVersionId: version.id }));
});

test("precise range UI applies atomic move/trim with undo-redo, rejects out-of-source ranges, and immediately versions/reopens/auditions/exports exact geometry", async t => {
  const {projectId,remixId}=await source(); const page=await browser.newPage(); t.after(()=>page.close());
  await page.addInitScript(()=>{window.__rangeAudio=[]; const start=AudioBufferSourceNode.prototype.start; AudioBufferSourceNode.prototype.start=function(...args){if(this.buffer)window.__rangeAudio.push({frames:this.buffer.length,left:Array.from(this.buffer.getChannelData(0))});return start.apply(this,args);};});
  await page.goto(`${origin}/?project=${projectId}&remix=${remixId}`); await page.getByTestId("waveyard-mode-studio").click();
  const form=page.getByRole("form",{name:"Precise clip range",exact:true}); await expect(form).toBeVisible();
  await form.getByLabel("Clip source offset (ms)",{exact:true}).fill("2500"); await form.getByLabel("Clip duration (ms)",{exact:true}).fill("1200"); await form.getByRole("button",{name:"Apply precise range",exact:true}).click(); await expect(form.getByRole("alert")).toContainText("exceeds this stem");
  await form.getByLabel("Clip source offset (ms)",{exact:true}).fill("1000"); await form.getByLabel("Clip timeline position (ms)",{exact:true}).fill("500"); await form.getByRole("button",{name:"Apply precise range",exact:true}).click();
  await page.getByRole("button",{name:"Undo",exact:true}).click(); await expect(form.getByLabel("Clip duration (ms)",{exact:true})).toHaveValue("3000"); await page.getByRole("button",{name:"Redo",exact:true}).click(); await expect(form.getByLabel("Clip duration (ms)",{exact:true})).toHaveValue("1200");
  const saving=page.waitForResponse(response=>response.url().endsWith(`/api/remixes/${remixId}/versions`)&&response.request().method()==="POST"); page.once("dialog",dialog=>dialog.accept("Precise range acknowledged")); await page.getByRole("button",{name:"Save version",exact:true}).click(); const {version}=await(await saving).json();
  const actual=await api(`/api/remixes/${remixId}`); const clip=actual.tracks[0].clips[0]; assert.equal(clip.timelineStartMs,500); assert.equal(clip.sourceOffsetMs,1000); assert.equal(clip.durationMs,1200);
  await page.reload(); await page.getByTestId("waveyard-mode-studio").click(); await expect(form.getByLabel("Clip timeline position (ms)",{exact:true})).toHaveValue("500"); await expect(form.getByLabel("Clip source offset (ms)",{exact:true})).toHaveValue("1000"); await expect(form.getByLabel("Clip duration (ms)",{exact:true})).toHaveValue("1200");
  await page.getByRole("button",{name:"Preview arrangement",exact:true}).click(); await page.waitForFunction(()=>window.__rangeAudio.length>0); const audio=await page.evaluate(()=>window.__rangeAudio.at(-1)); const exported=await render(version.id);
  assert.equal(audio.frames,74970); assert.equal(exported.decoded.samples.length/exported.decoded.channels,audio.frames); let error=0; for(let frame=0;frame<audio.frames;frame++){if(frame<22050)assert.equal(audio.left[frame],0); error=Math.max(error,Math.abs(audio.left[frame]-exported.decoded.samples[frame*exported.decoded.channels]));} assert.ok(error<0.00012,`audition/export error ${error}`);
});

test("Arcade browser reopens private failed attempts after restart without replacing previous playable game; save recovery commits exact validated bytes and exposes reopen",async t=>{
 const service=await import("../../src/lib/games/attempts.ts"),{generateGameOffline,validateGameCode}=await import("../../src/lib/games/index.ts");const {randomUUID}=await import("node:crypto");
 const {game:previous}=await api("/api/arcade","POST",{prompt:"snake — private attempt recovery previous",gameType:"snake"});
 let failed=(await service.beginAttempt(owner,randomUUID(),"CONTROLLED partial exposure puzzle — not model inference")).cursor; const partial='<!DOCTYPE html><html><canvas></canvas><script>// retained useful Unicode draft 🎵\nconst exposure=0.25;';
 failed=await service.checkpointAttempt(failed,{state:"failed",error:"Controlled repair outage"},{code:partial,validation:validateGameCode(partial),runtime:{modelId:"CONTROLLED-FIXTURE",backend:"fixture",ms:1}});
 let validated=(await service.beginAttempt(owner,randomUUID(),"CONTROLLED validated save retry — not model inference")).cursor;const code=generateGameOffline("snake with wrap").code; validated=await service.checkpointAttempt(validated,{state:"validated"},{code,validation:validateGameCode(code),runtime:{modelId:"CONTROLLED-FIXTURE",backend:"fixture",ms:1}});
 const page=await browser.newPage();t.after(()=>page.close());await page.goto(`${origin}/?room=arcade`);const previousEntry=page.getByRole("button").filter({has:page.getByText(previous.prompt,{exact:true})});await previousEntry.click();await expect(page.locator("iframe")).toHaveAttribute("srcdoc",previous.code);
 const failedRow=page.getByRole("article",{name:`Attempt ${failed.id}`,exact:true});await failedRow.getByRole("button",{name:"Inspect retained draft",exact:true}).click();const retained=page.getByTestId("arcade-failed-draft");await retained.locator("summary").click();await expect(retained.locator("pre")).toHaveText(partial);await expect(page.locator("iframe")).toHaveAttribute("srcdoc",previous.code);
 const download=page.waitForEvent("download");await failedRow.getByRole("link",{name:"Download exact attempt",exact:true}).click();assert.equal(await readFile(await(await download).path(),"utf8"),partial);
 await f.stop();await f.start();await page.reload();await expect(failedRow).toContainText("failed");await failedRow.getByRole("button",{name:"Inspect retained draft",exact:true}).click();await retained.locator("summary").click();await expect(retained.locator("pre")).toHaveText(partial);
 const validRow=page.getByRole("article",{name:`Attempt ${validated.id}`,exact:true});await validRow.getByRole("button",{name:"Retry saving exact attempt",exact:true}).click();await expect(validRow).toContainText("completed");await expect(page.locator("iframe")).toHaveAttribute("srcdoc",code);await page.reload();await validRow.getByRole("button",{name:"Open saved result",exact:true}).click();await expect(page.locator("iframe")).toHaveAttribute("srcdoc",code);await expect(page.frameLocator("iframe").locator("canvas")).toBeVisible();
});


// Distinct private sources, unlike the repeated-one-source renderer benchmark
// above. Real canonical controller/Worker/HTTP/PG; not the compiled Next UI.
test("distinct-source preparation profiles 4/16/32 stereo ten-second assets without hiding browser memory behind decoded-byte counters", { timeout: 1800000 }, async t => {
  const arrangements = [];
  for (let index = 0; index < 32; index++) {
    const { remixId } = await source(false, 10, 220 + index * 17);
    const result = await api(`/api/remixes/${remixId}`);
    arrangements.push({ ...result.remix, tracks: result.tracks });
  }
  const trackRows = arrangements.map(state => state.tracks[0]);
  assert.equal(new Set(trackRows.map(track => track.stemAssetId)).size, 32);
  const requestedCounts = process.env.ARENA_MEMORY_COUNTS;
  const profileCounts = requestedCounts ? requestedCounts.split(",").map(value => Number(value.trim())) : [4, 16, 32];
  assert.ok(profileCounts.length > 0 && profileCounts.every(count => [4, 16, 32].includes(count)), "ARENA_MEMORY_COUNTS must contain only 4, 16, and/or 32");
  const repeats = Number(process.env.ARENA_MEMORY_REPEATS ?? "1");
  assert.ok(Number.isInteger(repeats) && repeats >= 1 && repeats <= 5, "ARENA_MEMORY_REPEATS must be an integer from 1 to 5");
  const cdp = await browser.newBrowserCDPSession();
  const processes = await cdp.send("SystemInfo.getProcessInfo");
  const pid = processes.processInfo.find(process => process.type === "browser")?.id;
  const { readdir, readFile } = await import("node:fs/promises");
  async function samplePss() {
    if (process.platform !== "linux" || !pid) return null;
    const entries = (await readdir("/proc")).filter(name => /^\d+$/.test(name));
    const parents = await Promise.all(entries.map(async name => {
      try { const stat = await readFile(`/proc/${name}/stat`, "utf8"); return [Number(name), Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1])]; }
      catch { return null; }
    }));
    const children = new Set([pid]);
    for (let changed = true; changed;) { changed = false; for (const item of parents) if (item && children.has(item[1]) && !children.has(item[0])) { children.add(item[0]); changed = true; } }
    const values = await Promise.all([...children].map(async id => {
      try { return Number((await readFile(`/proc/${id}/smaps_rollup`, "utf8")).match(/^Pss:\s+(\d+)/m)?.[1] ?? 0) * 1024; } catch { return 0; }
    }));
    return values.reduce((sum, value) => sum + value, 0);
  }
  for (const count of profileCounts) for (let repeat = 1; repeat <= repeats; repeat++) {
    const page = await browser.newPage();
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    let peak = await samplePss(), busy = false;
    const timer = setInterval(async () => { if (busy) return; busy = true; try { const pss = await samplePss(); if (pss !== null) peak = Math.max(peak ?? 0, pss); } finally { busy = false; } }, 50);
    let fixedRuntimeFloorPssBytes = null;
    try {
      page.setDefaultNavigationTimeout(120000);
      await page.goto(`${origin}/?room=preparation`);
      await page.waitForFunction(() => typeof window.measurePreparation === "function");
      const floorSamples = [];
      for (let sample = 0; sample < 5; sample++) {
        await new Promise(resolve => setTimeout(resolve, 50));
        const pss = await samplePss();
        if (pss !== null) floorSamples.push(pss);
      }
      floorSamples.sort((a, b) => a - b);
      fixedRuntimeFloorPssBytes = floorSamples.length ? floorSamples[Math.floor(floorSamples.length / 2)] : null;
      const state = { ...arrangements[0], tracks: trackRows.slice(0, count).map(track => ({ ...track, volume: 1 / count })) };
      const implementation = process.env.ARENA_MEMORY_VARIANT ?? process.env.ARENA_MEMORY_CANDIDATE ?? "baseline";
      const result = await page.evaluate(input => window.measurePreparation(input.state, true, input.expectWorkerEviction),
        { state, expectWorkerEviction: ["prototype3", "prototype4"].includes(implementation) });
      // Keep the real open preparation/controller alive. Report natural retained
      // memory separately from the sampled high-water mark. GC-assisted retained
      // memory is a diagnostic, never a claim about ordinary cold peak.
      // Measure ordinary post-render residency after one quarter-second of
      // idle time; the following forced-GC sample remains diagnostic only.
      await new Promise(resolve => setTimeout(resolve, 250));
      const retainedPssBytes = await samplePss();
      const pageCdp = await page.context().newCDPSession(page);
      await pageCdp.send("HeapProfiler.collectGarbage");
      const gcRetainedPssBytes = await samplePss();
      await pageCdp.detach();
      console.log(JSON.stringify({ kind: "distinct-source-canonical-worker", fixedRuntimeFloorPssBytes,
        fixedRuntimeFloorSamplesPssBytes: floorSamples, retainedPssBytes, gcRetainedPssBytes,
        implementation, sources: count, repeat, seconds: 10, sampledWholeBrowserPeakPssBytes: peak, ...result,
        scope: "real controller/Worker, synthetic owned PCM, 50ms descendant-tree PSS; not compiled Next hydration, inference, Electron or instantaneous peak",
        fixedRuntimeFloorScope: "Loaded fixture page before AudioContext, Worker, or source PCM; not compiled Next hydration." }));
      assert.ok(Number.isFinite(fixedRuntimeFloorPssBytes), "fixed browser/runtime floor PSS is missing");
      assert.equal(result.frames, 441000);
      assert.equal(result.latestEditError, 0);
      const expectedBytes = count * 441000 * 2 * 4;
      assert.equal(result.replaySame, true);
      assert.equal(result.replayFetches, 0); assert.equal(result.replayDecodeCalls, 0);
      assert.equal(result.masterEditFetches, 0); assert.equal(result.masterEditDecodeCalls, 0);
      assert.equal(result.masterMixCacheHit, true); assert.ok(result.masterRetainedMixBytes > 0);
      assert.equal(result.trackEditFetches, 0); assert.equal(result.trackEditMixCacheHit, false);
      if (implementation === "prototype4") {
        assert.equal(result.trackEditDecodeCalls, count);
        assert.equal(result.trackEditWorkerSourceBytes, 0);
      } else {
        assert.equal(result.trackEditDecodeCalls, 0);
        assert.equal(result.trackEditWorkerSourceBytes, expectedBytes);
      }
      assert.equal(result.postIdleMasterEditFetches, 0); assert.equal(result.postIdleMasterEditDecodeCalls, 0);
      assert.equal(result.postIdleMasterMixCacheHit, true);
      assert.equal(result.postIdleTrackEditFetches, 0);
      if (implementation === "prototype4") {
        assert.equal(result.coldWorkerSourceBytes, 0);
        assert.equal(result.coldEvictedSourceBytes, expectedBytes);
        assert.equal(result.peakWorkerSourceBytes, 441000 * 2 * 4);
        assert.equal(result.workerSourceBytesAfterTrack.length, count);
        assert.ok(result.workerSourceBytesAfterTrack.every(track => track.sourceBytes === 0));
      } else {
        assert.equal(result.peakWorkerSourceBytes, expectedBytes);
      }
      assert.match(result.trackEditedPcmSha256, /^[a-f0-9]{64}$/);
      assert.match(result.postIdleMasterPcmSha256, /^[a-f0-9]{64}$/);
      assert.match(result.postIdleTrackPcmSha256, /^[a-f0-9]{64}$/);
      if (implementation === "prototype3") {
        assert.equal(result.diagnostics.sourceBytes, 0);
        assert.equal(result.diagnostics.workerSourcesEvicted, true);
        assert.equal(result.diagnostics.evictedSourceBytes, expectedBytes);
        assert.equal(result.masterWorkerSourceBytes, expectedBytes);
        assert.equal(result.idleWorkerSourceBytes, 0);
        assert.equal(result.idleWorkerSourcesEvicted, true);
        assert.equal(result.postIdleMasterWorkerSourceBytes, 0);
        assert.equal(result.postIdleTrackEditDecodeCalls, count);
        assert.equal(result.postIdleTrackEditDecodeMs > 0, true);
        assert.equal(result.postIdleTrackWorkerSourceBytes, expectedBytes);
      } else if (implementation === "prototype4") {
        assert.equal(result.diagnostics.sourceBytes, 0);
        assert.equal(result.diagnostics.workerSourcesEvicted, true);
        assert.equal(result.diagnostics.evictedSourceBytes, expectedBytes);
        assert.equal(result.masterWorkerSourceBytes, 0);
        assert.equal(result.idleWorkerSourceBytes, 0);
        assert.equal(result.idleWorkerSourcesEvicted, true);
        assert.equal(result.postIdleMasterWorkerSourceBytes, 0);
        assert.equal(result.trackEditDecodeCalls, count);
        assert.ok(result.trackEditDecodeMs > 0);
        assert.equal(result.postIdleTrackEditDecodeCalls, count);
        assert.equal(result.postIdleTrackWorkerSourceBytes, 0);
      } else {
        assert.equal(result.diagnostics.sourceBytes, expectedBytes);
        assert.equal(result.idleWorkerSourceBytes, expectedBytes);
        assert.equal(result.idleWorkerSourcesEvicted, false);
        assert.equal(result.postIdleMasterWorkerSourceBytes, expectedBytes);
        assert.equal(result.postIdleTrackEditDecodeCalls, 0);
      }
      if (["encoded-recovery", "prototype2", "prototype3", "prototype4"].includes(implementation)) {
        assert.equal(result.diagnostics.decodedBytes, 0);
        assert.ok(result.diagnostics.encodedRecoveryBytes > 0);
        assert.ok(result.diagnostics.encodedRecoveryBytes < expectedBytes * 0.9);
         assert.ok(result.diagnostics.encodedRecoveryBytes <= 128 * 1024 * 1024);
      } else {
        assert.equal(result.diagnostics.decodedBytes, implementation === "pr16" ? 0 : expectedBytes);
      }
      assert.match(result.pcmSha256, /^[a-f0-9]{64}$/);
      assert.match(result.editedPcmSha256, /^[a-f0-9]{64}$/);
      assert.ok(result.maximumGapMs < 250, `preparation-stage main-thread gap ${result.maximumGapMs}ms`);
      assert.ok(result.replayMs < 20);
      assert.deepEqual(errors, []);
    } finally { clearInterval(timer); await page.evaluate(() => window.releasePreparationMeasurement()).catch(() => {}); await page.close(); }
  }
  await cdp.detach();
});


test("P0 bank gate: actual separation publication, pinned session/donor playback, restart and decoded Studio export never combine generations", { timeout: 480000 }, async t => {
  const library = await import("../../src/lib/waveyard/library/service.ts");
  const sessions = await import("../../src/lib/waveyard/library/session-service.ts");
  const { handleSeparationJob } = await import("../../src/lib/waveyard/worker-local/separation.ts");
  const { getStorage } = await import("../../src/lib/waveyard/storage.ts");
  const { prepareArrangementPcm } = await import("../../src/lib/waveyard/arrangement-pcm.ts");
  const a = await source(false, 2, 1009), b = await source(false, 2, 1601);
  async function runBank(input, gain, mode = "complete") {
    const detail = await library.getTrack(owner, input.trackId);
    const [job] = await database.db.insert(schema.processingJobs).values({ projectId: input.projectId, sourceAssetId: detail.source.id, type: "separation", status: mode === "cancelled" ? "cancelled" : "queued", stage: "queued", model: "stems_4", requestedDevice: "cpu", idempotencyKey: crypto.randomUUID() }).returning();
    const payload = { processingJobId: job.id, projectId: job.projectId, sourceAssetId: job.sourceAssetId, model: "stems_4", requestedDevice: "cpu" };
    const deps = { db: database.db, openEngine: async () => ({ infer: async values => { if (mode === "failed") throw new Error("controlled inference seam failure"); return Float32Array.from(values, value => value * gain); }, release: async () => {}, resolvedDevice: "cpu" }) };
    if (mode === "failed") await assert.rejects(() => handleSeparationJob(payload, deps), /controlled inference seam failure/);
    else await handleSeparationJob(payload, deps);
    return { job, payload, deps };
  }
  const first = await runBank(a, .1), second = await runBank(a, .2), donor = await runBank(b, .15);
  const detail = await library.getTrack(owner, a.trackId);
  assert.equal(detail.banks.length, 2);
  assert.equal(detail.playback.assetIds.length, 0, "original eight-lane contamination must be refused, not hidden in UI");
  assert.ok(detail.selectionRequired);
  const { session } = await api("/api/library/sessions", "POST", { name: "Pinned bank processing gate (controlled inference seam, not genuine model)" });
  await api(`/api/library/sessions/${session.id}/tracks`, "POST", { trackId: a.trackId, bankId: first.job.id });
  const added = await api(`/api/library/sessions/${session.id}/tracks`, "POST", { trackId: a.trackId, bankId: second.job.id });
  assert.equal(added.session.tracks[0].stems.length, 4); assert.equal(added.session.tracks[1].stems.length, 4);
  const ids = added.session.tracks.map(item => item.playback.assetIds);
  assert.equal(new Set(ids.flat()).size, 8);
  const donorDetail = await library.getTrack(owner, b.trackId, { bankId: donor.job.id });
  const donorStem = donorDetail.stems.find(stem => stem.stemType === "drums");
  await api(`/api/library/sessions/${session.id}/swaps`, "POST", { sessionTrackId: added.session.tracks[0].id, stemType: "drums", toTrackId: b.trackId, toStemAssetId: donorStem.id, atSeconds: .5 });
  await runBank(a, .3); await runBank(b, .35);
  await runBank(a, .4, "failed"); await runBank(a, .5, "cancelled");
  const reread = await sessions.getSession(owner, session.id);
  assert.deepEqual(reread.tracks.map(item => item.playback.assetIds), ids);
  assert.equal(reread.swaps[0].toStemAssetId, donorStem.id);
  await handleSeparationJob(first.payload, first.deps); // terminal retry cannot replace assets
  assert.deepEqual((await sessions.getSession(owner, session.id)).tracks[0].playback.assetIds, ids[0]);
  const page = await browser.newPage(); t.after(() => page.close()); const errors = []; page.on("pageerror", e => errors.push(e.message));
  await page.goto(`${origin}/?room=listening&session=${session.id}`);
  const deck = page.getByTestId("session-deck-current");
  await expect(deck.locator("audio")).toHaveCount(4);
  await page.getByTestId("session-play").click();
  await expect.poll(() => deck.locator("audio").evaluateAll(els => els.every(el => !el.paused && el.currentTime > .1))).toBe(true);
  await expect(deck.locator('audio[aria-label="drums audio (swapped layer)"]')).toHaveAttribute("src", `/api/assets/${donorStem.id}`);
  await page.getByTestId("session-play").click();
  await page.goto(`${origin}/?room=preparation`); await f.stop(); await f.start();
  await page.goto(`${origin}/?room=listening&session=${session.id}`);
  await expect(deck.locator("audio")).toHaveCount(4);
  await expect(deck.locator('audio[aria-label="drums audio (swapped layer)"]')).toHaveAttribute("src", `/api/assets/${donorStem.id}`);
  const handoff = await sessions.sendSessionToStudio(owner, session.id);
  assert.equal(handoff.remixTrackCount, 8, "two explicit four-lane session items, not eight lanes per item");
  const arrangement = await api(`/api/remixes/${handoff.remixSessionId}`);
  const used = new Set(arrangement.tracks.flatMap(track => track.clips.map(clip => clip.stemAssetId)));
  assert.deepEqual(used, new Set([...ids.flat(), donorStem.id]));
  const decodedSources = new Map();
  for (const id of used) {
    const [stem] = await database.db.select().from(schema.stemAssets).where(eq(schema.stemAssets.id, id));
    const pcm = synth.decodeWav16(new Uint8Array(await readFile(getStorage().getLocalPath(stem.storageKey))));
    const channels = Array.from({ length: pcm.channels }, (_, channel) => Float32Array.from({length:pcm.samples.length/pcm.channels}, (_, frame) => pcm.samples[frame * pcm.channels + channel]));
    decodedSources.set(id, { sampleRate: pcm.sampleRate, length: channels[0].length, numberOfChannels: channels.length, getChannelData: channel => channels[channel] });
  }
  const expected = prepareArrangementPcm({ ...arrangement.remix, tracks: arrangement.tracks }, decodedSources, 44100);
  const version = await api(`/api/remixes/${handoff.remixSessionId}/versions`, "POST", { name: "Immutable bank export gate" });
  const output = await render(version.version.id);
  assert.ok(Math.abs(output.decoded.samples.length - expected.length) <= 2, "four-second render within one stereo PCM frame");
  let maximumError = 0; for (let i = 0; i < Math.min(expected.length, output.decoded.samples.length); i++) maximumError = Math.max(maximumError, Math.abs(expected[i] - output.decoded.samples[i]));
  assert.ok(maximumError < .0003, `decoded export must use exactly the pinned bank and donor: ${maximumError}`);
  const legacy = await sessions.createSession(owner, "Ambiguous legacy retained");
  const [item] = await database.db.insert(schema.listenSessionTracks).values({sessionId:legacy.id,trackId:a.trackId,position:0,stemMix:'{"drums":0.37}'}).returning();
  const unresolved = await sessions.getSession(owner, legacy.id); assert.ok(unresolved.tracks[0].selectionRequired); assert.equal(unresolved.tracks[0].playback, null);
  await assert.rejects(() => sessions.sendSessionToStudio(owner, legacy.id), /Resolve each bank/);
  await sessions.updateSessionTrack(owner, legacy.id, item.id, {bankId:first.job.id});
  const repaired = await sessions.getSession(owner, legacy.id); assert.deepEqual(repaired.tracks[0].playback.assetIds, ids[0]); assert.equal(repaired.tracks[0].stemMix.drums,.37);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({kind:"bank-identity-connected-gate", banks:3, lanesPerItem:4, pinnedDonor:donorStem.id, maximumExportError:maximumError, frames:output.decoded.samples.length/output.decoded.channels, scope:"actual processing/publication/PG/browser playback/restart/Studio/FFmpeg; controlled spectral inference seam, NOT genuine inference"}));
});

// Generated owned PCM + controlled public-provider transport. These assertions
// cover the actual UI/routes/storage/player; NOT live Archive/music/inference.
test("catalogue controlled HTTP → review/preview → actual import → reopened player; exact-file model import rejects corrupt bytes", async (t) => {
  const originalFetch=globalThis.fetch, oldModels=process.env.WAVEYARD_MODELS_DIR;
  const { MDX_MODELS }=await import("../../src/lib/waveyard/separation/mdx.ts");
  const spec=MDX_MODELS[0], originalSpec={...spec};
  const { createHash }=await import("node:crypto");
  const weightBytes=Buffer.alloc(2_000_000,13);
  Object.assign(spec,{sha256:createHash("sha256").update(weightBytes).digest("hex"),sizeBytes:weightBytes.length});
  process.env.WAVEYARD_MODELS_DIR=path.join(root,"controlled-owner-models");
  const pcm=synth.encodeWav16(Float32Array.from({length:44100*4},(_,i)=>0.2*Math.sin(Math.floor(i/2)*0.14)),44100);
  let downloads=0;
  catalogueProviderHandler=(url)=>{
    const pathname=url.pathname.replace("/archive-controlled","");
    if(pathname==="/advancedsearch.php")return Response.json({response:{docs:[{identifier:"owned-browser-fixture",title:"Owned browser contract",creator:"Arena acceptance",licenseurl:"https://creativecommons.org/publicdomain/zero/1.0/"}]}});
    if(pathname==="/metadata/owned-browser-fixture")return Response.json({metadata:{identifier:"owned-browser-fixture",title:"Owned browser contract",creator:"Arena acceptance",mediatype:"audio",licenseurl:"https://creativecommons.org/publicdomain/zero/1.0/"},files:[{name:"owned.wav",size:String(pcm.length)}]});
    if(pathname==="/download/owned-browser-fixture/owned.wav"){downloads++;return new Response(pcm,{headers:{"content-type":"audio/wav","content-length":String(pcm.length)}});}
    return new Response("not found",{status:404});
  };
  globalThis.fetch=(url,init)=>String(url).startsWith("https://archive.org/") ? originalFetch(`${origin}/archive-controlled${new URL(String(url)).pathname}${new URL(String(url)).search}`,init) : originalFetch(url,init);
  t.after(()=>{globalThis.fetch=originalFetch;catalogueProviderHandler=undefined;Object.assign(spec,originalSpec);if(oldModels===undefined)delete process.env.WAVEYARD_MODELS_DIR;else process.env.WAVEYARD_MODELS_DIR=oldModels;});
  const page=await browser.newPage();t.after(()=>page.close());page.setDefaultTimeout(15000);
  await page.route("https://archive.org/download/owned-browser-fixture/owned.wav",route=>route.fulfill({body:Buffer.from(pcm),contentType:"audio/wav"}));
  await page.goto(`${origin}/?room=catalogue`);
  await page.getByLabel("Find public audio",{exact:true}).fill("Owned");await page.getByRole("button",{name:"Search public audio",exact:true}).click();
  await page.getByRole("button",{name:"Review source / available audio",exact:true}).click();
  const acquire=page.getByRole("button",{name:"Import reviewed original audio",exact:true});await expect(acquire).toBeDisabled();assert.equal(downloads,0);
  await page.getByRole("checkbox",{name:/I reviewed the recording/}).check();
  const preview=page.getByLabel("Preview owned.wav",{exact:true});await preview.evaluate(audio=>audio.play());await expect.poll(()=>preview.evaluate(audio=>audio.currentTime)).toBeGreaterThan(0.05);
  await acquire.click();const link=page.getByRole("link",{name:"Open imported audio in Waveyard",exact:true});await expect(link).toBeVisible();
  const trackId=(await link.getAttribute("href")).split("/").pop();assert.equal(downloads,1);
  await page.goto(`${origin}/?room=player&track=${trackId}`);await expect(page.getByTestId("track-player")).toBeVisible();
  await page.locator(".wplayer-play").click();await expect(page.locator(".wplayer-play")).toHaveAttribute("aria-pressed","true");await expect.poll(async()=>Number(await page.getByRole("meter",{name:"Master level",exact:true}).getAttribute("aria-valuenow"))).toBeGreaterThan(0);await expect.poll(async()=>Number(await page.getByLabel("Seek",{exact:true}).inputValue())).toBeGreaterThan(0.05);await page.locator(".wplayer-play").click();
  await page.getByText("Source rights / attribution for this recording",{exact:true}).click();await expect(page.getByText(/Owned browser contract — Arena acceptance/)).toBeVisible();
  await page.reload();await page.getByText("Source rights / attribution for this recording",{exact:true}).click();await expect(page.getByText(/Owned browser contract — Arena acceptance/)).toBeVisible();
  const downloadEvent=page.waitForEvent("download");await page.getByRole("link",{name:"Save rights/attribution notice",exact:true}).click();const rightsDownload=await downloadEvent;assert.match(await readFile(await rightsDownload.path(),"utf8"),/creativecommons.org\/publicdomain\/zero/);
  const detail=await api(`/api/library/tracks/${trackId}`);assert.equal(detail.track.playback.kind,"source");assert.equal(detail.track.banks.length,0);
  const asset=await dispatch(new URL(`/api/assets/${detail.track.source.id}`,origin));assert.deepEqual(new Uint8Array(await asset.arrayBuffer()),pcm);
  await page.goto(`${origin}/?room=catalogue`);await page.getByText("Model sources, licences and exact-file import",{exact:true}).click();await page.getByRole("button",{name:"Inspect this machine’s model manifests",exact:true}).click();
  const fileInput=page.locator('input[type="file"]').first();await expect(fileInput).toBeDisabled();await page.getByRole("checkbox",{name:/I reviewed the source\/licensing/}).check();
  await fileInput.setInputFiles({name:"wrong.onnx",mimeType:"application/octet-stream",buffer:Buffer.alloc(weightBytes.length,7)});await expect(page.getByText(/does not match pinned/)).toBeVisible();
  await fileInput.setInputFiles({name:"controlled-contract-not-a-model.onnx",mimeType:"application/octet-stream",buffer:weightBytes});await expect(page.getByText(/Exact pinned bytes verified. No inference has run/)).toBeVisible();
  const { getModelFileStatus }=await import("../../src/lib/waveyard/separation/seed.ts");assert.equal((await getModelFileStatus(spec)).acquisition.kind,"owner-supplied-file");
});
