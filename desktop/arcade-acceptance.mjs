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
    prompt: "Create an original single-screen Pong game with two paddles, a bouncing ball, visible score, arrow-key controls, and an immediate playable start.",
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
  report.passed = passedCases === cases.length;
  assert.equal(report.passed, true, `Only ${passedCases}/${cases.length} representative prompts passed; see per-prompt results.`);
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error);
  if (report.flows.promptGeneration.status === "pending") {
    report.flows.promptGeneration = { status: "failed", reason: report.failure };
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
