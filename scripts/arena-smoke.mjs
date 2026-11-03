if (process.argv.includes("--mod-workshop-only")) {
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync("pnpm", ["--filter", "@workspace/scripts", "exec", "tsx", "--test", `${process.cwd()}/lib/arena/src/lib/games/mod-workshop.test.ts`, `${process.cwd()}/desktop/arcade-workshop.test.ts`], { stdio: "inherit" });
  process.exit(result.status ?? 1);
}
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { makeHomebrewNesRom, checkNesInputs, checkNesSaves, runNesInputSmoke } from "./arcade-nes-input-checks.mjs";

if (process.argv.includes("--nes-save-only")) {
  await runNesInputSmoke({ saveOnly: true });
  process.exit(0);
}

if (process.argv.includes("--nes-input-only")) {
  await runNesInputSmoke();
  process.exit(0);
}

if (process.argv.includes("--arcade-manifest-only")) {
  await import("./arcade-manifest-foundation.mjs");
  process.exit(0);
}
if (process.argv.includes("--progress-isolation-only") || process.argv.includes("--progress-backup-only")) {
  await import("./arcade-progress-isolation.mjs");
  process.exit(0);
}

if (process.argv.includes("--chip8-only") || process.argv.includes("--chip8-backup-only")) {
  await import("./arcade-chip8-smoke.mjs");
  process.exit(0);
}
if (process.argv.includes("--revision-rollback-only")) {
  await import("./arcade-revision-rollback.mjs");
  process.exit(0);
}
const waveyardMobileOnly = process.argv.includes("--waveyard-mobile-only");
const waveyardMobileOnlyComplete = "WAVEYARD_MOBILE_ONLY_COMPLETE";
const sessionModeRacesOnly = process.argv.includes("--session-mode-races-only");

if (!sessionModeRacesOnly) {
  execFileSync(
    process.execPath,
    [new URL("./waveyard-stem-transport.mjs", import.meta.url).pathname],
    { stdio: "inherit" },
  );
  execFileSync(
    process.execPath,
    [new URL("./waveyard-arrangement-preview.mjs", import.meta.url).pathname],
    { stdio: "inherit" },
  );
}

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
let touchSession = null;
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
if (sessionModeRacesOnly) {
  try {
    const { verifySessionModeRaces } = await import("./waveyard-session-mode-races.mjs");
    await verifySessionModeRaces({ page, context, base, makePcmWav, output });
    assert.deepEqual(errors, [], "Mode-save races must not raise browser errors");
  } finally {
    await browser.close();
  }
  process.exit(0);
}
async function touchAt(locator, offsetX, offsetY) {
  const bounds = await locator.boundingBox();
  assert(bounds, "Touch target must have visible bounds");
  if (!touchSession) {
    touchSession = await context.newCDPSession(page);
    await touchSession.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  }
  const x = Math.round(bounds.x + offsetX);
  const y = Math.round(bounds.y + offsetY);
  await touchSession.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y, id: 1, radiusX: 1, radiusY: 1, force: 1 }],
  });
  await touchSession.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}
async function tapCenter(locator) {
  const bounds = await locator.boundingBox();
  assert(bounds, "Touch target must have visible bounds");
  await touchAt(locator, bounds.width / 2, bounds.height / 2);
}
async function dragTouch(locator, deltaX, deltaY, cancel = false, xFraction = 0.5, yFraction = 0.5) {
  const bounds = await locator.boundingBox();
  assert(bounds, "Touch drag target must have visible bounds");
  if (!touchSession) {
    touchSession = await context.newCDPSession(page);
    await touchSession.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  }
  const startX = Math.round(bounds.x + bounds.width * xFraction);
  const startY = Math.round(bounds.y + bounds.height * yFraction);
  const hit = await locator.evaluate((element, point) => {
    const target = document.elementFromPoint(point.x, point.y);
    return {
      visible: point.x >= 0 && point.x < document.documentElement.clientWidth
        && point.y >= 0 && point.y < document.documentElement.clientHeight,
      onTarget: target === element || element.contains(target),
      hit: target instanceof HTMLElement ? `${target.tagName}.${target.className}` : target?.nodeName,
      viewport: { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight },
    };
  }, { x: startX, y: startY });
  assert(hit.visible && hit.onTarget, `Touch drag must start on the visible control: ${JSON.stringify(hit)}`);
  await touchSession.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: startX, y: startY, id: 1, radiusX: 1, radiusY: 1, force: 1 }],
  });
  for (let step = 1; step <= 4; step += 1) {
    await touchSession.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{
        x: Math.round(startX + deltaX * step / 4),
        y: Math.round(startY + deltaY * step / 4),
        id: 1,
        radiusX: 1,
        radiusY: 1,
        force: 1,
      }],
    });
    await page.waitForTimeout(20);
  }
  await touchSession.send("Input.dispatchTouchEvent", {
    type: cancel ? "touchCancel" : "touchEnd",
    touchPoints: [],
  });
}
async function swipeTouch(locator, deltaX, deltaY, xFraction = 0.5, yFraction = 0.5) {
  const bounds = await locator.boundingBox();
  assert(bounds, "Touch swipe target must have visible bounds");
  if (!touchSession) {
    touchSession = await context.newCDPSession(page);
    await touchSession.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  }
  const startX = Math.round(bounds.x + bounds.width * xFraction);
  const startY = Math.round(bounds.y + bounds.height * yFraction);
  assert(await locator.evaluate((element, point) => {
    const hit = document.elementFromPoint(point.x, point.y);
    return hit === element || element.contains(hit);
  }, { x: startX, y: startY }), "The touch swipe must begin on its intended visible target");
  await touchSession.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: startX, y: startY, id: 1, radiusX: 1, radiusY: 1, force: 1 }],
  });
  for (let step = 1; step <= 5; step += 1) {
    await touchSession.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{
        x: Math.round(startX + deltaX * step / 5),
        y: Math.round(startY + deltaY * step / 5),
        id: 1,
        radiusX: 1,
        radiusY: 1,
        force: 1,
      }],
    });
    await page.waitForTimeout(24);
  }
  await touchSession.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}
