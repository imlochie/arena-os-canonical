/** Actual SessionExperience + canonical WebAudio + production API handlers +
 * PostgreSQL + verified private files. Controlled PCM is NOT trained inference
 * or subjective musical quality. The HTTP adapter is a test harness, not Next
 * rendering; compiled Next/desktop acceptance is a separate gate. */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { expect } from "@playwright/test";
import { missionPostgres } from "../../../../tests/helpers/mission-postgres";

function pcm(hz: number) {
  const frames = 44100 * 20, bytes = Buffer.alloc(44 + frames * 2);
  bytes.write("RIFF"); bytes.writeUInt32LE(bytes.length-8, 4); bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(44100, 24); bytes.writeUInt32LE(88200, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36); bytes.writeUInt32LE(frames*2, 40);
  for (let i = 0; i < frames; i++) bytes.writeInt16LE(Math.round(8192*Math.sin(2*Math.PI*hz*i/44100)), 44+i*2);
  return bytes;
}

test("live four-category UI audio selection, held monitoring, rejected save/retry and reload use production handlers and real PostgreSQL", { timeout: 60000 }, async t => {
  const cleanup: Array<() => unknown> = []; t.after(async () => { for (const close of cleanup.reverse()) await close(); });
  const postgres = await missionPostgres(); cleanup.push(() => postgres.close());
  const root = mkdtempSync(path.join(tmpdir(), "arena-live-stems-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  process.env.DATABASE_URL = postgres.url; process.env.WAVEYARD_STORAGE_DIR = path.join(root, "objects");
  const { db, pool } = await import("@/db"); cleanup.push(() => pool.end());
  const schema = await import("@/db/waveyardSchema");
  const service = await import("./service"), sessions = await import("./session-service");
  const { LOCAL_OWNER_ID: ownerId } = await import("../local-context");
  const { getStorage } = await import("../storage");
  const categories = ["vocals", "drums", "bass", "instruments"], gains = [.73, .41, .62, .91];
  const frequencies = [[220, 440, 660, 880], [1100, 1320, 1540, 1760]];
  const assets: string[][] = [], trackIds: string[] = [], inputs: unknown[] = [];
  for (const song of [0, 1]) {
    const sourceFile = path.join(root, `controlled-song-${song}.wav`); writeFileSync(sourceFile, pcm(200+song*100));
    const intake = await service.addTrackFromAudioFile({ ownerId, filePath: sourceFile, filename: `controlled-song-${song}.wav`, mimeType: "audio/wav" });
    trackIds.push(intake.track.id);
    const detail = (await service.getTrack(ownerId, intake.track.id))!;
    const [job] = await db.select().from(schema.processingJobs).where(eq(schema.processingJobs.sourceAssetId, detail.source!.id));
    // Explicit synthetic fixture publication, never labelled as learned output.
    await db.update(schema.processingJobs).set({ status: "complete", model: "controlled-pcm-fixture" }).where(eq(schema.processingJobs.id, job.id));
    assets[song] = [];
    for (const [i, stemType] of categories.entries()) {
      const storageKey = `controlled-live/${song}/${stemType}.wav`, bytes = pcm(frequencies[song][i]);
      const filename = getStorage().getLocalPath(storageKey)!; mkdirSync(path.dirname(filename), { recursive: true }); writeFileSync(filename, bytes);
      const checksumSha256 = createHash("sha256").update(bytes).digest("hex");
      const [asset] = await db.insert(schema.stemAssets).values({ projectId: intake.track.studioProjectId, sourceAssetId: detail.source!.id, separationJobId: job.id, stemType, engine: "controlled-pcm-fixture", model: "controlled-pcm-fixture", modelVersion: "test", storageKey, checksumSha256, durationSeconds: 20, sampleRate: 44100, channels: 1, codec: "pcm_s16le", format: "wav", fileSizeBytes: bytes.length }).returning();
      assets[song].push(asset.id); inputs.push({ song, stemType, assetId: asset.id, checksumSha256 });
    }
  }
  const created = await sessions.createSession(ownerId, "Real SQL live stem acceptance");
  for (const trackId of trackIds) await sessions.addTrackToSession({ ownerId, sessionId: created.id, trackId });
  const detail = await sessions.getSession(ownerId, created.id), member = detail.tracks[0];
  assert.equal(member.stems.length, 4); assert.equal(detail.tracks[1].stems.length, 4);
  await sessions.updateSessionTrack(ownerId, created.id, member.id, { stemMix: Object.fromEntries(categories.map((name, i) => [name, gains[i]])) });
  const routes = {
    session: await import("@/app/api/library/sessions/[id]/route"),
    swaps: await import("@/app/api/library/sessions/[id]/swaps/route"),
    state: await import("@/app/api/library/sessions/[id]/state/route"),
    edit: await import("@/app/api/library/sessions/[id]/tracks/[itemId]/route"),
    library: await import("@/app/api/library/tracks/route"),
    asset: await import("@/app/api/assets/[id]/route"),
  };
  const bundled = await build({ entryPoints: ["tests/acceptance/session-runtime.fixture.tsx"], bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", define: { "process.env": JSON.stringify({ NODE_ENV: "development" }) } });
  let rejectSelection = false;
  const requests: Array<{ method: string; url: string; status: number }> = [];
  const server = createServer(async (incoming, outgoing) => {
    try {
      const url = new URL(incoming.url!, "http://fixture"); let bytes = "";
      for await (const chunk of incoming) bytes += chunk;
      const request = new Request(url, { method: incoming.method, headers: incoming.headers as Record<string, string>, ...(["GET", "HEAD"].includes(incoming.method!) ? {} : { body: bytes }) });
      const parts = url.pathname.split("/"); let response: Response;
      const params = { params: Promise.resolve({ id: created.id }) };
      if (url.pathname === "/fixture.js") response = new Response(bundled.outputFiles[0].contents as BodyInit, { headers: { "content-type": "text/javascript" } });
      else if (parts[2] === "assets") response = await routes.asset.GET(request, { params: Promise.resolve({ id: parts[3] }) });
      else if (parts[3] === "tracks") response = await routes.library.GET(request);
      else if (parts[3] === "sessions" && parts[4] === created.id) {
        if (parts[5] === "swaps") response = rejectSelection ? Response.json({ error: "Controlled lost availability at HTTP save boundary" }, { status: 503 }) : incoming.method === "DELETE" ? await routes.swaps.DELETE(request, params) : await routes.swaps.POST(request, params);
        else if (parts[5] === "state") response = await routes.state.PUT(request, params);
        else if (parts[5] === "tracks" && parts[6]) response = await routes.edit.PATCH(request, { params: Promise.resolve({ id: created.id, itemId: parts[6] }) });
        else response = await routes.session.GET(request, params);
      } else if (url.pathname.startsWith("/api/")) response = Response.json({});
      else response = new Response('<!doctype html><div id="root"></div><script src="/fixture.js"></script>', { headers: { "content-type": "text/html" } });
      requests.push({ method: incoming.method!, url: url.pathname, status: response.status });
      const output = Buffer.from(await response.arrayBuffer());
      outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(output);
    } catch (error) { outgoing.writeHead(500); outgoing.end(String(error)); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || process.env.ARENA_ARCADE_CHROMIUM_PATH || undefined, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--autoplay-policy=no-user-gesture-required"] }); cleanup.push(() => browser.close());
  const page = await browser.newPage(); const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    const Native = AudioContext;
    (window as unknown as { laneContexts: unknown[] }).laneContexts = [];
    window.AudioContext = class extends Native {
      constructor(...args: ConstructorParameters<typeof AudioContext>) {
        super(...args); const stems: Array<{ node: AnalyserNode; element: HTMLMediaElement }> = [];
        let source: HTMLMediaElement | null = null;
        const nativeSource = this.createMediaElementSource.bind(this), nativeAnalyser = this.createAnalyser.bind(this);
        this.createMediaElementSource = element => { source = element; return nativeSource(element); };
        this.createAnalyser = () => { const node = nativeAnalyser(); if (source) { stems.push({ node, element: source }); source = null; } return node; };
        (window as unknown as { laneContexts: unknown[] }).laneContexts.push({ context: this, stems });
      }
    };
  });
  const selected: Record<string, number> = {};
  const observe = () => page.evaluate(({ assets, frequencies, categories }) => {
    const contexts = (window as unknown as { laneContexts: Array<{ context: AudioContext; stems: Array<{ node: AnalyserNode; element: HTMLMediaElement }> }> }).laneContexts;
    return Object.fromEntries(contexts.filter(({ context }) => context.state === "running").flatMap(({ context, stems }) => stems.flatMap(({ node, element }) => {
      const index = assets[0].findIndex(id => element.getAttribute("src") === `/api/assets/${id}`); if (index < 0) return [];
      const pcm = new Float32Array(node.fftSize); node.getFloatTimeDomainData(pcm);
      const amplitude = (hz: number) => { let re = 0, im = 0; for (let i = 0; i < pcm.length; i++) { const phase = 2*Math.PI*hz*i/context.sampleRate; re += pcm[i]*Math.cos(phase); im += pcm[i]*Math.sin(phase); } return 2*Math.hypot(re, im)/pcm.length; };
      return [[categories[index], [amplitude(frequencies[0][index]), amplitude(frequencies[1][index])]]];
    })));
  }, { assets, frequencies, categories });
  const assertAudio = async () => expect.poll(async () => { const signals = await observe(); return categories.every((name, i) => { const donor = selected[name] ?? 0; return signals[name] && Math.abs(signals[name][donor] - .25*Math.SQRT1_2*gains[i]) < .01 && signals[name][1-donor] < .015; }); }, { intervals: [10] }).toBe(true);
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  await page.goto(`${origin}/${created.id}`); await page.getByTestId("session-play").click(); await assertAudio();
  const observations: unknown[] = [];
  for (let repeat = 0; repeat < 2; repeat++) for (const category of categories) for (const donor of [1, 0]) {
    const before = await observe(); await page.getByRole("group", { name: `Source for ${category}`, exact: true }).getByRole("button").nth(donor).click();
    selected[category] = donor; await assertAudio(); const after = await observe();
    observations.push({ repeat, category, donor, before, after });
  }
  await expect(page.getByLabel("Stem selection save status")).toContainText("saved");
  rejectSelection = true;
  await page.getByRole("group", { name: "Source for vocals", exact: true }).getByRole("button").nth(1).click(); selected.vocals = 1; await assertAudio();
  await expect(page.getByLabel("Stem selection save status")).toContainText("error");
  let persisted = await sessions.getSession(ownerId, created.id);
  assert.equal(persisted.swaps.filter(swap => swap.stemType === "vocals").at(-1)!.toStemAssetId, assets[0][0], "503 did not save the audible B selection");
  rejectSelection = false; await page.getByRole("button", { name: "Retry saving stem selections", exact: true }).click();
  await expect(page.getByLabel("Stem selection save status")).toContainText("saved");
  persisted = await sessions.getSession(ownerId, created.id); assert.equal(persisted.swaps.filter(swap => swap.stemType === "vocals").at(-1)!.toStemAssetId, assets[1][0]);
  await page.reload(); await page.getByTestId("session-play").click(); await assertAudio();
  const hold = page.getByRole("button", { name: "Hold to isolate vocals", exact: true }); await hold.hover(); await page.mouse.down();
  await expect.poll(async () => { const signal = await observe(); return signal.vocals?.[1] > .1 && categories.filter(name => name !== "vocals").every(name => signal[name]?.every(value => value < .001)); }).toBe(true);
  await page.mouse.move(1, 1); await page.mouse.up(); await assertAudio();
  persisted = await sessions.getSession(ownerId, created.id); assert.deepEqual(persisted.tracks[0].stemMix, Object.fromEntries(categories.map((name, i) => [name, gains[i]])));
  const stale = await routes.swaps.POST(new Request("http://fixture/stale", { method: "POST", body: JSON.stringify({ sessionTrackId: member.id, stemType: "vocals", fromStemAssetId: assets[1][0], toTrackId: trackIds[1], toStemAssetId: assets[1][0], atSeconds: 0 }) }), { params: Promise.resolve({ id: created.id }) });
  assert.equal(stale.status, 409); assert.match((await stale.json()).error, /target source bank changed/);
  assert.equal((await sessions.getSession(ownerId, created.id)).swaps.length, persisted.swaps.length, "stale source context did not insert a selection");
  await page.getByRole("button", { name: /Review removal of saved swaps for controlled-song-0/, exact: false }).click();
  await page.getByRole("button", { name: "Clear saved swap records", exact: true }).click();
  await expect(page.getByTestId("session-status")).toContainText("explicitly cleared");
  assert.equal((await sessions.getSession(ownerId, created.id)).swaps.length, 0);
  await page.getByLabel(`Bank for ${member.id}`, { exact: true }).selectOption("source");
  await expect(page.getByTestId("session-status")).toContainText("Audio choice saved");
  assert.equal((await sessions.getSession(ownerId, created.id)).tracks[0].playback?.kind, "source", "clearing swaps unblocks existing bank changes without deleting audio");
  assert.deepEqual(errors, []); assert.ok(requests.some(request => request.url.includes("/assets/") && request.status === 206), "real verified range-serving route executed");
  const evidence = { kind: "actual-ui-production-handler-postgresql-audio", inputs, observations, persisted, requests, browser: browser.version(), limitations: ["synthetic PCM fixture publication, not inference/music quality", "test HTTP adapter, not Next rendering/Electron", "reload after ACK, not abrupt kill"] };
  const evidenceDir = process.env.ARENA_LIVE_STEM_EVIDENCE_DIR ?? path.join(".data", "acceptance", "live-stems", `${Date.now()}-${process.pid}`); mkdirSync(evidenceDir, { recursive: true });
  const filename = path.join(evidenceDir, "ui-api-pg-audio.json"); writeFileSync(filename, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ kind: evidence.kind, filename, sha256: createHash("sha256").update(readFileSync(filename)).digest("hex"), observations: observations.length, limitations: evidence.limitations }));
});
