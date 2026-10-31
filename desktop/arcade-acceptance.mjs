/**
 * Compare focused and richer prompt-to-game generation in the packaged Windows
 * app with a real loopback Ollama model and Chromium's WebGPU API disabled.
 *
 * Import and gameplay-edit flows are intentionally reported separately; this
 * check does not exercise either of them.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron } from "playwright-core";

const here = path.dirname(fileURLToPath(import.meta.url));
const outputDir = path.resolve(here, "../generated-artifacts/windows-check");
const exe = process.argv[2];
const model = process.argv[3] || process.env.ARENA_ARCADE_ACCEPTANCE_MODEL;
const modelReportName = (model || "unselected").replace(/[^a-zA-Z0-9._-]+/g, "_");
const promptCases = [
  {
    id: "focused-collectible",
    prompt: "Create a tiny original HTML5 game for a local model test: draw a blue square on a canvas, move it with arrow keys, let it collect one gold coin, and show a score HUD. Use requestAnimationFrame. Make it one complete offline HTML file with no external URLs or assets.",
  },
  {
    id: "pong-mechanics",
    prompt: "Create an original single-screen HTML5 Pong game with two paddles and a bouncing ball. Player 1 controls the left paddle with W and S; Player 2 controls the right paddle with ArrowUp and ArrowDown. Show both scores at the top center. Start playing immediately, award a point when the ball passes a paddle, and let R restart the game and reset both scores to zero. Use a canvas and make it one complete offline HTML file with no external URLs or assets.",
  },
];
const report = {
  passed: false,
  platform: process.platform,
  arch: process.arch,
  engine: "live Ollama local inference",
  runtimePrerequisites: {
    app: "Packaged Windows x64 ArenaForge executable",
    localRuntime: "Ollama running on http://127.0.0.1:11434",
    localModel: model || null,
    webgpuRequired: false,
    providerCredentialsRequired: false,
    runner: "Node.js 22+ and installed workspace dependencies on the test workstation",
    memoryGuidance: "Qwen 2.5 3B: 12 GB RAM starting point; Qwen 2.5 Coder 1.5B: 8–11 GB starting point; guidance only, not a measured minimum",
  },
  flows: {
    import: { status: "not_run", reason: "Import is a separate browser-local flow." },
    promptGeneration: { status: "pending", cases: [] },
    gameplayMechanics: { status: "pending", cases: [] },
    gameplayEdit: { status: "not_run", reason: "Gameplay edits are a separate source-revision flow." },
  },
  checks: [],
  startedAt: new Date().toISOString(),
};
let desktop;
let page;
let base;
let dataRoot;

const pass = (name) => {
  report.checks.push({ name, passed: true });
  console.log(`PASS: ${name}`);
};

async function api(endpoint, body) {
  const response = await page.request[body === undefined ? "get" : "post"](
    `${base}${endpoint}`,
    body === undefined ? {} : { data: body, timeout: 300_000 },
  );
  const payload = await response.json();
  assert(response.ok(), `${endpoint}: ${payload.error || response.status()}`);
  return payload;
}

async function launch() {
  desktop = await _electron.launch({
    executablePath: exe,
    timeout: 150_000,
    args: ["--disable-gpu", "--disable-features=WebGPU,WebGPUDeveloperFeatures"],
    env: { ...process.env, ARENA_DATA_DIR: dataRoot },
  });
  page = await desktop.firstWindow({ timeout: 150_000 });
  await page.waitForURL("**/spaces", { timeout: 150_000 });
  await page.getByRole("heading", { name: "Browser tasks in private workspaces" }).waitFor();
  base = new URL(page.url()).origin;
}

