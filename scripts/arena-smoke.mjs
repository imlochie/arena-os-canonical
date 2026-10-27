import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";

const require = createRequire(new URL("../artifacts/api-server/package.json", import.meta.url));
const { chromium } = require("playwright-core");
const base = process.env.TEST_BASE_URL || "http://localhost:80";
const output = new URL("../generated-artifacts/arena-smoke/", import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || "/repl/tools/bin/chromium",
  headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await context.addInitScript(() => {
  localStorage.setItem("af_local_mode", "1");
  localStorage.setItem("af_ephemeral", "0");
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", err => errors.push(err.message));
const report = [];
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
