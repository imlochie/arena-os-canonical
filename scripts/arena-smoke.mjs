import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const require = createRequire(new URL("../artifacts/api-server/package.json", import.meta.url));
const { chromium } = require("playwright-core");
const arenaRequire = createRequire(new URL("../artifacts/arenaforge/package.json", import.meta.url));
const JSZip = arenaRequire("jszip");
const base = process.env.TEST_BASE_URL || "http://localhost:80";
const output = new URL("../generated-artifacts/arena-smoke/", import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || "/repl/tools/bin/chromium",
  headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const context = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  serviceWorkers: "block",
});
await context.addInitScript(() => {
  if (window === window.top) {
    if (localStorage.getItem("af_local_mode") === null) localStorage.setItem("af_local_mode", "1");
    if (localStorage.getItem("af_ephemeral") === null) localStorage.setItem("af_ephemeral", "0");
    if (localStorage.getItem("af_key_openrouter") === null) localStorage.setItem("af_key_openrouter", "arena-smoke-placeholder");
  }
});
let page = await context.newPage();
const errors = [];
page.on("pageerror", err => errors.push(err.message));
const report = [];
function makePcmWav(frequency, amplitude, durationSeconds = 8) {
  const sampleRate = 16_000;
  const sampleCount = sampleRate * durationSeconds;
  const pcm = Buffer.alloc(sampleCount * 2);
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = Math.sin((2 * Math.PI * frequency * index) / sampleRate) * amplitude;
    pcm.writeInt16LE(Math.round(sample * 32_767), index * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
const reaAnalysisSmoke = execFileSync(
  "pnpm",
  ["--filter", "@workspace/scripts", "exec", "tsx", "./rea-analysis-smoke.ts"],
  { encoding: "utf8", maxBuffer: 1024 * 1024 },
).trim();
assert(reaAnalysisSmoke.includes("without executing source"), "REA analysis smoke test did not complete successfully");
report.push(reaAnalysisSmoke);
let createdProject;
let createdSubscriptionName;
let createdSpaceId;
let battleId;
let fallbackBattleId;
function assertBlind(payload) {
  if (!payload || typeof payload !== "object") return;
  if (Array.isArray(payload)) { payload.forEach(assertBlind); return; }
  for (const [key, value] of Object.entries(payload)) {
    if (key === "runtimeA" || key === "runtimeB") {
      if (!value) continue;
      for (const field of ["modelId", "requestedModelId", "provider", "backend", "via", "fallbackFrom", "note"]) {
        assert(!(field in value), `Pre-vote ${key} leaked ${field}`);
      }
      assert(value.runtimeLevel, "Execution level must remain visible");
      assert.equal(typeof value.fallback, "boolean");
    }
    if (key === "modelAId" || key === "modelBId") assert.equal(value, "???");
    if (key === "assistantAId" || key === "assistantBId") assert.equal(value, null);
    assertBlind(value);
  }
}
function makeHomebrewNesRom() {
  // Original test-only NROM: paints the NES background palette, then loops.
  // This is generated from hand-authored 6502 opcodes; it contains no game
  // assets or copyrighted code.
  const header = Buffer.alloc(16);
  Buffer.from([0x4e, 0x45, 0x53, 0x1a, 1, 1, 0, 0]).copy(header);
  const prg = Buffer.alloc(0x4000, 0xea);
  Buffer.from([
    0x78, 0xd8, 0xa2, 0x40, 0x8e, 0x17, 0x40, 0xa2, 0xff, 0x9a, 0xe8,
    0x8e, 0x00, 0x20, 0x8e, 0x01, 0x20, 0x2c, 0x02, 0x20, 0x10, 0xfb,
    0xa9, 0x3f, 0x8d, 0x06, 0x20, 0xa9, 0x00, 0x8d, 0x06, 0x20, 0xa9,
    0x21, 0x8d, 0x07, 0x20, 0xa9, 0x08, 0x8d, 0x01, 0x20, 0x4c, 0x16,
    0x80,
  ]).copy(prg);
  Buffer.from([0x00, 0x80, 0x00, 0x80, 0x00, 0x80]).copy(prg, 0x3ffa);
  const chr = Buffer.alloc(0x2000);
  return Buffer.concat([header, prg, chr]);
}
function makeHomebrewGameBoyRom() {
  // Original 32 KiB Game Boy cartridge smoke fixture. It contains no
  // third-party game code, art, or assets.
  const rom = Buffer.alloc(0x8000);
  rom.set([0x00, 0xc3, 0x50, 0x01], 0x100); // NOP; JP $0150
  Buffer.from("ARCADE OPEN", "ascii").copy(rom, 0x134);
  rom[0x147] = 0x00; // ROM-only cartridge
  rom[0x148] = 0x00; // 32 KiB
  rom[0x149] = 0x00; // no cartridge RAM
  let headerChecksum = 0;
  for (let address = 0x134; address <= 0x14c; address += 1) {
    headerChecksum = (headerChecksum - rom[address] - 1) & 0xff;
  }
  rom[0x14d] = headerChecksum;
  rom.set([
    0x3e, 0xe4,       // LD A,$E4
    0xe0, 0x47,       // LDH ($FF47),A ; palette
    0x3e, 0x91,       // LD A,$91
    0xe0, 0x40,       // LDH ($FF40),A ; enable LCD
    0x18, 0xfe,       // loop
  ], 0x150);
  return rom;
}
async function json(url, options = {}) {
  const res = await context.request.fetch(base + url, options);
  assert(res.ok(), `${options.method || "GET"} ${url}: ${res.status()} ${await res.text()}`);
  return res.json();
}
try {
  await page.goto(base + "/", { waitUntil: "networkidle" });
  await page.getByPlaceholder("Ask anything… two anonymous fighters answer side-by-side, streamed live. You judge. (Ctrl+Enter to send)").fill("List three practical ways to organize a small recording studio.");
  const responsePromise = page.waitForResponse(res => res.url().includes("/api/battles/stream") && res.request().method() === "POST");
  await page.getByRole("button", { name: "⚔️ Start battle", exact: true }).click();
  const streamResponse = await responsePromise;
  assert(streamResponse.ok(), "Streaming battle request failed");
  await page.getByRole("button", { name: /A wins/ }).waitFor({ state: "visible", timeout: 30000 });
  const stream = await streamResponse.text();
  for (const line of stream.split("\n").filter(line => line.startsWith("data: "))) {
    assertBlind(JSON.parse(line.slice(6)));
  }
  battleId = stream.match(/"battleId"\s*:\s*"([^"]+)"/)?.[1] || stream.match(/"id"\s*:\s*"([^"]+)"/)?.[1];
  assert(battleId);
  assertBlind(await json(`/api/battles/${battleId}`));
  assertBlind(await json(`/api/page-data/battles/${battleId}`));
  const beforeVote = await json("/api/battles");
  assertBlind(beforeVote.battles.find(battle => battle.id === battleId));
  const votePromise = page.waitForResponse(res => /\/vote$/.test(res.url()) && res.request().method() === "POST");
  await page.getByRole("button", { name: /A wins/ }).click();
  const voteResponse = await votePromise;
  assert(voteResponse.ok(), "Vote request failed");
  const voted = await voteResponse.json();
  battleId ||= voted.battle?.id;
  assert(battleId, "No battle id returned");
  const saved = await json(`/api/battles/${battleId}`);
  assert.equal(saved.battle.winner, "a");
  assert.equal(saved.blind, false);
  assert(saved.messages.length >= 3);
  await page.screenshot({ path: new URL("battle.jpg", output).pathname, fullPage: true });
  report.push("Local-only streaming battle, both responses, vote, reveal, and persisted thread passed.");
  await page.goto(`${base}/battles/${battleId}`, { waitUntil: "networkidle" });
  await page.getByText("List three practical ways to organize a small recording studio.", { exact: false }).first().waitFor();
  assert(!(await page.locator("body").innerText()).includes("Could not load"));
  report.push("Shared battle detail survives direct navigation.");
  // Remote selections under Local Mode must fall back without leaking the
  // requested identities through nested runtime metadata or free-form notes.
  const fallback = await json("/api/battles", { method: "POST", data: {
    prompt: "Give two practical tips for recording a guitar.", category: "general", localOnly: true,
    fighterA: { type: "model", id: "openai" }, fighterB: { type: "model", id: "mistral" },
  } });
  fallbackBattleId = fallback.battle.id;
  assertBlind(fallback);
  assert.equal(fallback.battle.runtimeA.fallback, true);
  assert.equal(fallback.battle.runtimeB.fallback, true);
  const fallbackDetail = await json(`/api/battles/${fallbackBattleId}`);
  assertBlind(fallbackDetail);
  assertBlind(await json(`/api/page-data/battles/${fallbackBattleId}`));
  assertBlind(await json(`/api/battles/${fallbackBattleId}/followup`, { method: "POST", data: { message: "Make that shorter.", localOnly: true } }));
  const ephemeral = await json("/api/battles", { method: "POST", data: {
    prompt: "Suggest a simple recording checklist.", category: "general", localOnly: true, ephemeral: true,
    fighterA: { type: "model", id: "openai" }, fighterB: { type: "model", id: "mistral" },
  } });
  assertBlind(ephemeral);
  assert(ephemeral.battle.revealToken);
  const revealedFallback = await json(`/api/battles/${fallbackBattleId}/vote`, { method: "POST", data: { winner: "a" } });
  assert.equal(revealedFallback.battle.winner, "a");
  const afterFallbackVote = await json(`/api/battles/${fallbackBattleId}`);
  assert(afterFallbackVote.battle.runtimeA.fallbackFrom.modelId);
  report.push("Pre-vote SSE, history, detail, page-data, follow-up, and ephemeral payloads hide runtime identities, including local-mode fallback; voting restores full diagnostics.");
  const project = await json("/api/projects", { method: "POST", data: { name: `Migration smoke ${Date.now()}`, description: "Temporary migration verification", emoji: "🧪" } });
  createdProject = project.project.id;
  await page.goto(`${base}/projects/${createdProject}`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: new RegExp(project.project.name) }).first().waitFor();
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("heading", { name: new RegExp(project.project.name) }).first().waitFor();
  await json(`/api/projects/${createdProject}`, { method: "PUT", data: { name: "Migration smoke updated", description: "Updated" } });
  const updated = await json(`/api/projects/${createdProject}`);
  assert.equal(updated.project.name, "Migration smoke updated");
  report.push("Project create, detail, reload, update passed.");
  for (const path of ["/chat", "/rooms", "/rooms/assistant", "/command", "/leaderboard", "/assistants", "/studio", "/waveyard", "/waveyard/create", "/waveyard/discover", "/spaces", "/college", "/privacy"]) {
    await page.goto(base + path, { waitUntil: "networkidle" });
    const text = await page.locator("body").innerText();
    assert(!text.includes("Something went wrong"), `${path} crashed`);
    assert(!text.includes("Replit Agent is building"), `${path} shows scaffold`);
    assert(text.length > 150, `${path} is blank`);
    report.push(`${path} loaded.`);
  }
  let mockStemState = "rejected";
  let mockRetryCount = 0;
  let mockNotStartedState = "not-started";
  let mockStartCount = 0;
  let mockNotStartedRating = 0;
  let uploadAttempts = 0;
  const uploadAttemptNames = [];
  const recoveryTrack = {
    id: "arena-smoke-stem-recovery",
    title: "Retryable track",
    artist: "Smoke test",
    album: "",
    durationSeconds: 90,
    playCount: 0,
    rating: 0,
    labels: [],
    lastPlayedAt: null,
    addedAt: new Date().toISOString(),
    studioProjectId: "arena-smoke-stem-project",
  };
  const notStartedTrack = {
    ...recoveryTrack,
    id: "arena-smoke-stem-not-started",
    title: "Not started track",
    studioProjectId: "arena-smoke-not-started-project",
  };
  const mockTrackPayload = () => ({
    tracks: [
      {
        ...recoveryTrack,
        stemAvailability: mockStemState === "rejected"
          ? { status: "rejected", reason: "Worker rejected the job.", retryJobId: "arena-smoke-stem-job" }
          : mockStemState === "processing"
            ? {
                status: "processing",
                reason: "Stem separation is still running.",
                stage: "separating",
                progress: { percent: 36, phase: "2/4" },
              }
            : { status: "separated", stemCount: 4 },
      },
      {
        ...notStartedTrack,
        rating: mockNotStartedRating,
        stemAvailability: mockNotStartedState === "processing"
          ? { status: "processing", reason: "Separation is running." }
          : mockNotStartedState === "separated"
            ? { status: "separated", stemCount: 4 }
            : { status: "not-started", reason: "No job started." },
      },
    ],
  });
  const liveSessionId = "arena-smoke-live-swap";
  const liveSessionTrackId = "arena-smoke-live-session-track";
  const liveCurrentTrackId = "arena-smoke-live-current-track";
  const liveDonorTrackId = "arena-smoke-live-donor-track";
  const liveDrumsOnlyTrackId = "arena-smoke-live-drums-only-track";
  const liveCamelotTrackId = "arena-smoke-live-camelot-track";
  const liveVocalsAssetId = "arena-smoke-live-vocals";
  const liveDrumsAssetId = "arena-smoke-live-drums";
  const liveDonorVocalsAssetId = "arena-smoke-live-donor-vocals";
  const liveCamelotSourceAssetId = "arena-smoke-live-camelot-source";
  const liveCurrentItem = {
    id: liveSessionTrackId,
    position: 0,
    queueItemId: null,
    track: { id: liveCurrentTrackId, title: "Live source track", artist: "Smoke test", durationSeconds: 8 },
    sourceAssetId: null,
    stems: [
      { id: liveVocalsAssetId, stemType: "vocals", engine: "smoke-test", durationSeconds: 8 },
      { id: liveDrumsAssetId, stemType: "drums", engine: "smoke-test", durationSeconds: 8 },
    ],
    playback: { kind: "stems", assetIds: [liveVocalsAssetId, liveDrumsAssetId] },
    stemMix: { vocals: 1, drums: 1 },
    transition: { mode: "manual", crossfadeSeconds: 0, keepStems: [] },
    analysis: { bpm: 120, musicalKey: "C major", beatGridMs: [0, 500, 1000, 1500] },
  };
  const liveSessionTracks = [liveCurrentItem];
  let liveSwap = null;
  let liveSwapRequestCount = 0;
  let liveSwapDeleteRequestCount = 0;
  let liveTrackAddRequestCount = 0;
  let liveTrackPatchRequestCount = 0;
  let liveDonorFetchCount = 0;
  let signalFirstDonorFetchStarted;
  const firstDonorFetchStarted = new Promise(resolve => { signalFirstDonorFetchStarted = resolve; });
  let releaseFirstDonorFetch;
  const firstDonorFetchRelease = new Promise(resolve => { releaseFirstDonorFetch = resolve; });
  let resolveIsolatedMixSave;
  const isolatedMixSaved = new Promise(resolve => { resolveIsolatedMixSave = resolve; });
  let mockLiveSessionActive = false;
  const liveSessionPayload = () => structuredClone({
    id: liveSessionId,
    name: "Live swap acceptance",
    currentSessionTrackId: liveSessionTrackId,
    positionSeconds: 0,
    tracks: liveSessionTracks,
    swaps: liveSwap === null ? [] : [liveSwap],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const liveLibraryPayload = () => ({
    tracks: [
      { ...recoveryTrack, id: liveCurrentTrackId, title: "Live source track", durationSeconds: 8, analysis: { status: "complete", bpm: 120, musicalKey: "C major" }, stemAvailability: { status: "separated", stemCount: 2, stemTypes: ["vocals", "drums"] } },
      { ...recoveryTrack, id: liveDonorTrackId, title: "Donor track", durationSeconds: 8, analysis: null, stemAvailability: { status: "separated", stemCount: 1, stemTypes: ["vocals"] } },
      { ...recoveryTrack, id: liveDrumsOnlyTrackId, title: "Drums-only separated track", durationSeconds: 8, analysis: null, stemAvailability: { status: "separated", stemCount: 1, stemTypes: ["drums"] } },
      { ...recoveryTrack, id: liveCamelotTrackId, title: "Camelot library match", artist: "Smoke test", durationSeconds: 8, analysis: { status: "complete", bpm: 120, musicalKey: "A minor" }, stemAvailability: { status: "source-only", reason: "Separation has not started." } },
    ],
  });
  const quietStemWav = makePcmWav(440, 0.08);
  const drumStemWav = makePcmWav(110, 0.25);
  const donorStemWav = makePcmWav(880, 0.8);
  await context.route("**/api/library/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname === `/api/library/sessions/${liveSessionId}` && route.request().method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ session: liveSessionPayload() }) });
    } else if (url.pathname === `/api/library/sessions/${liveSessionId}/state` && route.request().method() === "PUT") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ saved: true }) });
    } else if (url.pathname.startsWith(`/api/library/sessions/${liveSessionId}/tracks/`) && route.request().method() === "PATCH") {
      const itemId = url.pathname.split("/").at(-1);
      const item = liveSessionTracks.find(candidate => candidate.id === itemId);
      assert(item, `Cannot persist a mix for missing session item ${itemId}`);
      const request = route.request().postDataJSON();
      if (request.stemMix) item.stemMix = { ...request.stemMix };
      if (request.transition) item.transition = { ...request.transition };
      liveTrackPatchRequestCount += 1;
      if (item.id === liveSessionTrackId && request.stemMix?.drums === 0) resolveIsolatedMixSave();
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ session: liveSessionPayload() }) });
    } else if (/^\/api\/library\/sessions\/[^/]+\/state$/.test(url.pathname) && route.request().method() === "PUT") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ saved: true }) });
    } else if (/^\/api\/library\/sessions\/[^/]+$/.test(url.pathname) && route.request().method() === "GET") {
      await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Session not found." }) });
    } else if (url.pathname === `/api/library/sessions/${liveSessionId}/tracks` && route.request().method() === "POST") {
      const request = route.request().postDataJSON();
      assert.equal(request.trackId, liveCamelotTrackId);
      assert.equal(request.position, 1, "a library cue must be inserted immediately after the current song");
      liveTrackAddRequestCount += 1;
      liveSessionTracks.splice(1, 0, {
        ...liveCurrentItem,
        id: "arena-smoke-live-camelot-session-track",
        position: 1,
        track: { id: liveCamelotTrackId, title: "Camelot library match", artist: "Smoke test", durationSeconds: 8 },
        stems: [],
        playback: { kind: "source", assetIds: [liveCamelotSourceAssetId] },
        stemMix: {},
        analysis: { bpm: 120, musicalKey: "A minor", beatGridMs: [0, 500, 1000, 1500] },
      });
      liveSessionTracks.forEach((item, index) => { item.position = index; });
      await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ session: liveSessionPayload() }) });
    } else if (url.pathname === `/api/library/sessions/${liveSessionId}/swaps` && route.request().method() === "POST") {
      const request = route.request().postDataJSON();
      assert.equal(request.sessionTrackId, liveSessionTrackId);
      assert.equal(request.stemType, "vocals");
      assert.equal(request.toTrackId, liveDonorTrackId);
      liveSwapRequestCount += 1;
      liveSwap = {
        id: "arena-smoke-live-swap-record",
        sessionTrackId: liveSessionTrackId,
        stemType: "vocals",
        fromTrackId: liveCurrentTrackId,
        toTrackId: liveDonorTrackId,
        atSeconds: request.atSeconds,
        createdAt: new Date().toISOString(),
        donorTrack: {
          id: liveDonorTrackId,
          title: "Donor track",
          stems: [{ id: liveDonorVocalsAssetId, stemType: "vocals", durationSeconds: 8 }],
        },
      };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ session: liveSessionPayload() }) });
    } else if (url.pathname === `/api/library/sessions/${liveSessionId}/swaps` && route.request().method() === "DELETE") {
      assert.equal(url.searchParams.get("swapId"), liveSwap?.id, "cancelling removes the exact pending live swap");
      liveSwapDeleteRequestCount += 1;
      liveSwap = null;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ session: liveSessionPayload() }) });
    } else if (url.pathname.endsWith("/separation") && route.request().method() === "POST") {
      mockStartCount += 1;
      mockNotStartedState = "processing";
      setTimeout(() => { mockNotStartedState = "separated"; }, 4000);
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({ state: "queued", jobId: "arena-smoke-new-separation" }),
      });
    } else if (url.pathname === "/api/library/tracks" && route.request().method() === "POST") {
      uploadAttempts += 1;
      const multipart = route.request().postDataBuffer()?.toString("latin1") ?? "";
      uploadAttemptNames.push(multipart.match(/filename="([^"]+)"/)?.[1] ?? "");
      if (uploadAttempts < 3) {
        await new Promise(resolve => setTimeout(resolve, 120));
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "Temporary upload outage." }),
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            track: { id: "arena-smoke-already-uploaded-track" },
            created: false,
            separationQueued: false,
          }),
        });
      }
    } else if (url.pathname === `/api/library/tracks/${notStartedTrack.id}` && route.request().method() === "PATCH") {
      const request = route.request().postDataJSON();
      assert.equal(request.rating, 4, "rating remains editable while stem separation is running");
      mockNotStartedRating = request.rating;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ track: { rating: mockNotStartedRating } }),
      });
    } else if (url.pathname.endsWith("/tracks") && route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(mockLiveSessionActive ? liveLibraryPayload() : mockTrackPayload()),
      });
    } else if (url.pathname.endsWith("/playback-state")) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ playbackState: { currentTrackId: null, positionSeconds: 0 } }) });
    } else if (url.pathname.endsWith("/playlists")) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ playlists: [] }) });
    } else if (url.pathname.endsWith("/queue")) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ queue: [] }) });
    } else if (url.pathname.endsWith("/sessions")) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ sessions: [] }) });
    } else if (url.pathname.endsWith("/collections")) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ collections: [] }) });
    } else {
      await route.continue();
    }
  });
  await page.route("**/api/assets/*", async route => {
    const assetId = new URL(route.request().url()).pathname.split("/").at(-1);
    if (assetId === liveCamelotSourceAssetId) {
      await route.fulfill({ status: 200, contentType: "audio/wav", body: quietStemWav });
      return;
    }
    if (assetId === liveDonorVocalsAssetId) {
      liveDonorFetchCount += 1;
      if (liveDonorFetchCount === 1) {
        signalFirstDonorFetchStarted();
        await firstDonorFetchRelease;
      }
      try {
        await route.fulfill({ status: 200, contentType: "audio/wav", body: donorStemWav });
      } catch (error) {
        if (liveDonorFetchCount !== 1) throw error;
      }
      return;
    }
    if (assetId === liveVocalsAssetId) {
      await route.fulfill({ status: 200, contentType: "audio/wav", body: quietStemWav });
      return;
    }
    if (assetId === liveDrumsAssetId) {
      await route.fulfill({ status: 200, contentType: "audio/wav", body: drumStemWav });
      return;
    }
    await route.fulfill({ status: 404, body: "Unknown smoke audio asset" });
  });
  await page.route("**/api/waveyard/projects", route => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ projects: [{ id: "arena-smoke-saved-studio-project", title: "Saved arrangement" }] }),
  }));
  let failTrackListOnce = true;
  await page.route("**/api/library/tracks", async (route) => {
    if (route.request().method() === "GET" && failTrackListOnce) {
      failTrackListOnce = false;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Temporary track-list failure" }),
      });
      return;
    }
    await route.fallback();
  });
  let playlistRequestCount = 0;
  let resolveSecondPlaylistStarted;
  const secondPlaylistStarted = new Promise((resolve) => { resolveSecondPlaylistStarted = resolve; });
  let releaseSecondPlaylistResponse;
  const secondPlaylistResponseGate = new Promise((resolve) => { releaseSecondPlaylistResponse = resolve; });
  await page.route("**/api/library/playlists", async (route) => {
    playlistRequestCount += 1;
    if (playlistRequestCount === 2) {
      resolveSecondPlaylistStarted();
      await secondPlaylistResponseGate;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Temporary playlist failure" }),
      });
      return;
    }
    await route.fallback();
  });
  await page.route("**/api/jobs/arena-smoke-stem-job/retry", async route => {
    assert.equal(route.request().method(), "POST");
    mockRetryCount += 1;
    mockStemState = "processing";
    setTimeout(() => { mockStemState = "separated"; }, 5000);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ job: { id: "arena-smoke-stem-job", status: "queued" } }),
    });
  });
  await page.goto(`${base}/waveyard`, { waitUntil: "networkidle" });
  const recoveryRow = page.locator('[data-testid="library-track"]').filter({ hasText: "Retryable track" });
  const notStartedRow = page.locator('[data-testid="library-track"]').filter({ hasText: "Not started track" });
  await page.getByTestId("track-load-failure").waitFor();
  assert.equal(
    await page.getByText("Your library is empty — add music to begin.", { exact: true }).count(),
    0,
    "a failed tracks request must not be presented as an empty library",
  );
  await page.getByRole("button", { name: "Retry track refresh", exact: true }).click();
  await secondPlaylistStarted;
  await recoveryRow.getByText("SEPARATION REJECTED", { exact: true }).waitFor();
  releaseSecondPlaylistResponse();
  await page.getByTestId("library-refresh-warning").waitFor();
  await page.getByRole("button", { name: "Retry library refresh", exact: true }).click();
  await page.getByTestId("library-refresh-warning").waitFor({ state: "detached" });
  await page.getByTestId("track-load-failure").waitFor({ state: "detached" });
  report.push("A failed track-list request shows retry instead of false emptiness; a playlist outage leaves tracks available and recovers on retry.");
  let resolveSlowSearchStarted;
  const slowSearchStarted = new Promise((resolve) => { resolveSlowSearchStarted = resolve; });
  let resolveSlowSearchFinished;
  const slowSearchFinished = new Promise((resolve) => { resolveSlowSearchFinished = resolve; });
  await page.route("**/api/library/tracks?*", async (route) => {
    const query = new URL(route.request().url()).searchParams.get("q");
    if (query !== "this-will-not-match") {
      await route.fallback();
      return;
    }
    resolveSlowSearchStarted();
    try {
      const response = await route.fetch();
      await new Promise((resolve) => setTimeout(resolve, 900));
      try {
        await route.fulfill({ response });
      } catch {
        // A newer search should cancel this delayed response.
      }
    } catch {
      // The browser may abort this request when the user changes the query.
    } finally {
      resolveSlowSearchFinished();
    }
  });
  const librarySearch = page.getByRole("textbox", { name: "Search your music" });
  await librarySearch.fill("this-will-not-match");
  await slowSearchStarted;
  const newerSearchResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname.endsWith("/api/library/tracks") && url.searchParams.get("q") === "retryable";
  });
  await librarySearch.fill("retryable");
  await newerSearchResponse;
  await recoveryRow.getByText("SEPARATION REJECTED", { exact: true }).waitFor();
  await slowSearchFinished;
  assert.equal(await recoveryRow.count(), 1, "a slow older search must not replace a newer result");
  await librarySearch.fill("");
  await notStartedRow.getByText("NOT STARTED", { exact: true }).waitFor();
  report.push("A delayed older search cannot replace the results from a newer query.");
  const waveyardNavigation = page.getByRole("navigation", { name: "Waveyard" });
  assert.equal(await page.getByRole("heading", { name: "Sessions", exact: true }).count(), 0);
  assert.equal(await page.getByRole("heading", { name: "Studio", exact: true }).count(), 0);
  assert.equal(
    await waveyardNavigation.getByRole("link", { name: "Sessions", exact: true }).getAttribute("href"),
    "/waveyard/sessions",
    "session creation and management remain available from their dedicated tab",
  );
  report.push("The Music tab stays focused on the library; sessions and arrangements have dedicated destinations.");
  assert.equal(
    await waveyardNavigation.getByRole("link", { name: "Studio", exact: true }).getAttribute("href"),
    "/waveyard/studio",
    "the Studio tab opens saved arrangements, not the new-project upload flow",
  );
  await page.route("**/api/waveyard/projects", async (route) => {
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "Temporary project-list failure" }),
    });
  }, { times: 1 });
  await waveyardNavigation.getByRole("link", { name: "Studio", exact: true }).click();
  await page.getByRole("heading", { name: "Your arrangements" }).waitFor();
  await page.getByRole("alert").filter({ hasText: "Saved arrangements could not be loaded." }).waitFor();
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await page.getByRole("link", { name: "Open Saved arrangement in Studio", exact: true }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: /Waveyard/ }).count(),
    1,
    "the global product switcher stays on Waveyard for nested Studio routes",
  );
  assert.equal(
    await page.getByRole("link", { name: "Open Saved arrangement in Studio", exact: true }).getAttribute("href"),
    "/waveyard/projects/arena-smoke-saved-studio-project?view=studio",
    "the Studio landing lists resumable arrangements",
  );
  report.push("Studio has a direct saved-arrangement landing, and its retry action recovers from a failed project-list request.");
  const waveformRetryProjectId = "arena-smoke-waveform-retry-project";
  const waveformRetryJobId = "arena-smoke-waveform-retry-job";
  const separationRetryJobId = "arena-smoke-project-separation-retry-job";
  const waveformCanvasAssetId = "arena-smoke-waveform-canvas-source";
  let waveformCanvasRequests = 0;
  let waveformCanvasAvailable = false;
  let waveformRetryAttempts = 0;
  let waveformRetryStatus = "failed";
  let separationRetryAttempts = 0;
  let separationRetryStatus = "failed";
  await page.route(`**/api/assets/${waveformCanvasAssetId}/waveform`, async (route) => {
    waveformCanvasRequests += 1;
    if (!waveformCanvasAvailable) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "The waveform queue is temporarily unavailable." }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        waveform: {
          assetId: waveformCanvasAssetId,
          durationSeconds: 8,
          resolutions: { "1024": { min: [-0.2, -0.3], max: [0.2, 0.3] } },
        },
      }),
    });
  });
  await page.route(`**/api/waveyard/projects/${waveformRetryProjectId}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        project: {
          title: "Waveform retry fixture",
          description: "",
          licenseCode: "CC0",
          visibility: "private",
          publicationStatus: "draft",
          moderationStatus: "approved",
        },
        role: "owner",
        build: null,
        stems: [{
          id: "arena-smoke-waveform-stem",
          sourceAssetId: waveformCanvasAssetId,
          stemType: "vocals",
          durationSeconds: 8,
          sampleRate: 44100,
          channels: 2,
          codec: "wav",
          format: "wav",
          fileSizeBytes: 16,
          checksumSha256: "0".repeat(64),
          model: "smoke-test",
          modelVersion: "1",
        }],
        studioSources: [{
          id: waveformCanvasAssetId,
          originalFilename: "waveform-retry-source.wav",
          durationSeconds: 8,
          sampleRate: 44100,
          channels: 2,
          codec: "wav",
          mimeType: "audio/wav",
          fileSizeBytes: 16,
          checksumSha256: "0".repeat(64),
        }],
        waveforms: [],
        waveformJobs: [{
          id: waveformRetryJobId,
          status: waveformRetryStatus,
          stage: waveformRetryStatus === "failed" ? "queue-unavailable" : "queued",
          errorMessage: waveformRetryStatus === "failed" ? "The local waveform queue is unavailable." : null,
        }],
        jobs: [{
          id: separationRetryJobId,
          sourceAssetId: "arena-smoke-project-source",
          status: separationRetryStatus,
          stage: separationRetryStatus === "failed" ? "queue-unavailable" : "queued",
          errorCode: "queue_unavailable",
          errorMessage: separationRetryStatus === "failed" ? "The local separation queue is unavailable." : null,
          model: "demucs",
          resolvedDevice: null,
          metadata: null,
        }],
        sources: [],
      }),
    });
  });
  await page.route(`**/api/jobs/${separationRetryJobId}/retry`, async (route) => {
    assert.equal(route.request().method(), "POST", "project separation recovery uses the explicit retry action");
    separationRetryAttempts += 1;
    if (separationRetryAttempts === 1) {
      await route.abort("failed");
      return;
    }
    separationRetryStatus = "queued";
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ job: { id: separationRetryJobId, status: "queued" } }),
    });
  });
  await page.route(`**/api/waveform-jobs/${waveformRetryJobId}/retry`, async (route) => {
    assert.equal(route.request().method(), "POST", "waveform recovery uses the explicit retry action");
    waveformRetryAttempts += 1;
    if (waveformRetryAttempts === 1) {
      await route.abort("failed");
      return;
    }
    if (waveformRetryAttempts === 2) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "The waveform worker is still unavailable." }),
      });
      return;
    }
    waveformRetryStatus = "queued";
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ job: { id: waveformRetryJobId, status: "queued" } }),
    });
  });
  await page.goto(`http://localhost:80/waveyard/projects/${waveformRetryProjectId}?view=studio`);
  const retryProjectSeparationButton = page.getByRole("button", { name: "Retry separation", exact: true });
  await retryProjectSeparationButton.waitFor();
  await retryProjectSeparationButton.click();
  await page.getByText(/Separation retry could not reach the server/).waitFor();
  assert.equal(await retryProjectSeparationButton.isEnabled(), true, "network failure leaves project separation retry available");
  await retryProjectSeparationButton.click();
  await page.getByText(/Separation is at the “queued” stage/).waitFor();
  assert.equal(separationRetryAttempts, 2, "project separation retry remains actionable after a network outage");
  assert.equal(await page.getByRole("button", { name: "Retry separation", exact: true }).count(), 0, "a queued separation retry no longer offers a duplicate failed-job action");
  report.push("A project-level separation retry recovers from a network outage without leaving the control stuck.");
  const retryWaveformButton = page.getByRole("button", { name: "Retry waveform", exact: true });
  await retryWaveformButton.waitFor();
  await retryWaveformButton.click();
  await page.getByText(/Waveform retry could not reach the server/).waitFor();
  assert.equal(await retryWaveformButton.innerText(), "Retry waveform", "network failure resets the waveform retry button");
  assert.equal(await retryWaveformButton.isEnabled(), true, "network failure leaves the waveform retry available");
  await retryWaveformButton.click();
  await page.getByText("The waveform worker is still unavailable.").waitFor();
  assert.equal(await retryWaveformButton.isEnabled(), true, "a rejected retry response leaves the action available");
  await retryWaveformButton.click();
  await page.getByText(/Waveforms are still being generated/).waitFor({ timeout: 8_000 });
  assert.equal(waveformRetryAttempts, 3, "the waveform retry can recover after both network and worker failures");
  assert.equal(await page.getByRole("button", { name: "Retry waveform", exact: true }).count(), 0, "a queued retry no longer offers a duplicate failed-job action");
  report.push("Waveform retry survives a network outage and a worker rejection, then resumes when the queue returns.");
  const studioWaveform = page.locator(".main-waveform");
  const retryCanvasWaveform = studioWaveform.getByTestId("waveform-canvas-retry");
  await retryCanvasWaveform.waitFor();
  await studioWaveform.getByRole("alert").getByText("The waveform queue is temporarily unavailable.").waitFor();
  waveformCanvasAvailable = true;
  await retryCanvasWaveform.click();
  await studioWaveform.getByRole("button", { name: "Seek project waveform" }).waitFor();
  assert(waveformCanvasRequests >= 2, "the Studio waveform retry must issue a new request for the selected asset");
  report.push("Studio waveform fetch failures show an inline retry and recover without reloading the project.");
  await page.goto("http://localhost:80/waveyard");
  await page.getByRole("navigation", { name: "Waveyard" }).getByRole("link", { name: "Music", exact: true }).click();
  await recoveryRow.getByText("SEPARATION REJECTED", { exact: true }).waitFor();
  await notStartedRow.getByText("NOT STARTED", { exact: true }).waitFor();
  assert.equal(
    await notStartedRow.getByRole("link", { name: "Studio ↗" }).getAttribute("href"),
    "/waveyard/projects/arena-smoke-not-started-project?view=studio",
    "a track's Studio shortcut opens the DAW directly",
  );
  const retrySeparationButton = recoveryRow.getByRole("button", { name: "Retry separation for Retryable track" });
  await retrySeparationButton.click();
  await recoveryRow.getByText("SEPARATING…", { exact: true }).waitFor();
  await page.getByRole("status").filter({ hasText: "Retryable track: separation retry started." }).waitFor();
  assert.equal(mockRetryCount, 1, "retrying a rejected separation must submit one idempotent job retry");
  await recoveryRow.getByText("SEPARATING · 36% · pass 2/4", { exact: true }).waitFor({ timeout: 6000 });
  await recoveryRow.getByText("4 STEMS", { exact: true }).waitFor({ timeout: 12000 });
  assert.equal(await page.getByRole("button", { name: "Retry separation for Retryable track" }).count(), 0);
  report.push("The library shows live separation percentage, retries a rejected job in place, and updates to separated without a reload.");
  const startSeparationButton = notStartedRow.getByRole("button", { name: "Start separation for Not started track" });
  await startSeparationButton.click();
  await notStartedRow.getByText("SEPARATING…", { exact: true }).waitFor();
  await page.getByRole("status").filter({ hasText: "Not started track: separation started." }).waitFor();
  assert.equal(mockStartCount, 1, "starting separation for an unprocessed track must submit one job");
  assert.equal(mockNotStartedState, "processing", "the worker remains active during the library interaction");
  assert.equal(await notStartedRow.getByRole("button", { name: "Play" }).isEnabled(), true);
  assert.equal(await notStartedRow.getByRole("button", { name: "Next" }).isEnabled(), true);
  await notStartedRow.getByRole("button", { name: "Rate Not started track: 4 stars" }).click();
  await notStartedRow.getByRole("button", { name: "Clear Not started track: 4 stars" }).waitFor();
  assert.equal(mockNotStartedRating, 4, "a library edit saves while separation is active");
  report.push("Library playback controls and track rating remain usable during background separation.");
  await page.reload({ waitUntil: "networkidle" });
  const reloadedNotStartedRow = page.locator('[data-testid="library-track"]').filter({ hasText: "Not started track" });
  await reloadedNotStartedRow.locator('[aria-label="Rating: 4 of 5"]').waitFor();
  await reloadedNotStartedRow.getByText("4 STEMS", { exact: true }).waitFor({ timeout: 12000 });
  assert.equal(await reloadedNotStartedRow.getByRole("button", { name: "Start separation for Not started track" }).count(), 0);
  report.push("A library track with no separation job can start work directly, then shows the persisted result after reload.");
  await page.getByLabel("Add music files").setInputFiles({
    name: "retry-this-upload.wav",
    mimeType: "audio/wav",
    buffer: Buffer.from("synthetic upload fixture"),
  });
  const failedUploadNotice = page.getByTestId("failed-library-uploads");
  await failedUploadNotice.getByText("retry-this-upload.wav").waitFor();
  assert.equal(uploadAttempts, 1);
  assert.equal(uploadAttemptNames[0], "retry-this-upload.wav", "the original upload request contains the selected file");
  await page.getByRole("button", { name: "Retry 1 failed upload", exact: true }).click();
  await page.getByRole("button", { name: "Retrying uploads…" }).waitFor();
  await page.getByRole("button", { name: "Retry 1 failed upload", exact: true }).waitFor();
  assert.equal(uploadAttempts, 2, "retry sends a second upload request without asking for the file again");
  assert.deepEqual(uploadAttemptNames, ["retry-this-upload.wav", "retry-this-upload.wav"]);
  await failedUploadNotice.getByText("retry-this-upload.wav").waitFor();
  await page.getByRole("button", { name: "Retry 1 failed upload", exact: true }).click();
  await page.getByText("That audio is already in your library — loading it in the live mixer.").waitFor();
  assert.equal(uploadAttempts, 3, "the second retry reaches the idempotent existing-track response");
  assert.deepEqual(uploadAttemptNames, [
    "retry-this-upload.wav",
    "retry-this-upload.wav",
    "retry-this-upload.wav",
  ]);
  assert.equal(await page.getByTestId("failed-library-uploads").count(), 0, "a confirmed duplicate is no longer shown as a failed upload");
  report.push("A retried upload can resolve to the existing library track without creating a duplicate or keeping a stale failure.");

  mockLiveSessionActive = true;
  await page.evaluate((id) => localStorage.setItem("waveyard.listening.sessionId", id), liveSessionId);
  const errorsBeforeLiveSwap = errors.length;
  await page.goto(`${base}/waveyard/session/${liveSessionId}`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("listening-workspace").waitFor({ timeout: 20_000 });
  await page.getByText("Live source track", { exact: true }).first().waitFor();
  const sourceVocals = page.locator(`audio[src$="/${liveVocalsAssetId}"]`);
  await page.getByTestId("session-play").click();
  await page.waitForFunction((assetId) => {
    const audio = document.querySelector(`audio[src$="/${assetId}"]`);
    return audio instanceof HTMLAudioElement && !audio.paused && audio.currentTime > 0.25;
  }, liveVocalsAssetId, { timeout: 12_000 });
  const clockBeforeSwap = await sourceVocals.evaluate((audio) => audio.currentTime);
  const vocalsMeter = page.locator(".wy-stem-vocals .wy-stem-meter i");
  await page.waitForFunction(() => {
    const bar = document.querySelector(".wy-stem-vocals .wy-stem-meter i");
    const peak = Number(bar?.getAttribute("style")?.match(/scaleX\(([^)]+)\)/)?.[1] ?? 0);
    return peak > 0.02;
  }, null, { timeout: 8_000 });
  const originalVocalPeak = await vocalsMeter.evaluate((bar) => Number(
    bar.getAttribute("style")?.match(/scaleX\(([^)]+)\)/)?.[1] ?? 0,
  ));
  const vocalSource = page.getByLabel("vocals source");
  assert.equal(await vocalSource.locator("option").filter({ hasText: "Drums-only separated track" }).count(), 0, "the vocal picker must hide separated tracks with no vocal stem");
  await vocalSource.selectOption(liveDonorTrackId);
  await page.getByTestId("session-status").filter({ hasText: "vocals source saved" }).waitFor({ timeout: 8_000 });
  await page.getByTestId("live-swap-pending-vocals").waitFor({ timeout: 8_000 });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("The slow donor audio request did not start")), 8_000);
    firstDonorFetchStarted.then(() => {
      clearTimeout(timeout);
      resolve();
    });
  });
  const clockBeforeCancel = await sourceVocals.evaluate((audio) => audio.currentTime);
  const cancelSlowSwap = page.getByRole("button", { name: "Cancel vocals switch to Donor track" });
  await cancelSlowSwap.click();
  await page.getByTestId("session-status").filter({ hasText: "vocals switch cancelled" }).waitFor({ timeout: 8_000 });
  assert.equal(liveSwap, null, "cancelling removes the pending donor from the session");
  assert.equal(liveSwapDeleteRequestCount, 1, "cancelling sends one removal request for the pending donor");
  releaseFirstDonorFetch();
  await page.waitForTimeout(250);
  assert.equal(
    await page.locator('audio[aria-label="vocals audio (swapped layer)"]').count(),
    0,
    "a late response from the cancelled donor cannot become the active stem",
  );
  await page.waitForFunction(({ assetId, after }) => {
    const audio = document.querySelector(`audio[src$="/${assetId}"]`);
    return audio instanceof HTMLAudioElement && !audio.paused && audio.currentTime > after + 0.2;
  }, { assetId: liveVocalsAssetId, after: clockBeforeCancel }, { timeout: 5_000 });
  assert.equal(await vocalSource.inputValue(), "", "cancelling restores the original vocal source selection");
  await vocalSource.selectOption(liveDonorTrackId);
  await page.getByTestId("session-status").filter({ hasText: "vocals source saved" }).waitFor({ timeout: 8_000 });
  await page.waitForFunction((assetId) => {
    const audio = document.querySelector(`audio[src$="/${assetId}"]`);
    return audio?.getAttribute("aria-label") === "vocals audio (swapped layer)";
  }, liveVocalsAssetId, { timeout: 8_000 });
  await page.waitForFunction(() => {
    const bar = document.querySelector(".wy-stem-vocals .wy-stem-meter i");
    const peak = Number(bar?.getAttribute("style")?.match(/scaleX\(([^)]+)\)/)?.[1] ?? 0);
    return peak > 0.4;
  }, null, { timeout: 8_000 });
  assert.equal(liveSwapRequestCount, 2, "a cancelled request and a later successful request each persist once");
  assert.equal(liveSwapDeleteRequestCount, 1, "the slow swap cancellation is persisted exactly once");
  assert.equal(liveDonorFetchCount, 2, "the cancelled and successful attempts both request the donor audio");
  const donorVocalPeak = await vocalsMeter.evaluate((bar) => Number(
    bar.getAttribute("style")?.match(/scaleX\(([^)]+)\)/)?.[1] ?? 0,
  ));
  assert(donorVocalPeak > originalVocalPeak * 2, "the live vocal meter must reflect the donor audio, not just the selected label");
  await page.waitForFunction(({ assetId, after }) => {
    const audio = document.querySelector(`audio[src$="/${assetId}"]`);
    return audio instanceof HTMLAudioElement && audio.currentTime > after + 0.2;
  }, { assetId: liveVocalsAssetId, after: clockBeforeSwap }, { timeout: 5_000 });
  const clockAfterSwap = await sourceVocals.evaluate((audio) => audio.currentTime);
  assert(clockAfterSwap > clockBeforeSwap + 0.2, `the recipient song clock must continue through a live stem swap (${clockBeforeSwap.toFixed(2)} → ${clockAfterSwap.toFixed(2)})`);
  const isolateVocals = page.getByRole("button", { name: "Isolate vocals" });
  await isolateVocals.click();
  assert.equal(await isolateVocals.getAttribute("aria-pressed"), "true");
  await page.waitForFunction(() => {
    const bar = document.querySelector(".wy-stem-drums .wy-stem-meter i");
    const peak = Number(bar?.getAttribute("style")?.match(/scaleX\(([^)]+)\)/)?.[1] ?? 0);
    return peak < 0.02;
  }, null, { timeout: 5_000 });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Isolated stem mix was not persisted")), 5_000);
    isolatedMixSaved.then(() => {
      clearTimeout(timeout);
      resolve();
    });
  });
  assert.equal(liveCurrentItem.stemMix.drums, 0, "isolation must persist the selected stem levels");
  assert(liveTrackPatchRequestCount > 0, "stem mix and transition changes must reach the persistence route");
  const addCamelotMatch = page.getByRole("button", { name: "Add Camelot library match as next" });
  await addCamelotMatch.waitFor({ state: "visible", timeout: 8_000 });
  await addCamelotMatch.click();
  await page.getByTestId("session-status").filter({ hasText: "Up next: Camelot library match." }).waitFor({ timeout: 8_000 });
  assert.equal(liveTrackAddRequestCount, 1, "the Camelot wheel must add a compatible library track directly to the next slot");
  assert.equal(liveSessionTracks[1].track.id, liveCamelotTrackId);
  assert.equal(errors.length, errorsBeforeLiveSwap, "live swapping and isolation must not throw browser errors");
  report.push("A slow live stem switch can be cancelled without rewinding playback; a later donor switch changes the audible vocal, isolation works, and Camelot cues a compatible track.");

  mockLiveSessionActive = false;
  const liveSessionPage = page;
  await liveSessionPage.evaluate(() => localStorage.removeItem("waveyard.listening.sessionId"));
  // Keep the fake session mounted until the context closes: its unmount saver
  // intentionally persists, so unloading it mid-smoke would escape the fixture.
  page = await context.newPage();
  page.on("pageerror", err => errors.push(err.message));
  const routeSource = await readFile(new URL("../artifacts/arenaforge/src/routes.ts", import.meta.url), "utf8");
  const auditRoutes = [...routeSource.matchAll(/path:\s*"([^"]+)"/g)]
    .map((match) => match[1].replace(/:[^/]+/g, "audit-test"));
  let auditedButtons = 0;
  let auditedLinks = 0;
  for (const path of auditRoutes) {
    const previousErrors = errors.length;
    await page.goto(base + path, { waitUntil: "domcontentloaded", timeout: 20_000 });
    await page.waitForTimeout(100);
    const audit = await page.evaluate(() => {
      const visible = (element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const closedDetails = element.closest("details:not([open])");
        if (closedDetails && !closedDetails.querySelector("summary")?.contains(element)) return false;
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      const hasHandler = (element, name) => {
        for (let node = element; node; node = node.parentElement) {
          const key = Object.keys(node).find((property) => property.startsWith("__reactProps$"));
          const props = key ? node[key] : null;
          if (typeof props?.[name] === "function" || typeof node[name.toLowerCase()] === "function") return true;
        }
        return false;
      };
      const buttons = [...document.querySelectorAll('button,input[type="button"],input[type="submit"]')].filter(visible);
      const links = [...document.querySelectorAll("a")].filter(visible);
      const unboundButtons = buttons.filter((element) => {
        if (element.disabled || element.getAttribute("aria-disabled") === "true") return false;
        if (hasHandler(element, "onClick") || element.closest("a[href]")) return false;
        const form = element.closest("form");
        const type = element.type || "submit";
        return !(type === "submit" && form && (hasHandler(form, "onSubmit") || form.getAttribute("action")));
      }).map((element) => ({
        text: (element.innerText || element.textContent || element.value || element.getAttribute("aria-label") || element.title || "").trim().slice(0, 90),
        route: location.pathname,
      }));
      const deadLinks = links.filter((element) => {
        const href = element.getAttribute("href");
        return href === null || href === "" || href === "#" || href.startsWith("javascript:");
      }).map((element) => ({
        text: (element.innerText || element.textContent || element.getAttribute("aria-label") || "").trim().slice(0, 90),
        href: element.getAttribute("href"),
        route: location.pathname,
      }));
      const unlabeledButtons = buttons.filter((element) =>
        !(element.innerText || element.textContent || element.value || element.getAttribute("aria-label") || element.title || "").trim(),
      ).map((element) => ({ route: location.pathname }));
      return { buttons: buttons.length, links: links.length, unboundButtons, deadLinks, unlabeledButtons };
    });
    auditedButtons += audit.buttons;
    auditedLinks += audit.links;
    assert.deepEqual(audit.unboundButtons, [], `${path} has visible enabled buttons without an action or submit path`);
    assert.deepEqual(audit.deadLinks, [], `${path} has visible links without a destination`);
    assert.deepEqual(audit.unlabeledButtons, [], `${path} has visible buttons without an accessible name`);
    assert.equal(errors.length, previousErrors, `${path} raised a browser error`);
  }
  report.push(`Control wiring audit passed across ${auditRoutes.length} routes: ${auditedButtons} visible buttons and ${auditedLinks} visible links.`);
  await page.goto(`${base}/spaces`, { waitUntil: "networkidle" });
  const roomLauncher = page.getByRole("button", { name: /Rooms/ });
  assert.equal(await roomLauncher.count(), 1, "Spaces navigation should expose one room launcher");
  const roomLauncherLabel = (await roomLauncher.innerText()).replace(/\s+/g, " ").trim();
  assert.match(roomLauncherLabel, /Rooms/);
  assert.doesNotMatch(roomLauncherLabel, /Spaces/, "The room launcher should not repeat the active primary tab");
  const initialSpaceCount = await page.locator("[data-space-id]").count();
  const newWorkspaceButton = initialSpaceCount === 0
    ? page.getByRole("button", { name: "Create browser workspace", exact: true })
    : page.getByRole("button", { name: "New browser workspace", exact: true });
  if (initialSpaceCount === 0) {
    assert.equal(await page.getByRole("button", { name: "New browser workspace", exact: true }).count(), 0,
      "Empty Spaces screen should not show a duplicate workspace CTA");
  }
  const createSpaceResponse = page.waitForResponse(response =>
    response.url().endsWith("/api/spaces") && response.request().method() === "POST",
  );
  await newWorkspaceButton.click();
  const createdSpace = await (await createSpaceResponse).json();
  createdSpaceId = createdSpace.space?.id;
  assert(createdSpaceId, "Creating a browser workspace should return its id");
  const createdSpaceCard = page.locator(`[data-space-id="${createdSpaceId}"]`);
  const browserTask = createdSpaceCard.getByRole("textbox", { name: "Browser task" });
  await browserTask.waitFor({ state: "visible", timeout: 10000 });
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Browser task", null, { timeout: 5000 });
  const taskBeforeManualBrowser = await createdSpaceCard.evaluate(card => {
    const task = card.querySelector('[aria-label="Browser task"]');
    const browser = card.querySelector('section[aria-label="Workspace browser"]');
    return Boolean(task && browser && (task.compareDocumentPosition(browser) & Node.DOCUMENT_POSITION_FOLLOWING));
  });
  assert(taskBeforeManualBrowser, "The mission task should appear before the manual browser control");
  report.push("Spaces navigation is distinct from the room launcher; first-run creates one workspace CTA, focuses the browser task, and puts mission controls before manual browsing.");
  const localHubModelId = "hub:ollama:qwen2.5-3b";
  await page.route("**/api/models", async route => {
    const response = await route.fetch();
    const payload = await response.json();
    const models = Array.isArray(payload.models) ? payload.models : [];
    if (!models.some(model => model.id === localHubModelId)) {
      models.push({
        id: localHubModelId,
        name: "qwen2.5:3b (ollama)",
        provider: "local · smoke fixture",
        backend: "local-server",
        kind: "text",
        requiresKey: false,
        requiresNetwork: false,
      });
    }
    await route.fulfill({ response, body: JSON.stringify({ ...payload, models }) });
  });
  const historyFixture = {
    id: "arena-smoke-history",
    prompt: "History action recovery",
    gameType: "pong",
    engine: "ai-codegen",
    bytes: 1024,
  };
  const historyFixtureCode = "<!doctype html><html><body><canvas width=\"320\" height=\"180\"></canvas></body></html>";
  let historyFixtureAvailable = true;
  let historyOpenFailure = true;
  let historyDeleteFailure = true;
  await page.route(/\/api\/arcade\?limit=30$/, async route => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ games: historyFixtureAvailable ? [historyFixture] : [] }),
    });
  });
  await page.route("**/api/arcade/arena-smoke-history", async route => {
    if (route.request().method() === "GET") {
      if (historyOpenFailure) {
        historyOpenFailure = false;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "Saved game is temporarily unavailable." }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ game: { ...historyFixture, code: historyFixtureCode } }),
      });
      return;
    }
    if (route.request().method() === "DELETE") {
      if (historyDeleteFailure) {
        historyDeleteFailure = false;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "Saved game deletion failed temporarily." }),
        });
        return;
      }
      historyFixtureAvailable = false;
      await route.fulfill({ status: 204 });
      return;
    }
    await route.fallback();
  });
  await page.goto(`${base}/arcade`, { waitUntil: "networkidle" });
  assert.equal(
    await page.getByTestId("arcade-model-setup").getAttribute("open"),
    null,
    "advanced model setup starts collapsed so the game task comes first",
  );
  const promptBounds = await page.getByLabel("Game prompt").boundingBox();
  const createBounds = await page.getByRole("button", { name: "🎮 Create & play" }).boundingBox();
  const initialViewportHeight = await page.evaluate(() => window.innerHeight);
  assert(promptBounds && promptBounds.y < initialViewportHeight, "the prompt is visible in Arcade's first viewport");
  assert(
    createBounds && createBounds.y + createBounds.height <= initialViewportHeight,
    "the primary Create & play action is visible without scrolling",
  );
  report.push("Arcade opens on the game task; model setup stays accessible but no longer blocks the primary action.");
  const modelSetupToggle = page.getByTestId("arcade-model-setup-toggle");
  await modelSetupToggle.click();
  const runtimeExplanation = page.getByTestId("arcade-model-runtime-explanation");
  await runtimeExplanation.waitFor();
  assert.match(
    await runtimeExplanation.innerText(),
    /browser-loaded model needs WebGPU.*Model Hub models do not.*packaged desktop app.*browser preview/s,
    "Arcade must distinguish browser WebGPU from Model Hub's server runtime and locality",
  );
  await modelSetupToggle.click();
  report.push("Arcade explains that browser WebGPU is separate from Model Hub and identifies where each server runs.");
  const historyGameButton = page.getByRole("button", { name: "Open saved game History action recovery" });
  await historyGameButton.click();
  await page.getByTestId("arcade-history-error").getByText("Saved game is temporarily unavailable.").waitFor();
  assert(await historyGameButton.isVisible(), "a failed game open must leave its library entry available");
  await page.getByRole("button", { name: "Retry saved game action" }).click();
  await page.locator('iframe[title="History action recovery"]').waitFor();
  const historyCard = page.locator('[data-game-id="arena-smoke-history"]');
  await historyCard.hover();
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "Delete saved game History action recovery" }).click();
  await page.getByTestId("arcade-history-error").getByText("Saved game deletion failed temporarily.").waitFor();
  assert(await historyGameButton.isVisible(), "a failed deletion must not remove the saved game");
  assert(await page.locator('iframe[title="History action recovery"]').isVisible(), "a failed deletion must preserve the open game");
  await page.getByRole("button", { name: "Retry saved game action" }).click();
  await historyGameButton.waitFor({ state: "detached" });
  assert.equal(await page.locator('iframe[title="History action recovery"]').count(), 0);
  report.push("Arcade saved-game open/delete failures are visible, retryable, and never discard the game before server confirmation.");
  const platformerButton = page.getByRole("button", { name: "Open offline game Platform Adventure" });
  await platformerButton.waitFor({ timeout: 15000 });
  await platformerButton.click();
  const platformerFrame = page.frameLocator('iframe[title*="Platform Adventure"]');
  await platformerFrame.locator("#game").waitFor({ timeout: 10000 });
  await platformerFrame.locator("#game").evaluate(canvas => {
    canvas.ownerDocument.defaultView.__start();
  });
  await platformerFrame.locator("#game").evaluate(canvas => {
    canvas.ownerDocument.defaultView.localStorage.setItem("af_platform_unlocked", "2");
  });
  await page.waitForFunction(() =>
    Object.keys(localStorage).some(key => key.includes("offline-starter:platformer") && key.startsWith("arenaforge.game-save.v1:"))
  );
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Open offline game Platform Adventure" }).click();
  const restoredPlatformer = page.frameLocator('iframe[title*="Platform Adventure"]');
  await restoredPlatformer.locator("#game").waitFor({ timeout: 10000 });
  await restoredPlatformer.locator("#game").evaluate(canvas => {
    canvas.ownerDocument.defaultView.__start();
  });
  await restoredPlatformer.locator("#hR").filter({ hasText: "STAGE 2 / 3" }).waitFor({ timeout: 5000 });
  assert((await restoredPlatformer.locator("#hR").innerText()).includes("STAGE 2 / 3"), "Offline game progress must survive reloads");
  report.push("Offline starter games are saved locally, reopen after reload, and resume their unlocked platform stage.");
  await page.evaluate(() => localStorage.setItem("af_local_mode", "0"));
  const localGenerationCheck = page.getByTestId("button-local-generation-check");
  if (!(await localGenerationCheck.isVisible())) {
    await page.locator("summary").filter({ hasText: "Model setup" }).click();
  }
  await localGenerationCheck.waitFor();
  assert(await localGenerationCheck.isDisabled(), "A local generation check must not run until an on-device model is loaded");
  assert.equal(await page.getByTestId("local-generation-result").count(), 0, "An unsupported test browser must never show a local-generation pass");
  report.push("Local model verification stays unavailable—not falsely passed—until an on-device model is actually loaded.");
  await page.getByLabel("Connected model source").selectOption("openai");
  let promptGenerationSeen = false;
  let localServerGenerationSeen = false;
  let localServerRevisionSeen = false;
  let expectedModelId = "openai";
  let expectedLocalOnly = false;
  let failNextGeneration = false;
  let holdNextGeneration = false;
  let heldGenerationHasSource = false;
  let generationStartedResolve = null;
  let releaseHeldGeneration = null;
  const generatedPong = '<!doctype html><html><head><title>Generated Pong</title></head><body><p id="generated-pong">AI Pong</p><canvas width="320" height="180"></canvas><script>let x=0;const c=document.querySelector("canvas"),ctx=c.getContext("2d");addEventListener("keydown",e=>{if(e.key==="ArrowRight")x++});function loop(){ctx.fillStyle="#111";ctx.fillRect(0,0,320,180);ctx.fillStyle="#fff";ctx.fillRect(x,20,8,30);requestAnimationFrame(loop)}loop();</script></body></html>';
  const revisedGeneratedPong = generatedPong.replace("AI Pong", "AI Pong with multi-ball");
  const revisedOfflinePlatformer = '<!doctype html><html><head><title>Revised local platformer</title></head><body><p id="offline-revision-marker">Double jump added</p><canvas width="320" height="180"></canvas><script>let jumps=2;addEventListener("keydown",e=>{if(e.key===" ")jumps--});requestAnimationFrame(function loop(){requestAnimationFrame(loop)});</script></body></html>';
  await page.route("**/api/arcade/forge", async route => {
    const body = route.request().postDataJSON();
    assert.equal(body.modelId, expectedModelId, "the selected model source must reach the game-generation route");
    assert.equal(Boolean(body.localOnly), expectedLocalOnly, "the generation route must preserve Local Mode");
    if (expectedLocalOnly) assert.equal(body.keys, undefined, "Local Mode must not send provider keys");
    if (failNextGeneration) {
      failNextGeneration = false;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "No game-writing model is reachable." }),
      });
      return;
    }
    if (holdNextGeneration) {
      holdNextGeneration = false;
      assert.equal(typeof body.priorCode === "string", heldGenerationHasSource,
        "a cancelled new game must not carry source; a cancelled revision must carry the current game");
      generationStartedResolve?.();
      generationStartedResolve = null;
      await new Promise(resolve => { releaseHeldGeneration = resolve; });
      try {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ code: generatedPong, title: "Late game", runtime: { ms: 12 } }),
        });
      } catch {
        // The browser should have cancelled this request before the late reply.
      }
      return;
    }
    if (body.prompt === "Pong") {
      promptGenerationSeen = true;
    } else if (body.prompt === "Pong with a rotating gate") {
      localServerGenerationSeen = true;
      assert.equal(body.priorCode, undefined, "New local-model games must not carry unrelated source");
    } else if (body.prompt === "Add a multi-ball mode") {
      localServerRevisionSeen = true;
      assert(body.priorCode.includes("AI Pong"), "A local-model revision must include the current game source");
    } else if (body.prompt === "Add a double jump") {
      assert.equal(body.ephemeral, true, "Offline starter revisions must not be saved to the shared catalog");
      assert.equal(body.parentId, undefined, "Offline starter revisions must not use a shared-game parent");
      assert(body.priorCode.includes("PLATFORM ADVENTURE"), "Offline revisions must carry the actual starter source");
    } else {
      assert.fail(`Unexpected game-generation prompt: ${body.prompt}`);
    }
    const isPong = body.prompt === "Pong";
    const isLocalPong = body.prompt === "Pong with a rotating gate";
    const isMultiBallRevision = body.prompt === "Add a multi-ball mode";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        game: isPong
          ? { id: "arena-smoke-pong", gameType: "pong" }
          : isLocalPong
            ? { id: "arena-smoke-local-pong", gameType: "pong" }
            : null,
        code: isMultiBallRevision
          ? revisedGeneratedPong
          : isPong || isLocalPong
            ? generatedPong
            : revisedOfflinePlatformer,
        title: isPong
          ? "Generated Pong"
          : isLocalPong
            ? "Local model Pong"
            : isMultiBallRevision
              ? "Revised Pong"
              : "Revised local platformer",
        runtime: {
          ms: 12,
          backend: expectedLocalOnly ? "local-server" : "openai",
          modelId: expectedModelId,
          via: expectedLocalOnly ? "local-server:127.0.0.1/qwen2.5:3b" : "openai:smoke-test",
          fallback: false,
        },
      }),
    });
  });
  await page.getByLabel("Game change").fill("Add a double jump");
  await page.getByRole("button", { name: "Apply change" }).click();
  await page.getByText(/Updated “Platform Adventure” in your offline shelf/).waitFor({ timeout: 10000 });
  await page.getByRole("button", { name: /Code/ }).click();
  await page.getByText("offline-revision-marker").waitFor();
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Open offline game Platform Adventure" }).click();
  await page.getByRole("button", { name: /Code/ }).click();
  await page.getByText("offline-revision-marker").waitFor();
  report.push("Prompt revisions change the saved offline game's source without adding it to the shared catalog.");
  await page.evaluate(() => localStorage.setItem("af_local_mode", "0"));
  const connectedModelSource = page.getByLabel("Connected model source");
  if (!(await connectedModelSource.isVisible())) {
    await page.locator("summary").filter({ hasText: "Model setup" }).click();
  }
  await connectedModelSource.selectOption("openai");
  await page.getByLabel("Game prompt").fill("Pong");
  await page.getByRole("button", { name: "🎮 Create & play" }).click();
  await page.getByText("✨ AI codegen").waitFor({ timeout: 10000 });
  assert(promptGenerationSeen, "Automatic prompt generation must call the code-writing model instead of a preset core");
  await page.locator('iframe[title="Pong"]').waitFor();
  report.push("Automatic creation routes a bare Pong prompt and the selected model source to generated game code instead of a preset.");
  await page.getByRole("button", { name: /Code/ }).click();
  await page.evaluate(() => Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async () => { throw new Error("Clipboard permission denied"); } },
  }));
  const copyButton = page.getByRole("button", { name: "Copy game source" });
  await copyButton.click();
  await page.getByTestId("arcade-copy-error").getByText("Clipboard permission denied").waitFor();
  assert.equal(await copyButton.innerText(), "📋", "a denied clipboard write must not show copy success");
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text) => { window.__arenaSmokeCopied = text; } },
    });
  });
  await copyButton.click();
  await page.getByRole("button", { name: "Game source copied" }).waitFor();
  assert.match(await page.evaluate(() => window.__arenaSmokeCopied), /AI Pong/);
  const htmlDownloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download game source as HTML" }).click();
  const htmlDownload = await htmlDownloadPromise;
  assert.match(htmlDownload.suggestedFilename(), /^arenaforge-pong-.+\.html$/);
  await page.getByRole("button", { name: /Play/ }).click();
  report.push("Arcade copy reports denied clipboard access honestly, confirms real copies, and downloads game source as HTML.");
  expectedModelId = localHubModelId;
  expectedLocalOnly = true;
  await page.evaluate(() => localStorage.setItem("af_local_mode", "1"));
  await page.getByLabel("Connected model source").selectOption(localHubModelId);
  await page.getByLabel("Game prompt").fill("Pong with a rotating gate");
  await page.getByRole("button", { name: "🎮 Create & play" }).click();
  await page.getByText("Local model Pong is playable").waitFor({ timeout: 10000 });
  assert.match(
    await page.getByTestId("game-runtime-provenance").innerText(),
    /Local Model Hub.*qwen2\.5:3b/,
    "Arcade should show the local model that actually generated the game",
  );
  assert(localServerGenerationSeen, "Local Mode must route new games to the selected local Model Hub model without WebGPU");
  await page.getByLabel("Game change").fill("Add a multi-ball mode");
  await page.getByRole("button", { name: "Apply change" }).click();
  await page.getByText(/Revised Pong is playable/).waitFor({ timeout: 10000 });
  assert(localServerRevisionSeen, "Local Mode edits must route the existing source to the selected local model");
  report.push("Local Mode routed new-game and source-revision requests to the selected local Model Hub model with no provider keys (mocked inference endpoint).");
  const prepareHeldGeneration = (hasSource) => {
    heldGenerationHasSource = hasSource;
    holdNextGeneration = true;
    return new Promise(resolve => { generationStartedResolve = resolve; });
  };
  const existingGameFrame = page.locator('iframe[title="Add a multi-ball mode"]');
  await existingGameFrame.waitFor({ timeout: 10000 });
  let generationStarted = prepareHeldGeneration(false);
  await page.getByLabel("Game prompt").fill("A long local game request to cancel");
  await page.getByRole("button", { name: "🎮 Create & play" }).click();
  await generationStarted;
  await page.getByRole("button", { name: /Stop local generation/ }).click();
  await page.getByText("Generation stopped. Your current game is unchanged.").waitFor({ timeout: 5000 });
  releaseHeldGeneration?.();
  releaseHeldGeneration = null;
  await existingGameFrame.waitFor({ timeout: 5000 });

  generationStarted = prepareHeldGeneration(true);
  await page.getByLabel("Game change").fill("Change the score display, then cancel");
  await page.getByRole("button", { name: "Apply change" }).click();
  await generationStarted;
  await page.getByRole("button", { name: /Stop local generation/ }).click();
  await page.getByText("Revision stopped. Your current game is unchanged.").waitFor({ timeout: 5000 });
  releaseHeldGeneration?.();
  releaseHeldGeneration = null;
  await existingGameFrame.waitFor({ timeout: 5000 });
  report.push("Slow local-model creation and revisions can be cancelled without replacing the current playable game.");
  failNextGeneration = true;
  await page.getByLabel("Game prompt").fill("Keep my current game if this model is unavailable");
  await page.getByRole("button", { name: "🎮 Create & play" }).click();
  await page.getByText(/No game-writing model is reachable/).waitFor({ timeout: 10000 });
  assert.notEqual(
    await page.getByTestId("arcade-model-setup").getAttribute("open"),
    null,
    "a missing model takes the user to model setup instead of leaving them at the failed prompt",
  );
  await page.locator('iframe[title="Add a multi-ball mode"]').waitFor({ timeout: 10000 });
  report.push("A failed new game prompt preserves the last playable game.");
  let reaAnalysisRequests = 0;
  page.on("request", request => {
    if (request.url().includes("/api/arcade/import/analyze")) reaAnalysisRequests += 1;
  });
  await page.getByRole("tab", { name: "Import and emulate" }).click();
  await page.getByLabel(/I own this game or have permission to use and play it/).check();
  const browserGame = `<!doctype html><html><head><title>Open homebrew fixture</title></head><body><p id="hud">Score 0</p><canvas id="game" width="240" height="160"></canvas><script>const c=document.getElementById("game"),x=c.getContext("2d");let n=0,score=Number(localStorage.getItem("fixture-score")||0);document.getElementById("hud").textContent="Score "+score;addEventListener("keydown",e=>{if(e.key==="ArrowRight"){score++;localStorage.setItem("fixture-score",String(score));document.getElementById("hud").textContent="Score "+score}});function step(){x.fillStyle=n++%2?"#13b981":"#121826";x.fillRect(0,0,c.width,c.height);requestAnimationFrame(step)}step();</script></body></html>`;
  await page.locator('input[accept=".html,.htm,.zip,text/html,application/zip"]').setInputFiles({
    name: "open-homebrew-fixture.html",
    mimeType: "text/html",
    buffer: Buffer.from(browserGame),
  });
  const browserFrame = page.frameLocator('iframe[title="Playable game: open-homebrew-fixture.html"]');
  await browserFrame.locator("#game").waitFor({ timeout: 10000 });
  const reaAuthorization = page.getByTestId("checkbox-rea-authorized");
  const reaAnalyzeButton = page.getByTestId("button-rea-analyze");
  await reaAnalyzeButton.waitFor();
  assert(await reaAnalyzeButton.isDisabled(), "REA analysis must require explicit authorization");
  await reaAuthorization.check();
  assert(!(await reaAnalyzeButton.isDisabled()), "REA analysis should be enabled after authorization");
  assert.equal(reaAnalysisRequests, 0, "Importing a game or accepting the checkbox must not send source to REA");
  assert.equal(await page.getByTestId("rea-analysis-report").count(), 0, "REA should not produce a report before the user explicitly runs it");
  report.push("REA static analysis is optional, requires explicit authorization, and does not run during import.");
  await browserFrame.locator("#game").click();
  await page.keyboard.press("ArrowRight");
  await browserFrame.getByText("Score 1", { exact: true }).waitFor({ timeout: 3_000 });
  assert.equal(await browserFrame.locator("#hud").innerText(), "Score 1");
  await page.waitForFunction(() =>
    Object.keys(localStorage).some((key) => key.startsWith("arenaforge.game-save.v1:"))
  );
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("tab", { name: "Import and emulate" }).click();
  const restoredBrowserFrame = page.frameLocator('iframe[title="Playable game: open-homebrew-fixture.html"]');
  await restoredBrowserFrame.locator("#game").waitFor({ timeout: 10000 });
  assert.equal(await restoredBrowserFrame.locator("#hud").innerText(), "Score 1", "HTML game progress must survive a page reload");
  await page.evaluate(() => localStorage.setItem("af_local_mode", "1"));
  const revisedGameHtml = `<!doctype html><html><head><title>Revised fixture</title></head><body><canvas id="patched" width="240" height="160"></canvas><script>let score=0;const c=document.getElementById("patched"),x=c.getContext("2d");function loop(){score++;x.fillStyle="#13b981";x.fillRect(0,0,c.width,c.height);document.title="Score "+score;requestAnimationFrame(loop)}loop();addEventListener("keydown",()=>{});addEventListener("touchstart",()=>{});</script><!-- ${"original test-only game code ".repeat(60)} --></body></html>`;
  const revisedArchiveHtml = '<!doctype html><html><head><title>Revised offline project</title><style>#tile{width:48px;height:48px;background-image:url("data:ARENA_ASSET_TOKEN_0001");background-size:cover}</style></head><body><p id="hud">Score 0</p><div id="tile"></div><img id="dynamic-sprite" src="data:ARENA_ASSET_TOKEN_0004"><audio id="sfx" src="data:ARENA_ASSET_TOKEN_0002"></audio><button id="play-sfx">Play sound</button><button id="play-dynamic-sfx">Play dynamic sound</button><script>let score=Number(localStorage.getItem("zip-score")||0);const hud=document.getElementById("hud");hud.textContent="Score "+score;addEventListener("keydown",e=>{if(e.key==="ArrowRight"){score+=2;localStorage.setItem("zip-score",String(score));hud.textContent="Score "+score}});const dynamicSfx=new Audio("data:ARENA_ASSET_TOKEN_0003");dynamicSfx.id="dynamic-sfx";document.body.appendChild(dynamicSfx);document.getElementById("play-sfx").addEventListener("click",()=>{void document.getElementById("sfx").play()});document.getElementById("play-dynamic-sfx").addEventListener("click",()=>{void dynamicSfx.play()});</script></body></html>';
  let revisionRequestSeen = false;
  let archiveAudioBase64 = "";
  await page.route("**/api/arcade/import/revise", async route => {
    const body = route.request().postDataJSON();
    assert.equal(body.ephemeral, true, "Imported source revisions must not be saved to the shared game catalog");
    assert.equal(body.modelId, expectedModelId, "Imported-source revisions must use the selected model source");
    assert.equal(Boolean(body.localOnly), expectedLocalOnly, "Imported-source revisions must preserve Local Mode");
    if (expectedLocalOnly) assert.equal(body.keys, undefined, "Local Mode must not send provider keys for imported source");
    revisionRequestSeen = true;
    if (body.prompt === "Add a pause overlay") {
      assert(body.priorCode.includes("Open homebrew fixture"), "Imported source must be included in the revision request");
    } else if (body.prompt === "Make movement faster") {
      assert(body.priorCode.includes("data:ARENA_ASSET_TOKEN_0001"), "Bundled images must stay out of model input");
      assert(!body.priorCode.includes("data:image/svg+xml;base64,"), "Binary image bytes must remain in the browser");
      assert(body.priorCode.includes("data:ARENA_ASSET_TOKEN_0002"), "Bundled audio must stay out of model input");
      assert(body.priorCode.includes("data:ARENA_ASSET_TOKEN_0003"), "JavaScript audio assets must stay out of model input");
      assert(body.priorCode.includes("data:ARENA_ASSET_TOKEN_0004"), "JavaScript image assets must stay out of model input");
      assert(!body.priorCode.includes(archiveAudioBase64), "Binary audio bytes must remain in the browser");
    } else {
      assert.fail(`Unexpected imported-game revision prompt: ${body.prompt}`);
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ code: body.prompt === "Make movement faster" ? revisedArchiveHtml : revisedGameHtml }),
    });
  });
  await page.getByLabel("Revise this browser game").fill("Add a pause overlay");
  await page.getByRole("button", { name: "Apply revision" }).click();
  await page.getByText("Revision applied to the current playable file.").waitFor({ timeout: 10000 });
  assert(revisionRequestSeen, "Prompt revision did not use the selected model route");
  await page.frameLocator('iframe[title="Playable game: open-homebrew-fixture.html"]').locator("#patched").waitFor();
  await page.getByLabel(/I own this game or have permission to use and play it/).check();
  const archive = new JSZip();
  archive.file("game/index.html", '<!doctype html><html><head><title>Offline project</title><link rel="stylesheet" href="game.css"></head><body><p id="hud">Score 0</p><div id="tile"></div><audio id="sfx" src="assets/tone.wav"></audio><button id="play-sfx">Play sound</button><button id="play-dynamic-sfx">Play dynamic sound</button><script src="game.js"></script></body></html>');
  archive.file("game/game.css", '#tile{width:48px;height:48px;background-image:url("assets/tile.svg");background-size:cover}');
  archive.file("game/game.js", 'let score=Number(localStorage.getItem("zip-score")||0);const hud=document.getElementById("hud");hud.textContent="Score "+score;addEventListener("keydown",e=>{if(e.key==="ArrowRight"){score++;localStorage.setItem("zip-score",String(score));hud.textContent="Score "+score}});const dynamicSfx=new Audio("assets/tone.wav");dynamicSfx.id="dynamic-sfx";document.body.appendChild(dynamicSfx);const dynamicSprite=new Image();dynamicSprite.id="dynamic-sprite";dynamicSprite.src="assets/tile.svg";document.body.appendChild(dynamicSprite);document.getElementById("play-sfx").addEventListener("click",()=>{void document.getElementById("sfx").play()});document.getElementById("play-dynamic-sfx").addEventListener("click",()=>{void dynamicSfx.play()});');
  archive.file("game/assets/tile.svg", '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#13b981"/></svg>');
  const archiveAudio = makePcmWav(440, 0.2, 1);
  archiveAudioBase64 = archiveAudio.toString("base64");
  archive.file("game/assets/tone.wav", archiveAudio);
  const archiveBuffer = await archive.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  await page.locator('input[accept=".html,.htm,.zip,text/html,application/zip"]').setInputFiles({
    name: "open-homebrew-project.zip",
    mimeType: "application/zip",
    buffer: archiveBuffer,
  });
  const archiveFrame = page.frameLocator('iframe[title="Playable game: open-homebrew-project.zip"]');
  await archiveFrame.locator("#tile").waitFor({ timeout: 10000 });
  await archiveFrame.locator("#dynamic-sprite").waitFor({ timeout: 10000 });
  const bundledBackground = await archiveFrame.locator("#tile").evaluate(element => getComputedStyle(element).backgroundImage);
  assert(bundledBackground.includes("data:image/svg+xml;base64,"), "Local archive assets must be bundled into the playable HTML");
  const dynamicSprite = archiveFrame.locator("#dynamic-sprite");
  assert(
    (await dynamicSprite.getAttribute("src"))?.startsWith("data:image/svg+xml;base64,"),
    "JavaScript image source assignments must be bundled as offline data URLs",
  );
  const archiveAudioElement = archiveFrame.locator("#sfx");
  assert(
    (await archiveAudioElement.getAttribute("src"))?.startsWith("data:audio/wav;base64,"),
    "Local archive audio must be bundled as an offline WAV data URL",
  );
  const assertAudioStarts = async audioElement => {
    const started = await audioElement.evaluate(audio => new Promise(resolve => {
      if (!audio.paused && audio.readyState >= 2) return resolve(true);
      const timer = setTimeout(() => resolve(false), 3000);
      audio.addEventListener("playing", () => {
        clearTimeout(timer);
        resolve(true);
      }, { once: true });
    }));
    assert.equal(started, true, "The imported local audio must actually play in the restricted iframe");
    await audioElement.evaluate(audio => audio.pause());
  };
  await archiveFrame.getByRole("button", { name: "Play sound" }).click();
  await assertAudioStarts(archiveAudioElement);
  const dynamicAudioElement = archiveFrame.locator("#dynamic-sfx");
  assert(
    (await dynamicAudioElement.getAttribute("src"))?.startsWith("data:audio/wav;base64,"),
    "Static new Audio() paths must be bundled as offline WAV data URLs",
  );
  await archiveFrame.getByRole("button", { name: "Play dynamic sound" }).click();
  await assertAudioStarts(dynamicAudioElement);
  await archiveFrame.locator("#tile").click();
  await archiveFrame.locator("#tile").evaluate(element =>
    element.ownerDocument.defaultView?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })),
  );
  await page.waitForTimeout(50);
  assert.equal(await archiveFrame.locator("#hud").innerText(), "Score 1", "Bundled game JavaScript must run with keyboard input");
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("tab", { name: "Import and emulate" }).click();
  const restoredArchiveFrame = page.frameLocator('iframe[title="Playable game: open-homebrew-project.zip"]');
  await restoredArchiveFrame.locator("#hud").waitFor({ timeout: 10000 });
  assert.equal(await restoredArchiveFrame.locator("#hud").innerText(), "Score 1", "Bundled game progress must survive a page reload");
  await page.evaluate(() => localStorage.setItem("af_local_mode", "1"));
  await page.getByLabel(/I own this game or have permission to use and play it/).check();
  await page.getByLabel("Revise this browser game").fill("Make movement faster");
  await page.getByRole("button", { name: "Apply revision" }).click();
  await page.getByText("Revision applied to the current playable file.").waitFor({ timeout: 10000 });
  const revisedArchiveFrame = page.frameLocator('iframe[title="Playable game: open-homebrew-project.zip"]');
  const revisedArchiveScript = await revisedArchiveFrame.locator("script").evaluateAll(scripts => scripts.map(script => script.textContent ?? "").join("\n"));
  assert(revisedArchiveScript.includes("score+=2"), "The imported game's actual scoring logic must be rewritten");
  const restoredImage = await revisedArchiveFrame.locator("#tile").evaluate(element => getComputedStyle(element).backgroundImage);
  assert(restoredImage.includes("data:image/svg+xml;base64,"), "Original local image must be restored after model revision");
  const restoredDynamicSprite = revisedArchiveFrame.locator("#dynamic-sprite");
  assert(
    (await restoredDynamicSprite.getAttribute("src"))?.startsWith("data:image/svg+xml;base64,"),
    "Original JavaScript image sources must be restored after model revision",
  );
  const revisedAudioElement = revisedArchiveFrame.locator("#sfx");
  assert(
    (await revisedAudioElement.getAttribute("src"))?.startsWith("data:audio/wav;base64,"),
    "Original local audio must be restored after model revision",
  );
  await revisedArchiveFrame.getByRole("button", { name: "Play sound" }).click();
  await assertAudioStarts(revisedAudioElement);
  const revisedDynamicAudioElement = revisedArchiveFrame.locator("#dynamic-sfx");
  assert(
    (await revisedDynamicAudioElement.getAttribute("src"))?.startsWith("data:audio/wav;base64,"),
    "Original JavaScript audio references must be restored after model revision",
  );
  await revisedArchiveFrame.getByRole("button", { name: "Play dynamic sound" }).click();
  await assertAudioStarts(revisedDynamicAudioElement);
  await revisedArchiveFrame.locator("#tile").evaluate(element => element.ownerDocument.defaultView?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
  await page.waitForTimeout(50);
  assert.equal(await revisedArchiveFrame.locator("#hud").innerText(), "Score 3", "Prompt revision must change imported gameplay, not just theme");
  await page.locator('input[accept=".html,.htm,.zip,text/html,application/zip"]').setInputFiles({
    name: "blocked-remote-resource.html",
    mimeType: "text/html",
    buffer: Buffer.from('<!doctype html><html><head><script src="https://example.invalid/game.js"></script></head><body></body></html>'),
  });
  assert((await page.getByRole("alert").innerText()).includes("external resource"));
  report.push("Authorized HTML imports play in a sandbox, prompt revisions carry the original source and remain unlisted, and external resources are refused.");
  await page.locator('input[accept=".nes,application/octet-stream"]').setInputFiles({
    name: "open-homebrew-fixture.nes",
    mimeType: "application/octet-stream",
    buffer: makeHomebrewNesRom(),
  });
  const nesCanvas = page.locator('canvas[aria-label="NES game screen"]');
  await nesCanvas.waitFor({ timeout: 10000 });
  await page.waitForFunction(() => {
    const canvas = document.querySelector('canvas[aria-label="NES game screen"]');
    const pixels = canvas?.getContext("2d")?.getImageData(0, 0, 256, 240).data;
    if (!pixels) return false;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i] || pixels[i + 1] || pixels[i + 2]) return true;
    }
    return false;
  }, { timeout: 10000 });
  await nesCanvas.click();
  await page.keyboard.press("ArrowRight");
  await page.getByRole("button", { name: "A", exact: true }).click();
  await page.getByRole("button", { name: "Save progress" }).click();
  await page.getByText("Progress saved on this browser.").waitFor({ timeout: 10000 });
  assert((await page.locator("body").innerText()).includes("mapper IDs 0–5"));
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("tab", { name: "Import and emulate" }).click();
  await page.getByRole("button", { name: /open-homebrew-fixture\.nes NES homebrew/ }).waitFor({ timeout: 10000 });
  await page.getByRole("button", { name: "Restore save" }).waitFor({ timeout: 10000 });
  report.push("Generated homebrew iNES ROM boots, renders a frame, accepts keyboard/touch controls, and restores a local save state after reload.");
  await page.getByLabel(/I own this game or have permission to use and play it/).check();
  await page.getByTestId("input-multisystem-rom").setInputFiles({
    name: "arcade-open-homebrew.gb",
    mimeType: "application/octet-stream",
    buffer: makeHomebrewGameBoyRom(),
  });
  const emulatorStatus = page.locator('iframe[data-testid="emulatorjs-player"] + p[role="status"]');
  await emulatorStatus.waitFor({ timeout: 15000 });
  await page.getByText("Game Boy / Game Boy Color game imported to this browser's local shelf.").waitFor({ timeout: 10000 });
  await emulatorStatus.getByText(/Core ready/).waitFor({ timeout: 120000 });
  await emulatorStatus.getByText(/Running/).waitFor({ timeout: 30000 });
  const emulatorFrame = page.frameLocator('iframe[data-testid="emulatorjs-player"]');
  const emulatorCanvas = emulatorFrame.locator("canvas").first();
  await emulatorCanvas.waitFor({ timeout: 30000 });
  await emulatorFrame.getByRole("button", { name: "Control Settings" }).waitFor({ timeout: 10000 });
  await emulatorFrame.getByRole("button", { name: "Save State" }).click();
  await emulatorFrame.getByText(/SAVE SAVED TO BROWSER/i).waitFor({ timeout: 15000 });
  const emulatorCache = await page.evaluate(async () => {
    if (!("databases" in indexedDB)) return [];
    const databases = await indexedDB.databases();
    return databases.map((database) => database.name).filter(Boolean);
  });
  assert(emulatorCache.some((name) => name?.includes("EmulatorJS-core")), "EmulatorJS should cache the selected system core locally");
  assert(emulatorCache.includes("EmulatorJS-states"), "EmulatorJS should store save states in browser-local storage");
  assert((await page.locator("body").innerText()).includes("GB/GBC, GBA, SNES"), "Arcade must show the supported emulator systems");
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("tab", { name: "Import and emulate" }).click();
  await page.getByText("arcade-open-homebrew.gb", { exact: true }).first().waitFor({ timeout: 10000 });
  const restoredEmulatorStatus = page.locator('iframe[data-testid="emulatorjs-player"] + p[role="status"]');
  await restoredEmulatorStatus.getByText(/Running/).waitFor({ timeout: 120000 });
  const restoredEmulator = page.frameLocator('iframe[data-testid="emulatorjs-player"]');
  await restoredEmulator.getByRole("button", { name: "Load State" }).click();
  await restoredEmulator.getByText(/SAVE LOADED FROM BROWSER/i).waitFor({ timeout: 15000 });
  report.push("The Game Boy emulator core initializes with control settings exposed; its browser-local save state restores after reload.");
  await page.setViewportSize({ width: 1280, height: 900 });
  createdSubscriptionName = `Arena smoke subscription ${Date.now()}`;
  await page.goto(`${base}/subscriptions`, { waitUntil: "networkidle" });
  await page.getByPlaceholder("Name (Netflix…)", { exact: true }).fill(createdSubscriptionName);
  await page.getByPlaceholder("Amount (12.99)", { exact: true }).fill("7.99");
  await page.locator('input[type="date"]').fill("2099-06-15");
  await page.getByRole("button", { name: "Add subscription", exact: true }).click();
  const subscriptionRow = () => page.getByText(createdSubscriptionName, { exact: true }).locator("xpath=ancestor::li[1]");
  await page.getByText("Subscription added.", { exact: true }).waitFor({ timeout: 10000 });
  await subscriptionRow().getByRole("button", { name: "Pause", exact: true }).click();
  await subscriptionRow().getByRole("button", { name: "Resume", exact: true }).waitFor({ timeout: 10000 });
  await page.reload({ waitUntil: "networkidle" });
  await subscriptionRow().getByRole("button", { name: "Resume", exact: true }).waitFor({ timeout: 10000 });
  await subscriptionRow().getByRole("button", { name: "Resume", exact: true }).click();
  await subscriptionRow().getByRole("button", { name: "Pause", exact: true }).waitFor({ timeout: 10000 });
  await page.reload({ waitUntil: "networkidle" });
  await subscriptionRow().getByRole("button", { name: "Pause", exact: true }).waitFor({ timeout: 10000 });
  await subscriptionRow().getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByText(createdSubscriptionName, { exact: true }).waitFor({ state: "detached", timeout: 10000 });
  await page.reload({ waitUntil: "networkidle" });
  assert.equal(await page.getByText(createdSubscriptionName, { exact: true }).count(), 0, "Deleted subscription reappeared after reload");
  report.push("Subscriptions can be added, paused and resumed across reloads, then deleted without leaving stale UI state.");
  await page.route("**/api/subscriptions", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "database unavailable" }),
      });
      return;
    }
    await route.continue();
  });
  await page.goto(`${base}/subscriptions`, { waitUntil: "networkidle" });
  await page.getByRole("alert").getByText(/Could not load subscriptions.*database unavailable/).waitFor({ timeout: 10000 });
  assert.equal(await page.getByText("Nothing tracked yet.", { exact: true }).count(), 0, "A database error must not look like an empty list");
  await page.unroute("**/api/subscriptions");
  await page.reload({ waitUntil: "networkidle" });
  assert.equal(await page.getByRole("alert").filter({ hasText: "Could not load subscriptions" }).count(), 0, "Subscription list did not recover after the API returned");
  report.push("A subscription database outage shows a retryable error rather than a false empty state.");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(base + "/", { waitUntil: "networkidle" });
  await page.screenshot({ path: new URL("mobile.jpg", output).pathname, fullPage: true });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2), "Homepage overflows mobile viewport");
  assert.equal(errors.length, 0, `Browser errors: ${errors.join("; ")}`);
  report.push("Mobile homepage has no horizontal overflow; no uncaught browser errors.");
  const csrf = await context.request.post(base + "/api/projects", {
    headers: { origin: "https://foreign.example", "sec-fetch-site": "cross-site" }, data: { name: "Must not be created" },
  });
  assert.equal(csrf.status(), 403);
  report.push("Cross-origin mutation protection passed.");
  await writeFile(new URL("report.json", output), JSON.stringify({ passed: true, report }, null, 2));
  console.log(report.join("\n"));
} catch (error) {
  console.error("Browser errors:", errors);
  console.error("Visible page:", (await page.locator("body").innerText()).slice(0, 4000));
  await page.screenshot({ path: new URL("failure.jpg", output).pathname, fullPage: true });
  throw error;
} finally {
  if (createdProject) await context.request.delete(`${base}/api/projects/${createdProject}`);
  if (createdSpaceId) await context.request.delete(`${base}/api/spaces/${createdSpaceId}`);
  if (createdSubscriptionName) {
    try {
      const response = await context.request.get(`${base}/api/subscriptions`);
      if (response.ok()) {
        const data = await response.json();
        for (const subscription of data.subscriptions ?? []) {
          if (subscription.name === createdSubscriptionName) {
            await context.request.post(`${base}/api/subscriptions`, { data: { action: "delete", id: subscription.id } });
          }
        }
      }
    } catch {
      // Keep smoke cleanup best-effort if the database itself is unavailable.
    }
  }
  if (battleId) await context.request.delete(`${base}/api/battles/${battleId}`);
  if (fallbackBattleId) await context.request.delete(`${base}/api/battles/${fallbackBattleId}`);
  await browser.close();
}