async function samplePongFrame(gameFrame, includePixels = false) {
  return gameFrame.evaluate((returnPixels) => {
    const canvas = document.querySelector("canvas");
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error("The Pong preview has no canvas.");
    const width = 96;
    const height = 60;
    const sample = document.createElement("canvas");
    sample.width = width;
    sample.height = height;
    const context = sample.getContext("2d", { willReadFrequently: true });
    const source = canvas.getContext("2d", { willReadFrequently: true });
    if (!context || !source) throw new Error("The Pong preview does not expose a readable 2D canvas.");
    context.drawImage(canvas, 0, 0, width, height);
    const { data } = context.getImageData(0, 0, width, height);
    const pixels = returnPixels ? new Array(width * height) : null;
    const bright = new Uint8Array(width * height);
    for (let index = 0; index < width * height; index++) {
      const offset = index * 4;
      const red = data[offset];
      const green = data[offset + 1];
      const blue = data[offset + 2];
      const color = ((red >> 4) << 8) | ((green >> 4) << 4) | (blue >> 4);
      if (pixels) pixels[index] = color;
      bright[index] = Math.max(red, green, blue) > 180 &&
        Math.min(red, green, blue) > 45 && data[offset + 3] > 120 ? 1 : 0;
    }

    // Locate the small bright moving object in the court, excluding the score
    // row and paddle lanes. This is evidence for movement/bounce, not a game API.
    const visited = new Uint8Array(width * height);
    const candidates = [];
    for (let start = width * 0.1 | 0; start < width * 0.9; start++) {
      for (let row = height * 0.16 | 0; row < height * 0.9; row++) {
        const origin = row * width + start;
        if (!bright[origin] || visited[origin]) continue;
        const stack = [origin];
        visited[origin] = 1;
        let minX = start, maxX = start, minY = row, maxY = row, count = 0;
        while (stack.length) {
          const point = stack.pop();
          const x = point % width;
          const y = Math.floor(point / width);
          count++;
          minX = Math.min(minX, x); maxX = Math.max(maxX, x);
          minY = Math.min(minY, y); maxY = Math.max(maxY, y);
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nextX = x + dx, nextY = y + dy;
            if (nextX < 1 || nextX >= width - 1 || nextY < 1 || nextY >= height - 1) continue;
            const next = nextY * width + nextX;
            if (bright[next] && !visited[next]) { visited[next] = 1; stack.push(next); }
          }
        }
        const boxWidth = maxX - minX + 1;
        const boxHeight = maxY - minY + 1;
        if (count >= 3 && count <= 100 && boxWidth >= 2 && boxHeight >= 2 && boxWidth <= 12 && boxHeight <= 12) {
          const x = (minX + maxX) / 2;
          const y = (minY + maxY) / 2;
          const centerDistance = Math.abs(x - width / 2) / width + Math.abs(y - height / 2) / height;
          candidates.push({ x, y, centerDistance, count });
        }
      }
    }
    candidates.sort((a, b) => a.centerDistance - b.centerDistance);

    const scorePixels = [];
    for (let row = 1; row < height * 0.16; row++) {
      for (let column = width * 0.28 | 0; column < width * 0.72; column++) {
        const offset = (row * width + column) * 4;
        scorePixels.push(((data[offset] >> 4) << 8) | ((data[offset + 1] >> 4) << 4) | (data[offset + 2] >> 4));
      }
    }
    const scoreText = (document.body.innerText || "").replace(/\s+/g, " ").match(
      /(?:score\s*[:=]?\s*\d+(?:\s*[-:]\s*\d+)?|(?:player\s*1|p1)\s*[:=]?\s*\d+\s+(?:player\s*2|p2)\s*[:=]?\s*\d+|\b\d+\s*[-:]\s*\d+\b)/i,
    )?.[0] ?? null;
    return { width, height, ...(pixels ? { pixels } : {}), ball: candidates[0] ? { x: candidates[0].x, y: candidates[0].y } : null, scorePixels, scoreText };
  }, includePixels);
}

function countPixelChanges(before, after, region = "all") {
  let changed = 0;
  for (let y = 10; y < 54; y++) {
    for (let x = 0; x < 96; x++) {
      if (region === "left" && x >= 18) continue;
      if (region === "right" && x < 78) continue;
      const index = y * 96 + x;
      if (before.pixels[index] !== after.pixels[index]) changed++;
    }
  }
  return changed;
}

