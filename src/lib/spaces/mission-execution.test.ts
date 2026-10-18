// Controlled model replies exercise the production dispatcher, real files and
// real child processes. This is execution-contract evidence, NOT autonomous
// model repair acceptance. No provider output is fabricated as a live model.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { applyMigrations } from "../../../desktop/runtime/migrate";
import { spaces } from "@/db/schema";
import type { db } from "@/db";
import { ensureWorkspace, executeTool, workspaceDir } from "./tools";
import { getLatestMission, runMission as runDurableMission } from "./mission";
import type { generate } from "../ai";

async function workspace(t: { after(fn: () => Promise<void>): void }) {
  const id = randomUUID(); const root = await ensureWorkspace(id);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { id, root };
}
const plan = [{ name: "Repairer", role: "worker", modelId: "controlled-contract" }];
function reply(actions: Array<{ tool: string; args: Record<string, unknown> }>, done = true): Awaited<ReturnType<typeof generate>> {
  return { text: JSON.stringify({ thought: "controlled dispatcher contract", actions, done }), backend: "arena-local-engine", runtimeLevel: "arena-local", modelId: "controlled-contract", via: "controlled-test", fallback: false, ms: 0 };
}

test("nonzero child exit is a failed tool outcome, not successful execution", async (t) => {
  const f = await workspace(t); await writeFile(path.join(f.root, "fail.cjs"), "process.exit(7)");
  const outcome = await executeTool(f.id, { tool: "run_command", args: { command: "node fail.cjs" } });
  assert.equal(outcome.ok, false); assert.match(outcome.output, /exit 7/);
});

test("actual failing tests and absent tests cannot return ok:true", async (t) => {
  const f = await workspace(t);
  const absent = await executeTool(f.id, { tool: "run_tests", args: {} }); assert.equal(absent.ok, false);
  await writeFile(path.join(f.root, "failure.test.cjs"), "require('node:test')('must fail',()=>require('node:assert/strict').equal(2,3));");
  const outcome = await executeTool(f.id, { tool: "run_tests", args: {} });
  assert.equal(outcome.ok, false); assert.match(outcome.output, /AssertionError/);
});

test("done:true cannot override a real failing test; bounded run retains failure", async (t) => {
  const f = await workspace(t);
  await writeFile(path.join(f.root, "failure.test.cjs"), "require('node:test')('must fail',()=>require('node:assert/strict').equal(2,3));");
  const mission = await runMission(f.id, { goal: "repair the failing invariant", isolation: "host", agentPlan: plan, maxTurnsPerAgent: 1 }, { generate: async () => reply([{ tool: "run_tests", args: {} }]) });
  assert.notEqual(mission.status, "done"); assert.equal(mission.journal[0].done, false);
  assert.equal(mission.journal[0].actions[0].ok, false);
  const recovered = await getLatestMission(f.id); assert.equal(recovered?.status, mission.status);
});

test("turn exhaustion without explicit completion cannot claim done", async (t) => {
  const f = await workspace(t);
  const mission = await runMission(f.id, { goal: "inspect, then repair", isolation: "host", agentPlan: plan, maxTurnsPerAgent: 1 }, { generate: async () => reply([{ tool: "list_files", args: {} }], false) });
  assert.notEqual(mission.status, "done");
});

test("real dispatcher feedback can investigate, patch source (not its invariant), rerun, and retrieve the transcript", async (t) => {
  const f = await workspace(t);
  await writeFile(path.join(f.root, "sum.cjs"), "exports.sum=(a,b)=>a-b;\n");
  const storage = await mkdtemp(path.join(tmpdir(), "arena-mission-sql-"));
  let client = new PGlite(storage);
  t.after(async () => { await client.close(); await rm(storage, { recursive: true, force: true }); });
  await applyMigrations({ client: client as unknown as import("pg").Client, migrationsDir: fileURLToPath(new URL("../../../desktop-migrations", import.meta.url)) });
  const database = drizzle(client) as unknown as typeof db;
  await database.insert(spaces).values({ id: f.id, prompt: "Controlled real-tool repair fixture" });
  const invariant = "require('node:test')('sum invariant',()=>require('node:assert/strict').equal(require('./sum.cjs').sum(2,3),5));\n";
  await writeFile(path.join(f.root, "sum.test.cjs"), invariant);
  let turn = 0;
  const mission = await runMission(f.id, { goal: "Repair sum without changing the invariant", isolation: "host", agentPlan: plan, maxTurnsPerAgent: 2 }, { database, generate: async (input) => {
    if (++turn === 1) return reply([{ tool: "search_code", args: { pattern: "exports.sum" } }, { tool: "read_file", args: { path: "sum.cjs" } }, { tool: "run_tests", args: {} }], false);
    assert.match(input.messages[0].content, /AssertionError|ERR_ASSERTION/);
    const intermediate = await getLatestMission(f.id, database);
    assert.equal(intermediate?.status, "running");
    assert.equal(intermediate?.journal[0].actions.length, 3, "tool observations persisted before next model call");
    return reply([{ tool: "edit_file", args: { path: "sum.cjs", old_text: "a-b", new_text: "a+b" } }, { tool: "run_tests", args: {} }]);
  } });
  assert.equal(mission.status, "done");
  assert.equal(await readFile(path.join(workspaceDir(f.id), "sum.test.cjs"), "utf8"), invariant);
  assert.match(await readFile(path.join(f.root, "sum.cjs"), "utf8"), /a\+b/);
  await client.close(); client = new PGlite(storage);
  const recovered = await getLatestMission(f.id, drizzle(client) as unknown as typeof db);
  assert.equal(recovered?.journal.length, 2);
  const runs = recovered!.journal.flatMap((step) => step.actions).filter((action) => action.tool === "run_tests");
  assert.deepEqual(runs.map((run) => run.ok), [false, true]);
  if (process.env.ARENA_AGENT_EVIDENCE_DIR) {
    await mkdir(process.env.ARENA_AGENT_EVIDENCE_DIR, { recursive: true });
    const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
    await writeFile(path.join(process.env.ARENA_AGENT_EVIDENCE_DIR, `${f.id}.json`), JSON.stringify({
      evidenceKind: "controlled-model-real-tools-real-SQL-reopen", limitations: ["not genuine model reasoning", "not host isolation or a repository self-repair acceptance", "PGlite PostgreSQL-compatible database, not desktop embedded PG"],
      missionSourceSha256: sha(await readFile(new URL("./mission.ts", import.meta.url))), invariantSha256: sha(invariant), repairedSource: await readFile(path.join(f.root, "sum.cjs"), "utf8"), recovered,
    }, null, 2), { flag: "wx" });
  }
});

// Ephemeral cases opt in; the persistence case supplies its real SQL adapter.
const runMission: typeof runDurableMission = (id, opts, deps = {}) => runDurableMission(id, opts, { memoryOnly: !deps.database, ...deps });