async function setSimulatedVisibility(targetPage, visibilityState) {
  await targetPage.evaluate((nextState) => {
    if (!Object.hasOwn(document, "__arenaSmokeVisibility")) {
      Object.defineProperty(document, "__arenaSmokeVisibility", {
        configurable: true,
        writable: true,
        value: document.visibilityState,
      });
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => document.__arenaSmokeVisibility,
      });
    }
    document.__arenaSmokeVisibility = nextState;
    document.dispatchEvent(new Event("visibilitychange"));
  }, visibilityState);
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
function makeUnsupportedMapperRom(mapper) {
  const header = Buffer.alloc(16);
  Buffer.from([0x4e, 0x45, 0x53, 0x1a, 1, 1, (mapper & 0x0f) << 4, mapper & 0xf0]).copy(header);
  return Buffer.concat([header, Buffer.alloc(0x6000)]);
}
function makeMalformedNesRom() {
  const header = Buffer.alloc(16);
  Buffer.from([0x4e, 0x45, 0x53, 0x00]).copy(header);
  return header;
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
function makeHomebrewChip8Rom() {
  // Original classic CHIP-8 program: wait for a key, then draw a five-row glyph
  // and loop. The hand-authored opcodes contain no third-party game code/assets.
  return Buffer.from([
    0xf0, 0x0a, // LD V0, K
    0xa2, 0x0c, // LD I, sprite
    0x60, 0x00, // LD V0, 0
    0x61, 0x00, // LD V1, 0
    0xd0, 0x15, // DRW V0, V1, 5
    0x12, 0x0a, // JP draw
    0xf0, 0x90, 0xf0, 0x90, 0x90, 0x00,
  ]);
}
async function json(url, options = {}) {
  const res = await context.request.fetch(base + url, options);
  assert(res.ok(), `${options.method || "GET"} ${url}: ${res.status()} ${await res.text()}`);
  return res.json();
}
async function verifyRecentRoomResume() {
  const resumeContext = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    serviceWorkers: "block",
  });
  try {
    const resumePage = await resumeContext.newPage();
    await resumePage.goto(`${base}/arcade`, { waitUntil: "networkidle" });
    await resumePage.waitForFunction(
      () => localStorage.getItem("arena:last-used-room:v1") === "/arcade",
    );
    await resumePage.goto(`${base}/runtime`, { waitUntil: "networkidle" });
    assert.equal(
      await resumePage.evaluate(() => localStorage.getItem("arena:last-used-room:v1")),
      "/arcade",
      "runtime settings must not replace the last product room",
    );
    await resumePage.goto(`${base}/`, { waitUntil: "networkidle" });
    const resumeCard = resumePage.locator('[aria-label="Continue to your last room"]');
    await resumeCard.waitFor({ state: "visible" });
    assert.equal(await resumeCard.getByRole("link").getAttribute("href"), "/arcade");
    await resumeCard.getByRole("link", { name: "Continue to Arcade" }).click();
    await resumePage.waitForURL("**/arcade");
    assert.equal(new URL(resumePage.url()).pathname, "/arcade");
    await resumePage.goto(`${base}/`, { waitUntil: "networkidle" });
    const refreshedCard = resumePage.locator('[aria-label="Continue to your last room"]');
    await refreshedCard.getByRole("button", { name: "Dismiss" }).click();
    assert.equal(await refreshedCard.count(), 0, "dismiss must clear the local resume card");
    await resumePage.goto(`${base}/waveyard/studio`, { waitUntil: "domcontentloaded" });
    await resumePage.waitForFunction(
      () => localStorage.getItem("arena:last-used-room:v1") === "/waveyard/studio",
    );
    await resumePage.goto(`${base}/`, { waitUntil: "networkidle" });
    const studioResume = resumePage.locator('[aria-label="Continue to your last room"]');
    await studioResume.waitFor({ state: "visible" });
    assert.equal(await studioResume.getByRole("link").getAttribute("href"), "/waveyard/studio");
    assert.match(await studioResume.innerText(), /Waveyard Studio/);
    report.push("The home screen resumes the last product room, ignores utility pages, and supports dismiss.");
  } finally {
    await resumeContext.close();
  }
}
try {
  await verifyRecentRoomResume();
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
  for (const path of ["/chat", "/rooms", "/rooms/assistant", "/command", "/leaderboard", "/assistants", "/studio", "/waveyard", "/waveyard/create", "/waveyard/discover", "/spaces", "/college", "/privacy", "/toolbox"]) {
    await page.goto(base + path, { waitUntil: "networkidle" });
    const text = await page.locator("body").innerText();
    assert(!text.includes("Something went wrong"), `${path} crashed`);
    assert(!text.includes("Replit Agent is building"), `${path} shows scaffold`);
    assert(text.length > 150, `${path} is blank`);
    report.push(`${path} loaded.`);
  }
  await page.goto(`${base}/privacy`, { waitUntil: "networkidle" });
  const privacyText = await page.locator("body").innerText();
  assert(privacyText.includes("hosted Arena server"), "privacy page must identify hosted request routing");
  assert(privacyText.includes("does not make browser-to-server traffic or storage local"), "Local Mode must not claim network isolation");
  const privacySummary = await json("/api/privacy/summary");
  assert.equal(privacySummary.residency, "Arena server database");
  assert.equal(privacySummary.training, "not used by Arena to train models");
  await page.goto(`${base}/toolbox`, { waitUntil: "networkidle" });
  assert((await page.locator("body").innerText()).includes("Files are sent to the Arena API for processing"), "Toolbox must disclose hosted file processing");
  await page.goto(`${base}/rooms`, { waitUntil: "networkidle" });
  assert.equal(await page.locator('[data-testid="room-card-arcade"]').count(), 1, "Arcade must be discoverable in the handoff room index");
  report.push("Privacy boundaries, hosted Toolbox processing, and Arcade room discovery are explicit.");
  let mockStemState = "rejected";
  let mockRetryCount = 0;
  let mockNotStartedState = "not-started";
  let mockStartCount = 0;
  let mockNotStartedRating = 0;
  let uploadAttempts = 0;
  const audioBackupPreflightIds = [];
  const audioBackupDownloadIds = [];
  const appleBackupAccountId = "arena-smoke-apple-account";
  const appleBackupSnapshotId = "arena-smoke-apple-snapshot";
  const appleLocalAudioTrackId = "arena-smoke-apple-local-audio";
  let appleBackupSnapshot = null;
  const uploadAttemptNames = [];
  const batchTrackIdsByName = new Map([
    ["batch-one.wav", "arena-smoke-batch-one"],
    ["batch-two.wav", "arena-smoke-batch-two"],
    ["batch-three.wav", "arena-smoke-batch-three"],
  ]);
  const uploadSessionId = "arena-smoke-library-import-session";
  const uploadSessionTracks = [];
  const uploadSessionTrackIds = [];
  let uploadSessionCurrentTrackId = null;
  let resolveFirstUploadSessionTrack;
  const firstUploadSessionTrack = new Promise(resolve => { resolveFirstUploadSessionTrack = resolve; });
  let resolveSecondUploadSessionTrack;
  const secondUploadSessionTrack = new Promise(resolve => { resolveSecondUploadSessionTrack = resolve; });
  let nextRetryUploadGate = null;
  let measureUploadConcurrency = false;
  let batchUploadsInFlight = 0;
  let maxBatchUploadsInFlight = 0;
  const recoveryTrack = {
    id: "arena-smoke-stem-recovery",
    sourceAssetId: "arena-smoke-source-asset",
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
                progress: { percent: 36, phase: "pass 2/4 · Drums · chunk 2 of 3" },
              }
            : { status: "separated", stemCount: 4 },
      },
      {
        ...notStartedTrack,
        rating: mockNotStartedRating,
        stemAvailability: mockNotStartedState === "queued"
          ? { status: "processing", reason: "Stem separation is queued. The full source remains playable.", stage: "queued" }
          : mockNotStartedState === "processing"
            ? {
                status: "processing",
                reason: "Stem separation is running. The full source remains playable.",
                stage: "separating",
                progress: { percent: 36, phase: "pass 2/4 · Drums · chunk 2 of 3" },
              }
          : mockNotStartedState === "separated"
            ? { status: "separated", stemCount: 4 }
            : { status: "not-started", reason: "No job started." },
      },
    ],
  });
  const liveSessionId = "arena-smoke-live-swap";
  const liveSessionTrackId = "arena-smoke-live-session-track";
  const studioProjectId = "00000000-0000-4000-8000-000000000089";
  const studioRemixId = "00000000-0000-4000-8000-000000000090";
  const liveCurrentTrackId = "arena-smoke-live-current-track";
  const liveNextTrackId = "arena-smoke-live-next-track";
  const liveDonorTrackId = "arena-smoke-live-donor-track";
  const liveSearchDonorTrackId = "arena-smoke-live-search-donor-track";
  const liveDrumDonorTrackId = "arena-smoke-live-drum-donor-track";
  const liveDrumsOnlyTrackId = "arena-smoke-live-drums-only-track";
  const liveCamelotTrackId = "arena-smoke-live-camelot-track";
  const liveProcessingTrackId = "arena-smoke-live-processing-track";
  const liveVocalsAssetId = "arena-smoke-live-vocals";
  const liveDrumsAssetId = "arena-smoke-live-drums";
  const liveBassAssetId = "arena-smoke-live-bass";
  const liveOtherAssetId = "arena-smoke-live-other";
  const liveCurrentSourceAssetId = "arena-smoke-live-original-source";
  const liveNextVocalsAssetId = "arena-smoke-live-next-vocals";
  const liveNextDrumsAssetId = "arena-smoke-live-next-drums";
  const liveNextBassAssetId = "arena-smoke-live-next-bass";
  const liveNextOtherAssetId = "arena-smoke-live-next-other";
  const liveDonorVocalsAssetId = "arena-smoke-live-donor-vocals";
  const liveSearchDonorVocalsAssetId = "arena-smoke-live-search-donor-vocals";
  const liveDrumDonorDrumsAssetId = "arena-smoke-live-drum-donor-drums";
  const liveCamelotSourceAssetId = "arena-smoke-live-camelot-source";
  const liveCurrentItem = {
    id: liveSessionTrackId,
    position: 0,
    queueItemId: null,
    track: { id: liveCurrentTrackId, title: "Live source track", artist: "Smoke test", durationSeconds: 45 },
    sourceAssetId: liveCurrentSourceAssetId,
    stems: [
      { id: liveVocalsAssetId, stemType: "vocals", engine: "smoke-test", durationSeconds: 45 },
      { id: liveDrumsAssetId, stemType: "drums", engine: "smoke-test", durationSeconds: 45 },
      { id: liveBassAssetId, stemType: "bass", engine: "smoke-test", durationSeconds: 45 },
      { id: liveOtherAssetId, stemType: "other", engine: "smoke-test", durationSeconds: 45 },
    ],
    playback: { kind: "stems", assetIds: [liveVocalsAssetId, liveDrumsAssetId, liveBassAssetId, liveOtherAssetId] },
    playbackPreference: null,
    stemMix: { vocals: 1, drums: 1, bass: 1, other: 1 },
    transition: { mode: "manual", crossfadeSeconds: 1, keepStems: ["drums"] },
    analysis: { bpm: 120, musicalKey: "C major", beatGridMs: [0, 500, 1000, 1500] },
  };
  let rejectUpcomingMode = false;
  const liveNextItem = {
    id: "arena-smoke-live-next-session-track",
    position: 1,
    queueItemId: null,
    track: { id: liveNextTrackId, title: "Next source track", artist: "Smoke test", durationSeconds: 8 },
    sourceAssetId: null,
    stems: [
      { id: liveNextVocalsAssetId, stemType: "vocals", engine: "smoke-test", durationSeconds: 8 },
      { id: liveNextDrumsAssetId, stemType: "drums", engine: "smoke-test", durationSeconds: 8 },
      { id: liveNextBassAssetId, stemType: "bass", engine: "smoke-test", durationSeconds: 8 },
      { id: liveNextOtherAssetId, stemType: "other", engine: "smoke-test", durationSeconds: 8 },
    ],
    playback: { kind: "stems", assetIds: [liveNextVocalsAssetId, liveNextDrumsAssetId, liveNextBassAssetId, liveNextOtherAssetId] },
    stemMix: { vocals: 1, drums: 1, bass: 1, other: 1 },
    transition: { mode: "manual", crossfadeSeconds: 0, keepStems: [] },
    analysis: { bpm: 120, musicalKey: "C major", beatGridMs: [0, 500, 1000, 1500] },
  };
  const liveSessionTracks = [liveCurrentItem];
  let liveSwaps = [];
  let liveSwapRequestCount = 0;
  let liveSwapDeleteRequestCount = 0;
  let liveTrackAddRequestCount = 0;
  let studioHandoffRequestCount = 0;
  let studioHandoffPayload = null;
  let liveTrackPatchRequestCount = 0;
  let liveDonorFetchCount = 0;
  let liveDrumDonorFetchCount = 0;
  let failLiveDrumDonorFetch = false;
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
    swaps: liveSwaps,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const uploadSessionPayload = () => structuredClone({
    id: uploadSessionId,
    name: "Smoke upload session",
    currentSessionTrackId: uploadSessionCurrentTrackId,
    positionSeconds: 0,
    tracks: uploadSessionTracks,
    swaps: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const liveLibraryPayload = () => ({
    tracks: [
      { ...recoveryTrack, id: liveCurrentTrackId, title: "Live source track", durationSeconds: 45, analysis: { status: "complete", bpm: 120, musicalKey: "C major" }, stemAvailability: { status: "separated", stemCount: 4, stemTypes: ["vocals", "drums", "bass", "other"] } },
      { ...recoveryTrack, id: liveNextTrackId, title: "Next source track", durationSeconds: 8, analysis: { status: "complete", bpm: 120, musicalKey: "C major" }, stemAvailability: { status: "separated", stemCount: 4, stemTypes: ["vocals", "drums", "bass", "other"] } },
      { ...recoveryTrack, id: liveDonorTrackId, title: "Donor track", durationSeconds: 8, analysis: null, stemAvailability: { status: "separated", stemCount: 1, stemTypes: ["vocals"] } },
      { ...recoveryTrack, id: liveSearchDonorTrackId, title: "Search donor track", durationSeconds: 8, analysis: null, stemAvailability: { status: "separated", stemCount: 1, stemTypes: ["vocals"] } },
      { ...recoveryTrack, id: liveDrumDonorTrackId, title: "Drum donor track", durationSeconds: 8, analysis: null, stemAvailability: { status: "separated", stemCount: 1, stemTypes: ["drums"] } },
      { ...recoveryTrack, id: liveDrumsOnlyTrackId, title: "Drums-only separated track", durationSeconds: 8, analysis: null, stemAvailability: { status: "separated", stemCount: 1, stemTypes: ["drums"] } },
      { ...recoveryTrack, id: liveCamelotTrackId, title: "Camelot library match", artist: "Smoke test", durationSeconds: 8, analysis: { status: "complete", bpm: 120, musicalKey: "A minor" }, stemAvailability: { status: "source-only", reason: "Separation has not started." } },
      { ...recoveryTrack, id: liveProcessingTrackId, title: "Processing donor track", durationSeconds: 8, analysis: null, stemAvailability: { status: "processing", reason: "Stem separation is running.", stage: "separating", progress: { percent: 36, phase: "pass 2/4 · Drums · chunk 2 of 3" } } },
    ],
  });
  const quietStemWav = makePcmWav(440, 0.08);
  const liveSourceWav = makePcmWav(440, 0.35, 45);
  const liveVocalsWav = makePcmWav(440, 0.08, 45);
  const liveDrumsWav = makePcmWav(110, 0.25, 45);
  const liveBassWav = makePcmWav(220, 0.16, 45);
  const liveOtherWav = makePcmWav(330, 0.12, 45);
  const drumStemWav = makePcmWav(110, 0.25);
  const bassStemWav = makePcmWav(220, 0.16);
  const otherStemWav = makePcmWav(330, 0.12);
  const donorStemWav = makePcmWav(880, 0.8);
  const drumDonorStemWav = makePcmWav(165, 0.65);
  await context.route("**/api/streaming/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/streaming/accounts" && route.request().method() === "GET") {
      const stats = appleBackupSnapshot === null ? null : {
        playlists: appleBackupSnapshot.playlists.length,
        tracks: appleBackupSnapshot.playlists.reduce((total, playlist) => total + playlist.tracks.length, 0),
      };
      const accounts = appleBackupSnapshot === null ? [] : [{
        id: appleBackupAccountId,
        service: "apple",
        displayName: "My Apple Music",
        snapshotCount: 1,
        lastSyncAt: appleBackupSnapshot.takenAt,
        trackCount: stats.tracks,
        latestSnapshotId: appleBackupSnapshotId,
      }];
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ accounts }) });
    } else if (url.pathname === "/api/streaming/accounts" && route.request().method() === "POST") {
      assert.equal(route.request().postDataJSON().service, "apple");
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ account: { id: appleBackupAccountId, service: "apple", displayName: "My Apple Music" } }),
      });
    } else if (url.pathname === `/api/streaming/accounts/${appleBackupAccountId}/snapshots` && route.request().method() === "POST") {
      appleBackupSnapshot = route.request().postDataJSON().snapshot;
      assert.equal(appleBackupSnapshot.service, "apple");
      assert.equal(appleBackupSnapshot.playlists[0].tracks[0].title, "Apple Library Song");
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          snapshot: {
            id: appleBackupSnapshotId,
            takenAt: appleBackupSnapshot.takenAt,
            playlistCount: appleBackupSnapshot.playlists.length,
            trackCount: appleBackupSnapshot.playlists.reduce((total, playlist) => total + playlist.tracks.length, 0),
          },
        }),
      });
    } else if (url.pathname === `/api/streaming/snapshots/${appleBackupSnapshotId}` && route.request().method() === "GET") {
      const trackCount = appleBackupSnapshot.playlists.reduce((total, playlist) => total + playlist.tracks.length, 0);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          snapshot: {
            id: appleBackupSnapshotId,
            service: "apple",
            takenAt: appleBackupSnapshot.takenAt,
            playlistCount: appleBackupSnapshot.playlists.length,
            trackCount,
            library: appleBackupSnapshot,
          },
          diff: null,
        }),
      });
    } else if (url.pathname === `/api/streaming/snapshots/${appleBackupSnapshotId}/export`) {
      const format = url.searchParams.get("format") === "csv" ? "csv" : "json";
      await route.fulfill({
        status: 200,
        contentType: format === "csv" ? "text/csv; charset=utf-8" : "application/json",
        headers: { "Content-Disposition": `attachment; filename="waveyard-apple-library.${format}"` },
        body: format === "csv" ? "playlist,position,title,artists,album,isrc,duration_ms,service,external_id\r\n" : JSON.stringify(appleBackupSnapshot),
      });
    } else {
      await route.continue();
    }
  });
  await context.route("**/api/library/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/library/audio-backup" && route.request().method() === "GET") {
      const ids = (url.searchParams.get("ids") ?? "").split(",").filter(Boolean);
      if (url.searchParams.get("preflight") === "1") {
        audioBackupPreflightIds.push(...ids);
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ audioFiles: ids.length, totalBytes: 2048, maximumFiles: 100, maximumBytes: 2 * 1024 ** 3 }),
        });
      } else {
        audioBackupDownloadIds.push(...ids);
        await route.fulfill({
          status: 200,
          contentType: "application/zip",
          headers: { "Content-Disposition": 'attachment; filename="waveyard-audio-backup-2026-10-31.zip"' },
          body: Buffer.from("mock-zip"),
        });
      }
    } else if (url.pathname === "/api/library/tracks" &&
      route.request().method() === "GET" &&
      url.searchParams.get("limit") === "500") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          tracks: [{
            id: appleLocalAudioTrackId,
            sourceAssetId: "arena-smoke-apple-local-asset",
            title: "Apple Library Song",
            artist: "Example Artist",
            album: "Test Album",
            durationSeconds: 150,
          }],
        }),
      });
    } else if (url.pathname === "/api/library/sessions" && route.request().method() === "POST") {
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ session: { id: uploadSessionId, name: "Smoke upload session" } }),
      });
    } else if (url.pathname === `/api/library/sessions/${uploadSessionId}` && route.request().method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ session: uploadSessionPayload() }) });
    } else if (url.pathname === `/api/library/sessions/${uploadSessionId}/state` && route.request().method() === "PUT") {
      const state = route.request().postDataJSON();
      uploadSessionCurrentTrackId = state.sessionTrackId ?? null;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ saved: true }) });
    } else if (url.pathname === `/api/library/sessions/${uploadSessionId}/tracks` && route.request().method() === "POST") {
      const request = route.request().postDataJSON();
      uploadSessionTrackIds.push(request.trackId);
      const item = {
        id: `arena-smoke-upload-session-track-${uploadSessionTrackIds.length}`,
        position: request.position,
        queueItemId: null,
        track: { id: request.trackId, title: `Imported ${request.trackId}`, artist: "Smoke test", durationSeconds: 8 },
        sourceAssetId: liveVocalsAssetId,
        stems: [],
        playback: { kind: "source", assetIds: [liveVocalsAssetId] },
        stemMix: {},
        transition: { mode: "manual", crossfadeSeconds: 0, keepStems: [] },
        analysis: null,
      };
      uploadSessionTracks.splice(request.position, 0, item);
      uploadSessionTracks.forEach((entry, index) => { entry.position = index; });
      if (uploadSessionTrackIds.length === 1) resolveFirstUploadSessionTrack();
      if (uploadSessionTrackIds.length === 2) resolveSecondUploadSessionTrack();
      await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ session: uploadSessionPayload() }) });
    } else if (url.pathname === `/api/library/sessions/${liveSessionId}` && route.request().method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ session: liveSessionPayload() }) });
    } else if (url.pathname === `/api/library/sessions/${liveSessionId}/state` && route.request().method() === "PUT") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ saved: true }) });
    } else if (url.pathname === `/api/library/sessions/${liveSessionId}/studio-handoff` && route.request().method() === "POST") {
      const request = route.request().postDataJSON();
      assert(request.sessionTrackIds.includes(liveSessionTrackId), "the session handoff must include its selected playable track");
      assert(request.sessionTrackIds.includes(liveNextItem.id), "the session handoff must include the selected following track");
      assert(Array.isArray(request.trackEdits), "the session handoff must send the current mix edits");
      assert.equal(request.trackEdits.find((edit) => edit.sessionTrackId === liveSessionTrackId)?.stemMix.drums, 0,
        "the session handoff must carry the isolated drum level into Studio");
      studioHandoffPayload = request;
      studioHandoffRequestCount += 1;
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          handoff: {
            projectId: studioProjectId,
            remixTrackCount: 8,
            preservedSwapCount: 2,
            preservedTransitionCount: 1,
          },
        }),
      });
    } else if (url.pathname.startsWith(`/api/library/sessions/${liveSessionId}/tracks/`) && route.request().method() === "PATCH") {
      if (rejectUpcomingMode && url.pathname.endsWith(liveNextItem.id)) {
        rejectUpcomingMode = false;
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Fixture save outage" }) });
        return;
      }
      const itemId = url.pathname.split("/").at(-1);
      const item = liveSessionTracks.find(candidate => candidate.id === itemId);
      assert(item, `Cannot persist a mix for missing session item ${itemId}`);
      const request = route.request().postDataJSON();
      if (request.stemMix) item.stemMix = { ...request.stemMix };
      if (request.transition) item.transition = { ...request.transition };
      if (request.playbackPreference) {
        item.playbackPreference = request.playbackPreference;
        item.playback = request.playbackPreference === "source"
          ? { kind: "source", assetIds: [item.sourceAssetId] }
          : { kind: "stems", assetIds: item.stems.filter(stem => stem.engine !== "passthrough-unseparated").map(stem => stem.id) };
      }
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
      const donor = request.stemType === "vocals"
        ? request.toTrackId === liveSearchDonorTrackId
          ? { id: liveSearchDonorTrackId, title: "Search donor track", stemId: liveSearchDonorVocalsAssetId }
          : { id: liveDonorTrackId, title: "Donor track", stemId: liveDonorVocalsAssetId }
        : request.stemType === "drums"
          ? { id: liveDrumDonorTrackId, title: "Drum donor track", stemId: liveDrumDonorDrumsAssetId }
          : null;
      assert(donor, `Unexpected live stem swap type: ${request.stemType}`);
      assert.equal(request.toTrackId, donor.id, `${request.stemType} must select its matching donor track`);
      liveSwapRequestCount += 1;
      const swap = {
        id: `arena-smoke-live-swap-${request.stemType}`,
        sessionTrackId: liveSessionTrackId,
        stemType: request.stemType,
        fromTrackId: liveCurrentTrackId,
        toTrackId: donor.id,
        atSeconds: request.atSeconds,
        createdAt: new Date().toISOString(),
        donorTrack: {
          id: donor.id,
          title: donor.title,
          stems: [{ id: donor.stemId, stemType: request.stemType, durationSeconds: 8 }],
        },
      };
      liveSwaps = [...liveSwaps.filter((entry) => entry.stemType !== request.stemType), swap];
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ session: liveSessionPayload() }) });
    } else if (url.pathname === `/api/library/sessions/${liveSessionId}/swaps` && route.request().method() === "DELETE") {
      const swapId = url.searchParams.get("swapId");
      assert(liveSwaps.some((swap) => swap.id === swapId), "cancelling removes the exact pending live swap");
      liveSwapDeleteRequestCount += 1;
      liveSwaps = liveSwaps.filter((swap) => swap.id !== swapId);
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ session: liveSessionPayload() }) });
    } else if (url.pathname.endsWith("/separation") && route.request().method() === "POST") {
      mockStartCount += 1;
      mockNotStartedState = "queued";
      setTimeout(() => { mockNotStartedState = "processing"; }, 5000);
      setTimeout(() => { mockNotStartedState = "separated"; }, 9000);
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({ state: "queued", jobId: "arena-smoke-new-separation" }),
      });
    } else if (url.pathname === "/api/library/tracks" && route.request().method() === "POST") {
      uploadAttempts += 1;
      const multipart = route.request().postDataBuffer()?.toString("latin1") ?? "";
      const uploadName = multipart.match(/filename="([^"]+)"/)?.[1] ?? "";
      uploadAttemptNames.push(uploadName);
      if (measureUploadConcurrency) {
        batchUploadsInFlight += 1;
        maxBatchUploadsInFlight = Math.max(maxBatchUploadsInFlight, batchUploadsInFlight);
        await new Promise(resolve => setTimeout(resolve, 250));
        batchUploadsInFlight -= 1;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            track: { id: batchTrackIdsByName.get(uploadName) ?? "arena-smoke-batch-upload-track" },
            created: true,
            separationQueued: true,
          }),
        });
      } else if (uploadAttempts < 3) {
        if (uploadAttempts === 2 && nextRetryUploadGate) {
          nextRetryUploadGate.signalStarted();
          await nextRetryUploadGate.response;
        } else {
          await new Promise(resolve => setTimeout(resolve, 120));
        }
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
    } else if (url.pathname.endsWith("/sessions") && route.request().method() === "GET") {
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
    if (assetId === liveCurrentSourceAssetId) {
      await route.fulfill({ status: 200, contentType: "audio/wav", body: liveSourceWav });
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
    if (assetId === liveSearchDonorVocalsAssetId) {
      await route.fulfill({ status: 200, contentType: "audio/wav", body: donorStemWav });
      return;
    }
    if (assetId === liveDrumDonorDrumsAssetId) {
      liveDrumDonorFetchCount += 1;
      if (failLiveDrumDonorFetch) {
        await route.fulfill({ status: 503, headers: { "cache-control": "no-store" }, body: "Donor temporarily unavailable" });
        return;
      }
      await route.fulfill({ status: 200, contentType: "audio/wav", body: drumDonorStemWav });
      return;
    }
    if (assetId === liveVocalsAssetId) {
      await route.fulfill({ status: 200, contentType: "audio/wav", body: liveVocalsWav });
      return;
    }
    if (assetId === liveDrumsAssetId) {
      await route.fulfill({ status: 200, contentType: "audio/wav", body: liveDrumsWav });
      return;
    }
    if (assetId === liveBassAssetId) {
      await route.fulfill({ status: 200, contentType: "audio/wav", body: liveBassWav });
      return;
    }
    if (assetId === liveOtherAssetId) {
      await route.fulfill({ status: 200, contentType: "audio/wav", body: liveOtherWav });
      return;
    }
    if ([liveNextVocalsAssetId, liveNextDrumsAssetId, liveNextBassAssetId, liveNextOtherAssetId].includes(assetId)) {
      await route.fulfill({
        status: 200,
        contentType: "audio/wav",
        body: assetId === liveNextVocalsAssetId ? quietStemWav
          : assetId === liveNextDrumsAssetId ? drumStemWav
            : assetId === liveNextBassAssetId ? bassStemWav : otherStemWav,
      });
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
  await page.route("**/api/assets/arena-smoke-source-asset?download=1", async (route) => {
    assert.equal(route.request().method(), "GET", "original-file backup uses the private asset read route");
    await route.fulfill({
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Disposition": 'attachment; filename="September.mp3"',
      },
      body: Buffer.from("smoke-test-audio"),
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
  const originalDownloadLink = recoveryRow.getByRole("link", { name: "Download original audio for Retryable track" });
  assert.equal(
    await originalDownloadLink.getAttribute("href"),
    "/api/assets/arena-smoke-source-asset?download=1",
    "backup downloads the exact original private source asset",
  );
  const downloadStarted = page.waitForEvent("download");
  await originalDownloadLink.click();
  assert.equal((await downloadStarted).suggestedFilename(), "September.mp3", "the source endpoint returns the original filename");
  await recoveryRow.getByRole("checkbox", { name: "Include Retryable track in audio backup" }).check();
  const audioBackupDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download audio ZIP (1)" }).click();
  assert.equal((await audioBackupDownload).suggestedFilename(), "waveyard-audio-backup-2026-10-31.zip");
  assert.deepEqual(audioBackupPreflightIds, [recoveryTrack.id], "audio backup preflights only the selected track");
  assert.deepEqual(audioBackupDownloadIds, [recoveryTrack.id], "the browser downloads the selected original file archive");
  await page.getByRole("status").filter({ hasText: "CSV manifest" }).waitFor();
  report.push("Library audio backup preflights selected files and starts a streaming ZIP download with a CSV manifest.");
  const appleBackupShortcut = page.getByRole("button", { name: "Apple Music catalog backup", exact: true });
  const appleCatalogDesktopViewport = page.viewportSize();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0));
  const appleShortcutLayout = await appleBackupShortcut.evaluate((button) => {
    const rect = button.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      viewportHeight: window.innerHeight,
    };
  });
  assert(appleShortcutLayout.top >= 0 && appleShortcutLayout.bottom <= appleShortcutLayout.viewportHeight,
    "Apple catalog shortcut is visible in the phone-sized first screen");
  assert(appleShortcutLayout.left >= 0 && appleShortcutLayout.right <= appleShortcutLayout.viewportWidth,
    "Apple catalog shortcut fits the phone viewport");
  assert(appleShortcutLayout.documentWidth <= appleShortcutLayout.viewportWidth + 2,
    "Apple catalog shortcut does not cause horizontal phone overflow");
  await appleBackupShortcut.focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => {
    const details = document.getElementById("apple-music-metadata-backup");
    if (!(details instanceof HTMLDetailsElement) || !details.open) return false;
    const rect = details.getBoundingClientRect();
    return rect.bottom > 0 && rect.top < window.innerHeight;
  });
  assert.equal(await appleBackupShortcut.getAttribute("aria-expanded"), "true",
    "keyboard activation opens the Apple catalog backup disclosure");
  assert.equal(
    await page.locator("#apple-music-metadata-backup > summary").evaluate((summary) => document.activeElement === summary),
    true,
    "keyboard activation moves focus to the opened Apple catalog controls",
  );
  await page.setViewportSize(appleCatalogDesktopViewport ?? { width: 1280, height: 900 });
  await page.getByTestId("connected-libraries").waitFor();
  await page.getByText("Direct Apple sign-in isn’t available", { exact: false }).waitFor();
  await page.getByText(/metadata only—not protected Apple Music subscription audio/).waitFor();
  report.push("The Apple catalog shortcut is visible and fits on a phone, and keyboard activation opens and scrolls to metadata-only controls.");
  const appleBackupInput = page.getByLabel("Import Apple Music backup");
  assert.equal(
    await appleBackupInput.getAttribute("accept"),
    "application/json,.csv,text/csv,.xml,text/xml,application/xml",
    "Apple Music backup accepts CSV, JSON, and iTunes-style XML metadata",
  );
  await appleBackupInput.setInputFiles({
    name: "Apple Library.xml",
    mimeType: "application/xml",
    buffer: Buffer.from(`<?xml version="1.0"?><plist version="1.0"><dict>
      <key>Tracks</key><dict><key>501</key><dict>
        <key>Track ID</key><integer>501</integer><key>Persistent ID</key><string>LIB001</string>
        <key>Name</key><string>Apple Library Song</string><key>Artist</key><string>Example Artist</string>
        <key>Album</key><string>Test Album</string><key>Total Time</key><integer>150000</integer>
        <key>Location</key><string>file:///private/Protected.m4p</string>
      </dict></dict>
      <key>Playlists</key><array><dict>
        <key>Playlist Persistent ID</key><string>APPLE-PLAYLIST</string><key>Name</key><string>My Playlist</string>
        <key>Playlist Items</key><array><dict><key>Track ID</key><integer>501</integer></dict></array>
      </dict></array>
    </dict></plist>`),
  });
  await page.getByRole("status").filter({ hasText: "Imported your Apple Music library" }).waitFor();
  await page.getByRole("button", { name: /My Playlist/ }).click();
  await page.locator(".stream-tracks").getByText("Apple Library Song", { exact: true }).waitFor();
  const appleCsvDownload = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download CSV" }).click();
  assert.equal((await appleCsvDownload).suggestedFilename(), "waveyard-apple-library.csv");
  report.push("Apple Music Library XML imports as a metadata snapshot and exports as CSV; the source file path and protected audio are not copied.");
  const localAudioBackupButton = page.getByTestId("download-matched-local-audio");
  await page.waitForFunction(() => {
    const button = document.querySelector('[data-testid="download-matched-local-audio"]');
    return button instanceof HTMLButtonElement && !button.disabled && button.textContent?.includes("Download 1 likely local original");
  });
  const matchedLocalAudioDownload = page.waitForEvent("download");
  await localAudioBackupButton.click();
  assert.match((await matchedLocalAudioDownload).suggestedFilename(), /^waveyard-audio-backup-.*\.zip$/);
  assert.deepEqual(
    audioBackupPreflightIds,
    [recoveryTrack.id, appleLocalAudioTrackId],
    "Apple catalog matching only packages the local Waveyard audio ID",
  );
  assert.deepEqual(audioBackupDownloadIds, [recoveryTrack.id, appleLocalAudioTrackId]);
  report.push("Apple Music metadata now filters existing Waveyard originals by the current playlist/search and downloads unique high-confidence local matches as a ZIP with CSV manifest.");
  releaseSecondPlaylistResponse();
  await page.getByTestId("library-refresh-warning").waitFor();
  await page.getByRole("button", { name: "Retry library refresh", exact: true }).click();
  await page.getByTestId("library-refresh-warning").waitFor({ state: "detached" });
  await page.getByTestId("track-load-failure").waitFor({ state: "detached" });
  report.push("A failed track-list request shows retry instead of false emptiness; a playlist outage leaves tracks available and recovers on retry.");
  report.push("A library track can download its exact original private audio file with the stored source filename.");
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
  let separationResolvedDevice = null;
  await page.route(`**/api/assets/${waveformCanvasAssetId}/waveform`, async (route) => {
    waveformCanvasRequests += 1;
    if (!waveformCanvasAvailable) {
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({
          error: "Waveform is not available for this asset yet.",
          waveformJob: {
            id: waveformRetryJobId,
            status: "failed",
            errorCode: "queue_unavailable",
          },
        }),
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
          errorCode: waveformRetryStatus === "failed" ? "queue_unavailable" : null,
          errorMessage: waveformRetryStatus === "failed" ? "The local waveform queue is unavailable." : null,
        }],
        jobs: [{
          id: separationRetryJobId,
          sourceAssetId: "arena-smoke-project-source",
          status: separationRetryStatus,
          stage: separationRetryStatus === "failed" ? "queue-unavailable" : separationRetryStatus,
          errorCode: separationRetryStatus === "failed" ? "queue_unavailable" : null,
          errorMessage: separationRetryStatus === "failed" ? "The local separation queue is unavailable." : null,
          model: "demucs",
          requestedDevice: "auto",
          resolvedDevice: separationResolvedDevice,
          metadata: null,
        }],
        sources: [],
      }),
    });
  });
  await page.route(`**/api/waveyard/projects/${waveformRetryProjectId}/remixes`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ remixes: [] }),
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
    separationResolvedDevice = null;
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
    waveformCanvasAvailable = true;
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ job: { id: waveformRetryJobId, status: "queued" } }),
    });
  });
  await page.goto(`http://localhost:80/waveyard/projects/${waveformRetryProjectId}?view=studio`);
  const studioTransport = page.getByRole("region", { name: "Transport controls" });
  await studioTransport.waitFor({ state: "visible" });
  const disabledArrangementPreview = page.getByRole("button", { name: "Create arrangement to preview" });
  await disabledArrangementPreview.waitFor({ state: "visible" });
  assert.equal(await disabledArrangementPreview.isDisabled(), true,
    "an empty Studio must not present a working-looking arrangement preview that does nothing");
  assert.equal(await page.evaluate(() => {
    const transport = document.querySelector('[aria-label="Transport controls"]');
    const sourcePool = document.querySelector('[aria-label="Project source pool"]');
    return Boolean(transport && sourcePool && (transport.compareDocumentPosition(sourcePool) & Node.DOCUMENT_POSITION_FOLLOWING));
  }), true, "the transport must sit directly after the timeline, before secondary source browsing");
  await page.getByRole("tab", { name: "Analyze", exact: true }).click();
  assert.equal(await studioTransport.isVisible(), true,
    "Studio transport controls must remain available while the user switches to Analyze");
  await page.getByRole("tab", { name: "Edit", exact: true }).click();
  const desktopStudioViewport = page.viewportSize();
  if (desktopStudioViewport) {
    for (const width of [320, 402]) {
      await page.setViewportSize({ width, height: 874 });
      await page.getByRole("region", { name: "Transport controls" }).scrollIntoViewIfNeeded();
      const studioMobileLayout = await page.evaluate(() => {
        const transport = document.querySelector('[aria-label="Transport controls"]')?.getBoundingClientRect();
        return {
          viewportWidth: document.documentElement.clientWidth,
          documentWidth: document.documentElement.scrollWidth,
          transportLeft: transport?.left ?? -1,
          transportRight: transport?.right ?? Number.POSITIVE_INFINITY,
          overflowing: [...document.body.querySelectorAll("*")].map((element) => {
            const bounds = element.getBoundingClientRect();
            return {
              tag: element.tagName,
              className: typeof element.className === "string" ? element.className : "",
              id: element.id,
              left: Math.round(bounds.left),
              right: Math.round(bounds.right),
              width: Math.round(bounds.width),
              scrollWidth: element.scrollWidth,
              clientWidth: element.clientWidth,
            };
          }).filter((element) => element.right > document.documentElement.clientWidth + 1)
            .sort((left, right) => right.right - left.right).slice(0, 12),
        };
      });
      assert.equal(studioMobileLayout.documentWidth, studioMobileLayout.viewportWidth,
        `the Studio page and transport must not create horizontal overflow at ${width}px: ${JSON.stringify(studioMobileLayout)}`);
      assert(studioMobileLayout.transportLeft >= 0 && studioMobileLayout.transportRight <= studioMobileLayout.viewportWidth,
        `the Studio transport must remain completely reachable at ${width}px`);
    }
    await page.setViewportSize(desktopStudioViewport);
  }
  report.push("Studio playback controls remain visible in Analyze, cannot preview a missing arrangement, and fit 320px and 402px viewports without page overflow.");
  const retryProjectSeparationButton = page.getByRole("button", { name: "Retry separation", exact: true });
  await retryProjectSeparationButton.waitFor();
  await retryProjectSeparationButton.click();
  await page.getByText(/Separation retry could not reach the server/).waitFor();
  assert.equal(await retryProjectSeparationButton.isEnabled(), true, "network failure leaves project separation retry available");
  await retryProjectSeparationButton.click();
  await page.getByText(/Separation is at the “queued” stage/).waitFor();
  assert.equal(separationRetryAttempts, 2, "project separation retry remains actionable after a network outage");
  assert.equal(await page.getByRole("button", { name: "Retry separation", exact: true }).count(), 0, "a queued separation retry no longer offers a duplicate failed-job action");
  separationRetryStatus = "complete";
  separationResolvedDevice = "cpu";
  await page.reload({ waitUntil: "networkidle" });
  const deviceStatus = page.getByTestId("job-device-status");
  await deviceStatus.waitFor();
  assert.equal((await deviceStatus.innerText()).trim(), "· CPU fallback");
  assert.match(await deviceStatus.getAttribute("title"), /may take longer/);
  report.push("Project separation retry recovers, and automatic CPU fallback is identified as slower.");
  const retryWaveformButton = page.getByRole("button", { name: "Retry waveform", exact: true });
  await retryWaveformButton.waitFor();
  await page.getByText("Waveform generation could not be queued because processing is unavailable. Audio playback and downloads remain available; no substitute peaks are drawn.").waitFor();
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
  await studioWaveform.getByRole("alert").getByText(/could not be queued because processing is unavailable/).waitFor();
  await retryCanvasWaveform.click();
  await studioWaveform.getByRole("button", { name: "Seek project waveform" }).waitFor();
  assert(waveformCanvasRequests >= 2, "the Studio waveform retry must issue a new request for the selected asset");
  assert.equal(waveformRetryAttempts, 4, "the listener waveform retry must submit the failed job to the queue");
  report.push("Studio surfaces queue outages in plain language, retries the failed waveform job, and displays real peaks after recovery.");
  await page.goto("http://localhost:80/waveyard");
  await page.getByRole("navigation", { name: "Waveyard" }).getByRole("link", { name: "Music", exact: true }).click();
  const emptyMixerAddMusic = page.getByRole("link", { name: "Add music", exact: true });
  await emptyMixerAddMusic.waitFor();
  assert.equal(await emptyMixerAddMusic.getAttribute("href"), "#waveyard-add-music");
  await page.locator("#waveyard-add-music").waitFor();
  assert.equal(await page.locator("#waveyard-add-music").count(), 1);
  report.push("The empty live mixer can jump directly to Waveyard's working add-music control.");
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
  await recoveryRow.getByText("SEPARATING · pass 2/4 · Drums · chunk 2 of 3", { exact: true }).waitFor({ timeout: 6000 });
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileProgressLayout = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    offenders: [...document.querySelectorAll("body *")]
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          tag: element.tagName.toLowerCase(),
          className: typeof element.className === "string" ? element.className : "",
          text: (element.textContent ?? "").trim().slice(0, 80),
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          width: Math.round(rect.width),
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
        };
      })
      .filter((item) => item.left < -2 || item.right > window.innerWidth + 2)
      .sort((a, b) => b.right - a.right)
      .slice(0, 8),
  }));
  assert(
    mobileProgressLayout.documentWidth <= mobileProgressLayout.viewportWidth + 2,
    `multi-pass progress must not create horizontal overflow on mobile: ${JSON.stringify(mobileProgressLayout)}`,
  );
  await page.setViewportSize({ width: 1280, height: 900 });
  await recoveryRow.getByText("4 STEMS", { exact: true }).waitFor({ timeout: 12000 });
  assert.equal(await page.getByRole("button", { name: "Retry separation for Retryable track" }).count(), 0);
  report.push("The library shows the active stem pass and chunk without a misleading whole-job percentage, retries a rejected job in place, and updates without a reload.");
  const startSeparationButton = notStartedRow.getByRole("button", { name: "Start separation for Not started track" });
  await startSeparationButton.click();
  await notStartedRow.getByText("SEPARATING…", { exact: true }).waitFor();
  await page.getByRole("status").filter({ hasText: "Not started track: separation started." }).waitFor();
  assert.equal(mockStartCount, 1, "starting separation for an unprocessed track must submit one job");
  assert.equal(mockNotStartedState, "queued", "the local worker queue is serial and reports waiting jobs honestly");
  await notStartedRow.getByText("QUEUED", { exact: true }).waitFor({ timeout: 6000 });
  await notStartedRow.getByText("SEPARATING · pass 2/4 · Drums · chunk 2 of 3", { exact: true }).waitFor({ timeout: 9000 });
  assert.equal(await notStartedRow.getByRole("button", { name: "Play" }).isEnabled(), true);
  assert.equal(await notStartedRow.getByRole("button", { name: "Next" }).isEnabled(), true);
  await notStartedRow.getByRole("button", { name: "Rate Not started track: 4 stars" }).click();
  await notStartedRow.getByRole("button", { name: "Clear Not started track: 4 stars" }).waitFor();
  assert.equal(mockNotStartedRating, 4, "a library edit saves while separation is active");
  report.push("The library distinguishes queued from active separation, then keeps playback controls and rating usable while work runs.");
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
  let signalRetryUploadStarted;
  const retryUploadStarted = new Promise((resolve) => { signalRetryUploadStarted = resolve; });
  let releaseRetryUploadResponse;
  const retryUploadResponseGate = new Promise((resolve) => { releaseRetryUploadResponse = resolve; });
  nextRetryUploadGate = {
    signalStarted: signalRetryUploadStarted,
    response: retryUploadResponseGate,
  };
  await page.getByRole("button", { name: "Retry 1 failed upload", exact: true }).click();
  await retryUploadStarted;
  await page.getByRole("button", { name: "Retrying uploads…" }).waitFor();
  releaseRetryUploadResponse();
  nextRetryUploadGate = null;
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
  await firstUploadSessionTrack;
  assert.equal(uploadSessionTrackIds[0], "arena-smoke-already-uploaded-track");
  report.push("A retried upload can resolve to the existing library track without creating a duplicate or keeping a stale failure.");
  measureUploadConcurrency = true;
  await page.getByLabel("Add music files").setInputFiles([
    { name: "batch-one.wav", mimeType: "audio/wav", buffer: Buffer.from("batch one") },
    { name: "batch-two.wav", mimeType: "audio/wav", buffer: Buffer.from("batch two") },
    { name: "batch-three.wav", mimeType: "audio/wav", buffer: Buffer.from("batch three") },
  ]);
  const uploadProgress = page.getByTestId("library-upload-progress");
  await uploadProgress.getByText("0 of 3 complete", { exact: false }).waitFor();
  await uploadProgress.waitFor({ state: "detached", timeout: 10_000 });
  measureUploadConcurrency = false;
  assert.equal(uploadAttempts, 6, "a three-file batch submits each selected file once");
  assert.deepEqual(
    uploadAttemptNames.slice(3).sort(),
    ["batch-one.wav", "batch-two.wav", "batch-three.wav"].sort(),
    "parallel request arrival order may vary, but each selected file must be submitted once",
  );
  assert.equal(maxBatchUploadsInFlight, 2, "the library uploads at most two files concurrently");
  await secondUploadSessionTrack;
  assert.equal(
    uploadSessionTrackIds[1],
    "arena-smoke-batch-one",
    "the first selected file, not whichever upload finishes first, is loaded into the mixer",
  );
  report.push("Multi-file library imports show progress, upload two-at-a-time, and load the first selected file into the mixer.");

  mockLiveSessionActive = true;
  liveNextItem.sourceAssetId = liveNextVocalsAssetId;
  liveSessionTracks.push(liveNextItem);
  await page.evaluate((id) => localStorage.setItem("waveyard.listening.sessionId", id), liveSessionId);
  const errorsBeforeLiveSwap = errors.length;
  await page.goto(`${base}/waveyard/session/${liveSessionId}`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("listening-workspace").waitFor({ timeout: 20_000 });
  await page.getByText("Live source track", { exact: true }).first().waitFor();
  const sourceVocals = page.locator(`audio[src$="/${liveVocalsAssetId}"]`);
  const sourceDrums = page.locator(`audio[src$="/${liveDrumsAssetId}"]`);
  await page.getByTestId("session-play").click();
  await page.waitForFunction((assetId) => {
    const audio = document.querySelector(`audio[src$="/${assetId}"]`);
    return audio instanceof HTMLAudioElement && !audio.paused && audio.currentTime > 0.25;
  }, liveVocalsAssetId, { timeout: 12_000 });
  await page.getByText(`Session order · ${liveSessionTracks.length}`, { exact: true }).click();
  const upcomingMode = page.getByTestId(`session-playback-mode-${liveNextItem.id}`);
  await page.evaluate((assetId) => {
    window.__modePrepAudio = document.querySelector(`audio[src$="/${assetId}"]`);
    window.__modePrepTime = window.__modePrepAudio.currentTime;
    window.__modePrepInterruptions = 0;
    for (const name of ["pause", "emptied", "loadstart"]) {
      window.__modePrepAudio.addEventListener(name, () => { window.__modePrepInterruptions++; });
    }
  }, liveVocalsAssetId);
  rejectUpcomingMode = true;
  await upcomingMode.selectOption("source");
  await page.getByTestId("session-status").filter({ hasText: "Could not save the playback mode" }).waitFor();
  assert.equal(await upcomingMode.inputValue(), "stems", "failed saves must not pretend the choice was saved");
  await upcomingMode.selectOption("source");
  await page.getByTestId("session-status").filter({ hasText: "Full track saved" }).waitFor();
  assert.equal(liveNextItem.playbackPreference, "source");
  assert.equal(liveCurrentItem.playbackPreference, null, "upcoming preparation must not alter the current entry");
  await upcomingMode.selectOption("stems");
  await page.getByTestId("session-status").filter({ hasText: "Stems saved" }).waitFor();
  assert.equal(liveNextItem.playbackPreference, "stems");
  assert.equal(await page.evaluate((assetId) => {
    const audio = document.querySelector(`audio[src$="/${assetId}"]`);
    return audio === window.__modePrepAudio && !audio.paused
      && audio.currentTime > window.__modePrepTime && window.__modePrepInterruptions === 0;
  }, liveVocalsAssetId), true, "preparing the next entry must retain the audible element and advancing playback");
  report.push("Upcoming full-track/stems choices save per entry, survive a rejected save/retry, and leave current audio advancing without pause/load events.");
  liveSessionTracks.splice(liveSessionTracks.indexOf(liveNextItem), 1);
  liveNextItem.sourceAssetId = null;
  await page.getByTestId(`button-return-full-track-${liveSessionTrackId}`).click();
  await page.getByTestId("session-status").filter({ hasText: "Returned to the full track" }).waitFor({ timeout: 8_000 });
  assert.equal(liveCurrentItem.playbackPreference, "source", "returning to the full track must save the per-session choice");
  assert.equal(liveCurrentItem.playback.kind, "source");
  await page.waitForFunction((assetId) => {
    const audio = document.querySelector(`audio[src$="/${assetId}"]`);
    return audio instanceof HTMLAudioElement && !audio.paused && audio.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
  }, liveCurrentSourceAssetId, { timeout: 8_000 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByTestId("listening-workspace").waitFor({ timeout: 20_000 });
  await page.locator(`audio[src$="/${liveCurrentSourceAssetId}"]`).waitFor({ state: "attached", timeout: 8_000 });
  assert.equal(liveCurrentItem.playbackPreference, "source", "reopening the session must retain full-track playback");
  await page.getByTestId(`button-switch-stems-${liveSessionTrackId}`).waitFor({ timeout: 8_000 });
  await page.getByTestId(`button-switch-stems-${liveSessionTrackId}`).click();
  await page.getByTestId("session-status").filter({ hasText: "Switched" }).waitFor({ timeout: 8_000 });
  assert.equal(liveCurrentItem.playbackPreference, "stems", "the reopened full-track session must still allow a return to stems");
  report.push("A full-track choice survives a session reload, remains gaplessly switchable, and can be changed back to stems.");

  liveCurrentItem.sourceAssetId = null;
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByTestId("listening-workspace").waitFor({ timeout: 20_000 });
  await page.getByTestId(`full-track-unavailable-${liveSessionTrackId}`)
    .filter({ hasText: "Original audio unavailable" })
    .waitFor({ timeout: 8_000 });
  assert.equal(
    await page.getByTestId(`button-return-full-track-${liveSessionTrackId}`).count(),
    0,
    "a session track without an original asset must not show a return action",
  );
  assert.equal(
    await page.getByTestId(`button-retry-full-track-${liveSessionTrackId}`).count(),
    0,
    "a missing original asset must not offer a load retry",
  );
  assert.equal(await page.getByTestId("quick-isolate-vocals").isEnabled(), true,
    "stem controls remain usable when the original asset is missing");
  await page.getByTestId("session-play").click();
  await page.waitForFunction((assetId) => {
    const audio = document.querySelector(`audio[src$="/${assetId}"]`);
    return audio instanceof HTMLAudioElement && !audio.paused && audio.currentTime > 0.25;
  }, liveVocalsAssetId, { timeout: 12_000 });
  await page.getByTestId("session-play").click();
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto(`${base}/arcade`, { waitUntil: "domcontentloaded" });
  const compactDock = page.locator(".wy-host-compact");
  await compactDock.waitFor({ timeout: 20_000 });
  const compactMissingOriginal = compactDock.getByTestId(`compact-full-track-unavailable-${liveSessionTrackId}`);
  const compactPlay = compactDock.getByTestId("session-play");
  const compactIsolateVocals = compactDock.getByTestId("compact-isolate-vocals");
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await compactMissingOriginal.waitFor({ state: "visible" });
    assert.equal(await compactPlay.isVisible(), true, `${width}px compact dock keeps playback visible`);
    assert.equal(await compactIsolateVocals.isVisible(), true, `${width}px compact dock keeps stem controls visible`);
    assert.equal(await page.evaluate((testIds) => testIds.every((testId) => {
      const element = document.querySelector(`[data-testid="${testId}"]`);
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      return rect.top >= 0 && rect.bottom <= window.innerHeight
        && rect.left >= 0 && rect.right <= window.innerWidth;
    }), [
      `compact-full-track-unavailable-${liveSessionTrackId}`,
      "session-play",
      "compact-isolate-vocals",
    ]), true, `${width}px compact status and controls fit in the phone viewport`);
    assert.equal(await compactDock.getByTestId(`button-return-full-track-${liveSessionTrackId}`).count(), 0,
      `${width}px compact dock must not offer a return to an absent original`);
    assert.equal(await compactDock.getByTestId(`button-retry-full-track-${liveSessionTrackId}`).count(), 0,
      `${width}px compact dock must not offer a retry for an absent original`);
  }
  assert.equal(await compactIsolateVocals.isEnabled(), true,
    "stem isolation remains enabled in compact mode when the original asset is missing");
  await compactIsolateVocals.click();
  await page.waitForFunction(() => document.querySelector('[data-testid="compact-isolate-vocals"]')?.getAttribute("aria-pressed") === "true");
  await compactDock.getByTestId("compact-restore-stems").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="compact-isolate-vocals"]')?.getAttribute("aria-pressed") === "false");
  await compactPlay.click();
  await page.waitForFunction((assetId) => {
    const audio = document.querySelector(`audio[src$="/${assetId}"]`);
    return audio instanceof HTMLAudioElement && !audio.paused && audio.currentTime > 0.25;
  }, liveVocalsAssetId, { timeout: 12_000 });
  await compactPlay.click();
  report.push("Compact listening keeps the missing-original status visible, hides full-track recovery actions, and plays/isolate stems at 320px and 390px.");
  await page.goto(`${base}/waveyard/session/${liveSessionId}`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("listening-workspace").waitFor({ timeout: 20_000 });
  liveCurrentItem.sourceAssetId = liveCurrentSourceAssetId;
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByTestId("listening-workspace").waitFor({ timeout: 20_000 });

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
  const drumsMeter = page.locator(".wy-stem-drums .wy-stem-meter i");
  await page.waitForFunction(() => {
    const bar = document.querySelector(".wy-stem-drums .wy-stem-meter i");
    const peak = Number(bar?.getAttribute("style")?.match(/scaleX\(([^)]+)\)/)?.[1] ?? 0);
    return peak > 0.02;
  }, null, { timeout: 8_000 });
  const originalDrumPeak = await drumsMeter.evaluate((bar) => Number(
    bar.getAttribute("style")?.match(/scaleX\(([^)]+)\)/)?.[1] ?? 0,
  ));
  await page.getByTestId("open-live-swap-vocals").click();
  assert.equal(await page.getByTestId(`live-swap-candidate-vocals-${liveDrumsOnlyTrackId}`).count(), 0,
    "the vocal picker must hide separated tracks with no vocal stem");
  const preparationProgress = page.getByTestId(`live-swap-preparing-vocals-${liveProcessingTrackId}`);
  await preparationProgress.waitFor();
  assert.equal(
    (await preparationProgress.innerText()).trim(),
    "pass 2/4 · Drums · chunk 2 of 3",
    "the live-swap picker must show the active stem pass rather than a misleading whole-job percentage",
  );
  await page.getByTestId(`live-swap-candidate-vocals-${liveDonorTrackId}`).click();
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
  assert.equal(liveSwaps.length, 0, "cancelling removes the pending donor from the session");
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
  assert.equal(await page.getByTestId("restore-live-swap-vocals").count(), 0,
    "cancelling restores the original vocal source selection");
  await page.getByTestId("open-live-swap-vocals").click();
  await page.getByTestId(`live-swap-candidate-vocals-${liveDonorTrackId}`).click();
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
  failLiveDrumDonorFetch = true;
  const clockBeforeDonorFailure = await sourceVocals.evaluate((audio) => audio.currentTime);
  await page.getByTestId("open-live-swap-drums").click();
  await page.getByTestId(`live-swap-candidate-drums-${liveDrumDonorTrackId}`).click();
  await page.getByTestId("session-status").filter({ hasText: "drums switch failed: Stem download failed (503)" })
    .waitFor({ timeout: 8_000 });
  await page.getByTestId("live-swap-pending-drums").waitFor({ state: "detached" });
  assert(liveDrumDonorFetchCount >= 1, "the failing drum donor must actually be requested");
  assert.deepEqual(liveSwaps.map(({ stemType }) => stemType), ["vocals"],
    "failed drums roll back without deleting the working vocal swap");
  assert.equal(liveSwapDeleteRequestCount, 2, "only the failed drum swap is removed after the earlier cancellation");
  assert.equal(liveDonorFetchCount, 2, "the working vocal donor must not be fetched again or discarded");
  await page.getByTestId("restore-live-swap-vocals").waitFor();
  assert.equal(await sourceVocals.getAttribute("aria-label"), "vocals audio (swapped layer)");
  assert.equal(await sourceDrums.getAttribute("aria-label"), "drums audio",
    "the failed donor leaves the original drum layer selected");
  await page.waitForFunction(({ assetId, after }) => {
    const audio = document.querySelector(`audio[src$="/${assetId}"]`);
    const bar = document.querySelector(".wy-stem-vocals .wy-stem-meter i");
    const peak = Number(bar?.getAttribute("style")?.match(/scaleX\(([^)]+)\)/)?.[1] ?? 0);
    return audio instanceof HTMLAudioElement && !audio.paused && audio.currentTime > after + 0.2 && peak > 0.4;
  }, { assetId: liveVocalsAssetId, after: clockBeforeDonorFailure }, { timeout: 5_000 });
  assert.equal(await sourceDrums.evaluate((audio) => audio.paused), false,
    "the original drums continue playing while the vocal donor stays audible");
  report.push("A failed drum-donor download rolls back only drums; the working vocal donor remains audible and the recipient clock keeps advancing, then drums can be retried.");
  failLiveDrumDonorFetch = false;
  await page.getByTestId("open-live-swap-drums").click();
  await page.getByTestId(`live-swap-candidate-drums-${liveDrumDonorTrackId}`).click();
  await page.getByTestId("session-status").filter({ hasText: "drums source saved" }).waitFor({ timeout: 8_000 });
  const swappedDrumsAudio = page.locator('audio[aria-label="drums audio (swapped layer)"]');
  await page.waitForFunction((originalAssetId) => {
    const audio = [...document.querySelectorAll('audio[aria-label="drums audio (swapped layer)"]')]
      .find((element) => element.getAttribute("src")?.endsWith(`/api/assets/${originalAssetId}`));
    const bar = document.querySelector(".wy-stem-drums .wy-stem-meter i");
    const peak = Number(bar?.getAttribute("style")?.match(/scaleX\(([^)]+)\)/)?.[1] ?? 0);
    return audio instanceof HTMLAudioElement && peak > 0;
  }, liveDrumsAssetId, { timeout: 8_000 });
  assert.equal(await swappedDrumsAudio.getAttribute("src"), `/api/assets/${liveDrumsAssetId}`,
    "the session keeps the recipient element while replacing its active drum audio buffer");
  assert.equal(await sourceDrums.count(), 1, "the recipient drum element remains associated with the current session track");
  assert(liveDrumDonorFetchCount >= 1,
    "the matching drum donor asset must be requested as the replacement audio buffer");
  await page.waitForFunction((after) => {
    const bar = document.querySelector(".wy-stem-drums .wy-stem-meter i");
    const peak = Number(bar?.getAttribute("style")?.match(/scaleX\(([^)]+)\)/)?.[1] ?? 0);
    return peak > after * 1.5;
  }, originalDrumPeak, { timeout: 8_000 });
  assert.equal(liveSwaps.length, 2, "two live swaps on distinct stems must remain in the session");
  assert.deepEqual(
    liveSwaps.map(({ stemType, toTrackId }) => ({ stemType, toTrackId })).sort((a, b) => a.stemType.localeCompare(b.stemType)),
    [
      { stemType: "drums", toTrackId: liveDrumDonorTrackId },
      { stemType: "vocals", toTrackId: liveDonorTrackId },
    ],
    "each saved stem swap must retain its own donor track",
  );
  assert.equal(liveSwapRequestCount, 4, "the cancellation, failed drums, and both successful stem swaps each persist once");
  const isolateVocals = page.getByRole("button", { name: "Isolate vocals", exact: true });
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
  const desktopViewport = page.viewportSize();
  await page.setViewportSize({ width: 402, height: 874 });
  await page.waitForTimeout(100);
  const mobileStemControls = await page.evaluate(() => {
    const viewportWidth = document.documentElement.clientWidth;
    const targets = Array.from(document.querySelectorAll([
      '[data-testid^="quick-isolate-"]',
      '[data-testid^="quick-open-live-swap-"]',
      '[data-testid="quick-restore-mix"]',
      ".wy-deck.sess-deck-active .wy-stem input[type=range]",
      ".wy-deck.sess-deck-active .wy-stem .wy-toggle",
      ".wy-transport .wy-buttons button",
      ".wy-transport .wy-mixbtn",
      ".wy-transport .wy-seek input",
      ".wy-transport .wy-master input",
    ].join(", "))).map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        testId: element.getAttribute("data-testid")
          ?? element.getAttribute("aria-label")
          ?? element.className,
        left: rect.left,
        right: rect.right,
        width: rect.width,
        height: rect.height,
      };
    });
    return {
      viewportWidth,
      documentWidth: document.documentElement.scrollWidth,
      targets,
      faderCount: document.querySelectorAll(".wy-deck.sess-deck-active .wy-stem input[type=range]").length,
      stemActionCount: document.querySelectorAll(".wy-deck.sess-deck-active .wy-stem .wy-toggle").length,
    };
  });
  assert.equal(mobileStemControls.documentWidth, mobileStemControls.viewportWidth, "mobile stem controls must not create horizontal overflow");
  assert.equal(mobileStemControls.targets.filter((target) => target.testId.startsWith("quick-isolate-")).length, 4);
  assert.equal(mobileStemControls.targets.filter((target) => target.testId.startsWith("quick-open-live-swap-")).length, 4);
  assert(mobileStemControls.targets.some((target) => target.testId === "quick-restore-mix"), "the mobile player must expose restore mix");
  assert.equal(mobileStemControls.faderCount, 4, "all four active stem levels must be present in the phone player");
  assert.equal(mobileStemControls.stemActionCount, 12, "mute, isolate, and hold actions must remain available for every active stem");
  for (const target of mobileStemControls.targets) {
    assert(target.width >= 44 && target.height >= 44, `${target.testId} must meet a 44px mobile touch target`);
    assert(target.left >= 0 && target.right <= mobileStemControls.viewportWidth, `${target.testId} must stay within the mobile viewport`);
  }

  const mobileSwapTrigger = page.getByTestId("quick-open-live-swap-vocals");
  await mobileSwapTrigger.click();
  const mobileSwapPicker = page.getByTestId("live-swap-picker-vocals");
  await mobileSwapPicker.waitFor({ state: "visible", timeout: 5_000 });
  const mobilePickerBounds = await mobileSwapPicker.evaluate((picker) => {
    const rect = picker.getBoundingClientRect();
    return {
      position: getComputedStyle(picker).position,
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      viewportWidth: document.documentElement.clientWidth,
      viewportHeight: document.documentElement.clientHeight,
    };
  });
  assert.equal(mobilePickerBounds.position, "fixed", "the phone donor picker must open as a sheet, not below the stem rows");
  assert(mobilePickerBounds.left >= 0 && mobilePickerBounds.right <= mobilePickerBounds.viewportWidth,
    "the phone donor picker must fit within the viewport");
  assert(mobilePickerBounds.top >= 0 && mobilePickerBounds.bottom <= mobilePickerBounds.viewportHeight,
    "the phone donor picker must remain fully reachable above the safe-area edge");
  const mobileSearch = mobileSwapPicker.locator(".wy-swap-search input");
  await mobileSearch.waitFor({ state: "visible", timeout: 3_000 });
  assert.equal(await mobileSearch.evaluate((input) => document.activeElement === input), false,
    "opening the phone picker must not raise the keyboard before the user chooses to search");
  await mobileSearch.focus();
  await page.setViewportSize({ width: 402, height: 520 });
  await page.waitForFunction(() => {
    const picker = document.querySelector(".wy-swap-picker");
    return picker instanceof HTMLElement
      && Number.parseFloat(getComputedStyle(picker).getPropertyValue("--wy-swap-visual-height")) > 0;
  }, null, { timeout: 2_000 });
  const keyboardPickerLayout = await mobileSwapPicker.evaluate((picker) => {
    const pickerRect = picker.getBoundingClientRect();
    const searchRect = picker.querySelector("input[type=search]")?.getBoundingClientRect();
    const closeRect = picker.querySelector(".wy-swap-close")?.getBoundingClientRect();
    const candidateRect = picker.querySelector(".wy-swap-candidate")?.getBoundingClientRect();
    return {
      viewportHeight: document.documentElement.clientHeight,
      picker: { top: pickerRect.top, bottom: pickerRect.bottom },
      search: searchRect === undefined ? null : { top: searchRect.top, bottom: searchRect.bottom },
      close: closeRect === undefined ? null : { top: closeRect.top, bottom: closeRect.bottom },
      candidate: candidateRect === undefined ? null : { top: candidateRect.top, bottom: candidateRect.bottom },
    };
  });
  assert(keyboardPickerLayout.picker.top >= 0 && keyboardPickerLayout.picker.bottom <= keyboardPickerLayout.viewportHeight,
    `the donor sheet must stay within the shortened keyboard viewport: ${JSON.stringify(keyboardPickerLayout)}`);
  for (const control of [keyboardPickerLayout.search, keyboardPickerLayout.close, keyboardPickerLayout.candidate]) {
    assert(control !== null && control.top >= keyboardPickerLayout.picker.top && control.bottom <= keyboardPickerLayout.picker.bottom,
      `search, close, and a donor result must remain reachable above the keyboard: ${JSON.stringify(keyboardPickerLayout)}`);
  }
  await mobileSwapPicker.getByRole("button", { name: "Close source picker" }).click();
  await page.waitForFunction(() => document.activeElement?.getAttribute("data-live-swap-anchor") === "vocals");
  assert.equal(await mobileSwapTrigger.getAttribute("aria-expanded"), "false",
    "closing the phone picker returns focus to the pad that opened it");
  await page.setViewportSize({ width: 402, height: 874 });

  const mobilePlay = page.getByTestId("session-play");
  const wasPlaying = await mobilePlay.getAttribute("aria-pressed") === "true";
  if (wasPlaying) {
    await mobilePlay.click();
    await page.waitForFunction(() => document.querySelector('[data-testid="session-play"]')?.getAttribute("aria-pressed") === "false");
  }
  await mobilePlay.click();
  await page.waitForFunction(({ assetId }) => {
    const audio = document.querySelector(`audio[src$="/${assetId}"]`);
    return audio instanceof HTMLAudioElement && !audio.paused;
  }, { assetId: liveVocalsAssetId }, { timeout: 5_000 });

  await page.getByLabel("Snap stem changes").selectOption("off");
  const mobilePlaybackTime = await sourceVocals.evaluate((audio) => audio.currentTime);
  const isolateBass = page.getByTestId("quick-isolate-bass");
  await isolateBass.click();
  await page.waitForFunction(() => document.querySelector('[data-testid="quick-isolate-bass"]')?.getAttribute("aria-pressed") === "true");
  assert.equal(await page.locator(".wy-stem-vocals").evaluate((row) => row.classList.contains("silent")), true,
    "phone isolation must apply to the active audio mix, not only change the button state");
  const mobileRestoreSaved = page.waitForResponse((response) => {
    if (response.request().method() !== "PATCH" || !response.url().endsWith(`/api/library/sessions/${liveSessionId}/tracks/${liveSessionTrackId}`)) return false;
    const mix = response.request().postDataJSON()?.stemMix;
    return mix !== undefined && ["vocals", "drums", "bass", "other"].every((stemType) => mix[stemType] === 1);
  }, { timeout: 5_000 });
  await page.getByTestId("quick-restore-mix").click();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid^="quick-isolate-"]')]
    .every((button) => button.getAttribute("aria-pressed") === "false"));
  await mobileRestoreSaved;
  await page.waitForFunction(({ assetId, after }) => {
    const audio = document.querySelector(`audio[src$="/${assetId}"]`);
    return audio instanceof HTMLAudioElement && !audio.paused && audio.currentTime > after + 0.2;
  }, { assetId: liveVocalsAssetId, after: mobilePlaybackTime }, { timeout: 5_000 });

  const mobileSeek = page.getByLabel("Seek current track");
  const mobileSeekBounds = await mobileSeek.boundingBox();
  assert(mobileSeekBounds !== null, "the phone seek control must be on screen");
  await mobileSeek.focus();
  await mobileSeek.press("Home");
  await page.waitForFunction(() => Number(document.querySelector('[aria-label="Seek current track"]')?.value) < 1,
    null, { timeout: 2_000 });
  await page.waitForFunction(({ assetId }) => {
    const audio = document.querySelector(`audio[src$="/${assetId}"]`);
    return audio instanceof HTMLAudioElement && !audio.paused && audio.currentTime < 1.5;
  }, { assetId: liveVocalsAssetId }, { timeout: 5_000 });

  liveCurrentItem.stemMix = { ...liveCurrentItem.stemMix, drums: 0 };

  await page.setViewportSize({ width: 320, height: 740 });
  const narrowPhoneLayout = await page.evaluate(() => ({
    viewportWidth: document.documentElement.clientWidth,
    documentWidth: document.documentElement.scrollWidth,
    overflowingElements: Array.from(document.querySelectorAll("body *")).flatMap((element) => {
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.right <= document.documentElement.clientWidth + 1) return [];
      return [{
        tag: element.tagName,
        className: typeof element.className === "string" ? element.className : "",
        id: element.id,
        testId: element.getAttribute("data-testid"),
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        width: Math.round(rect.width),
        scrollWidth: element.scrollWidth,
        computedWidth: getComputedStyle(element).width,
        minWidth: getComputedStyle(element).minWidth,
        parent: element.parentElement === null ? null : {
          className: typeof element.parentElement.className === "string" ? element.parentElement.className : "",
          left: Math.round(element.parentElement.getBoundingClientRect().left),
          right: Math.round(element.parentElement.getBoundingClientRect().right),
          width: Math.round(element.parentElement.getBoundingClientRect().width),
          display: getComputedStyle(element.parentElement).display,
        },
      }];
    }).slice(0, 12),
    targets: Array.from(document.querySelectorAll([
      '[data-testid^="quick-isolate-"]',
      '[data-testid^="quick-open-live-swap-"]',
      '[data-testid="quick-restore-mix"]',
      ".wy-deck.sess-deck-active .wy-stem input[type=range]",
      ".wy-deck.sess-deck-active .wy-stem .wy-toggle",
      ".wy-transport .wy-buttons button",
      ".wy-transport .wy-mixbtn",
      ".wy-transport .wy-seek input",
    ].join(", "))).map((element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, width: rect.width, height: rect.height };
    }),
  }));
  assert.equal(narrowPhoneLayout.documentWidth, narrowPhoneLayout.viewportWidth,
    `the player must also avoid horizontal overflow on a narrow phone: ${JSON.stringify(narrowPhoneLayout)}`);
  for (const target of narrowPhoneLayout.targets) {
    assert(target.width >= 44 && target.height >= 44, "narrow-phone controls must retain a 44px touch target");
    assert(target.left >= 0 && target.right <= narrowPhoneLayout.viewportWidth,
      "narrow-phone controls must stay within the viewport");
  }

  await page.setViewportSize({ width: 844, height: 390 });
  await page.getByTestId("quick-open-live-swap-vocals").scrollIntoViewIfNeeded();
  const landscapeMixerLayout = await page.evaluate(() => {
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = document.documentElement.clientHeight;
    const transport = document.querySelector(".wy-host-full .wy-transport");
    const transportRect = transport?.getBoundingClientRect();
    const targets = Array.from(document.querySelectorAll([
      ".wy-host-full .wy-transport .wy-buttons button",
      ".wy-host-full .wy-transport .wy-mixbtn",
      ".wy-host-full .wy-transport .wy-seek input",
      '[data-testid^="quick-isolate-"]',
      '[data-testid^="quick-open-live-swap-"]',
      '[data-testid="quick-restore-mix"]',
      ".wy-deck.sess-deck-active .wy-stem input[type=range]",
      ".wy-deck.sess-deck-active .wy-stem .wy-toggle",
    ].join(", "))).map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        label: element.getAttribute("data-testid") ?? element.getAttribute("aria-label") ?? element.className,
        left: rect.left,
        right: rect.right,
        width: rect.width,
        height: rect.height,
      };
    });
    return {
      viewportWidth,
      viewportHeight,
      documentWidth: document.documentElement.scrollWidth,
      transport: transportRect === undefined ? null : {
        left: transportRect.left,
        right: transportRect.right,
        top: transportRect.top,
        bottom: transportRect.bottom,
      },
      targets,
    };
  });
  assert.equal(landscapeMixerLayout.documentWidth, landscapeMixerLayout.viewportWidth,
    `the mixer must not create horizontal overflow in landscape: ${JSON.stringify(landscapeMixerLayout)}`);
  assert(landscapeMixerLayout.transport !== null
    && landscapeMixerLayout.transport.left >= 0
    && landscapeMixerLayout.transport.right <= landscapeMixerLayout.viewportWidth
    && landscapeMixerLayout.transport.top >= 0
    && landscapeMixerLayout.transport.bottom <= landscapeMixerLayout.viewportHeight,
  `the landscape transport dock must stay fully visible: ${JSON.stringify(landscapeMixerLayout)}`);
  for (const target of landscapeMixerLayout.targets) {
    assert(target.width >= 44 && target.height >= 44, `${target.label} must retain a 44px landscape touch target`);
    assert(target.left >= 0 && target.right <= landscapeMixerLayout.viewportWidth,
      `${target.label} must stay within the landscape viewport`);
  }
  const landscapeSwapTrigger = page.getByTestId("quick-open-live-swap-vocals");
  await landscapeSwapTrigger.click();
  const landscapeSwapPicker = page.getByTestId("live-swap-picker-vocals");
  await landscapeSwapPicker.waitFor({ state: "visible", timeout: 5_000 });
  const landscapePickerBounds = await landscapeSwapPicker.evaluate((picker) => {
    const rect = picker.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      viewportWidth: document.documentElement.clientWidth,
      viewportHeight: document.documentElement.clientHeight,
    };
  });
  assert(landscapePickerBounds.left >= 0 && landscapePickerBounds.right <= landscapePickerBounds.viewportWidth
    && landscapePickerBounds.top >= 0 && landscapePickerBounds.bottom <= landscapePickerBounds.viewportHeight,
  `the live donor sheet must stay reachable in landscape: ${JSON.stringify(landscapePickerBounds)}`);
  await landscapeSwapPicker.getByRole("button", { name: "Close source picker" }).click();
  report.push("Waveyard mobile live stems pass portrait keyboard-viewport and short landscape layout checks.");
  if (waveyardMobileOnly) throw new Error(waveyardMobileOnlyComplete);
  await page.setViewportSize(desktopViewport ?? { width: 1280, height: 800 });
  liveSessionTracks.push(liveNextItem);
  liveSessionTracks.forEach((item, index) => { item.position = index; });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByTestId("listening-workspace").waitFor({ timeout: 20_000 });
  await page.getByTestId("session-handoff").click();
  await page.getByRole("status").filter({ hasText: "Studio arrangement created with 8 remix tracks" }).waitFor({ timeout: 8_000 });
  assert(
    (await page.locator(".sess-handoff").innerText()).includes("2 live stem swaps carried over")
      && (await page.locator(".sess-handoff").innerText()).includes("1 session crossfade carried over"),
    "the session result must report both carried live swaps and the supported crossfade",
  );
  const openStudioAfterHandoff = page.getByTestId("link-open-studio");
  assert.equal(
    await openStudioAfterHandoff.getAttribute("href"),
    `/waveyard/projects/${studioProjectId}?view=studio`,
    "a successful session handoff must expose the Studio destination directly",
  );
  await openStudioAfterHandoff.evaluate((link) => {
    const tabbable = Array.from(document.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )).filter((element) => element.getClientRects().length > 0 && !element.closest("[inert]"));
    const linkIndex = tabbable.indexOf(link);
    if (linkIndex < 1) throw new Error("The Studio handoff link is missing from keyboard navigation.");
    tabbable[linkIndex - 1].focus();
  });
  await page.keyboard.press("Tab");
  assert.equal(
    await openStudioAfterHandoff.evaluate((link) => document.activeElement === link),
    true,
    "the Studio handoff link must be reachable in the normal keyboard tab order",
  );
  assert.equal(studioHandoffRequestCount, 1, "the UI must create one Studio arrangement from the selected session mix");
  assert.equal(errors.length, errorsBeforeLiveSwap, "live swapping and isolation must not throw browser errors");
  const studioCurrentSourceId = "arena-smoke-session-current-source";
  const studioDonorSourceId = "arena-smoke-session-donor-source";
  const studioDrumDonorSourceId = "arena-smoke-session-drum-donor-source";
  const studioNextSourceId = "arena-smoke-session-next-source";
  const studioStemRows = [
    { id: liveDonorVocalsAssetId, sourceAssetId: studioDonorSourceId, stemType: "vocals" },
    { id: liveDrumDonorDrumsAssetId, sourceAssetId: studioDrumDonorSourceId, stemType: "drums" },
    { id: liveBassAssetId, sourceAssetId: studioCurrentSourceId, stemType: "bass" },
    { id: liveOtherAssetId, sourceAssetId: studioCurrentSourceId, stemType: "other" },
    { id: liveNextVocalsAssetId, sourceAssetId: studioNextSourceId, stemType: "vocals" },
    { id: liveNextDrumsAssetId, sourceAssetId: studioNextSourceId, stemType: "drums" },
    { id: liveNextBassAssetId, sourceAssetId: studioNextSourceId, stemType: "bass" },
    { id: liveNextOtherAssetId, sourceAssetId: studioNextSourceId, stemType: "other" },
  ].map((stem) => ({
    ...stem,
    durationSeconds: 8,
    sampleRate: 44100,
    channels: 1,
    codec: "pcm_s16le",
    format: "wav",
    fileSizeBytes: 1024,
    checksumSha256: `smoke-${stem.id}`,
    model: "smoke-test",
    modelVersion: "1",
  }));
  const studioSourceRows = [
    { id: studioCurrentSourceId, originalFilename: "Live source track.wav", durationSeconds: 8, linkedFromLibrary: true },
    { id: studioDonorSourceId, originalFilename: "Donor track.wav", durationSeconds: 8, linkedFromLibrary: true },
    { id: studioDrumDonorSourceId, originalFilename: "Drum donor track.wav", durationSeconds: 8, linkedFromLibrary: true },
    { id: studioNextSourceId, originalFilename: "Next source track.wav", durationSeconds: 8, linkedFromLibrary: true },
  ];
  assert(
    studioStemRows.every((stem) => studioSourceRows.some((source) => source.id === stem.sourceAssetId)),
    "the project response must resolve every arrangement stem to a linked source",
  );
  const makeHandoffRemixTrack = (stem, sortOrder, timelineStartMs, fadeInMs, fadeOutMs, volume) => ({
    id: `arena-smoke-session-remix-track-${sortOrder}`,
    remixSessionId: studioRemixId,
    stemAssetId: stem.id,
    name: `${studioSourceRows.find((source) => source.id === stem.sourceAssetId)?.originalFilename ?? "Unknown source"} — ${stem.stemType}`,
    sortOrder,
    volume,
    pan: 0,
    muted: false,
    solo: false,
    inserts: [],
    phaseInverted: false,
    clips: [{
      id: `arena-smoke-session-remix-clip-${sortOrder}`,
      remixTrackId: `arena-smoke-session-remix-track-${sortOrder}`,
      stemAssetId: stem.id,
      timelineStartMs,
      sourceOffsetMs: 0,
      durationMs: 8000,
      gain: 1,
      fadeInMs,
      fadeOutMs,
      tempoSyncEnabled: false,
      keySyncEnabled: false,
      beatSnapEnabled: false,
    }],
  });
  const studioRemixResponse = {
    remix: {
      id: studioRemixId,
      projectId: studioProjectId,
      name: "Live swap acceptance",
      masterVolume: 1,
      masterInserts: "[]",
      loopStartMs: 0,
      loopEndMs: null,
      tempoBpm: 120,
      timeSignatureNumerator: 4,
      timeSignatureDenominator: 4,
      gridDivision: "beat",
      snapEnabled: true,
      targetKey: null,
      version: 1,
    },
    tracks: studioStemRows.map((stem, index) => {
      const nextTrack = stem.sourceAssetId === studioNextSourceId;
      const currentVolume = studioHandoffPayload?.trackEdits
        .find((edit) => edit.sessionTrackId === liveSessionTrackId)?.stemMix[stem.stemType] ?? 1;
      return makeHandoffRemixTrack(
        stem,
        index,
        nextTrack ? 7000 : 0,
        nextTrack ? 1000 : 0,
        !nextTrack && stem.stemType !== "drums" ? 1000 : 0,
        nextTrack ? 1 : currentVolume,
      );
    }),
    automation: [],
    stems: studioStemRows,
  };
  let studioProjectRequestCount = 0;
  let studioRemixRequestCount = 0;
  const studioKeyboardEdits = [];
  const studioSaveAttempts = [];
  const studioSavedStates = [];
  let failNextStudioRemixPut = false;
  await page.route(`**/api/waveyard/projects/${studioProjectId}`, async (route) => {
    studioProjectRequestCount += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        project: { title: "Session · Live swap acceptance", description: "Derived from a listening session", licenseCode: "private", visibility: "private", publicationStatus: "draft", moderationStatus: "pending" },
        role: "owner",
        build: null,
        sources: [],
        studioSources: studioSourceRows,
        stems: studioStemRows,
        waveforms: [],
        waveformJobs: [],
        jobs: [],
      }),
    });
  });
  await page.route(`**/api/waveyard/projects/${studioProjectId}/arena-handoff`, (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ linked: false }),
  }));
  await page.route(`**/api/waveyard/projects/${studioProjectId}/publication`, (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      publication: {
        visibility: "private",
        publicationStatus: "draft",
        moderationStatus: "pending",
        publishedExportAssetId: null,
        licenseCode: "private",
        downloadPermission: "owner-only",
        rightsAcknowledgementVersion: "smoke-test",
        rightsAcknowledgementStatement: "",
        tags: [],
      },
      exports: [],
      exportJobs: [],
    }),
  }));
  await page.route(`**/api/waveyard/projects/${studioProjectId}/publication/audit`, (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ events: [] }),
  }));
  await page.route(`**/api/waveyard/projects/${studioProjectId}/remixes`, async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ remixes: [{ id: studioRemixId }] }) });
  });
  await page.route(`**/api/remixes/${studioRemixId}`, async (route) => {
    if (route.request().method() === "GET") {
      studioRemixRequestCount += 1;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(studioRemixResponse) });
    } else if (route.request().method() === "PUT") {
      const request = route.request().postDataJSON();
      studioSaveAttempts.push(request);
      if (failNextStudioRemixPut) {
        failNextStudioRemixPut = false;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "Smoke-test save failure." }),
        });
        return;
      }
      studioSavedStates.push(request);
      const { tracks, automation, ...settings } = request;
      Object.assign(studioRemixResponse.remix, settings);
      studioRemixResponse.tracks = tracks;
      studioRemixResponse.automation = automation;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(studioRemixResponse) });
    } else {
      await route.continue();
    }
  });
  await page.route(`**/api/remixes/${studioRemixId}/clips/batch-edit`, async (route) => {
    const request = route.request().postDataJSON();
    studioKeyboardEdits.push(request);
    const movedClips = studioRemixResponse.tracks.flatMap((track) => track.clips)
      .filter((clip) => request.clipIds.includes(clip.id))
      .map((clip) => request.operation === "duplicate"
        ? { ...clip, id: `${clip.id}-copy-${studioKeyboardEdits.length}`, timelineStartMs: clip.timelineStartMs + clip.durationMs }
        : { ...clip, timelineStartMs: clip.timelineStartMs + Number(request.timelineDeltaMs ?? (request.direction === "back" ? -1 : request.direction === "forward" ? 1 : 0)) });
    studioRemixResponse.tracks = studioRemixResponse.tracks.map((track) => ({
      ...track,
      clips: request.operation === "delete" ? track.clips.filter((clip) => !request.clipIds.includes(clip.id))
        : request.operation === "duplicate"
          ? [...track.clips, ...movedClips.filter((clip) => clip.remixTrackId === track.id)]
          : track.clips.map((clip) => movedClips.find((updated) => updated.id === clip.id) ?? clip),
    }));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ clips: movedClips }),
    });
  });
  await page.route(`**/api/remixes/${studioRemixId}/versions`, (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ versions: [] }),
  }));
  for (const [index, stem] of studioStemRows.entries()) {
    await page.route(`**/api/assets/${stem.id}`, (route) => route.fulfill({
      status: 200,
      contentType: "audio/wav",
      body: makePcmWav(220 + index * 55, 0.2),
    }));
  }
  await page.keyboard.press("Enter");
  await page.getByRole("heading", { name: "Mixer console" }).waitFor({ timeout: 15_000 });
  await page.locator(".timeline-track").nth(7).waitFor({ state: "visible", timeout: 15_000 });
  await page.waitForFunction(() => document.activeElement?.id === "studio-editor", null, { timeout: 15_000 });
  assert(
    await page.locator("#studio-editor").evaluate((editor) => Number.parseFloat(getComputedStyle(editor).outlineWidth) >= 3),
    "opening Studio from the keyboard must leave a visible focus indicator on the editor",
  );
  assert(studioProjectRequestCount >= 1, "Open in Studio must load the linked project through its project API");
  assert.equal(await page.locator('[data-testid^="source-stems-"]').count(), 4,
    "the project API result must expose current, both donor, and following linked audio sources");
  assert.equal(await page.locator(".timeline-track").count(), 8,
    "the linked remix must load all eight stem tracks into the timeline");
  assert.equal(await page.locator(".clip").count(), 8,
    "the linked remix must load its saved audio clips, not an empty arrangement");
  assert.equal(await page.getByLabel("Drum donor track.wav — Drums arrangement volume").inputValue(), "0",
    "the isolated stem level must be present in the Studio mix");
  const donorStudioAudio = page.locator(`audio[src$="/${liveDonorVocalsAssetId}"]`);
  await donorStudioAudio.waitFor({ state: "attached" });
  await page.waitForFunction((assetId) => {
    const audio = document.querySelector(`audio[src$="/${assetId}"]`);
    return audio instanceof HTMLAudioElement && audio.readyState >= HTMLMediaElement.HAVE_METADATA;
  }, liveDonorVocalsAssetId, { timeout: 8_000 });
  assert(
    (await donorStudioAudio.getAttribute("src"))?.endsWith(`/api/assets/${liveDonorVocalsAssetId}`),
    "the Studio vocals layer must use the donor audio selected by the live swap",
  );
  assert.equal(
    await page.locator(`[data-testid="source-stems-${studioDonorSourceId}"] audio`).getAttribute("src"),
    `/api/assets/${liveDonorVocalsAssetId}`,
    "the vocal donor source group must contain the matching vocals asset",
  );
  const donorDrumStudioAudio = page.locator(`audio[src$="/${liveDrumDonorDrumsAssetId}"]`);
  await donorDrumStudioAudio.waitFor({ state: "attached" });
  await page.waitForFunction((assetId) => {
    const audio = document.querySelector(`audio[src$="/${assetId}"]`);
    return audio instanceof HTMLAudioElement && audio.readyState >= HTMLMediaElement.HAVE_METADATA;
  }, liveDrumDonorDrumsAssetId, { timeout: 8_000 });
  assert(
    (await donorDrumStudioAudio.getAttribute("src"))?.endsWith(`/api/assets/${liveDrumDonorDrumsAssetId}`),
    "the Studio drums layer must use the different donor audio selected for drums",
  );
  assert.equal(
    await page.locator(`[data-testid="source-stems-${studioDrumDonorSourceId}"] audio`).getAttribute("src"),
    `/api/assets/${liveDrumDonorDrumsAssetId}`,
    "the drum donor source group must contain its own matching drums asset",
  );
  const donorVocalsTrack = page.locator(".timeline-track").filter({ hasText: "Donor track.wav — Vocals" });
  const donorDrumsTrack = page.locator(".timeline-track").filter({ hasText: "Drum donor track.wav — Drums" });
  assert.equal(await donorVocalsTrack.count(), 1, "the vocal lane must identify the vocal donor");
  assert.equal(await donorDrumsTrack.count(), 1, "the drum lane must identify the drum donor");
  const outgoingVocalsTrack = donorVocalsTrack;
  await outgoingVocalsTrack.locator(".clip").focus();
  await page.getByLabel("Fade out (ms)").waitFor();
  assert.equal(await page.getByLabel("Fade out (ms)").inputValue(), "1000",
    "the outgoing clip must restore its supported crossfade fade-out");
  await donorDrumsTrack.locator(".clip").focus();
  assert.equal(await page.getByLabel("Fade out (ms)").inputValue(), "0",
    "the swapped drum lane must retain the session's keep-drums transition setting");
  const incomingVocalsTrack = page.locator(".timeline-track").filter({ hasText: "Next source track.wav — Vocals" });
  await incomingVocalsTrack.locator(".clip").focus();
  assert.equal(await page.getByLabel("Fade in (ms)").inputValue(), "1000",
    "the incoming clip must restore its supported crossfade fade-in");
  assert.equal(await incomingVocalsTrack.getByLabel("Next source track.wav — Vocals arrangement volume").inputValue(), "1");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Mixer console" }).waitFor({ timeout: 15_000 });
  await page.locator(".timeline-track").nth(7).waitFor({ state: "visible", timeout: 15_000 });
  await page.waitForFunction(() => document.activeElement?.id === "studio-editor", null, { timeout: 15_000 });
  assert(
    await page.locator("#studio-editor").evaluate((editor) => Number.parseFloat(getComputedStyle(editor).outlineWidth) >= 3),
    "reloading Studio must restore useful keyboard focus with a visible editor indicator",
  );
  assert(studioProjectRequestCount >= 2, "reloading Studio must refetch linked source stems from the project API");
  assert(studioRemixRequestCount >= 2, "reloading Studio must refetch the saved remix arrangement");
  assert.equal(await page.locator(".timeline-track").count(), 8, "all linked remix tracks must return after reload");
  assert.equal(await page.locator(".clip").count(), 8, "all saved clips must return after reload");
  await page.waitForFunction(({ vocalAssetId, drumAssetId }) => {
    return [vocalAssetId, drumAssetId].every((assetId) => {
      const audio = document.querySelector(`audio[src$="/${assetId}"]`);
      return audio instanceof HTMLAudioElement && audio.readyState >= HTMLMediaElement.HAVE_METADATA;
    });
  }, { vocalAssetId: liveDonorVocalsAssetId, drumAssetId: liveDrumDonorDrumsAssetId }, { timeout: 8_000 });
  assert.equal(await page.getByLabel("Drum donor track.wav — Drums arrangement volume").inputValue(), "0",
    "the isolated stem mix value must survive reload");
  assert.equal(await page.locator(`audio[src$="/${liveDonorVocalsAssetId}"]`).count(), 1,
    "the live-swapped vocal donor stem must remain the source audio after reload");
  assert.equal(await page.locator(`audio[src$="/${liveDrumDonorDrumsAssetId}"]`).count(), 1,
    "the different live-swapped drum donor must remain the source audio after reload");
  assert.equal(
    await page.locator(`[data-testid="source-stems-${studioDonorSourceId}"] audio`).getAttribute("src"),
    `/api/assets/${liveDonorVocalsAssetId}`,
    "the vocal donor source group must still contain the matching vocals asset after reload",
  );
  assert.equal(
    await page.locator(`[data-testid="source-stems-${studioDrumDonorSourceId}"] audio`).getAttribute("src"),
    `/api/assets/${liveDrumDonorDrumsAssetId}`,
    "the drum donor source group must still contain the matching drums asset after reload",
  );
  assert.equal(await page.locator(".timeline-track").filter({ hasText: "Donor track.wav — Vocals" }).count(), 1,
    "the reloaded vocal lane must still identify its matching donor");
  assert.equal(await page.locator(".timeline-track").filter({ hasText: "Drum donor track.wav — Drums" }).count(), 1,
    "the reloaded drum lane must still identify its matching donor");
  await page.locator(".timeline-track").filter({ hasText: "Donor track.wav — Vocals" }).locator(".clip").focus();
  assert.equal(await page.getByLabel("Fade out (ms)").inputValue(), "1000",
    "the outgoing supported transition must survive reload");
  await page.locator(".timeline-track").filter({ hasText: "Next source track.wav — Vocals" }).locator(".clip").focus();
  assert.equal(await page.getByLabel("Fade in (ms)").inputValue(), "1000",
    "the incoming supported transition must survive reload");
  const keyboardTimeline = page.getByRole("region", { name: "Arrangement timeline" });
  const keyboardFirstLane = page.locator(".timeline-track").first();
  const keyboardFirstClip = keyboardFirstLane.locator(".clip").first();
  const keyboardSecondClip = page.locator(".timeline-track").nth(1).locator(".clip").first();
  const playingBeforeKeyboard = await page.locator("audio").evaluateAll((elements) => elements.filter((audio) => !audio.paused).length);
  const waitForStudioSave = (method, suffix = "") => page.waitForResponse((response) =>
    new URL(response.url()).pathname === `/api/remixes/${studioRemixId}${suffix}` && response.request().method() === method);
  const pressAndSave = async (key, method = "POST", suffix = "/clips/batch-edit") => {
    const saved = waitForStudioSave(method, suffix);
    await page.keyboard.press(key);
    await saved;
    await page.waitForTimeout(80);
  };
  await keyboardTimeline.focus();
  await page.keyboard.press("Enter");
  assert(await keyboardFirstClip.evaluate((element) => document.activeElement === element),
    "Enter on the timeline must focus and select its first clip");
  assert((await keyboardFirstClip.getAttribute("class")).includes("selected"));
  assert(await keyboardFirstClip.evaluate((element) => Number.parseFloat(getComputedStyle(element).outlineWidth) >= 3),
    "keyboard-focused clips need a visible outline distinct from selection");
  await page.keyboard.press("Space");
  assert.equal(await page.locator("audio").evaluateAll((elements) => elements.filter((audio) => !audio.paused).length), playingBeforeKeyboard,
    "Space on a clip selects it instead of starting playback");
  await page.keyboard.press("ArrowDown");
  assert(await keyboardSecondClip.evaluate((element) => document.activeElement === element), "Down moves to the next timeline lane");
  await page.keyboard.press("ArrowUp");
  assert(await keyboardFirstClip.evaluate((element) => document.activeElement === element), "Up returns to the previous lane");
  const keyboardOriginalLeft = await keyboardFirstClip.evaluate((element) => element.style.left);
  await pressAndSave("Alt+ArrowRight");
  assert.equal(studioKeyboardEdits.at(-1).timelineDeltaMs, 500, "keyboard movement must use the active beat snap grid");
  assert.notEqual(await keyboardFirstClip.evaluate((element) => element.style.left), keyboardOriginalLeft);
  assert(await keyboardFirstClip.evaluate((element) => document.activeElement === element), "moving a clip must retain its focus");
  await pressAndSave("Alt+ArrowLeft");
  assert.equal(await keyboardFirstClip.evaluate((element) => element.style.left), keyboardOriginalLeft);
  await page.keyboard.press("Tab");
  assert(await keyboardFirstClip.locator(".trim-left").evaluate((element) => document.activeElement === element),
    "Tab must reach a clip's left trim handle");
  await pressAndSave("ArrowRight", "PUT", "");
  assert.equal(studioSavedStates.at(-1).tracks[0].clips[0].sourceOffsetMs, 500,
    "left trim keys must save the changed source window, not just a visual preview");
  await pressAndSave("ArrowLeft", "PUT", "");
  const keyboardOriginalWidth = await keyboardFirstClip.evaluate((element) => element.style.width);
  await keyboardFirstClip.locator(".trim-right").focus();
  await pressAndSave("ArrowLeft", "PUT", "");
  assert.notEqual(await keyboardFirstClip.evaluate((element) => element.style.width), keyboardOriginalWidth,
    "right trim keys must resize the clip without dragging");
  await pressAndSave("ArrowRight", "PUT", "");
  assert.equal(await keyboardFirstClip.evaluate((element) => element.style.width), keyboardOriginalWidth);
  await keyboardFirstClip.focus();
  await page.locator(".multi-clip-actions").getByRole("button", { name: "Duplicate", exact: true }).focus();
  await pressAndSave("Space");
  assert.equal(await keyboardFirstLane.locator(".clip").count(), 2,
    "Space must activate the focused Duplicate button rather than the global playback shortcut");
  await keyboardFirstClip.focus();
  await page.keyboard.press("End");
  assert(await keyboardFirstLane.locator(".clip").nth(1).evaluate((element) => document.activeElement === element),
    "End must reach the last clip in the lane");
  await page.keyboard.press("Home");
  assert(await keyboardFirstClip.evaluate((element) => document.activeElement === element), "Home must reach the first clip");
  await page.keyboard.press("ArrowRight");
  await pressAndSave("Delete");
  assert.equal(await keyboardFirstLane.locator(".clip").count(), 1);
  assert(await keyboardFirstClip.evaluate((element) => document.activeElement === element),
    "deleting the focused clip must focus the remaining clip rather than the page body");
  await pressAndSave("Delete");
  const emptyKeyboardLane = keyboardFirstLane.locator(".clip-lane");
  assert(await emptyKeyboardLane.evaluate((element) => document.activeElement === element),
    "deleting the last clip must leave focus on its empty lane");
  assert(await emptyKeyboardLane.evaluate((element) => Number.parseFloat(getComputedStyle(element).outlineWidth) >= 3));
  await page.keyboard.press("ArrowDown");
  assert(await keyboardSecondClip.evaluate((element) => document.activeElement === element),
    "keyboard navigation must still work from an empty lane");
  await pressAndSave("Control+z", "PUT", "");
  assert.equal(await keyboardFirstLane.locator(".clip").count(), 1, "keyboard undo restores the deleted clip through the save route");
  assert.equal(await page.locator(".clip").count(), 8, "keyboard edits leave the original arrangement restored for later checks");
  report.push("Studio keyboard users can enter the timeline, select clips, navigate lanes and clips, move by the snap grid, trim and save both edges, duplicate through a focused button, delete with focus recovery including empty lanes, and undo without dragging.");
  const mobileTransport = page.getByRole("region", { name: "Transport controls" });
  const presentationTabs = page.getByRole("tablist", { name: "Waveyard presentation mode" });
  const studioFocusTabs = page.getByRole("tablist", { name: "Studio focus" });
  const assertViewFocus = async (tab) => {
    assert.equal(await tab.getAttribute("aria-selected"), "true", "keyboard switching must activate the focused view");
    assert(await tab.evaluate((element) => document.activeElement === element && element.closest("#studio-editor") !== null),
      "switching a Studio view must keep focus in the editor, not on the page body");
    assert(await tab.evaluate((element) => Number.parseFloat(getComputedStyle(element).outlineWidth) >= 3),
      "the focused view tab must have a visible keyboard indicator");
  };
  await presentationTabs.getByRole("tab", { name: "Studio", exact: true }).focus();
  await page.keyboard.press("ArrowLeft");
  await assertViewFocus(presentationTabs.getByRole("tab", { name: "Play", exact: true }));
  await page.getByTestId("living-player").waitFor();
  const openStudioFromPlay = page.getByTestId("living-player").getByRole("button", { name: "Open Studio", exact: true });
  await openStudioFromPlay.focus();
  await page.keyboard.press("Enter");
  await assertViewFocus(presentationTabs.getByRole("tab", { name: "Studio", exact: true }));
  await keyboardTimeline.waitFor();
  await page.keyboard.press("End");
  await assertViewFocus(presentationTabs.getByRole("tab", { name: "Visual", exact: true }));
  await page.getByTestId("cinematic-visual").waitFor();
  const visualPresetButton = page.getByRole("group", { name: "Visual preset", exact: true })
    .getByRole("button", { name: "Prism", exact: true });
  await visualPresetButton.focus();
  await page.keyboard.press("Space");
  assert.equal(await visualPresetButton.getAttribute("aria-pressed"), "true",
    "the visual view must remain usable through its keyboard-operated preset buttons");
  await page.getByTestId("cinematic-visual").getByRole("button", { name: "Studio", exact: true }).focus();
  await page.keyboard.press("Space");
  await assertViewFocus(presentationTabs.getByRole("tab", { name: "Studio", exact: true }));
  await studioFocusTabs.getByRole("tab", { name: "Edit", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await assertViewFocus(studioFocusTabs.getByRole("tab", { name: "Analyze", exact: true }));
  await page.getByText("Linked library audio. Mix and arrange it here; source analysis stays with the original project.", { exact: true }).waitFor();
  await keyboardTimeline.waitFor();
  await page.keyboard.press("ArrowRight");
  await assertViewFocus(studioFocusTabs.getByRole("tab", { name: "Showcase", exact: true }));
  await page.getByTestId("stem-deck").waitFor();
  await page.keyboard.press("Home");
  await assertViewFocus(studioFocusTabs.getByRole("tab", { name: "Edit", exact: true }));
  await page.getByRole("heading", { name: "Mixer console" }).waitFor();
  await keyboardTimeline.focus();
  await page.keyboard.press("Enter");
  assert(await keyboardFirstClip.evaluate((element) => document.activeElement === element),
    "returning to Edit must leave the timeline usable from the keyboard");
  await page.getByTestId("mini-player").locator(".mini-player-title").focus();
  await page.keyboard.press("Enter");
  await assertViewFocus(presentationTabs.getByRole("tab", { name: "Play", exact: true }));
  await openStudioFromPlay.focus();
  await page.keyboard.press("Space");
  await assertViewFocus(presentationTabs.getByRole("tab", { name: "Studio", exact: true }));
  await page.getByRole("heading", { name: "Mixer console" }).waitFor();
  report.push("Keyboard view switches retain visible focus across Play, Studio, Visual, Edit, Analyze and Showcase; disappearing in-view launch buttons restore focus to the active mode, and preset/timeline controls remain usable.");
  for (const width of [320, 402]) {
    await page.setViewportSize({ width, height: 874 });
    const timelineScroller = page.getByRole("region", { name: "Arrangement timeline" });
    const timelineMetrics = await timelineScroller.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      scrollLeft: element.scrollLeft,
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
    }));
    assert(timelineMetrics.scrollWidth > timelineMetrics.clientWidth,
      `the arrangement timeline must scroll inside its own viewport at ${width}px`);
    assert.equal(timelineMetrics.documentWidth, timelineMetrics.viewportWidth,
      `the loaded Studio arrangement must not cause page-level horizontal overflow at ${width}px`);
    await timelineScroller.evaluate((element) => { element.scrollLeft = 160; });
    assert(await timelineScroller.evaluate((element) => element.scrollLeft > 0),
      `the timeline's internal horizontal scroll must remain usable at ${width}px`);
    await timelineScroller.evaluate((element) => { element.scrollLeft = 0; });

    const playButton = mobileTransport.getByRole("button", { name: "Play", exact: true });
    const previewButton = mobileTransport.getByRole("button", { name: "Preview arrangement", exact: true });
    const seekSlider = mobileTransport.getByLabel("Seek project");
    if (width === 320) {
      const touchClip = page.locator(".clip").first();
      await touchClip.scrollIntoViewIfNeeded();
      const touchSeekBefore = await seekSlider.inputValue();
      const moveHandle = touchClip.getByRole("button", { name: /^Move / });
      await tapCenter(moveHandle);
      assert((await touchClip.getAttribute("class"))?.includes("selected"),
        "a touch tap on the clip's move control must select it without moving it");
      assert.equal(await seekSlider.inputValue(), touchSeekBefore,
        "selecting a clip by touch must not seek the arrangement");

      await timelineScroller.evaluate((element) => { element.scrollLeft = 0; });
      const scrollBeforeTouchSwipe = await timelineScroller.evaluate((element) => element.scrollLeft);
      assert.equal(await timelineScroller.evaluate((element) => getComputedStyle(element).touchAction), "pan-x pan-y",
        "the mobile timeline must leave horizontal touch movement to native scrolling");
      const clipPositionBeforeTouchSwipe = await touchClip.evaluate((element) => element.style.left);
      const swipeBounds = await touchClip.boundingBox();
      assert(swipeBounds, "The clip must be visible for the native-scroll touch test");
      const swipePoint = await touchClip.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const visibleLeft = Math.max(0, bounds.left);
        const visibleRight = Math.min(window.innerWidth, bounds.right);
        return { x: visibleLeft + (visibleRight - visibleLeft) / 2, y: bounds.top + Math.min(20, bounds.height / 2) };
      });
      assert(swipePoint.x >= 0 && swipePoint.x < width,
        "The native-scroll touch must start on the visible portion of the clip");
      const swipeX = swipePoint.x;
      const swipeFraction = (swipeX - swipeBounds.x) / swipeBounds.width;
      const swipeYFraction = (swipePoint.y - swipeBounds.y) / swipeBounds.height;
      await swipeTouch(touchClip, -76, 0, swipeFraction, swipeYFraction);
      await page.waitForFunction(({ before }) => {
        const scroller = document.querySelector(".timeline-scroll");
        return scroller instanceof HTMLElement && scroller.scrollLeft > before;
      }, { before: scrollBeforeTouchSwipe }, { timeout: 3_000 });
      assert.equal(await seekSlider.inputValue(), touchSeekBefore,
        "a native horizontal touch swipe beginning on a clip must not seek the playback position");
      assert(await timelineScroller.evaluate((element, before) => element.scrollLeft > before, scrollBeforeTouchSwipe),
        "a native horizontal touch swipe beginning on a clip must scroll the arrangement");
      assert.equal(await touchClip.evaluate((element) => element.style.left), clipPositionBeforeTouchSwipe,
        "a native horizontal touch swipe must not drag the clip");

      await timelineScroller.evaluate((element) => { element.scrollLeft = 0; });
      const initialClipLeft = await touchClip.evaluate((element) => element.style.left);
      await dragTouch(moveHandle, 88, 0, true);
      assert.equal(await touchClip.evaluate((element) => element.style.left), initialClipLeft,
        "cancelling a touch move must restore the original clip position");
      const touchMoveResponsePromise = page.waitForResponse((response) =>
        new URL(response.url()).pathname === `/api/remixes/${studioRemixId}/clips/batch-edit` &&
        response.request().method() === "POST" &&
        response.request().postDataJSON().operation === "move");
      await dragTouch(moveHandle, 88, 0);
      const touchMoveResponse = await touchMoveResponsePromise;
      assert(touchMoveResponse.ok(), "a completed touch move must save through the clip batch-edit API");
      await page.waitForFunction((left) => document.querySelector(".clip")?.style.left !== left, initialClipLeft);
      const movedClipLeft = await touchClip.evaluate((element) => element.style.left);
      assert.notEqual(movedClipLeft, initialClipLeft,
        "the dedicated touch move control must move a clip and preserve timeline snapping");
      assert.equal(
        studioRemixResponse.tracks[0].clips[0].timelineStartMs,
        Number.parseFloat(movedClipLeft) / 80 * 1000,
        "the touch move must reach the persisted clip batch-edit route, not only the preview",
      );
      assert.equal(studioKeyboardEdits.at(-1).operation, "move",
        "a completed touch move must send the move operation to the API");
      await page.locator(".save-state.saved").waitFor({ timeout: 5_000 });

      const rightTrim = touchClip.locator(".trim-right");
      await rightTrim.scrollIntoViewIfNeeded();
      const initialClipWidth = await touchClip.evaluate((element) => element.style.width);
      await dragTouch(rightTrim, -72, 0, true);
      assert.equal(await touchClip.evaluate((element) => element.style.width), initialClipWidth,
        "cancelling a touch trim must preserve the original clip duration");
      const touchTrimSave = page.waitForResponse((response) =>
        new URL(response.url()).pathname === `/api/remixes/${studioRemixId}` &&
        response.request().method() === "PUT");
      await dragTouch(rightTrim, -72, 0);
      await page.waitForFunction((widthBefore) => document.querySelector(".clip")?.style.width !== widthBefore, initialClipWidth);
      const touchTrimResponse = await touchTrimSave;
      assert(touchTrimResponse.ok(), "a completed touch trim must save through the remix API");
      const touchTrimAttempt = studioSaveAttempts.at(-1);
      assert(touchTrimAttempt, "the touch trim must send an arrangement save");
      const touchTrimSavedClip = touchTrimAttempt.tracks[0].clips[0];
      assert.notEqual(touchTrimSavedClip.durationMs, Number.parseFloat(initialClipWidth) / 80 * 1000,
        "the touch trim request must contain the changed clip duration");
      assert.notEqual(await touchClip.evaluate((element) => element.style.width), initialClipWidth,
        "the enlarged touch trim handle must change a clip's duration");
      await page.locator(".save-state.saved").waitFor({ timeout: 5_000 });
      const touchPersistedClip = studioRemixResponse.tracks[0].clips[0];
      assert.equal(touchPersistedClip.timelineStartMs, Number.parseFloat(movedClipLeft) / 80 * 1000,
        "the successful trim must retain the saved touch move");
      assert.equal(touchPersistedClip.durationMs, touchTrimSavedClip.durationMs,
        "the successful trim response must retain the edited clip duration");
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.getByRole("heading", { name: "Mixer console" }).waitFor({ timeout: 15_000 });
      await page.locator(".timeline-track").nth(7).waitFor({ state: "visible", timeout: 15_000 });
      const reopenedTouchClip = page.locator(".timeline-track").first().locator(".clip").first();
      await page.waitForFunction(({ left, width }) => {
        const clip = document.querySelector(".timeline-track .clip");
        return clip instanceof HTMLElement && clip.style.left === left && clip.style.width === width;
      }, {
        left: `${(touchPersistedClip.timelineStartMs / 1000) * 80}px`,
        width: `${Math.max(18, (touchPersistedClip.durationMs / 1000) * 80)}px`,
      }, { timeout: 5_000 });
      assert.equal(await reopenedTouchClip.evaluate((element) => element.style.left),
        `${(touchPersistedClip.timelineStartMs / 1000) * 80}px`,
        "reopening Studio must restore the touch-moved timeline position");
      assert.equal(await reopenedTouchClip.evaluate((element) => element.style.width),
        `${Math.max(18, (touchPersistedClip.durationMs / 1000) * 80)}px`,
        "reopening Studio must restore the touch-trimmed duration");

      const trimLeft = reopenedTouchClip.locator(".trim-left");
      await trimLeft.scrollIntoViewIfNeeded();
      const failedSaveResponse = page.waitForResponse((response) =>
        new URL(response.url()).pathname === `/api/remixes/${studioRemixId}` &&
        response.request().method() === "PUT");
      failNextStudioRemixPut = true;
      await dragTouch(trimLeft, 48, 0);
      const rejectedTouchSave = await failedSaveResponse;
      assert.equal(rejectedTouchSave.status(), 503, "the failure fixture must reject the touch edit save");
      await page.locator(".save-state.failed").waitFor({ timeout: 5_000 });
      assert.equal(await page.locator(".save-state").innerText(), "Save failed",
        "a rejected touch edit must visibly report that it was not saved");
      const rejectedAttempt = studioSaveAttempts.at(-1).tracks[0].clips[0];
      assert.notDeepEqual(
        [rejectedAttempt.timelineStartMs, rejectedAttempt.sourceOffsetMs, rejectedAttempt.durationMs],
        [touchPersistedClip.timelineStartMs, touchPersistedClip.sourceOffsetMs, touchPersistedClip.durationMs],
        "the failed touch trim must have attempted a distinct unsaved edit",
      );
      assert.deepEqual(
        [studioRemixResponse.tracks[0].clips[0].timelineStartMs, studioRemixResponse.tracks[0].clips[0].sourceOffsetMs, studioRemixResponse.tracks[0].clips[0].durationMs],
        [touchPersistedClip.timelineStartMs, touchPersistedClip.sourceOffsetMs, touchPersistedClip.durationMs],
        "a rejected save must not update the server's last saved arrangement",
      );
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.getByRole("heading", { name: "Mixer console" }).waitFor({ timeout: 15_000 });
      await page.locator(".timeline-track").nth(7).waitFor({ state: "visible", timeout: 15_000 });
      const afterFailureClip = page.locator(".timeline-track").first().locator(".clip").first();
      assert.equal(await afterFailureClip.evaluate((element) => element.style.left),
        `${(touchPersistedClip.timelineStartMs / 1000) * 80}px`,
        "reopening after a failed save must retain the previous saved move, not the failed edit");
      assert.equal(await afterFailureClip.evaluate((element) => element.style.width),
        `${Math.max(18, (touchPersistedClip.durationMs / 1000) * 80)}px`,
        "reopening after a failed save must retain the previous saved trim, not the failed edit");
      report.push("Touch move and trim edits reach the remix APIs and restore after reopening; rejected touch saves are visible and leave the prior saved arrangement intact.");
    }
    await mobileTransport.scrollIntoViewIfNeeded();
    const mobileTargets = await Promise.all([playButton, previewButton, seekSlider].map(async (target) => {
      const bounds = await target.boundingBox();
      assert(bounds, "Playback controls must remain visible on a phone");
      return { left: bounds.x, right: bounds.x + bounds.width, height: bounds.height };
    }));
    for (const [index, target] of mobileTargets.entries()) {
      assert(target.left >= 0 && target.right <= width,
        `Studio transport target ${index} must remain in the ${width}px viewport`);
      assert(target.height >= 44,
        `Studio transport target ${index} must be at least 44px tall at ${width}px`);
    }
    if (width === 320) {
      await tapCenter(seekSlider);
      await page.waitForFunction(() => Number(document.querySelector('[aria-label="Seek project"]')?.value ?? 0) > 0.5);
      await page.evaluate(() => {
        const contexts = [];
        const NativeAudioContext = window.AudioContext;
        Object.defineProperty(window, "__arenaSmokeAudioContexts", { configurable: true, value: contexts });
        window.AudioContext = new Proxy(NativeAudioContext, {
          construct(target, args, newTarget) {
            const audioContext = Reflect.construct(target, args, newTarget);
            contexts.push(audioContext);
            return audioContext;
          },
        });
      });
      await tapCenter(playButton);
      const pauseButton = mobileTransport.getByRole("button", { name: "Pause", exact: true });
      await pauseButton.waitFor({ state: "visible" });
      try {
        await setSimulatedVisibility(page, "hidden");
        await page.evaluate(async () => {
          document.querySelectorAll('audio[aria-label$=" audio"]').forEach((audio) => audio.pause());
          await window.__arenaSmokeAudioContexts[0]?.suspend();
        });
        await setSimulatedVisibility(page, "visible");
        await page.waitForFunction(() =>
          window.__arenaSmokeAudioContexts[0]?.state === "running" &&
          [...document.querySelectorAll('audio[aria-label$=" audio"]')].some((audio) => !audio.paused) &&
          document.querySelector('[aria-label="Pause"]'),
        null, { timeout: 10_000 });
        const stemTimeBefore = await page.locator('audio[aria-label$=" audio"]').first().evaluate((audio) => audio.currentTime);
        await page.waitForFunction((before) =>
          [...document.querySelectorAll('audio[aria-label$=" audio"]')].some((audio) => !audio.paused && audio.currentTime > before + 0.15),
        stemTimeBefore, { timeout: 5_000 });
        report.push("Stem playback recovers after a simulated phone app switch suspends its audio context and pauses media.");
        const foregroundStemTime = await page.locator('audio[aria-label$=" audio"]').first().evaluate((audio) => audio.currentTime);
        await page.evaluate(() => window.__arenaSmokeAudioContexts[0]?.suspend());
        await page.waitForFunction((before) =>
          document.visibilityState === "visible" &&
          window.__arenaSmokeAudioContexts[0]?.state === "running" &&
          [...document.querySelectorAll('audio[aria-label$=" audio"]')].some((audio) => !audio.paused && audio.currentTime > before + 0.15),
        foregroundStemTime, { timeout: 10_000 });
        report.push("Foreground stem playback recovers from an audio-context interruption without losing its playhead.");
      } finally {
        await setSimulatedVisibility(page, "visible");
      }
      await page.evaluate(() => {
        const audio = [...document.querySelectorAll('audio[aria-label$=" audio"]')].find((element) => !element.paused);
        if (!audio) throw new Error("No active stem audio element is available for interruption testing.");
        const originalPlay = audio.play.bind(audio);
        let rejectPlay = true;
        audio.play = () => {
          if (rejectPlay) {
            rejectPlay = false;
            return Promise.reject(new DOMException("play blocked", "NotAllowedError"));
          }
          return originalPlay();
        };
        return window.__arenaSmokeAudioContexts[0]?.suspend();
      });
      await mobileTransport.getByRole("alert").filter({ hasText: "Tap Play stems to resume" }).waitFor({ timeout: 5_000 });
      assert.equal(await page.evaluate(() => document.visibilityState), "visible",
        "a blocked foreground audio-context recovery must not depend on a visibility transition");
      await playButton.waitFor({ state: "visible" });
      assert.equal(await page.locator('audio[aria-label$=" audio"]').evaluateAll((audios) => audios.filter((audio) => !audio.paused).length), 0,
        "a denied media restart must stop every stem instead of leaving partial silent playback");
      await tapCenter(playButton);
      await pauseButton.waitFor({ state: "visible", timeout: 5_000 });
      report.push("A browser-blocked stem restart shows an actionable Play stems state and succeeds after a user tap.");
      await tapCenter(pauseButton);
      await playButton.waitFor({ state: "visible" });
      const pausedStemTimes = await page.locator('audio[aria-label$=" audio"]').evaluateAll((audios) => audios.map((audio) => audio.currentTime));
      await setSimulatedVisibility(page, "hidden");
      await setSimulatedVisibility(page, "visible");
      await page.waitForTimeout(250);
      assert.equal(await mobileTransport.getByRole("button", { name: "Play", exact: true }).count(), 1,
        "returning to Studio must not restart stems that the listener paused");
      assert.equal(
        await page.locator('audio[aria-label$=" audio"]').evaluateAll((audios) => audios.filter((audio) => !audio.paused).length),
        0,
        "manually paused stem media must remain paused after returning to Studio");
      const pausedStemTimesAfter = await page.locator('audio[aria-label$=" audio"]').evaluateAll((audios) => audios.map((audio) => audio.currentTime));
      assert.deepEqual(pausedStemTimesAfter, pausedStemTimes,
        "manual stem pause must preserve its playhead through a background transition");
      await tapCenter(previewButton);
      const pauseArrangement = mobileTransport.getByRole("button", { name: "Pause arrangement", exact: true });
      await pauseArrangement.waitFor({ state: "visible", timeout: 15_000 });
      const positionBeforeArrangementInterruption = Number(await seekSlider.inputValue());
      await setSimulatedVisibility(page, "hidden");
      await page.evaluate(() => window.__arenaSmokeAudioContexts[1]?.suspend());
      await setSimulatedVisibility(page, "visible");
      await page.waitForFunction(() =>
        window.__arenaSmokeAudioContexts[1]?.state === "running" &&
        document.querySelector('[aria-label="Pause arrangement"]'),
      null, { timeout: 10_000 });
      await page.waitForFunction((before) =>
        Number(document.querySelector('[aria-label="Seek project"]')?.value ?? 0) > before + 0.1,
      positionBeforeArrangementInterruption, { timeout: 5_000 });
      report.push("Arrangement preview resumes at its playhead after a suspended audio context is restored.");
      const foregroundArrangementPosition = Number(await seekSlider.inputValue());
      await page.evaluate(() => window.__arenaSmokeAudioContexts[1]?.suspend());
      await page.waitForFunction((before) =>
        document.visibilityState === "visible" &&
        window.__arenaSmokeAudioContexts[1]?.state === "running" &&
        Number(document.querySelector('[aria-label="Seek project"]')?.value ?? 0) > before + 0.1,
      foregroundArrangementPosition, { timeout: 10_000 });
      report.push("Foreground arrangement preview recovers from an audio-context interruption and continues at its playhead.");
      await pauseArrangement.evaluate(async () => {
        const audioContext = window.__arenaSmokeAudioContexts[1];
        const originalResume = audioContext.resume.bind(audioContext);
        let rejectResume = true;
        audioContext.resume = () => {
          if (rejectResume) {
            rejectResume = false;
            return Promise.reject(new DOMException("resume blocked", "NotAllowedError"));
          }
          return originalResume();
        };
        await audioContext.suspend();
      });
      await mobileTransport.getByRole("alert").filter({ hasText: "Tap Preview arrangement to try again" }).waitFor({ timeout: 5_000 });
      assert.equal(await page.evaluate(() => document.visibilityState), "visible",
        "a blocked foreground arrangement recovery must not depend on a visibility transition");
      await previewButton.waitFor({ state: "visible" });
      assert.equal(await pauseArrangement.count(), 0,
        "blocked arrangement recovery must not leave a playing indicator for silent audio");
      await tapCenter(previewButton);
      await pauseArrangement.waitFor({ state: "visible", timeout: 10_000 });
      await tapCenter(pauseArrangement);
      await previewButton.waitFor({ state: "visible" });
      await setSimulatedVisibility(page, "hidden");
      await setSimulatedVisibility(page, "visible");
      await page.waitForTimeout(250);
      assert.equal(await pauseArrangement.count(), 0,
        "returning to Studio must not restart an arrangement the listener paused");
    }
  }
  await page.setViewportSize({ width: 320, height: 874 });
  await page.getByRole("tab", { name: "Analyze", exact: true }).click();
  await mobileTransport.scrollIntoViewIfNeeded();
  assert.equal(await mobileTransport.isVisible(), true,
    "the loaded Studio transport must remain reachable in Analyze at phone width");
  assert.equal(await mobileTransport.getByRole("button", { name: "Preview arrangement", exact: true }).isVisible(), true,
    "arrangement preview must remain reachable after switching Studio tabs on a phone");
  if (touchSession) {
    await touchSession.send("Emulation.setTouchEmulationEnabled", { enabled: false });
    await touchSession.detach();
    touchSession = null;
  }
  await page.setViewportSize(desktopViewport);
  report.push("In Chromium touch emulation at phone widths, touch selects clips without seeking, native horizontal swipes scroll without dragging clips, dedicated controls move and trim clips, and cancelled move/trim gestures restore the arrangement.");
  report.push("At 320px and 402px, the arrangement scrolls internally with no page overflow; touch-sized play, seek, and arrangement preview controls respond to taps.");
  report.push("A session handoff opens a linked, audio-backed Studio arrangement; clips, isolated mix, two distinct donor swaps, and supported crossfades survive reload.");
  report.push("A slow live stem switch can be cancelled without rewinding playback; later swaps, isolation, Camelot cueing, portrait keyboard-safe donor search, and landscape mobile controls pass.");

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
  const localHubModelId = "turboagent-smoke-qwen";
  const unavailableModelHubId = "modelhub-smoke-qwen";
  await page.route("**/api/models", async route => {
    const response = await route.fetch();
    const payload = await response.json();
    const models = Array.isArray(payload.models) ? payload.models : [];
    if (!models.some(model => model.id === localHubModelId)) {
      models.push({
        id: localHubModelId,
        name: "qwen2.5:3b (TurboAgent)",
        provider: "local · smoke fixture",
        backend: "turboagent",
        kind: "text",
        requiresKey: false,
        requiresNetwork: false,
      });
    }
    if (!models.some(model => model.id === unavailableModelHubId)) {
      models.push({
        id: unavailableModelHubId,
        name: "qwen2.5:3b (ollama)",
        provider: "local · offline smoke fixture",
        backend: "local-server",
        pollinationsId: "__server__:http%3A%2F%2F127.0.0.1%3A11434:qwen2.5%3A3b",
        kind: "text",
        requiresKey: false,
        requiresNetwork: false,
      });
    }
    await route.fulfill({ response, body: JSON.stringify({ ...payload, models }) });
  });
  await page.route("**/api/model-hub", async route => {
    if (route.request().method() === "POST") {
      const request = route.request().postDataJSON();
      if (request.action === "scan") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            probe: {
              kind: "ollama",
              baseUrl: request.baseUrl,
              online: false,
              models: [],
              detail: "No local runtime answered.",
            },
          }),
        });
        return;
      }
      return route.fallback();
    }
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        connections: [{
          id: "smoke-runtime",
          kind: "ollama",
          baseUrl: "http://127.0.0.1:11434",
          label: "Smoke Ollama",
          online: true,
          models: ["qwen2.5:3b"],
          detail: "Connected",
        }],
        discovered: [],
        catalog: [],
        registered: [{
          id: localHubModelId,
          name: "qwen2.5:3b (TurboAgent)",
          provider: "local · smoke fixture",
          description: "Smoke-test local model",
          kind: "text",
        }],
        agentBridge: { connected: false, name: null, lastPolledAt: null },
      }),
    });
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
  await page.goto(`${base}/spaces`, { waitUntil: "networkidle" });
  const spacesTaskModel = createdSpaceCard.getByLabel("Task model");
  await spacesTaskModel.waitFor();
  const spacesTaskModelOptions = await spacesTaskModel.locator("option").allTextContents();
  assert(
    spacesTaskModelOptions.some(option => /qwen2\.5:3b \(TurboAgent\).*local runtime/.test(option)),
    "Spaces must identify TurboAgent as a local runtime in its task model selector",
  );
  assert.match(
    await createdSpaceCard.getByText(/It runs on the Arena host/).innerText(),
    /your PC in the installed app, Replit in a hosted preview/,
  );
  report.push("Spaces labels every supported local model as a local runtime and clarifies which host runs it.");
  await page.goto(`${base}/model-hub`, { waitUntil: "networkidle" });
  await page.getByRole("link", { name: "Test qwen2.5:3b (TurboAgent) in Arcade" }).click();
  await page.getByTestId("model-test-handoff").waitFor();
  assert.equal(await page.getByTestId("arcade-model-setup").getAttribute("open"), "");
  assert.equal(await page.getByLabel("Connected model source").inputValue(), localHubModelId);
  assert.equal(await page.getByTestId("button-local-server-generation-check").isEnabled(), true);
  assert.equal(await page.evaluate(() => new URLSearchParams(window.location.search).has("testModel")), false);
  report.push("Model Hub's per-model test link opens Arcade with the local model selected and its real generation test ready, without auto-running or saving a game.");
  await page.goto(`${base}/arcade`, { waitUntil: "networkidle" });
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
  await page.getByTestId("game-controls").getByText("No control instructions are available for this game.").waitFor();
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
  await page.getByTestId("game-controls").getByText("← → / A-D — run · Space / W / ▲ — jump").waitFor();
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
  const modelPreflight = page.getByTestId("arcade-model-preflight");
  await modelPreflight.waitFor();
  const preflightText = await modelPreflight.innerText();
  assert.match(
    preflightText,
    /Checking whether this browser|No custom-game model route is ready|WebGPU is available|Ready: browser model|Route target: (local|remote)|provider connection is saved/,
    "Arcade should state the current model route before custom generation",
  );
  if (preflightText.includes("No custom-game model route is ready")) {
    assert(
      await page.getByRole("button", { name: "🎮 Create & play" }).isDisabled(),
      "Custom prompts must not be submitted when WebGPU is unavailable and no provider or local model is selected",
    );
    assert(await page.getByRole("link", { name: "Open Model Hub" }).isVisible(), "the blocked preflight must link directly to Model Hub");
    await page.getByTestId("arcade-open-model-setup").click();
    assert.equal(await page.getByTestId("arcade-model-setup").getAttribute("open"), "");
  }
  await page.getByLabel("Connected model source").selectOption(unavailableModelHubId);
  await page.getByTestId("arcade-model-preflight").getByText(/Selected local model is not ready/).waitFor();
  assert(
    await page.getByRole("button", { name: "🎮 Create & play" }).isDisabled(),
    "Arcade must block a custom prompt when the selected Model Hub runtime is offline",
  );
  assert(await page.getByRole("link", { name: "Open Model Hub" }).isVisible(), "offline Model Hub preflight must offer a direct recovery action");
  report.push("An offline selected Model Hub runtime is detected before prompt submission and links directly to runtime setup.");
  report.push("Arcade shows the selected model route or the missing WebGPU/provider/Model Hub requirement before custom prompts; blocked generation links to setup.");
  await page.getByLabel("Connected model source").selectOption("openai");
  let promptGenerationSeen = false;
  let localServerGenerationSeen = false;
  let localServerRevisionSeen = false;
  let localModelProofSeen = false;
  let expectedModelId = "openai";
  let expectedLocalOnly = false;
  let failNextGeneration = false;
  let failNextRuntimeCheck = false;
  let holdNextGeneration = false;
  let heldGenerationHasSource = false;
  let generationStartedResolve = null;
  let releaseHeldGeneration = null;
  const generatedPong = '<!doctype html><html><head><title>Generated Pong</title><meta name="arena-controls" content="ArrowRight — move the paddle"></head><body><p id="generated-pong">AI Pong</p><canvas width="320" height="180"></canvas><script>let x=0;const c=document.querySelector("canvas"),ctx=c.getContext("2d");addEventListener("keydown",e=>{if(e.key==="ArrowRight")x++});function loop(){ctx.fillStyle="#111";ctx.fillRect(0,0,320,180);ctx.fillStyle="#fff";ctx.fillRect(x,20,8,30);requestAnimationFrame(loop)}loop();</script></body></html>';
  const passedStartupVerification = {
    status: "passed",
    scope: "startup-render-only",
    issues: [],
    canvas: { width: 320, height: 180 },
    animationFrames: 12,
    blockedRequests: 0,
  };
  const brokenDraftCode = generatedPong.replace("AI Pong", "draft-preserved-marker");
  const localProofGame = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Square and Coin</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #101827; color: #fff; font: 16px system-ui, sans-serif; }
    main { width: min(94vw, 560px); padding: 20px; text-align: center; }
    h1 { margin: 0 0 8px; color: #c8dcff; }
    #score { display: inline-block; min-width: 120px; padding: 8px 14px; border: 1px solid #5274a8; border-radius: 20px; font-weight: 700; }
    canvas { display: block; width: 100%; margin: 12px auto; border: 2px solid #5274a8; border-radius: 10px; background: #18263b; }
    .help { color: #aebbd0; }
  </style>
</head>
<body>
  <main>
    <h1>Square and Coin</h1>
    <p id="score" aria-live="polite">Score: 0</p>
    <p class="help">Move the blue square with the arrow keys. Collect the gold coin.</p>
    <canvas id="game" width="480" height="320" aria-label="Square and coin game"></canvas>
  </main>
  <script>
    (() => {
      "use strict";
      const canvas = document.getElementById("game");
      const context = canvas.getContext("2d");
      const scoreLabel = document.getElementById("score");
      const player = { x: 32, y: 32, size: 24, speed: 3.4 };
      const coin = { x: 300, y: 180, radius: 11 };
      const held = new Set();
      let score = 0;
      let previousTime = 0;

      function onKeyDown(event) {
        if (event.key.startsWith("Arrow")) {
          event.preventDefault();
          held.add(event.key);
        }
      }
      function onKeyUp(event) {
        held.delete(event.key);
      }
      function placeCoin() {
        coin.x = 24 + Math.random() * (canvas.width - 48);
        coin.y = 24 + Math.random() * (canvas.height - 48);
      }
      function update(delta) {
        if (held.has("ArrowLeft")) player.x -= player.speed * delta;
        if (held.has("ArrowRight")) player.x += player.speed * delta;
        if (held.has("ArrowUp")) player.y -= player.speed * delta;
        if (held.has("ArrowDown")) player.y += player.speed * delta;
        player.x = Math.max(0, Math.min(canvas.width - player.size, player.x));
        player.y = Math.max(0, Math.min(canvas.height - player.size, player.y));
        const closeX = Math.abs(player.x + player.size / 2 - coin.x) < player.size / 2 + coin.radius;
        const closeY = Math.abs(player.y + player.size / 2 - coin.y) < player.size / 2 + coin.radius;
        if (closeX && closeY) {
          score += 1;
          scoreLabel.textContent = "Score: " + score;
          placeCoin();
        }
      }
      function draw() {
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = "#18263b";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = "#ffd451";
        context.beginPath();
        context.arc(coin.x, coin.y, coin.radius, 0, Math.PI * 2);
        context.fill();
        context.fillStyle = "#4aa8ff";
        context.fillRect(player.x, player.y, player.size, player.size);
      }
      function frame(time) {
        const delta = Math.min(2, (time - previousTime) / 16.67 || 1);
        previousTime = time;
        update(delta);
        draw();
        requestAnimationFrame(frame);
      }
      window.addEventListener("keydown", onKeyDown);
      window.addEventListener("keyup", onKeyUp);
      requestAnimationFrame(frame);
    })();
  </script>
</body>
</html>`;
  const revisedGeneratedPong = generatedPong.replace("AI Pong", "AI Pong with multi-ball");
  const revisedOfflinePlatformer = '<!doctype html><html><head><title>Revised local platformer</title></head><body><p id="offline-revision-marker">Double jump added</p><canvas width="320" height="180"></canvas><script>let jumps=2;addEventListener("keydown",e=>{if(e.key===" ")jumps--});requestAnimationFrame(function loop(){requestAnimationFrame(loop)});</script></body></html>';
  await page.route("**/api/arcade/forge", async route => {
    const body = route.request().postDataJSON();
    assert.equal(body.modelId, expectedModelId, "the selected model source must reach the game-generation route");
    assert.equal(Boolean(body.localOnly), expectedLocalOnly, "the generation route must preserve Local Mode");
    if (expectedLocalOnly) assert.equal(body.keys, undefined, "Local Mode must not send provider keys");
    if (body.prompt.includes("local model test")) {
      assert.equal(body.ephemeral, true, "The local model proof must not save a shared game");
      assert.equal(body.priorCode, undefined, "The local model proof must not reuse another game's source");
      localModelProofSeen = true;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          code: localProofGame,
          title: "Temporary local model proof",
          runtimeVerification: passedStartupVerification,
          runtime: {
            ms: 12,
            backend: "turboagent",
            modelId: expectedModelId,
            via: "turboagent:qwen2.5:3b",
            fallback: false,
          },
        }),
      });
      return;
    }
    if (failNextRuntimeCheck) {
      failNextRuntimeCheck = false;
      await route.fulfill({
        status: 422,
        contentType: "application/json",
        body: JSON.stringify({
          error: "The game did not pass its isolated startup check. The game was not published.",
          draft: {
            code: brokenDraftCode,
            title: "Broken Pong Draft",
            gameType: "pong",
            runtimeVerification: {
              status: "failed",
              scope: "startup-render-only",
              issues: ["The game did not start its animation loop."],
            },
          },
        }),
      });
      return;
    }
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
          body: JSON.stringify({ code: generatedPong, title: "Late game", runtimeVerification: passedStartupVerification, runtime: { ms: 12 } }),
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
        runtimeVerification: passedStartupVerification,
        runtime: {
          ms: 12,
          backend: expectedLocalOnly ? "turboagent" : "openai",
          modelId: expectedModelId,
          via: expectedLocalOnly ? "turboagent:qwen2.5:3b" : "openai:smoke-test",
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
  await page.getByTestId("game-controls").getByText("ArrowRight — move the paddle").waitFor();
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
  assert(
    await page.getByTestId("button-local-server-generation-check").isEnabled(),
    "the local-model proof button must recognize TurboAgent models",
  );
  await page.getByTestId("button-local-server-generation-check").click();
  await page.getByTestId("local-generation-result").getByText(/Passed: The selected local model generated a valid game/).waitFor({ timeout: 10000 });
  assert(localModelProofSeen, "The local-model proof button must make an ephemeral request through the selected model");
  await page.getByLabel("Game prompt").fill("Pong with a rotating gate");
  await page.getByRole("button", { name: "🎮 Create & play" }).click();
  await page.getByText("Local model Pong passed the isolated startup check").waitFor({ timeout: 10000 });
  assert.match(
    await page.getByTestId("game-runtime-provenance").innerText(),
    /Local TurboAgent.*qwen2\.5:3b/,
    "Arcade should identify the local TurboAgent model that generated the game",
  );
  assert(localServerGenerationSeen, "Local Mode must route new games to the selected local Model Hub model without WebGPU");
  await page.getByLabel("Game change").fill("Add a multi-ball mode");
  await page.getByRole("button", { name: "Apply change" }).click();
  await page.getByText(/Revised Pong passed the isolated startup check/).waitFor({ timeout: 10000 });
  assert(localServerRevisionSeen, "Local Mode edits must route the existing source to the selected local model");
  report.push("Local Mode routed new-game and source-revision requests to the selected local TurboAgent model with no provider keys (mocked inference endpoint).");
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
  failNextRuntimeCheck = true;
  await page.getByLabel("Game prompt").fill("A game with a startup error");
  await page.getByRole("button", { name: "🎮 Create & play" }).click();
  await page.getByText(/Unverified draft saved as “Broken Pong Draft”; your current game was left unchanged/).waitFor({ timeout: 10000 });
  await page.locator('iframe[title="Add a multi-ball mode"]').waitFor({ timeout: 10000 });
  assert.equal(await page.getByText(/draft · unverified/).count(), 1, "a failed runtime check must be visible as an unverified local draft");
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Open offline game Broken Pong Draft" }).click();
  await page.getByRole("button", { name: /Code/ }).click();
  await page.getByText(/draft-preserved-marker/).waitFor({ timeout: 10000 });
  report.push("A runtime-rejected game is retained as an unverified local draft, while the previously playable game remains untouched.");
  let reaAnalysisRequests = 0;
  let importedExternalRequestCount = 0;
  const importedPopupUrls = [];
  page.on("request", request => {
    if (request.url().includes("/api/arcade/import/analyze")) reaAnalysisRequests += 1;
    if (request.url().includes("example.invalid")) importedExternalRequestCount += 1;
  });
  page.on("popup", popup => importedPopupUrls.push(popup.url()));
  await page.getByRole("tab", { name: "Import and emulate" }).click();
  await page.getByLabel(/I own this game or have permission to use and play it/).check();
  // Construct navigation APIs dynamically so this exercises the runtime sandbox,
  // not only the import-time source filter.
  const browserGame = `<!doctype html><html><head><title>Open homebrew fixture</title></head><body><p id="hud">Score 0</p><canvas id="game" width="240" height="160"></canvas><script>try{window["to"+"p"]["loc"+"ation"]["assign"]("https://example.invalid/host-escape")}catch(e){};try{window["op"+"en"]("https://example.invalid/popup")}catch(e){};document.body.dataset.navigationAttempted="true";const c=document.getElementById("game"),x=c.getContext("2d");let n=0,score=Number(localStorage.getItem("fixture-score")||0);document.getElementById("hud").textContent="Score "+score;addEventListener("keydown",e=>{if(e.key==="ArrowRight"){score++;localStorage.setItem("fixture-score",String(score));document.getElementById("hud").textContent="Score "+score}});function step(){x.fillStyle=n++%2?"#13b981":"#121826";x.fillRect(0,0,c.width,c.height);requestAnimationFrame(step)}step();</script></body></html>`;
  const hostUrlBeforeNavigationAttempt = page.url();
  await page.locator('input[accept=".html,.htm,.zip,text/html,application/zip"]').setInputFiles({
    name: "open-homebrew-fixture.html",
    mimeType: "text/html",
    buffer: Buffer.from(browserGame),
  });
  const browserFrame = page.frameLocator('iframe[title="Playable game: open-homebrew-fixture.html"]');
  await browserFrame.locator("#game").waitFor({ timeout: 10000 });
  await browserFrame.locator('body[data-navigation-attempted="true"]').waitFor();
  await page.waitForTimeout(200);
  assert.equal(page.url(), hostUrlBeforeNavigationAttempt, "An imported game's parent-navigation attempt must not navigate the host page");
  assert.deepEqual(importedPopupUrls, [], "An imported game must not open an external popup");
  assert.equal(importedExternalRequestCount, 0, "An imported game must not contact an external site");
  assert.equal(await browserFrame.locator("#game").count(), 1, "A blocked navigation attempt must leave the imported game running");
  report.push("Imported browser-game parent navigation and external popup attempts stay inside the sandbox without contacting external sites.");
  const reaAuthorization = page.getByTestId("checkbox-rea-authorized");
  const reaAnalyzeButton = page.getByTestId("button-rea-analyze");
  await reaAnalyzeButton.waitFor();
  assert(await reaAnalyzeButton.isDisabled(), "REA analysis must require explicit authorization");
  await reaAuthorization.check();
  assert(!(await reaAnalyzeButton.isDisabled()), "REA analysis should be enabled after authorization");
  assert.equal(reaAnalysisRequests, 0, "Importing a game or accepting the checkbox must not send source to REA");
  assert.equal(await page.getByTestId("rea-analysis-report").count(), 0, "REA should not produce a report before the user explicitly runs it");
  report.push("REA static analysis is optional, requires explicit authorization, and does not run during import.");
  await browserFrame.locator("#game").evaluate(element =>
    element.ownerDocument.defaultView?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })),
  );
  await browserFrame.getByText("Score 1", { exact: true }).waitFor({ timeout: 5_000 });
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
  const revisedGameHtml = `<!doctype html><html><head><title>Revised fixture</title></head><body><p id="hud">Score 0</p><canvas id="patched" width="240" height="160"></canvas><script>const c=document.getElementById("patched"),x=c.getContext("2d"),hud=document.getElementById("hud");let score=Number(localStorage.getItem("fixture-score")||0);hud.textContent="Score "+score;addEventListener("keydown",e=>{if(e.key==="ArrowRight"){score+=2;localStorage.setItem("fixture-score",String(score));hud.textContent="Score "+score}});function loop(){x.fillStyle="#13b981";x.fillRect(0,0,c.width,c.height);requestAnimationFrame(loop)}loop();addEventListener("touchstart",()=>{});</script><!-- ${"original test-only game code ".repeat(60)} --></body></html>`;
  const revisedArchiveHtml = '<!doctype html><html><head><title>Revised offline project</title><style>#tile{width:48px;height:48px;background-image:url("data:ARENA_ASSET_TOKEN_0001");background-size:cover}</style></head><body><p id="hud">Score 0</p><div id="tile"></div><img id="dynamic-sprite" src="data:ARENA_ASSET_TOKEN_0004"><audio id="sfx" src="data:ARENA_ASSET_TOKEN_0002"></audio><button id="play-sfx">Play sound</button><button id="play-dynamic-sfx">Play dynamic sound</button><script>let score=Number(localStorage.getItem("zip-score")||0);const hud=document.getElementById("hud");hud.textContent="Score "+score;addEventListener("keydown",e=>{if(e.key==="ArrowRight"){score+=2;localStorage.setItem("zip-score",String(score));hud.textContent="Score "+score}});const dynamicSfx=new Audio("data:ARENA_ASSET_TOKEN_0003");dynamicSfx.id="dynamic-sfx";document.body.appendChild(dynamicSfx);document.getElementById("play-sfx").addEventListener("click",()=>{void document.getElementById("sfx").play()});document.getElementById("play-dynamic-sfx").addEventListener("click",()=>{void dynamicSfx.play()});</script></body></html>';
  const readImportedFixture = async () => page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("arenaforge-imported-games");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const records = await new Promise((resolve, reject) => {
      const request = database.transaction("games", "readonly").objectStore("games").getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    return records.find(record => record.name === "open-homebrew-fixture.html");
  });
  const importedFixtureBeforeRevision = await readImportedFixture();
  assert(importedFixtureBeforeRevision?.id, "The test game must already have a saved identity");
  const importedSaveKey = `arenaforge.game-save.v1:${importedFixtureBeforeRevision.id}`;
  const importedSaveBeforeRevision = await page.evaluate(key => localStorage.getItem(key), importedSaveKey);
  assert(importedSaveBeforeRevision, "The test game progress must be saved before revisions");
  assert.equal(JSON.parse(importedSaveBeforeRevision)["fixture-score"], "1", "The save must contain the starting game progress");
  let revisionRequestSeen = false;
  let cancelRevisionStarted = false;
  let releaseCancelRevisionRoute;
  let archiveAudioBase64 = "";
  await page.route("**/api/arcade/import/revise", async route => {
    const body = route.request().postDataJSON();
    assert.equal(body.ephemeral, true, "Imported source revisions must not be saved to the shared game catalog");
    assert.equal(body.modelId, expectedModelId, "Imported-source revisions must use the selected model source");
    assert.equal(Boolean(body.localOnly), expectedLocalOnly, "Imported-source revisions must preserve Local Mode");
    if (expectedLocalOnly) assert.equal(body.keys, undefined, "Local Mode must not send provider keys for imported source");
    if (body.prompt === "Cancel this revision") {
      cancelRevisionStarted = true;
      await new Promise(resolve => { releaseCancelRevisionRoute = resolve; });
      try { await route.abort("aborted"); } catch {}
      return;
    }
    revisionRequestSeen = true;
    if (body.prompt === "Add a pause overlay") {
      assert(body.priorCode.includes("Open homebrew fixture"), "Imported source must be included in the revision request");
    } else if (body.prompt === "Reject unsafe revision") {
      assert(body.priorCode.includes("Open homebrew fixture"), "Rejected revisions must use the current imported source");
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
      body: JSON.stringify({
        code: body.prompt === "Make movement faster"
          ? revisedArchiveHtml
          : body.prompt === "Reject unsafe revision"
            ? '<!doctype html><html><head><script src="https://example.invalid/game.js"></script></head><body></body></html>'
            : revisedGameHtml,
      }),
    });
  });
  const cancelRequest = page.waitForRequest(request =>
    request.url().includes("/api/arcade/import/revise") &&
    request.postDataJSON()?.prompt === "Cancel this revision",
  );
  const cancelledRequestFailure = page.waitForEvent("requestfailed", request =>
    request.url().includes("/api/arcade/import/revise") &&
    request.postDataJSON()?.prompt === "Cancel this revision",
  );
  await page.getByLabel("Revise this browser game").fill("Cancel this revision");
  await page.getByRole("button", { name: "Apply revision" }).click();
  await cancelRequest;
  assert(cancelRevisionStarted, "The cancel revision request did not reach the selected model route");
  await page.getByTestId("button-cancel-imported-revision").click();
  releaseCancelRevisionRoute?.();
  const failedRevisionRequest = await cancelledRequestFailure;
  assert(failedRevisionRequest.failure()?.errorText, "Stopping an imported-game revision must abort its in-flight request");
  await page.getByText("Revision cancelled. The imported game and its progress are unchanged.").waitFor();
  assert.equal(await browserFrame.locator("#patched").count(), 0, "A cancelled revision must leave the imported source untouched");
  assert.equal(await page.getByTestId("imported-revision-undo").count(), 0, "A cancelled revision must not create an undo entry");
  const importedFixtureAfterCancellation = await readImportedFixture();
  assert.equal(importedFixtureAfterCancellation?.source, importedFixtureBeforeRevision.source, "A cancelled revision must leave imported source unchanged");
  assert.equal(
    await page.evaluate(key => localStorage.getItem(key), importedSaveKey),
    importedSaveBeforeRevision,
    "A cancelled revision must leave the exact saved progress unchanged",
  );
  await page.getByLabel("Revise this browser game").fill("Reject unsafe revision");
  await page.getByRole("button", { name: "Apply revision" }).click();
  await page.getByText(/Revision failed:.*external resource/).waitFor({ timeout: 10000 });
  assert.equal(await page.getByTestId("imported-revision-undo").count(), 0, "A safety-rejected revision must not create an undo entry");
  assert.equal(await page.frameLocator('iframe[title="Playable game: open-homebrew-fixture.html"]').locator("#game").count(), 1);
  const importedFixtureAfterRejection = await readImportedFixture();
  assert.equal(importedFixtureAfterRejection?.source, importedFixtureBeforeRevision.source, "A rejected revision must leave imported source unchanged");
  assert.equal(
    await page.evaluate(key => localStorage.getItem(key), importedSaveKey),
    importedSaveBeforeRevision,
    "A rejected revision must leave the exact saved progress unchanged",
  );
  await page.getByLabel("Revise this browser game").fill("Add a pause overlay");
  await page.getByRole("button", { name: "Apply revision" }).click();
  await page.getByText("Revision applied. Play it, then keep it or undo it.").waitFor({ timeout: 10000 });
  assert(revisionRequestSeen, "Prompt revision did not use the selected model route");
  const revisedFixtureFrame = page.frameLocator('iframe[title="Playable game: open-homebrew-fixture.html"]');
  await revisedFixtureFrame.locator("#patched").waitFor();
  assert.equal(await revisedFixtureFrame.locator("#hud").innerText(), "Score 1", "A successful prompt revision must load the existing saved progress");
  assert.equal(
    await page.evaluate(key => localStorage.getItem(key), importedSaveKey),
    importedSaveBeforeRevision,
    "A successful revision must preserve the exact save until gameplay changes it",
  );
  assert.equal(await page.getByTestId("button-keep-imported-revision").isEnabled(), true);
  assert.equal(await page.getByTestId("button-undo-imported-revision").isEnabled(), true);
  assert.equal(await page.getByRole("button", { name: "Apply revision" }).isDisabled(), true, "A pending undo must not be overwritten by another revision");
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("tab", { name: "Import and emulate" }).click();
  await page.getByTestId("imported-revision-undo").waitFor({ timeout: 10000 });
  assert.equal(await page.getByRole("button", { name: "Apply revision" }).isDisabled(), true, "A pending undo must remain available after a browser reload");
  const revisedFixtureAfterReload = page.frameLocator('iframe[title="Playable game: open-homebrew-fixture.html"]');
  await revisedFixtureAfterReload.locator("#patched").waitFor();
  assert.equal(await revisedFixtureAfterReload.locator("#hud").innerText(), "Score 1", "Saved progress must remain available in the revised game after reload");
  assert.equal(
    await page.evaluate(key => localStorage.getItem(key), importedSaveKey),
    importedSaveBeforeRevision,
    "A browser reload after revision must retain the exact saved progress",
  );
  await page.getByTestId("button-undo-imported-revision").click();
  const restoredImportedFixture = page.frameLocator('iframe[title="Playable game: open-homebrew-fixture.html"]');
  await restoredImportedFixture.locator("#game").waitFor();
  assert.equal(await restoredImportedFixture.locator("#hud").innerText(), "Score 1", "Undo must restore the earlier source with its existing browser progress");
  assert.equal(await page.getByTestId("imported-revision-undo").count(), 0, "Undo must clear the pending revision entry");
  const importedFixtureAfterUndo = await readImportedFixture();
  assert.equal(importedFixtureAfterUndo?.id, importedFixtureBeforeRevision.id, "Undo must preserve the imported game's identity");
  assert.equal(importedFixtureAfterUndo?.source, importedFixtureBeforeRevision.source, "Undo must restore the exact earlier source");
  await page.getByLabel("Revise this browser game").fill("Add a pause overlay");
  await page.getByRole("button", { name: "Apply revision" }).click();
  await page.getByTestId("imported-revision-undo").waitFor({ timeout: 10000 });
  await page.getByTestId("button-keep-imported-revision").click();
  await page.getByTestId("imported-revision-undo").waitFor({ state: "detached" });
  await page.getByLabel("Revise this browser game").fill("Add a pause overlay");
  assert.equal(await page.getByRole("button", { name: "Apply revision" }).isDisabled(), false, "Accepting a revision must allow the next revision");
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
  const assertAudioStarts = async (audioElement, playButton) => {
    // A 200 ms fixture can finish before Playwright returns from click().
    // Arm evidence before the trusted gesture instead of missing its event.
    await audioElement.evaluate(audio => {
      audio.dataset.smokePlaybackStarted = "false";
      audio.addEventListener("playing", () => { audio.dataset.smokePlaybackStarted = "true"; }, { once: true });
    });
    await playButton.click();
    const started = await audioElement.evaluate(audio => new Promise(resolve => {
      if (audio.dataset.smokePlaybackStarted === "true" || (!audio.paused && audio.readyState >= 2)) return resolve(true);
      const timer = setTimeout(() => resolve(false), 3000);
      audio.addEventListener("playing", () => {
        clearTimeout(timer);
        resolve(true);
      }, { once: true });
    }));
    assert.equal(started, true, `The imported local audio must actually play in the restricted iframe${
      started ? "" : `: ${JSON.stringify(await audioElement.evaluate(audio => ({
        paused: audio.paused, ended: audio.ended, readyState: audio.readyState,
        currentTime: audio.currentTime, error: audio.error?.message ?? null,
      })))}`
    }`);
    await audioElement.evaluate(audio => audio.pause());
  };
  await assertAudioStarts(archiveAudioElement, archiveFrame.getByRole("button", { name: "Play sound" }));
  const dynamicAudioElement = archiveFrame.locator("#dynamic-sfx");
  assert(
    (await dynamicAudioElement.getAttribute("src"))?.startsWith("data:audio/wav;base64,"),
    "Static new Audio() paths must be bundled as offline WAV data URLs",
  );
  await assertAudioStarts(dynamicAudioElement, archiveFrame.getByRole("button", { name: "Play dynamic sound" }));
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
  await page.getByText("Revision applied. Play it, then keep it or undo it.").waitFor({ timeout: 10000 });
  const revisedArchiveFrame = page.frameLocator('iframe[title="Playable game: open-homebrew-project.zip"]');
  // The parent status can precede srcdoc navigation. Playwright's text
  // filtering excludes script elements, so inspect their DOM text directly.
  let revisedArchiveScript = "";
  const revisionDocumentDeadline = Date.now() + 10_000;
  do {
    revisedArchiveScript = await revisedArchiveFrame.locator("script").evaluateAll(scripts => scripts.map(script => script.textContent ?? "").join("\n"));
    if (revisedArchiveScript.includes("score+=2")) break;
    await page.waitForTimeout(50);
  } while (Date.now() < revisionDocumentDeadline);
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
  await assertAudioStarts(revisedAudioElement, revisedArchiveFrame.getByRole("button", { name: "Play sound" }));
  const revisedDynamicAudioElement = revisedArchiveFrame.locator("#dynamic-sfx");
  assert(
    (await revisedDynamicAudioElement.getAttribute("src"))?.startsWith("data:audio/wav;base64,"),
    "Original JavaScript audio references must be restored after model revision",
  );
  await assertAudioStarts(revisedDynamicAudioElement, revisedArchiveFrame.getByRole("button", { name: "Play dynamic sound" }));
  await revisedArchiveFrame.locator("#tile").evaluate(element => element.ownerDocument.defaultView?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
  await page.waitForTimeout(50);
  assert.equal(await revisedArchiveFrame.locator("#hud").innerText(), "Score 3", "Prompt revision must change imported gameplay, not just theme");
  await page.getByTestId("button-keep-imported-revision").click();
  await page.getByTestId("imported-revision-undo").waitFor({ state: "detached" });
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
  report.push(...await checkNesInputs(page));
  assert((await page.locator("body").innerText()).includes("mapper IDs 0–5"));
  report.push(...await checkNesSaves(page, "open-homebrew-fixture.nes"));
  await page.getByLabel(/I own this game or have permission to use and play it/).check();
  for (const mapper of [6, 8]) {
    await page.locator('input[accept=".nes,application/octet-stream"]').setInputFiles({
      name: `unsupported-mapper-${mapper}.nes`,
      mimeType: "application/octet-stream",
      buffer: makeUnsupportedMapperRom(mapper),
    });
    await page.getByRole("alert").getByText(`This ROM could not be started: Unsupported mapper: ${mapper}`, { exact: true }).waitFor({ timeout: 10000 });
    assert.equal(await page.getByRole("tab", { name: "Import and emulate" }).count(), 1, `Mapper ${mapper} failure must not stop the page`);
    await page.getByRole("button", { name: `Remove unsupported-mapper-${mapper}.nes` }).click();
    // Removal saves the shelf asynchronously, then clears its error. Do not
    // let that late cleanup erase the next import's expected validation error.
    await page.getByRole("button", { name: `Remove unsupported-mapper-${mapper}.nes` }).waitFor({ state: "detached" });
  }
  await page.locator('input[accept=".nes,application/octet-stream"]').setInputFiles({
    name: "malformed-homebrew.nes",
    mimeType: "application/octet-stream",
    buffer: makeMalformedNesRom(),
  });
  await page.getByRole("alert").getByText("This does not look like an iNES-format homebrew ROM.", { exact: true }).waitFor({ timeout: 10000 });
  assert.equal(await page.getByRole("tab", { name: "Import and emulate" }).count(), 1, "Malformed ROM failure must not stop the page");
  report.push("Unsupported NES mappers and a malformed ROM show readable errors while Arcade remains usable.");
  await page.getByLabel(/I own this game or have permission to use and play it/).check();
  await page.getByTestId("input-chip8-rom").setInputFiles({
    name: "open-homebrew.ch8",
    mimeType: "application/octet-stream",
    buffer: makeHomebrewChip8Rom(),
  });
  await page.getByText("Classic CHIP-8 program imported to this browser's local shelf.").waitFor({ timeout: 10000 });
  const chip8Canvas = page.locator('canvas[aria-label="CHIP-8 screen for open-homebrew.ch8"]');
  await chip8Canvas.waitFor({ timeout: 10000 });
  await page.getByText(/Running classic CHIP-8/).waitFor({ timeout: 10000 });
  await chip8Canvas.click();
  await page.keyboard.down("1");
  await page.waitForFunction(() => {
    const canvas = document.querySelector('canvas[aria-label="CHIP-8 screen for open-homebrew.ch8"]');
    const pixel = canvas?.getContext("2d")?.getImageData(0, 0, 1, 1).data;
    return Boolean(pixel && pixel[1] > 100);
  }, { timeout: 10000 });
  await page.keyboard.up("1");
  assert((await page.locator("body").innerText()).includes("Prompt modification needs editable source"), "CHIP-8 ROMs must not be passed to prompt gameplay edits");
  assert((await page.locator("body").innerText()).includes("Original HP48 half-pixel"), "Arcade must show explicit remaining Super-CHIP limitations");
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("tab", { name: "Import and emulate" }).click();
  await page.getByText("open-homebrew.ch8", { exact: true }).first().waitFor({ timeout: 10000 });
  await page.locator('[data-testid="chip8-player"]').getByText(/Progress restored from this browser/).waitFor({ timeout: 10000 });
  assert(await page.evaluate(() => Object.keys(localStorage).some((key) => key.startsWith("arenaforge.chip8-state.v1:"))), "CHIP-8 progress must persist in browser-local storage");
  report.push("Generated classic CHIP-8 homebrew boots, responds to keyboard input, stays outside prompt editing, and restores its browser-local progress after reload.");
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
  if (waveyardMobileOnly && error instanceof Error && error.message === waveyardMobileOnlyComplete) {
    console.log(report.join("\n"));
  } else {
    console.error("Browser errors:", errors);
    console.error("Visible page:", (await page.locator("body").innerText()).slice(0, 4000));
    await page.screenshot({ path: new URL("failure.jpg", output).pathname, fullPage: true });
    throw error;
  }
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

if (waveyardMobileOnly) process.exit(0);

execFileSync(
  process.execPath,
  [new URL("./arcade-shelf-persistence.mjs", import.meta.url).pathname],
  { stdio: "inherit", env: { ...process.env, TEST_BASE_URL: base } },
);
