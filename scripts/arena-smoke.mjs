import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";

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
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await context.addInitScript(() => {
  if (window === window.top) {
    if (localStorage.getItem("af_local_mode") === null) localStorage.setItem("af_local_mode", "1");
    if (localStorage.getItem("af_ephemeral") === null) localStorage.setItem("af_ephemeral", "0");
    if (localStorage.getItem("af_key_openrouter") === null) localStorage.setItem("af_key_openrouter", "arena-smoke-placeholder");
  }
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", err => errors.push(err.message));
const report = [];
const reaAnalysisSmoke = execFileSync(
  "pnpm",
  ["--filter", "@workspace/scripts", "exec", "tsx", "./rea-analysis-smoke.ts"],
  { encoding: "utf8", maxBuffer: 1024 * 1024 },
).trim();
assert(reaAnalysisSmoke.includes("without executing source"), "REA analysis smoke test did not complete successfully");
report.push(reaAnalysisSmoke);
let createdProject;
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
  await page.waitForTimeout(50);
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
  await page.keyboard.press("ArrowRight");
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
  if (battleId) await context.request.delete(`${base}/api/battles/${battleId}`);
  if (fallbackBattleId) await context.request.delete(`${base}/api/battles/${fallbackBattleId}`);
  await browser.close();
}
