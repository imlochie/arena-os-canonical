/**
 * Run ON WINDOWS against the packaged executable and an actual Ollama model.
 * No scripted/model responses are injected. Failures are evidence, not passes.
 * Only synthetic cookie markers are inspected; real user profiles are unused.
 */
import { _electron, chromium } from "playwright-core";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const output = path.join(here, "../generated-artifacts/windows-check");
const exe = process.argv[2];
const model = process.argv[3] || process.env.ARENA_ACCEPTANCE_MODEL;
const report = { passed: false, platform: process.platform, arch: process.arch, engine: "actual Ollama; no scripted model", checks: [], startedAt: new Date().toISOString() };
let desktop;
let page;
let base;
let root;
let workspace;
let otherWorkspace;
let modelId;
let mission;
let saved;
let reportContents;
const pass = name => { report.checks.push({ name, passed: true }); console.log(`PASS: ${name}`); };

async function request(endpoint, body) {
  const response = await page.request[body === undefined ? "get" : "post"](`${base}${endpoint}`, body === undefined ? {} : { data: body, timeout: 300_000 });
  const payload = await response.json();
  assert(response.ok(), `${endpoint}: ${payload.error || response.status()}`);
  return payload;
}

async function launch() {
  desktop = await _electron.launch({
    executablePath: exe, timeout: 150_000,
    env: { ...process.env, ARENA_DATA_DIR: root },
  });
  page = await desktop.firstWindow({ timeout: 150_000 });
  await page.waitForURL("**/spaces", { timeout: 150_000 });
  await page.getByRole("heading", { name: "Browser tasks in private workspaces" }).waitFor();
  base = new URL(page.url()).origin;
}

async function taskCard(id) {
  const card = page.locator(`[data-space-id="${id}"]`);
  await card.getByRole("textbox", { name: "Browser task", exact: true }).waitFor();
  return card;
}

async function runFromUi(id, resume = false) {
  const card = await taskCard(id);
  const response = page.waitForResponse(value =>
    value.url() === `${base}/api/spaces/${id}/mission` && value.request().method() === "POST",
  { timeout: 1_200_000 });
  await card.getByRole("button", { name: resume ? /Resume/ : "Run browser task", exact: !resume }).click();
  const result = await response;
  const payload = await result.json();
  assert(result.ok(), payload.error || `Mission returned ${result.status()}`);
  return payload.mission;
}

