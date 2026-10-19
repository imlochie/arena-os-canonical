// Actual mission HTTP handlers, real PostgreSQL, real child SIGKILL, actual
// file/command dispatcher and actual workbench component in Chromium.
// Controlled model response is only setup: this is NOT reasoning acceptance.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { expect } from "@playwright/test";
import { missionPostgres } from "../helpers/mission-postgres.ts";
let f, handlers, runtime, tools, schema, server, browser, origin, globalPool;
const roots = [];
before(async () => {
  f = await missionPostgres(); process.env.DATABASE_URL = f.url;
  handlers = await import("../../src/app/api/spaces/[id]/mission/route.ts");
  runtime = await import("../../src/lib/spaces/mission.ts"); tools = await import("../../src/lib/spaces/tools.ts"); schema = await import("../../src/db/schema.ts");
  globalPool = (await import("../../src/db/index.ts")).pool;
  const bundle = await build({ entryPoints: ["tests/acceptance/mission-recovery.fixture.tsx"], bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", define: { "process.env": JSON.stringify({ NODE_ENV: "development" }) } });
  server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://fixture");
      if (url.pathname === "/fixture.js") { res.setHeader("content-type", "text/javascript"); return res.end(bundle.outputFiles[0].contents); }
      const match = url.pathname.match(/^\/api\/spaces\/([^/]+)\/mission$/);
      if (match) {
        let body = ""; for await (const chunk of req) body += chunk;
        const result = await handlers[req.method](new Request(url, { method: req.method, headers: { "content-type": "application/json" }, ...(req.method !== "GET" ? { body } : {}) }), { params: Promise.resolve({ id: match[1] }) });
        res.writeHead(result.status, Object.fromEntries(result.headers)); return res.end(Buffer.from(await result.arrayBuffer()));
      }
      res.setHeader("content-type", "text/html"); res.end('<!doctype html><div id="root"></div><script src="/fixture.js"></script>');
    } catch (error) { res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise((resolve) => server.listen(0, "0.0.0.0", resolve)); origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
});
after(async () => { await browser?.close(); await new Promise((resolve) => server ? server.close(resolve) : resolve()); await globalPool?.end(); await f?.close(); for (const root of roots) await rm(root, { recursive: true, force: true }); });
async function interrupted(boundary, lease = 200) {
  const id = randomUUID(); await f.database.insert(schema.spaces).values({ id, prompt: "Actual recovery UI" });
  const root = await tools.ensureWorkspace(id); roots.push(root);
  await writeFile(path.join(root, "increment.cjs"), "const fs=require('node:fs');const n=Number(fs.existsSync('count')?fs.readFileSync('count','utf8'):0);fs.writeFileSync('count',String(n+1));console.log('actual effect count',n+1);");
  const actions = [{ tool: "run_command", args: { command: "node increment.cjs" } }, { tool: "write_file", args: { path: "report.json", content: '{"retained":true}\n' } }];
  const child = spawnSync(process.execPath, ["--import", "./scripts/register-src-loader.mjs", "tests/fixtures/mission-crash.ts"], { env: { ...process.env, DATABASE_URL: f.url, RECOVERY_SPACE_ID: id, RECOVERY_BOUNDARY: boundary, RECOVERY_ACTIONS: JSON.stringify(actions), RECOVERY_LEASE_MS: String(lease) }, encoding: "utf8", timeout: 15000 });
  assert.equal(child.signal, "SIGKILL", child.stderr);
  return { id, root };
}
test("review in the real panel → actual HTTP/SQL audit → explicit resume → useful retained file, without duplicated command", async (t) => {
  const { id, root } = await interrupted("action_executed"); await new Promise((resolve) => setTimeout(resolve, 250));
  const before = await runtime.runMission(id, { goal: "Durable increment and inspection" }); assert.equal(before.status, "needs_reconciliation");
  const page = await browser.newPage(); page.setDefaultTimeout(7000); t.after(() => page.close());
  await page.goto(`${origin}/?space=${id}`);
  await expect(page.getByText(/run_command · uncertain/)).toBeVisible(); await expect(page.getByText("Storage: postgres", { exact: false })).toBeVisible();
  await page.getByLabel("Inspection evidence").fill("Inspected count in workspace: exact value 1, one committed command effect; checked native child is gone.");
  await page.getByRole("button", { name: "Save inspected outcome" }).click();
  await expect(page.getByText("checkpointed", { exact: true })).toBeVisible();
  const reviewed = await runtime.getLatestMission(id); assert.equal(reviewed.journal[0].requestedActions[0].resolutions.length, 1);
  assert.equal(await readFile(path.join(root, "report.json"), "utf8").catch(() => "absent"), "absent");
  await page.getByRole("button", { name: /▶ Resume/ }).click(); await expect(page.getByText("done", { exact: true }).first()).toBeVisible();
  const completed = await runtime.getLatestMission(id); assert.equal(completed.id, before.id); assert.equal(completed.status, "done");
  assert.equal(await readFile(path.join(root, "count"), "utf8"), "1"); assert.equal(await readFile(path.join(root, "report.json"), "utf8"), '{"retained":true}\n');
  await page.reload(); await page.getByText(/run_command · finished/).click(); await expect(page.getByText(/owner chose succeeded/)).toBeVisible(); await expect(page.getByText(/^workspace:.*report.json/)).toBeVisible();
});
test("active SQL lease yields actionable HTTP 409; panel can cancel the same persisted mission", async (t) => {
  const { id } = await interrupted("created", 30000);
  const page = await browser.newPage(); page.setDefaultTimeout(7000); t.after(() => page.close()); await page.goto(`${origin}/?space=${id}`);
  await page.getByRole("button", { name: /▶ Resume/ }).click(); await expect(page.getByRole("alert")).toContainText("active runner lease");
  await page.getByRole("button", { name: "Cancel mission" }).click(); await expect(page.getByText("cancelled", { exact: true })).toBeVisible();
  assert.equal((await runtime.getLatestMission(id)).status, "cancelled");
});
test("real database outage is visible, not empty/success; the panel recovers persisted work after SQL restart", async (t) => {
  const { id } = await interrupted("created", 30000);
  const page = await browser.newPage(); page.setDefaultTimeout(7000); t.after(() => page.close()); await page.goto(`${origin}/?space=${id}`);
  await expect(page.getByText("running", { exact: true })).toBeVisible();
  await f.stop(); await page.reload(); await expect(page.getByRole("alert")).toContainText("Mission storage unavailable");
  await f.start(); await expect(page.getByText("running", { exact: true })).toBeVisible(); await expect(page.getByRole("alert")).toHaveCount(0);
});

test("approval decisions reconnect to PostgreSQL after an outage instead of staying on an empty memory ledger", async () => {
  const id = randomUUID(); await f.database.insert(schema.spaces).values({ id, prompt: "Recover actual approval" });
  const root = await tools.ensureWorkspace(id); roots.push(root);
  const waiting = await runtime.runMission(id, { goal: "Review one local validation-only publication", isolation: "host", maxTurnsPerAgent: 1, agentPlan: [{ name: "Publisher", role: "worker", modelId: "controlled-protocol" }] }, { generate: async () => ({ text: JSON.stringify({ actions: [{ tool: "github_publish", args: { repo: "owner/never-contacted", files: [] } }], done: true }), backend: "arena-local-engine", runtimeLevel: "arena-local", via: "controlled-test", modelId: "controlled-protocol", fallback: false, ms: 0 }) });
  assert.equal(waiting.status, "awaiting_approval");
  const governance = await import("../../src/lib/spaces/governance.ts"); const [pending] = await governance.listApprovals(id); assert.equal(pending.status, "pending");
  await f.stop(); await assert.rejects(governance.listApprovals(id), /Approval storage unavailable/); await f.start();
  const [restored] = await governance.listApprovals(id); assert.equal(restored.id, pending.id);
  const approvals = await import("../../src/app/api/spaces/approvals/route.ts");
  const decision = await approvals.POST(new Request("http://fixture/api/spaces/approvals", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: restored.id, decision: "approve", decidedBy: "actual local owner" }) }));
  assert.equal(decision.status, 200); assert.equal((await governance.getApproval(restored.id)).status, "approved");
  const resumed = await runtime.runMission(id, { goal: waiting.goal });
  assert.equal(resumed.id, waiting.id); assert.equal(resumed.status, "incomplete", "actual publish validation failure is not completion or a remote publication claim");
});
