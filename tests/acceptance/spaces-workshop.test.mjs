// Actual Next pages + real HTTP routing, PostgreSQL and workspace dispatcher.
// Scripted provider responses control the scenario; NOT live agent reasoning,
// Electron, a live external integration, or container isolation acceptance.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright-core";
import { expect } from "@playwright/test";
import { missionPostgres } from "../helpers/mission-postgres.ts";
const sha = value => createHash("sha256").update(value).digest("hex");
const evidenceDir = path.resolve(".data/spaces-workshop-acceptance");
const original = "export const answer = 41;\n", corrected = "export const answer = 42;\n";
const testSource = 'import test from "node:test";import assert from "node:assert/strict";import{answer}from"./answer.mjs";test("answer is 42",()=>assert.equal(answer,42));\n';
const effectSource = 'import{appendFileSync}from"node:fs";appendFileSync("effects.log","once\\n");setInterval(()=>{},1000);\n';
const testCommand = "node --test --test-reporter=tap verify.test.mjs";

test("real Spaces workshop repairs and verifies workspace files, retains immutable outputs and resumes uncertain work without replay", { timeout: 180000 }, async t => {
  await mkdir(evidenceDir, { recursive: true });
  const root = await mkdtemp(path.join(tmpdir(), "arena-spaces-workshop-"));
  const receipt = { commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), scope: "Actual Next workbench/pop-out, real PostgreSQL, host-jail commands and Artifacts; SCRIPTED provider HTTP replies. No live model intelligence, external integration, container or Electron claim.", modelCalls: [], extraProviderPaths: [] };
  let pg, provider, server, browser, context, page, workspace, logs = "";
  async function stopServer() {
    if (!server || server.exitCode !== null) return;
    const current = server, exited = once(current, "exit");
    current.kill("SIGTERM"); const kill = setTimeout(() => current.kill("SIGKILL"), 3000);
    try { await exited; } finally { clearTimeout(kill); }
  }
  t.after(async () => {
    await context?.tracing.stop({ path: path.join(evidenceDir, "workshop-trace.zip") }).catch(() => {});
    await browser?.close(); await stopServer();
    if (provider) await new Promise(resolve => provider.close(resolve));
    await pg?.close(); if (workspace) await rm(workspace, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
    await writeFile(path.join(evidenceDir, "server.log"), logs);
    await writeFile(path.join(evidenceDir, "receipt.json"), JSON.stringify(receipt, null, 2));
  });
  try {
    pg = await missionPostgres();
    provider = createServer(async (req, res) => {
      if (req.url !== "/v1/chat/completions") { receipt.extraProviderPaths.push(req.url); res.writeHead(404).end(); return; }
      let text = ""; for await (const chunk of req) text += chunk;
      const input = JSON.parse(text), turn = receipt.modelCalls.length + 1;
      const prompt = input.messages.at(-1).content;
      receipt.modelCalls.push({ turn, model: input.model, sawRealFailedTest: prompt.includes("not ok 1") && prompt.includes("answer is 42"), sawHostJailNotice: prompt.includes("HOST") });
      const response = turn === 1
        ? { thought: "Create a deliberately failing regression, then observe its real result.", actions: [
          { tool: "write_file", args: { path: "answer.mjs", content: original } },
          { tool: "write_file", args: { path: "verify.test.mjs", content: testSource } },
          { tool: "write_file", args: { path: "effect.mjs", content: effectSource } },
          { tool: "run_tests", args: { command: testCommand } },
        ], done: false }
        : { thought: "Repair the observed failure, rerun its test, then exercise the controlled post-effect timeout.", actions: [
          { tool: "edit_file", args: { path: "answer.mjs", old_text: "answer = 41", new_text: "answer = 42" } },
          { tool: "run_tests", args: { command: testCommand } },
          { tool: "run_command", args: { command: "node effect.mjs" } },
        ], done: true, handoff: "Inspect the recorded test outputs and pinned corrected answer Artifact. Reconcile any uncertain effect before continuation." };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(response) } }] }));
    });
    await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
    const providerUrl = `http://127.0.0.1:${provider.address().port}`;
    const probe = createServer(); await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
    const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
    const origin = `http://127.0.0.1:${port}`;
    async function startServer() {
      server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1", "-p", String(port)], {
        env: { ...process.env, DATABASE_URL: pg.url, WAVEYARD_STORAGE_DIR: root, ARENA_DESKTOP_MODE: "1", WAVEYARD_LOCAL_WORKER: "0", TURBOAGENT_URL: providerUrl },
        stdio: ["ignore", "pipe", "pipe"],
      });
      for (const stream of [server.stdout, server.stderr]) stream.on("data", chunk => { logs = (logs + chunk).slice(-100000); });
      await expect.poll(async () => { try { return (await fetch(`${origin}/spaces`)).status; } catch { return 0; } }, { timeout: 45000 }).toBe(200);
    }
    await startServer();
    browser = await chromium.launch({ executablePath: process.env.ARENA_SPACES_CHROMIUM_PATH || undefined, headless: true, args: process.env.CI === "true" ? ["--no-sandbox", "--disable-dev-shm-usage"] : [] });
    context = await browser.newContext({ acceptDownloads: true });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    await context.addInitScript(url => { localStorage.setItem("af_url_turboagent", url); localStorage.setItem("af_local_mode", "0"); localStorage.setItem("af_ephemeral", "0"); }, providerUrl);
    page = await context.newPage(); page.setDefaultTimeout(20000);
    await page.goto(`${origin}/spaces`);
    await page.getByLabel("Title", { exact: true }).fill("Controlled software workshop");
    // Playwright's implicit-label name includes the textarea's initial value.
    // Match the stable label prefix, not that entire changing accessible name.
    await page.getByLabel(/^Task prompt\b/).fill("Prepare reviewable workspace changes and recorded tests; do not publish externally.");
    const createdPromise = page.waitForResponse(r => r.url() === `${origin}/api/spaces` && r.request().method() === "POST");
    await page.getByRole("button", { name: "🪟 Create space", exact: true }).click();
    const createdHttp = await createdPromise, created = await createdHttp.json();
    assert.equal(createdHttp.status(), 201); const id = created.space.id;
    assert.match(id, /^[a-f0-9-]{36}$/);
    workspace = path.resolve(".data/space-workspaces", id);
    await page.getByRole("button", { name: "⏸ Pause", exact: true }).click();
    await expect(page.getByRole("button", { name: "▶ Resume", exact: true })).toBeVisible();
    const popupPromise = page.waitForEvent("popup");
    await page.getByTitle("Pop out into its own browser window").click();
    const previous = page; page = await popupPromise; await previous.close(); page.setDefaultTimeout(20000);
    await page.waitForURL(`${origin}/spaces/${id}`);
    let workshop = page.getByRole("region", { name: "Space mission workshop" });
    await expect(workshop).toBeVisible();
    await workshop.getByRole("button", { name: "+ Agent", exact: true }).click();
    await workshop.getByPlaceholder("Name (e.g. Researcher)").fill("Workspace verifier");
    await workshop.getByPlaceholder("Role (worker, critic, planner…)").fill("builder");
    await workshop.getByLabel("Fleet agent model").selectOption("turboagent-7b");
    await workshop.getByRole("button", { name: "Add agent", exact: true }).click();
    await expect(workshop.getByText("Agent fleet · 1", { exact: true })).toBeVisible();
    await workshop.getByTitle("Agent iteration budget + extra command allowlist").click();
    await workshop.getByTitle(/^Where commands run/).selectOption("host");
    await workshop.getByTitle(/^Turns per agent/).selectOption("3");
    await workshop.getByLabel("Mission goal").fill("Repair answer.mjs to 42, prove the regression, retain outputs, and inspect the controlled one-effect timeout probe.");
    const firstMissionPromise = page.waitForResponse(r => r.url() === `${origin}/api/spaces/${id}/mission` && r.request().method() === "POST", { timeout: 60000 });
    await workshop.getByRole("button", { name: "🚀 Run mission", exact: true }).click();
    const firstHttp = await firstMissionPromise, first = (await firstHttp.json()).mission;
    assert.equal(firstHttp.status(), 200); assert.equal(first.status, "needs_reconciliation");
    assert.equal(receipt.modelCalls.length, 2); assert.equal(receipt.modelCalls[1].sawRealFailedTest, true);
    const tests = first.journal.flatMap(step => step.actions).filter(action => action.tool === "run_tests");
    assert.equal(tests.length, 2); assert.equal(tests[0].ok, false); assert.equal(tests[1].ok, true);
    assert.match(tests[0].output, /# fail 1/); assert.match(tests[1].output, /# pass 1/);
    assert.equal(await readFile(path.join(workspace, "answer.mjs"), "utf8"), corrected);
    assert.equal(await readFile(path.join(workspace, "effects.log"), "utf8"), "once\n");
    await page.screenshot({ path: path.join(evidenceDir, "uncertain-before-restart.png"), fullPage: true });
    await stopServer(); await startServer(); await page.reload();
    workshop = page.getByRole("region", { name: "Space mission workshop" });
    await expect(workshop.getByText("needs_reconciliation", { exact: true })).toBeVisible();
    const resumedPromise = page.waitForResponse(r => r.url() === `${origin}/api/spaces/${id}/mission` && r.request().method() === "POST");
    await workshop.getByRole("button", { name: "▶ Resume", exact: true }).click();
    const recovered = (await (await resumedPromise).json()).mission;
    assert.equal(recovered.id, first.id); assert.equal(recovered.status, "needs_reconciliation");
    assert.equal(await readFile(path.join(workspace, "effects.log"), "utf8"), "once\n", "uncertain effect was not automatically replayed");
    const reviewText = `Test operator inspected effects.log: exactly one once line, SHA-256 ${sha("once\n")}. Actual command hung after that write and timed out; do not retry.`;
    await workshop.getByLabel("Inspected outcome").selectOption("succeeded");
    await workshop.getByLabel("Inspection evidence").fill(reviewText);
    const reviewPromise = page.waitForResponse(r => r.url() === `${origin}/api/spaces/${id}/mission` && r.request().postData()?.includes('"operation":"reconcile"'));
    await workshop.getByRole("button", { name: "Save inspected outcome", exact: true }).click(); await reviewPromise;
    const finalPromise = page.waitForResponse(r => r.url() === `${origin}/api/spaces/${id}/mission` && r.request().method() === "POST");
    await workshop.getByRole("button", { name: "▶ Resume", exact: true }).click();
    const final = (await (await finalPromise).json()).mission;
    assert.equal(final.id, first.id); assert.equal(final.status, "done");
    assert.equal(receipt.modelCalls.length, 2, "stored model/action requests were resumed, not regenerated");
    assert.equal(await readFile(path.join(workspace, "effects.log"), "utf8"), "once\n");
    const summary = workshop.getByRole("region", { name: "Mission evidence summary" });
    await expect(summary).toContainText("Test-tool commands: 1 succeeded · 1 failed");
    await expect(summary).toContainText("Owner-reviewed outcomes: 1 — not independently machine-verified.");
    const output = final.artifacts.find(item => item.path === "answer.mjs" && item.tool === "edit_file");
    assert.equal(output.state, "complete"); assert.equal(output.checksumSha256, sha(corrected));
    assert.ok(output.artifactId && output.revisionId);
    const item = workshop.getByRole("region", { name: "Mission outputs" }).getByRole("listitem").filter({ hasText: output.checksumSha256 });
    await item.getByRole("button", { name: "View answer.mjs", exact: true }).click();
    await expect(item.locator("pre")).toHaveText(corrected.trim());
    const downloadPromise = page.waitForEvent("download");
    await item.getByRole("link", { name: "Download answer.mjs", exact: true }).click();
    const downloaded = await downloadPromise, bytes = await readFile(await downloaded.path());
    assert.equal(bytes.toString(), corrected); assert.equal(sha(bytes), output.checksumSha256);
    await item.getByRole("button", { name: "Prepare reuse answer.mjs", exact: true }).click();
    await expect(workshop.getByLabel("Mission goal")).toHaveValue(new RegExp(output.revisionId));
    assert.equal(receipt.modelCalls.length, 2, "preparing reuse does not dispatch work");
    await page.screenshot({ path: path.join(evidenceDir, "verified-workshop.png"), fullPage: true });
    receipt.status = "passed"; receipt.spaceId = id; receipt.missionId = final.id;
    receipt.runtime = final.journal.map(step => step.runtime); receipt.testRuns = tests;
    receipt.deliverable = output; receipt.downloadSha256 = sha(bytes); receipt.effectCount = 1;
    receipt.restartBoundary = "Persisted command timeout after file effect, needs_reconciliation; real app server stop/restart. Not an injected executor or abrupt post-return checkpoint crash.";
    receipt.provenance = final.journal.flatMap(step => step.actions).map(action => ({ tool: action.tool, requestId: action.requestId, ok: action.ok, provenance: action.provenance }));
  } catch (error) {
    receipt.status = "failed"; receipt.error = String(error);
    await page?.screenshot({ path: path.join(evidenceDir, "failure.png"), fullPage: true }).catch(() => {});
    throw error;
  }
});
