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
            ? { status: "processing", reason: "Stem separation is still running." }
            : { status: "separated", stemCount: 4 },
      },
      {
        ...notStartedTrack,
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
  let liveTrackAddRequestCount = 0;
  let liveTrackPatchRequestCount = 0;
  let liveDonorFetchCount = 0;
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
    } else if (url.pathname.endsWith("/separation") && route.request().method() === "POST") {
      mockStartCount += 1;
      mockNotStartedState = "processing";
      setTimeout(() => { mockNotStartedState = "separated"; }, 1500);
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({ state: "queued", jobId: "arena-smoke-new-separation" }),
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
      await route.fulfill({ status: 200, contentType: "audio/wav", body: donorStemWav });
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
    body: JSON.stringify({ projects: [] }),
  }));
  await page.route("**/api/jobs/arena-smoke-stem-job/retry", async route => {
    assert.equal(route.request().method(), "POST");
    mockRetryCount += 1;
    mockStemState = "processing";
    setTimeout(() => { mockStemState = "separated"; }, 1500);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ job: { id: "arena-smoke-stem-job", status: "queued" } }),
    });
  });
  await page.goto(`${base}/waveyard`, { waitUntil: "networkidle" });
  const recoveryRow = page.locator('[data-testid="library-track"]').filter({ hasText: "Retryable track" });
  const notStartedRow = page.locator('[data-testid="library-track"]').filter({ hasText: "Not started track" });
  await recoveryRow.getByText("SEPARATION REJECTED", { exact: true }).waitFor();
  await notStartedRow.getByText("NOT STARTED", { exact: true }).waitFor();
  assert.equal(await notStartedRow.getByRole("link", { name: "Studio ↗" }).getAttribute("href"), "/waveyard/projects/arena-smoke-not-started-project");
  const retrySeparationButton = recoveryRow.getByRole("button", { name: "Retry separation for Retryable track" });
  await retrySeparationButton.click();
  await recoveryRow.getByText("SEPARATING…", { exact: true }).waitFor();
  await page.getByRole("status").filter({ hasText: "Retryable track: separation retry started." }).waitFor();
  assert.equal(mockRetryCount, 1, "retrying a rejected separation must submit one idempotent job retry");
  await recoveryRow.getByText("4 STEMS", { exact: true }).waitFor({ timeout: 12000 });
  assert.equal(await page.getByRole("button", { name: "Retry separation for Retryable track" }).count(), 0);
  report.push("The library identifies a rejected stem job, retries it in place, and updates from processing to separated without a reload.");
  const startSeparationButton = notStartedRow.getByRole("button", { name: "Start separation for Not started track" });
  await startSeparationButton.click();
  await notStartedRow.getByText("SEPARATING…", { exact: true }).waitFor();
  await page.getByRole("status").filter({ hasText: "Not started track: separation started." }).waitFor();
  assert.equal(mockStartCount, 1, "starting separation for an unprocessed track must submit one job");
  await page.reload({ waitUntil: "networkidle" });
  const reloadedNotStartedRow = page.locator('[data-testid="library-track"]').filter({ hasText: "Not started track" });
  await reloadedNotStartedRow.getByText("4 STEMS", { exact: true }).waitFor({ timeout: 12000 });
  assert.equal(await reloadedNotStartedRow.getByRole("button", { name: "Start separation for Not started track" }).count(), 0);
  report.push("A library track with no separation job can start work directly, then shows the persisted result after reload.");

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
  await page.waitForFunction((assetId) => {
    const audio = document.querySelector(`audio[src$="/${assetId}"]`);
    return audio?.getAttribute("aria-label") === "vocals audio (swapped layer)";
  }, liveVocalsAssetId, { timeout: 8_000 });
  await page.waitForFunction(() => {
    const bar = document.querySelector(".wy-stem-vocals .wy-stem-meter i");
    const peak = Number(bar?.getAttribute("style")?.match(/scaleX\(([^)]+)\)/)?.[1] ?? 0);
    return peak > 0.4;
  }, null, { timeout: 8_000 });
  assert.equal(liveSwapRequestCount, 1, "choosing a live donor must persist exactly one swap");
  assert.equal(liveDonorFetchCount, 1, "the selected donor's actual audio must be downloaded and decoded");
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
  report.push("A live donor changes the audible vocal meter while playback keeps its clock; isolation silences drums, and the Camelot wheel cues a compatible library track directly.");

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
  await page.goto(`${base}/arcade`, { waitUntil: "networkidle" });
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
  let failNextGeneration = false;
  const generatedPong = '<!doctype html><html><head><title>Generated Pong</title></head><body><p id="generated-pong">AI Pong</p><canvas width="320" height="180"></canvas><script>let x=0;const c=document.querySelector("canvas"),ctx=c.getContext("2d");addEventListener("keydown",e=>{if(e.key==="ArrowRight")x++});function loop(){ctx.fillStyle="#111";ctx.fillRect(0,0,320,180);ctx.fillStyle="#fff";ctx.fillRect(x,20,8,30);requestAnimationFrame(loop)}loop();</script></body></html>';
  const revisedOfflinePlatformer = '<!doctype html><html><head><title>Revised local platformer</title></head><body><p id="offline-revision-marker">Double jump added</p><canvas width="320" height="180"></canvas><script>let jumps=2;addEventListener("keydown",e=>{if(e.key===" ")jumps--});requestAnimationFrame(function loop(){requestAnimationFrame(loop)});</script></body></html>';
  await page.route("**/api/arcade/forge", async route => {
    const body = route.request().postDataJSON();
    assert.equal(body.modelId, "openai", "the selected model source must reach the game-generation route");
    if (failNextGeneration) {
      failNextGeneration = false;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "No game-writing model is reachable." }),
      });
      return;
    }
    if (body.prompt === "Pong") {
      promptGenerationSeen = true;
    } else {
      assert.equal(body.prompt, "Add a double jump");
      assert.equal(body.ephemeral, true, "Offline starter revisions must not be saved to the shared catalog");
      assert.equal(body.parentId, undefined, "Offline starter revisions must not use a shared-game parent");
      assert(body.priorCode.includes("PLATFORM ADVENTURE"), "Offline revisions must carry the actual starter source");
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        game: body.prompt === "Pong" ? { id: "arena-smoke-pong", gameType: "pong" } : null,
        code: body.prompt === "Pong" ? generatedPong : revisedOfflinePlatformer,
        title: body.prompt === "Pong" ? "Generated Pong" : "Revised local platformer",
        runtime: { ms: 12 },
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
  failNextGeneration = true;
  await page.getByLabel("Game prompt").fill("Keep my current game if this model is unavailable");
  await page.getByRole("button", { name: "🎮 Create & play" }).click();
  await page.getByText(/No game-writing model is reachable/).waitFor({ timeout: 10000 });
  await page.locator('iframe[title="Pong"]').waitFor({ timeout: 10000 });
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
  await page.evaluate(() => localStorage.setItem("af_local_mode", "0"));
  const revisedGameHtml = `<!doctype html><html><head><title>Revised fixture</title></head><body><canvas id="patched" width="240" height="160"></canvas><script>let score=0;const c=document.getElementById("patched"),x=c.getContext("2d");function loop(){score++;x.fillStyle="#13b981";x.fillRect(0,0,c.width,c.height);document.title="Score "+score;requestAnimationFrame(loop)}loop();addEventListener("keydown",()=>{});addEventListener("touchstart",()=>{});</script><!-- ${"original test-only game code ".repeat(60)} --></body></html>`;
  const revisedArchiveHtml = '<!doctype html><html><head><title>Revised offline project</title><style>#tile{width:48px;height:48px;background-image:url("data:ARENA_ASSET_TOKEN_0001");background-size:cover}</style></head><body><p id="hud">Score 0</p><div id="tile"></div><script>let score=Number(localStorage.getItem("zip-score")||0);const hud=document.getElementById("hud");hud.textContent="Score "+score;addEventListener("keydown",e=>{if(e.key==="ArrowRight"){score+=2;localStorage.setItem("zip-score",String(score));hud.textContent="Score "+score}});</script></body></html>';
  let revisionRequestSeen = false;
  await page.route("**/api/arcade/import/revise", async route => {
    const body = route.request().postDataJSON();
    assert.equal(body.ephemeral, true, "Imported source revisions must not be saved to the shared game catalog");
    assert.equal(body.modelId, "openai", "Imported-source revisions must use the selected model source");
    revisionRequestSeen = true;
    if (body.prompt === "Add a pause overlay") {
      assert(body.priorCode.includes("Open homebrew fixture"), "Imported source must be included in the revision request");
    } else if (body.prompt === "Make movement faster") {
      assert(body.priorCode.includes("data:ARENA_ASSET_TOKEN_0001"), "Bundled images must stay out of model input");
      assert(!body.priorCode.includes("data:image/svg+xml;base64,"), "Binary image bytes must remain in the browser");
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
  archive.file("game/index.html", '<!doctype html><html><head><title>Offline project</title><link rel="stylesheet" href="game.css"></head><body><p id="hud">Score 0</p><div id="tile"></div><script src="game.js"></script></body></html>');
  archive.file("game/game.css", '#tile{width:48px;height:48px;background-image:url("assets/tile.svg");background-size:cover}');
  archive.file("game/game.js", 'let score=Number(localStorage.getItem("zip-score")||0);const hud=document.getElementById("hud");hud.textContent="Score "+score;addEventListener("keydown",e=>{if(e.key==="ArrowRight"){score++;localStorage.setItem("zip-score",String(score));hud.textContent="Score "+score}});');
  archive.file("game/assets/tile.svg", '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#13b981"/></svg>');
  const archiveBuffer = await archive.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  await page.locator('input[accept=".html,.htm,.zip,text/html,application/zip"]').setInputFiles({
    name: "open-homebrew-project.zip",
    mimeType: "application/zip",
    buffer: archiveBuffer,
  });
  const archiveFrame = page.frameLocator('iframe[title="Playable game: open-homebrew-project.zip"]');
  await archiveFrame.locator("#tile").waitFor({ timeout: 10000 });
  const bundledBackground = await archiveFrame.locator("#tile").evaluate(element => getComputedStyle(element).backgroundImage);
  assert(bundledBackground.includes("data:image/svg+xml;base64,"), "Local archive assets must be bundled into the playable HTML");
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
  await page.evaluate(() => localStorage.setItem("af_local_mode", "0"));
  await page.getByLabel(/I own this game or have permission to use and play it/).check();
  await page.getByLabel("Revise this browser game").fill("Make movement faster");
  await page.getByRole("button", { name: "Apply revision" }).click();
  await page.getByText("Revision applied to the current playable file.").waitFor({ timeout: 10000 });
  const revisedArchiveFrame = page.frameLocator('iframe[title="Playable game: open-homebrew-project.zip"]');
  const revisedArchiveScript = await revisedArchiveFrame.locator("script").evaluateAll(scripts => scripts.map(script => script.textContent ?? "").join("\n"));
  assert(revisedArchiveScript.includes("score+=2"), "The imported game's actual scoring logic must be rewritten");
  const restoredImage = await revisedArchiveFrame.locator("#tile").evaluate(element => getComputedStyle(element).backgroundImage);
  assert(restoredImage.includes("data:image/svg+xml;base64,"), "Original local image must be restored after model revision");
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