function scoreChanged(initial, current) {
  if (initial.scoreText && current.scoreText) return initial.scoreText !== current.scoreText;
  let changed = 0;
  for (let index = 0; index < initial.scorePixels.length; index++) {
    if (initial.scorePixels[index] !== current.scorePixels[index]) changed++;
  }
  return changed >= 3;
}

function scoreReset(initial, current) {
  if (initial.scoreText && current.scoreText) return initial.scoreText === current.scoreText;
  let changed = 0;
  for (let index = 0; index < initial.scorePixels.length; index++) {
    if (initial.scorePixels[index] !== current.scorePixels[index]) changed++;
  }
  return changed <= 2;
}

async function pressPongKey(gameFrame, canvas, key) {
  await canvas.click({ force: true });
  await page.keyboard.down(key);
  await page.waitForTimeout(260);
  await page.keyboard.up(key);
  await page.waitForTimeout(100);
}

async function verifyPongMechanics(gameFrame, testCase) {
  const canvas = gameFrame.locator("canvas").first();
  await canvas.waitFor({ timeout: 10_000 });
  await canvas.click({ force: true });
  await page.waitForTimeout(350);
  const initial = await samplePongFrame(gameFrame, true);
  const checks = {
    leftPaddleUp: false,
    leftPaddleDown: false,
    rightPaddleUp: false,
    rightPaddleDown: false,
    ballMovement: false,
    ballBounce: false,
    scoreChange: false,
    restartResetsScore: false,
  };
  const observations = { controls: {}, ballSamples: 0, bounceAxis: null, scoreBefore: initial.scoreText, scoreAfter: null };

  for (const control of [
    { name: "leftPaddleUp", key: "w", side: "left" },
    { name: "leftPaddleDown", key: "s", side: "left" },
    { name: "rightPaddleUp", key: "ArrowUp", side: "right" },
    { name: "rightPaddleDown", key: "ArrowDown", side: "right" },
  ]) {
    const before = await samplePongFrame(gameFrame, true);
    await pressPongKey(gameFrame, canvas, control.key);
    const after = await samplePongFrame(gameFrame, true);
    const own = countPixelChanges(before, after, control.side);
    const other = countPixelChanges(before, after, control.side === "left" ? "right" : "left");
    observations.controls[control.name] = { edgePixelsChanged: own, oppositeEdgePixelsChanged: other };
    checks[control.name] = own >= 4 && own > other;
  }

  let previousBall = null;
  let previousDirection = { x: 0, y: 0 };
  let scoreStreak = 0;
  let lastScoreState = initial;
  const started = Date.now();
  while (Date.now() - started < 30_000 && (!checks.ballBounce || !checks.scoreChange)) {
    await page.waitForTimeout(120);
    const current = await samplePongFrame(gameFrame);
    if (current.ball) {
      observations.ballSamples++;
      if (previousBall) {
        const dx = current.ball.x - previousBall.x;
        const dy = current.ball.y - previousBall.y;
        if (Math.abs(dx) + Math.abs(dy) >= 1) checks.ballMovement = true;
        for (const axis of ["x", "y"]) {
          const delta = axis === "x" ? dx : dy;
          const dimension = axis === "x" ? current.width : current.height;
          const prior = previousDirection[axis];
          // Ignore teleport-sized score resets and single-pixel antialias noise.
          if (Math.abs(delta) > 1 && Math.abs(delta) < dimension * 0.18 && prior && Math.sign(delta) !== Math.sign(prior)) {
            checks.ballBounce = true;
            observations.bounceAxis = axis;
          }
          if (Math.abs(delta) > 1 && Math.abs(delta) < dimension * 0.18) previousDirection[axis] = delta;
        }
      }
      previousBall = current.ball;
    }
    if (scoreChanged(initial, current)) {
      scoreStreak++;
      lastScoreState = current;
      if (scoreStreak >= 2) checks.scoreChange = true;
    } else {
      scoreStreak = 0;
    }
  }
  observations.scoreAfter = lastScoreState.scoreText;
  if (checks.scoreChange) {
    await pressPongKey(gameFrame, canvas, "r");
    await page.waitForTimeout(500);
    const restarted = await samplePongFrame(gameFrame);
    checks.restartResetsScore = scoreReset(initial, restarted);
    observations.scoreAfterRestart = restarted.scoreText;
  }
  const failed = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
  return {
    id: testCase.id,
    model: report.model,
    status: failed.length === 0 ? "passed" : "failed",
    checks,
    observations,
    ...(failed.length ? { failureType: "gameplay-mechanics", failures: failed } : {}),
  };
}

