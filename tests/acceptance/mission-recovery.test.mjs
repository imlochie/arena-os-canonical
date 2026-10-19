// Actual mission HTTP handlers, real PostgreSQL, real child SIGKILL, actual
// file/command dispatcher and actual workbench component in Chromium.
// Controlled model response is only setup: this is NOT reasoning acceptance.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFile, readFile, rm, mkdtemp, symlink } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { expect } from "@playwright/test";
import { missionPostgres } from "../helpers/mission-postgres.ts";
let f, handlers, outputsHandler, runtime, tools, schema, server, browser, origin, globalPool;
const roots = [];
before(async () => {
  f = await missionPostgres(); process.env.DATABASE_URL = f.url;
  process.env.WAVEYARD_STORAGE_DIR = await mkdtemp(path.join(tmpdir(), "arena-mission-output-storage-")); roots.push(process.env.WAVEYARD_STORAGE_DIR);
  handlers = await import("../../src/app/api/spaces/[id]/mission/route.ts");
  outputsHandler = await import("../../src/app/api/spaces/[id]/mission/outputs/[outputId]/route.ts");
  runtime = await import("../../src/lib/spaces/mission.ts"); tools = await import("../../src/lib/spaces/tools.ts"); schema = await import("../../src/db/schema.ts");
  globalPool = (await import("../../src/db/index.ts")).pool;
  const bundle = await build({ entryPoints: ["tests/acceptance/mission-recovery.fixture.tsx"], bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", define: { "process.env": JSON.stringify({ NODE_ENV: "development" }) } });
  server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://fixture");
      if (url.pathname === "/fixture.js") { res.setHeader("content-type", "text/javascript"); return res.end(bundle.outputFiles[0].contents); }
      const outputMatch = url.pathname.match(/^\/api\/spaces\/([^/]+)\/mission\/outputs\/([^/]+)$/);
      if (outputMatch) {
        const result = await outputsHandler.GET(new Request(url, { headers: { host: "localhost" } }), { params: Promise.resolve({ id: outputMatch[1], outputId: outputMatch[2] }) });
        res.writeHead(result.status, Object.fromEntries(result.headers)); return res.end(Buffer.from(await result.arrayBuffer()));
      }
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
  await page.reload(); await page.getByText(/run_command · finished/).click(); await expect(page.getByText(/owner chose succeeded/)).toBeVisible(); await expect(page.getByRole("link", { name: "Download report.json", exact: true })).toBeVisible();
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

test("mission panel retrieves immutable outputs after SQL restart and later edits, checks downloads, and reuses pinned content", async (t) => {
  const id = randomUUID(); await f.database.insert(schema.spaces).values({ id, prompt: "Retrieve real deliverables" }); roots.push(await tools.ensureWorkspace(id));
  const original = '{"actual":true,"retained":"original"}\n';
  const plan = (actions) => ({ generate: async () => ({ text: JSON.stringify({ actions, done: true }), backend: "controlled-protocol", runtimeLevel: "arena-local", via: "controlled-test", modelId: "not-reasoning", fallback: false, ms: 0 }) });
  const opts = { goal: "Create reports for later retrieval", isolation: "host", maxTurnsPerAgent: 1, agentPlan: [{ name: "Contract writer", role: "worker", modelId: "controlled-protocol" }] };
  const mission = await runtime.runMission(id, opts, plan([{ tool: "write_file", args: { path: "report.json", content: original } }, { tool: "write_file", args: { path: "notes.md", content: "# Useful retained work\n" } }, { tool: "write_file", args: { path: "generated.js", content: "console.log('VERIFIED_REPORT');\n" } }, { tool: "run_command", args: { command: "node generated.js" } }]));
  assert.equal(mission.status, "done"); assert.equal(mission.artifacts.length, 4); assert.ok(mission.artifacts.every((output) => output.state === "complete" && output.revisionId));
  const report = mission.artifacts.find((output) => output.path === "report.json");
  await f.stop(); await f.start();
  const page = await browser.newPage(); page.setDefaultTimeout(7000); t.after(() => page.close()); await page.goto(`${origin}/?space=${id}`);
  await page.getByRole("button", { name: "View report.json", exact: true }).click(); await expect(page.locator("pre").filter({ hasText: '"retained":"original"' })).toBeVisible();
  const downloadPromise = page.waitForEvent("download"); await page.getByRole("link", { name: "Download report.json", exact: true }).click(); const bytes = await readFile(await (await downloadPromise).path());
  assert.equal(bytes.toString("utf8"), original); assert.equal(createHash("sha256").update(bytes).digest("hex"), report.checksumSha256);
  const later = await runtime.runMission(id, { ...opts, goal: "Reuse old work and retain useful partial results" }, plan([{ tool: "reuse_mission_output", args: { sourceSpaceId: id, missionId: mission.id, outputId: report.id, path: "reused.json" } }, { tool: "write_file", args: { path: "report.json", content: '{"different":"later task"}\n' } }, { tool: "write_file", args: { path: "broken.js", content: "function {" } }]));
  assert.equal(later.status, "incomplete"); assert.equal(await readFile(path.join(tools.workspaceDir(id), "reused.json"), "utf8"), original);
  assert.equal(later.artifacts.find((output) => output.path === "broken.js").state, "unavailable");
  await page.reload(); await expect(page.getByRole("link", { name: "Download reused.json", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Download broken.js", exact: true })).toHaveCount(0);
  await page.getByRole("combobox", { name: "Mission history", exact: true }).selectOption(mission.id);
  await expect(page.getByRole("link", { name: "Download notes.md", exact: true })).toBeVisible();
  const oldDownload = page.waitForEvent("download"); await page.getByRole("link", { name: "Download report.json", exact: true }).click(); assert.equal(await readFile(await (await oldDownload).path(), "utf8"), original);
  // An arbitrary/other-space reference and changed ownership cannot resolve.
  const endpoint = (space = id) => new Request(`${origin}/api/spaces/${space}/mission/outputs/${report.id}?missionId=${mission.id}`, { headers: { host: "localhost" } });
  const ctx = (space = id) => ({ params: Promise.resolve({ id: space, outputId: report.id }) });
  assert.equal((await outputsHandler.GET(endpoint(randomUUID()), ctx(randomUUID()))).status, 410);
  const { artifacts } = await import("../../src/db/schema.ts"); const { eq } = await import("drizzle-orm");
  await f.database.update(artifacts).set({ ownerId: "foreign-owner" }).where(eq(artifacts.id, report.artifactId));
  assert.equal((await outputsHandler.GET(endpoint(), ctx())).status, 410); await f.database.update(artifacts).set({ ownerId: "00000000-0000-4000-8000-000000000001" }).where(eq(artifacts.id, report.artifactId));
  const { getStorage } = await import("../../src/lib/waveyard/storage.ts"); const object = getStorage().getLocalPath(`owners/00000000-0000-4000-8000-000000000001/mission-outputs/${report.checksumSha256}.bin`);
  await writeFile(object, "corrupted");
  try { const corrupted = await outputsHandler.GET(endpoint(), ctx()); assert.equal(corrupted.status, 410); assert.match((await corrupted.json()).error, /checksum/); }
  finally { await writeFile(object, bytes); }
  const outside = path.join(process.env.WAVEYARD_STORAGE_DIR, "unrelated-private.txt"); await writeFile(outside, "PRIVATE UNCHANGED"); await symlink(outside, path.join(tools.workspaceDir(id), "outside.txt"));
  const refusedWrite = await tools.executeTool(id, { tool: "write_file", args: { path: "outside.txt", content: "must not escape" } }); assert.equal(refusedWrite.ok, false);
  const refusedOutput = await tools.executeTool(id, { tool: "publish_output", args: { path: "outside.txt" } }); assert.equal(refusedOutput.ok, false); assert.equal(await readFile(outside, "utf8"), "PRIVATE UNCHANGED");
});

test("SIGKILL after immutable output capture before mission advancement recovers one original revision without rewriting the file", async () => {
  const id = randomUUID(); await f.database.insert(schema.spaces).values({ id, prompt: "Durable output interruption" }); const root = await tools.ensureWorkspace(id); roots.push(root);
  const content = "Original captured deliverable before interruption\n";
  const child = spawnSync(process.execPath, ["--import", "./scripts/register-src-loader.mjs", "tests/fixtures/mission-crash.ts"], { env: { ...process.env, DATABASE_URL: f.url, RECOVERY_SPACE_ID: id, RECOVERY_BOUNDARY: "output_captured", RECOVERY_ACTIONS: JSON.stringify([{ tool: "write_file", args: { path: "interrupted.txt", content } }]), RECOVERY_LEASE_MS: "200" }, encoding: "utf8", timeout: 15000 }); assert.equal(child.signal, "SIGKILL", child.stderr);
  const { artifacts, artifactRevisions } = await import("../../src/db/schema.ts"); const { eq } = await import("drizzle-orm");
  const interrupted = await runtime.getLatestMission(id); assert.equal(interrupted.artifacts.length, 0); assert.equal(interrupted.journal[0].requestedActions[0].state, "executing");
  const [captured] = await f.database.select().from(artifacts).where(eq(artifacts.sourceId, interrupted.id)); assert.ok(captured);
  const { updateArtifact } = await import("../../src/lib/arcadeStore.ts");
  await updateArtifact(f.database, captured.id, captured.ownerId, { body: "A later owner edit must not reinterpret the earlier output" }, 1);
  await new Promise((resolve) => setTimeout(resolve, 250)); const resumed = await runtime.runMission(id, { goal: interrupted.goal }); assert.equal(resumed.status, "done");
  assert.equal(resumed.artifacts.length, 1); assert.equal(resumed.artifacts[0].artifactId, captured.id); assert.equal(resumed.artifacts[0].revisionId, captured.currentRevisionId);
  assert.equal((await f.database.select().from(artifacts).where(eq(artifacts.sourceId, interrupted.id))).length, 1);
  assert.equal((await f.database.select().from(artifactRevisions).where(eq(artifactRevisions.artifactId, captured.id))).length, 2, "only the explicitly authorised edit created another revision");
  const { retrieveMissionOutput } = await import("../../src/lib/spaces/mission-outputs.ts"); assert.equal((await retrieveMissionOutput(id, resumed.id, resumed.artifacts[0].id)).bytes.toString("utf8"), content);
  assert.equal(await readFile(path.join(root, "interrupted.txt"), "utf8"), content);
});
