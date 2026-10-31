/**
 * Prove prompt-to-game generation in the packaged Windows app with a real
 * loopback Ollama model and Chromium's WebGPU API disabled.
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
    memoryGuidance: "Qwen 2.5 3B: 12 GB RAM starting point; Qwen 2.5 1.5B: 8–11 GB starting point",
  },
  flows: {
    import: { status: "not_run", reason: "Import is a separate browser-local flow." },
    promptGeneration: { status: "pending" },
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

  const requestPromise = page.waitForRequest(
    (request) => request.url() === `${base}/api/arcade/forge` && request.method() === "POST",
    { timeout: 300_000 },
  );
  const responsePromise = page.waitForResponse(
    (response) => response.url() === `${base}/api/arcade/forge` && response.request().method() === "POST",
    { timeout: 300_000 },
  );
  const runtimeErrors = [];
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  const localCheckButton = page.getByTestId("button-local-server-generation-check");
  await localCheckButton.waitFor({ state: "visible" });
  assert(await localCheckButton.isEnabled(), "The selected Model Hub model must enable the local-generation check.");
  await localCheckButton.click();
  const [generationRequest, generationResponse] = await Promise.all([requestPromise, responsePromise]);

  const requestBody = generationRequest.postDataJSON();
  assert.equal(requestBody.modelId, modelId, "Arcade must send the selected local model.");
  assert.equal(requestBody.localOnly, true, "Arcade must preserve Local Mode.");
  assert.equal(requestBody.keys, undefined, "Local Mode must not send provider credentials.");
  assert.match(requestBody.prompt, /local model test/i, "The UI must send the focused local-generation prompt.");
  assert.equal(requestBody.ephemeral, true, "The local proof must not save a shared game.");
  assert.equal(requestBody.priorCode, undefined, "A new local proof must not carry unrelated game source.");

  const generated = await generationResponse.json();
  assert(generationResponse.ok(), generated.error || `Generation returned HTTP ${generationResponse.status()}.`);
  assert.equal(generated.runtime?.backend, "local-server", "Generation must use a real Model Hub server model.");
  assert.equal(generated.runtime?.modelId, modelId, "The selected Ollama model must perform generation.");
  assert.equal(generated.runtime?.fallback, false, "A deterministic fallback is not a model-generation pass.");
  assert.equal(generated.validation?.ok, true, "Returned game source must pass Arcade validation.");
  assert(typeof generated.code === "string" && generated.code.length > 0, "Arcade must return game source.");
  assert.match(generated.code, /<canvas\b/i, "The returned source must contain a playable canvas game.");

  assert.equal(generated.runtimeVerification?.status, "passed", "Generated game source must pass the isolated startup check.");
  await page.getByTestId("local-generation-result")
    .getByText(/Passed: The selected local model generated a valid game/, { exact: false })
    .waitFor({ timeout: 30_000 });
  const gameFrame = page.getByTestId("local-generation-preview");
  await gameFrame.waitFor({ timeout: 30_000 });
  const frame = gameFrame.contentFrame();
  const canvas = frame.locator("canvas");
  await canvas.waitFor({ timeout: 30_000 });
  assert(await canvas.evaluate((element) => element.getContext("2d") !== null),
    "The generated game must initialize its canvas in the isolated preview.");
  await page.waitForTimeout(500);
  assert.deepEqual(runtimeErrors, [], `Generated game runtime errors: ${runtimeErrors.join("; ")}`);

  report.flows.promptGeneration = {
    status: "passed",
    model,
    backend: generated.runtime.backend,
    validation: generated.validation.ok,
    sourceBytes: Buffer.byteLength(generated.code, "utf8"),
    isolatedCanvasLoaded: true,
    rendererRuntimeErrors: runtimeErrors,
  };
  report.passed = true;
  pass("Real local prompt returned validated game source and loaded in Arcade's isolated preview");
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
  await writeFile(path.join(outputDir, "arcade-result.json"), JSON.stringify(report, null, 2));
  console.log(`Result: ${path.join(outputDir, "arcade-result.json")}`);
  if (dataRoot) console.log("An isolated temporary app-data directory was retained locally for diagnosis.");
}