try {
  assert.equal(process.platform, "win32", "This acceptance check only counts on actual Windows.");
  assert.equal(process.arch, "x64", "The packaged app must be Windows x64.");
  assert(exe && path.isAbsolute(exe) && existsSync(exe), "Supply the absolute installed ArenaForge.exe path.");
  assert(model, "Supply an installed Ollama model, for example qwen2.5:3b.");

  await mkdir(outputDir, { recursive: true });
  dataRoot = await mkdtemp(path.join(os.tmpdir(), "arenaforge-arcade-check-"));
  await launch();
  pass("Packaged Windows app starts with an isolated data directory");

  const webGpuAdapterAvailable = await page.evaluate(async () => {
    if (!navigator.gpu) return false;
    try {
      return Boolean(await navigator.gpu.requestAdapter());
    } catch {
      return false;
    }
  });
  assert.equal(webGpuAdapterAvailable, false, "A WebGPU adapter must be unavailable for this acceptance run.");
  report.webgpu = { adapterAvailable: false, disabledBy: "Chromium GPU and WebGPU feature switches" };
  pass("No WebGPU adapter is available in the packaged app renderer");

  const connected = await api("/api/model-hub", {
    action: "connect",
    baseUrl: "http://127.0.0.1:11434",
    kind: "ollama",
    label: "Arcade local-model acceptance",
  });
  assert(connected.models.includes(model), `Ollama does not list ${model}.`);
  const registered = await api("/api/model-hub", {
    action: "register",
    connectionId: connected.connection.id,
    remoteModel: model,
  });
  const modelId = registered.model.id;
  report.model = model;
  pass("Installed Ollama model is connected and selectable in Model Hub");

  await page.goto(`${base}/arcade`);
  await page.evaluate(() => localStorage.setItem("af_local_mode", "1"));
  await page.reload();
  const modelSource = page.getByLabel("Connected model source");
  if (!(await modelSource.isVisible())) {
    await page.locator("summary").filter({ hasText: "Model setup" }).click();
  }
  await modelSource.selectOption(modelId);

  await page.evaluate(() => localStorage.setItem("af_ephemeral", "1"));
  await page.reload();
  assert.equal(await page.evaluate(() => localStorage.getItem("af_local_mode")), "1");
  assert.equal(await page.evaluate(() => localStorage.getItem("af_ephemeral")), "1");

  const runtimeErrors = [];
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  for (const testCase of promptCases) {
    const rendererErrorOffset = runtimeErrors.length;
    const result = {
      id: testCase.id,
      prompt: testCase.prompt,
      status: "failed",
      checks: {
        localOnly: false,
        noProviderCredentials: false,
        selectedModelUsed: false,
        validation: false,
        isolatedStartup: false,
        canvasLoaded: false,
      },
    };
    report.flows.promptGeneration.cases.push(result);
    try {
      const createButton = page.getByRole("button", { name: "🎮 Create & play" });
      await createButton.waitFor({ state: "visible" });
      await page.waitForFunction(() => {
        const button = Array.from(document.querySelectorAll("button"))
          .find((candidate) => candidate.textContent?.trim() === "🎮 Create & play");
        return button && !button.disabled;
      }, undefined, { timeout: 300_000 });
      const requestPromise = page.waitForRequest(
        (request) => request.url() === `${base}/api/arcade/forge` && request.method() === "POST",
        { timeout: 300_000 },
      );
      const responsePromise = page.waitForResponse(
        (response) => response.url() === `${base}/api/arcade/forge` && response.request().method() === "POST",
        { timeout: 300_000 },
      );
      await page.getByLabel("Game prompt").fill(testCase.prompt);
      await page.getByRole("button", { name: "🎮 Create & play" }).click();
      const [generationRequest, generationResponse] = await Promise.all([requestPromise, responsePromise]);
      const requestBody = generationRequest.postDataJSON();

      assert.equal(requestBody.prompt, testCase.prompt, "Arcade must send the selected representative prompt.");
      assert.equal(requestBody.modelId, modelId, "Arcade must send the selected local model.");
      assert.equal(requestBody.localOnly, true, "Arcade must preserve Local Mode.");
      result.checks.localOnly = true;
      assert.equal(requestBody.keys, undefined, "Local Mode must not send provider credentials.");
      result.checks.noProviderCredentials = true;
      assert.equal(requestBody.ephemeral, true, "The test game must not be persisted.");
      assert.equal(requestBody.priorCode, undefined, "Prompt generation must not include import or gameplay-edit source.");

      const generated = await generationResponse.json();
      if (!generationResponse.ok()) {
        result.reason = generated.error || `Generation returned HTTP ${generationResponse.status()}.`;
        result.runtimeVerification = generated.runtimeVerification ?? generated.draft?.runtimeVerification ?? null;
        result.validation = generated.draft?.validation ?? null;
        result.failureType = result.validation?.ok === false
          ? "arcade-validation"
          : result.runtimeVerification?.status === "failed" || result.runtimeVerification?.status === "unavailable"
            ? "isolated-startup"
            : generationResponse.status() === 503
              ? "model-routing-or-runtime"
              : "generation";
        if (testCase.id === "pong-mechanics") {
          report.flows.gameplayMechanics.cases.push({
            id: testCase.id,
            model,
            status: "not_run",
            failureType: result.failureType,
            reason: result.reason,
          });
        }
        console.error(`FAILED (${testCase.id}): ${result.reason}`);
        continue;
      }
      assert.equal(generated.runtime?.backend, "local-server", "Generation must use a real Model Hub server model.");
      assert.equal(generated.runtime?.modelId, modelId, "The selected Ollama model must perform generation.");
      result.checks.selectedModelUsed = true;
      assert.equal(generated.runtime?.fallback, false, "A deterministic fallback is not a model-generation pass.");
      assert.equal(generated.validation?.ok, true, "Returned game source must pass Arcade validation.");
      assert(typeof generated.code === "string" && generated.code.length > 0, "Arcade must return game source.");
      assert.match(generated.code, /<canvas\b/i, "The returned source must contain a playable canvas game.");
      result.checks.validation = true;
      assert.equal(generated.runtimeVerification?.status, "passed", "Generated source must pass the isolated startup check.");
      result.checks.isolatedStartup = true;
      result.runtimeVerification = generated.runtimeVerification;

      const gameFrame = page.locator(`iframe[title="${testCase.prompt}"]`);
      await gameFrame.waitFor({ timeout: 30_000 });
      const canvas = gameFrame.contentFrame().locator("canvas");
      await canvas.waitFor({ timeout: 30_000 });
      assert(await canvas.evaluate((element) => element.getContext("2d") !== null),
        "The generated game must initialize its canvas in the packaged app preview.");
      result.checks.canvasLoaded = true;
      await page.waitForTimeout(500);
      const caseRuntimeErrors = runtimeErrors.slice(rendererErrorOffset);
      assert.deepEqual(caseRuntimeErrors, [], `Generated game renderer errors: ${caseRuntimeErrors.join("; ")}`);

      if (testCase.id === "pong-mechanics") {
        const mechanics = {
          id: testCase.id,
          model,
          status: "not_run",
          checks: {},
          reason: null,
        };
        report.flows.gameplayMechanics.cases.push(mechanics);
        try {
          const result = await verifyPongMechanics(gameFrame, testCase);
          Object.assign(mechanics, result);
          if (result.status === "passed") {
            pass(`${model} Pong controls, ball movement/bounce, scoring, and restart passed in Arcade's isolated preview`);
          } else {
            console.error(`FAILED (Pong gameplay mechanics): ${result.failures.join(", ")}`);
          }
        } catch (error) {
          mechanics.status = "failed";
          mechanics.failureType = "gameplay-mechanics";
          mechanics.reason = error instanceof Error ? error.message : String(error);
          console.error(`FAILED (Pong gameplay mechanics): ${mechanics.reason}`);
        }
      }

      Object.assign(result, {
        status: "passed",
        backend: generated.runtime.backend,
        validation: generated.validation,
        runtimeVerification: generated.runtimeVerification,
        repairsUsed: generated.repairsUsed ?? null,
        generationMs: generated.runtime.ms ?? null,
        sourceBytes: Buffer.byteLength(generated.code, "utf8"),
      });
      pass(`${model} generated ${testCase.id}; validation and isolated startup passed without WebGPU`);
    } catch (error) {
      result.reason = error instanceof Error ? error.message : String(error);
      result.failureType ??= !result.checks.selectedModelUsed
        ? "model-routing-or-runtime"
        : !result.checks.validation
          ? "arcade-validation"
          : !result.checks.isolatedStartup || !result.checks.canvasLoaded
            ? "isolated-startup"
            : "generation-or-renderer";
      if (testCase.id === "pong-mechanics" && !report.flows.gameplayMechanics.cases.some((item) => item.id === testCase.id)) {
        report.flows.gameplayMechanics.cases.push({
          id: testCase.id,
          model,
          status: "not_run",
          failureType: result.failureType,
          reason: result.reason,
        });
      }
      console.error(`FAILED (${testCase.id}): ${result.reason}`);
    }
  }

  const cases = report.flows.promptGeneration.cases;
  const passedCases = cases.filter((testCase) => testCase.status === "passed").length;
  report.flows.promptGeneration.status = passedCases === cases.length
    ? "passed"
    : passedCases > 0 ? "partial" : "failed";
  report.flows.promptGeneration.model = model;
  report.flows.promptGeneration.webgpuAdapterAvailable = false;
  report.flows.promptGeneration.providerCredentialsSent = false;
  const mechanicCases = report.flows.gameplayMechanics.cases;
  const mechanicsPassed = mechanicCases.length === 1 && mechanicCases[0].status === "passed";
  report.flows.gameplayMechanics.status = mechanicsPassed
    ? "passed"
    : mechanicCases.length === 0 || mechanicCases.every((item) => item.status === "not_run") ? "not_run" : "failed";
  report.passed = passedCases === cases.length && mechanicsPassed;
  assert.equal(report.passed, true,
    `Generation/startup passed for ${passedCases}/${cases.length} prompts; Pong mechanics status: ${report.flows.gameplayMechanics.status}. See per-flow results.`);
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error);
  if (report.flows.promptGeneration.status === "pending") {
    report.flows.promptGeneration = { status: "failed", reason: report.failure };
  }
  if (report.flows.gameplayMechanics.status === "pending") {
    report.flows.gameplayMechanics = {
      status: "not_run",
      cases: report.flows.gameplayMechanics.cases,
      reason: report.failure,
      blockedBy: "environment-or-prerequisite",
    };
  }
  console.error(`FAILED: ${report.failure}`);
  process.exitCode = 1;
} finally {
  await desktop?.close().catch(() => {});
  await mkdir(outputDir, { recursive: true });
  report.finishedAt = new Date().toISOString();
  const resultJson = JSON.stringify(report, null, 2);
  const latestReport = path.join(outputDir, "arcade-result.json");
  const modelReport = path.join(outputDir, `arcade-result-${modelReportName}.json`);
  await Promise.all([
    writeFile(latestReport, resultJson),
    writeFile(modelReport, resultJson),
  ]);
  console.log(`Result: ${latestReport}`);
  console.log(`Model-specific result: ${modelReport}`);
  if (dataRoot) console.log("An isolated temporary app-data directory was retained locally for diagnosis.");
}