try {
  assert.equal(process.platform, "win32", "This acceptance check only counts on actual Windows");
  assert.equal(process.arch, "x64");
  assert(exe && path.isAbsolute(exe) && existsSync(exe), "Supply the absolute installed ArenaForge.exe path");
  assert(model, "Supply an installed Ollama model, for example qwen2.5:3b");
  await mkdir(output, { recursive: true });
  root = await mkdtemp(path.join(os.tmpdir(), "arenaforge-windows-check-"));
  // Root deliberately retained on failure so the owner can inspect/retry.
  await launch();
  pass("Packaged Windows app starts the Vite frontend and Express API");
  const connected = await request("/api/model-hub", { action: "connect", baseUrl: "http://127.0.0.1:11434", kind: "ollama", label: "Windows local model check" });
  assert(connected.models.includes(model), `Ollama does not list ${model}`);
  const registered = await request("/api/model-hub", { action: "register", connectionId: connected.connection.id, remoteModel: model });
  modelId = registered.model.id;
  report.model = model;
  pass("Installed real Ollama model is registered through Model Hub");

  const create = () => request("/api/spaces", {
    title: "Windows browser acceptance", prompt: "Only run browser tasks when requested.",
    modelId, intervalMinutes: 1440, status: "paused",
  });
  workspace = (await create()).space.id;
  otherWorkspace = (await create()).space.id;
  await page.reload();
  const card = page.locator(`[data-space-id="${workspace}"]`);
  await card.getByRole("combobox", { name: "Task model" }).selectOption(modelId);
  const goal = "Open https://example.com, read the actual heading, click its Learn more link (wait for my approval), then read the destination page title. Save both observed titles and URLs in reports/windows-browser-task.md. Do not fill forms, log in, or use any other site. Complete only after saving the report.";
  await card.getByRole("textbox", { name: "Browser task", exact: true }).fill(goal);
  mission = await runFromUi(workspace);
  assert.equal(mission.status, "awaiting_approval", `Expected approval, got ${mission.status}: ${mission.statusDetail}`);
  assert(mission.journal.some(step => step.runtime?.backend === "local-server" && step.runtime?.fallback === false));
  const pending = (await request(`/api/spaces/approvals?spaceId=${workspace}&status=pending`)).approvals.filter(item => item.missionId === mission.id);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].actionClass, "browser.interact");
  pass("Natural-language task uses the live local model and pauses before clicking");

  // Restart WHILE awaiting approval. The decision and plan must remain intact.
  await desktop.close();
  desktop = null;
  await launch();
  const reloaded = (await request(`/api/spaces/${workspace}/mission`)).mission;
  assert.equal(reloaded.id, mission.id);
  assert.equal(reloaded.status, "awaiting_approval");
  assert.equal(reloaded.mode, "browser");
  const resumedCard = page.locator(`[data-space-id="${workspace}"]`);
  const decision = page.waitForResponse(response => response.url() === `${base}/api/spaces/approvals` && response.request().method() === "POST");
  await resumedCard.getByRole("button", { name: /Approve/ }).click();
  assert((await decision).ok(), "The approval decision did not save");
  mission = await runFromUi(workspace, true);
  for (let attempts = 0; mission.status === "checkpointed" && attempts < 4; attempts++) {
    mission = await runFromUi(workspace, true);
  }
  assert.equal(mission.status, "done", `Task not completed: ${mission.status}: ${mission.statusDetail}`);
  const ledger = (await request(`/api/spaces/approvals?spaceId=${workspace}`)).approvals;
  assert.equal(ledger.find(item => item.id === pending[0].id)?.status, "executed");
  assert.equal(mission.journal.flatMap(step => step.actions).filter(action => action.tool === "browser_click" && action.ok && !action.output.includes("already executed")).length, 1);
  pass("Approval persists over an app restart and the approved click executes once");

  saved = mission.artifacts.find(file => file.path === "reports/windows-browser-task.md");
  assert(saved, "The model did not save the requested report");
  const download = page.waitForEvent("download", { timeout: 30_000 });
  await resumedCard.getByRole("link", { name: /windows-browser-task.md/ }).click();
  const file = await download;
  assert.equal(file.suggestedFilename(), "windows-browser-task.md");
  const reportPath = path.join(output, "windows-browser-task.md");
  await file.saveAs(reportPath);
  reportContents = await readFile(reportPath, "utf8");
  assert.match(reportContents, /Example Domain/i);
  assert.match(reportContents, /iana\.org/i);
  pass("Saved report downloads through the actual Windows UI");

  // The following tests the REAL shipped Chromium, with synthetic session data.
  // Stop the app first so its profile locks are released.
  await desktop.close();
  desktop = null;
  const chromiumExe = path.join(path.dirname(exe), "resources/chromium/chrome.exe");
  const profile = id => path.join(root, "data/space-workspaces", id, "browser-profile");
  const openProfile = id => chromium.launchPersistentContext(profile(id), { executablePath: chromiumExe, headless: true, serviceWorkers: "block" });
  const a = await openProfile(workspace);
  try {
    await a.addCookies([{ name: "arena_acceptance_marker", value: "synthetic-not-a-login", domain: "example.com", path: "/", expires: Math.floor(Date.now() / 1000) + 3600, secure: true }]);
  } finally { await a.close(); }
  const b = await openProfile(otherWorkspace);
  try { assert.equal((await b.cookies()).some(cookie => cookie.name === "arena_acceptance_marker"), false); }
  finally { await b.close(); }
  const aAgain = await openProfile(workspace);
  try { assert((await aAgain.cookies()).some(cookie => cookie.name === "arena_acceptance_marker")); }
  finally { await aAgain.close(); }
  pass("Packaged Chromium profiles are separate and retain synthetic session state");
  await launch();
  const persistedMission = (await request(`/api/spaces/${workspace}/mission`)).mission;
  assert.equal(persistedMission.id, mission.id);
  assert.equal(persistedMission.status, "done");
  assert((await request("/api/model-hub")).registered.some(entry => entry.id === modelId));
  const persistedReport = await page.request.get(`${base}/api/spaces/${workspace}/browser?file=${encodeURIComponent(saved.path)}`);
  assert(persistedReport.ok());
  assert.equal(await persistedReport.text(), reportContents);
  const blocked = await page.request.get(`${base}/api/spaces/${workspace}/browser?file=browser-profile/Cookies`);
  assert.equal(blocked.status(), 400);
  await request(`/api/spaces/${workspace}/browser`, { url: "https://example.com" });
  pass("Model connection, mission, report and browser profile reopen after restart");
  await page.screenshot({ path: path.join(output, "windows-workspace.png") });
  report.passed = true;
} catch (error) {
  report.failure = error.message;
  console.error(`FAILED: ${error.message}`);
  process.exitCode = 1;
} finally {
  await desktop?.close().catch(() => {});
  await mkdir(output, { recursive: true });
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(output, "result.json"), JSON.stringify(report, null, 2));
  console.log(`Result: ${path.join(output, "result.json")}`);
  if (root) console.log(`Isolated check data retained locally at ${root}. Do not upload browser-profile or database files.`);
}
