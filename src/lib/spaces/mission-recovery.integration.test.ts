// Real PostgreSQL + actual mission dispatcher/files/child restart. Model
// replies are deterministic contracts, NOT autonomous reasoning acceptance.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { spaces, spaceActionApprovals, spaceAgents, spaceMissions } from "@/db/schema";
import { ensureWorkspace } from "./tools";
import { getLatestMission, runMission, reconcileMission, cancelMission, MissionBusyError } from "./mission";
import { eq } from "drizzle-orm";
import { missionPostgres } from "../../../tests/helpers/mission-postgres";
import { assertActuallyKilled } from "../../../tests/helpers/platform-exit";
/** Startup allowance for the crash fixture: it boots a real process, connects
 * to PostgreSQL, calls a model and executes a command before reaching the
 * boundary. 15 s was enough on Linux and not on a Windows runner, where the
 * harness — not the fixture — killed it at `turn_recorded`. The assertion is
 * unchanged; only the allowance for the fixture to arrive is. */
const FIXTURE_TIMEOUT_MS = 60_000;

let f: Awaited<ReturnType<typeof missionPostgres>>;
before(async () => { f = await missionPostgres(); });
after(async () => { await f?.close(); });
function failSpaceAgentReads<T extends object>(database: T, failure: Error): T {
  return new Proxy(database, {
    get(target, property) {
      const original = Reflect.get(target, property, target);
      if (property === "select" && typeof original === "function") {
        return (...args: unknown[]) => {
          const query = original.apply(target, args) as object;
          return new Proxy(query, {
            get(queryTarget, queryProperty) {
              if (queryProperty === "from") {
                return (table: unknown) => {
                  if (table === spaceAgents) throw failure;
                  const from = Reflect.get(queryTarget, "from", queryTarget) as (table: unknown) => unknown;
                  return from.call(queryTarget, table);
                };
              }
              const value = Reflect.get(queryTarget, queryProperty, queryTarget);
              return typeof value === "function" ? value.bind(queryTarget) : value;
            },
          });
        };
      }
      return typeof original === "function" ? original.bind(target) : original;
    },
  });
}
test("a fresh default mission routes every role through its selected Space model and records actual execution", async () => {
  const id = randomUUID();
  const selectedModel = "groq/llama-3.3-70b-versatile";
  await f.database.insert(spaces).values({ id, prompt: "Selected-model routing fixture", modelId: selectedModel });
  const dispatched: string[] = [];
  const mission = await runMission(id, { goal: "Exercise the default mission plan", isolation: "host" }, {
    database: f.database,
    generate: async (input) => {
      dispatched.push(input.modelId);
      return {
        text: JSON.stringify({ actions: [], done: true }),
        provider: "Arena",
        backend: "arena-local-engine",
        runtimeLevel: "arena-local",
        modelId: "local-engine",
        requestedModelId: selectedModel,
        via: "offline-fallback",
        ms: 0,
        fallback: true,
        fallbackFrom: { runtimeLevel: "remote", backend: "groq", modelId: selectedModel },
        fallbackReason: "Provider key is not configured.",
      };
    },
  });
  assert.deepEqual(mission.agentPlan.map((agent) => agent.modelId), [selectedModel, selectedModel, selectedModel]);
  assert.deepEqual(dispatched, [selectedModel, selectedModel, selectedModel]);
  assert.deepEqual(mission.journal.map((step) => ({
    requested: step.runtime?.agentModelId,
    providerRequest: step.runtime?.requestedModelId,
    actual: step.runtime?.modelId,
    provider: step.runtime?.provider,
    backend: step.runtime?.backend,
    fallback: step.runtime?.fallback,
    reason: step.runtime?.fallbackReason,
  })), [
    { requested: selectedModel, providerRequest: selectedModel, actual: "local-engine", provider: "Arena", backend: "arena-local-engine", fallback: true, reason: "Provider key is not configured." },
    { requested: selectedModel, providerRequest: selectedModel, actual: "local-engine", provider: "Arena", backend: "arena-local-engine", fallback: true, reason: "Provider key is not configured." },
    { requested: selectedModel, providerRequest: selectedModel, actual: "local-engine", provider: "Arena", backend: "arena-local-engine", fallback: true, reason: "Provider key is not configured." },
  ]);

  const explicitModel = "openrouter/user-selected-model";
  const explicitRequests: string[] = [];
  const overridden = await runMission(id, {
    goal: "Use the explicit per-mission model override",
    isolation: "host",
    agentPlan: [{ name: "Override", role: "explicit override", modelId: explicitModel }],
  }, {
    database: f.database,
    generate: async (input) => {
      explicitRequests.push(input.modelId);
      return {
        text: JSON.stringify({ actions: [], done: true }),
        backend: "openrouter",
        runtimeLevel: "remote",
        modelId: "user-selected-model",
        requestedModelId: explicitModel,
        provider: "OpenRouter",
        via: "openrouter",
        ms: 0,
        fallback: false,
      };
    },
  });
  assert.deepEqual(overridden.agentPlan.map((agent) => agent.modelId), [explicitModel]);
  assert.deepEqual(explicitRequests, [explicitModel]);
  assert.equal(overridden.journal[0]?.runtime?.modelId, "user-selected-model");
  assert.equal(overridden.journal[0]?.runtime?.fallback, false);
});
test("a fresh mission honors its configured Space fleet from the injected PostgreSQL database", async () => {
  const id = randomUUID();
  const selectedModel = "space-default/unused-when-fleet-configured";
  const fleet = [
    { name: "Planner", role: "plan", modelId: "groq/planner" },
    { name: "Builder", role: "implement", modelId: "openrouter/builder" },
    { name: "Reviewer", role: "verify", modelId: "gemini/reviewer" },
  ];
  await f.database.insert(spaces).values({ id, prompt: "Injected fleet routing fixture", modelId: selectedModel });
  await f.database.insert(spaceAgents).values(fleet.map((agent, index) => ({
    spaceId: id,
    ...agent,
    systemPrompt: `role ${agent.role}`,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)),
  })));
  const routed: string[] = [];
  const mission = await runMission(id, { goal: "Exercise the configured Space fleet", isolation: "host" }, {
    database: f.database,
    generate: async (input) => {
      routed.push(input.modelId);
      return result([{ tool: "list_files", args: {} }]);
    },
  });
  assert.equal(mission.status, "done");
  assert.deepEqual(mission.agentPlan.map((agent) => agent.modelId), fleet.map((agent) => agent.modelId));
  assert.deepEqual(routed, fleet.map((agent) => agent.modelId));
});
test("a failed fleet read stops before mission creation or provider dispatch", async () => {
  const id = randomUUID();
  await f.database.insert(spaces).values({ id, prompt: "Fleet read failure fixture", modelId: "space-default/unused" });
  let providerCalls = 0;
  const failedDatabase = failSpaceAgentReads(f.database, new Error("configured fleet could not be read"));
  await assert.rejects(
    runMission(id, { goal: "Do not silently replace a configured fleet", isolation: "host" }, {
      database: failedDatabase,
      generate: async () => {
        providerCalls += 1;
        return result([{ tool: "list_files", args: {} }]);
      },
    }),
    /configured fleet could not be read/,
  );
  assert.equal(providerCalls, 0);
  assert.equal(await getLatestMission(id, f.database), null);
});
test("a killed runtime resumes its recorded next agent without duplicating a committed command", async (t) => {
  const id = randomUUID(); await f.database.insert(spaces).values({ id, prompt: "Crash recovery fixture" });
  const root = await ensureWorkspace(id); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "increment.cjs"), "const fs=require('node:fs');const n=Number(fs.existsSync('count')?fs.readFileSync('count','utf8'):0);fs.writeFileSync('count',String(n+1));");
  const child = spawnSync(process.execPath, ["--import", "./scripts/register-src-loader.mjs", "tests/fixtures/mission-crash.ts"], { env: { ...process.env, DATABASE_URL: f.url, RECOVERY_SPACE_ID: id }, encoding: "utf8", timeout: FIXTURE_TIMEOUT_MS });
  assert.equal(child.status, 73, child.stderr);
  const interrupted = await getLatestMission(id, f.database); assert.equal(interrupted?.status, "running");
  assert.equal(await readFile(path.join(root, "count"), "utf8"), "1");
  await new Promise((resolve) => setTimeout(resolve, 250));
  const recovered = await runMission(id, { goal: interrupted!.goal, isolation: "host" }, { database: f.database, generate: async (input) => ({
    text: JSON.stringify({ actions: [{ tool: input.messages[0].content.includes("agent 1/2") ? "run_command" : "list_files", args: input.messages[0].content.includes("agent 1/2") ? { command: "node increment.cjs" } : {} }], done: true }), backend: "groq", runtimeLevel: "remote", modelId: "controlled", fallback: false, via: "controlled-test", ms: 0,
  }) });
  assert.equal(recovered.id, interrupted!.id, "restart must not create a new mission over unfinished work");
  assert.equal(recovered.status, "done"); assert.equal(await readFile(path.join(root, "count"), "utf8"), "1");
  assert.equal(recovered.journal.length, 2); assert.equal(recovered.journal[0].actions[0].ok, true);
});
test("a resumed step without its saved model request fails closed before provider execution", async (t) => {
  const { id } = await setup(t);
  crash(id, "model_requested"); await expired();
  const interrupted = await getLatestMission(id, f.database);
  assert.ok(interrupted);
  const steps = interrupted.journal.map((step, index) => {
    if (index !== 0) return step;
    const { modelRequest: _missing, ...withoutRequest } = step;
    return withoutRequest;
  });
  await f.database.update(spaceMissions)
    .set({ journal: { steps, control: interrupted.checkpoint } })
    .where(eq(spaceMissions.id, interrupted.id));
  const missingRequestState = await getLatestMission(id, f.database);
  assert.equal(missingRequestState?.journal[0]?.modelState, "requesting");
  assert.equal(missingRequestState?.journal[0]?.modelRequest, undefined);
  assert.equal(missingRequestState?.checkpoint?.activeStepId, missingRequestState?.journal[0]?.id);
  let providerCalls = 0;
  const resumed = await runMission(id, { goal: interrupted.goal }, {
    database: f.database,
    generate: async () => {
      providerCalls++;
      return result([]);
    },
  });
  assert.equal(resumed.id, interrupted.id);
  assert.equal(providerCalls, 0, "a missing saved request must never become a new provider call");
  assert.equal(resumed.status, "failed");
  assert.match(resumed.statusDetail, /saved model request is missing/i);
  assert.match(resumed.journal[0].thought, /refusing to call a provider/i);
});

const increment = { tool: "run_command", args: { command: "node increment.cjs" } };
const report = { tool: "write_file", args: { path: "report.json", content: '{"recovered":true}\n' } };
const result = (actions: unknown[]) => ({ text: JSON.stringify({ actions, done: true }), backend: "groq" as const, runtimeLevel: "remote" as const, modelId: "controlled", fallback: false, via: "controlled-test", ms: 0 });
async function setup(t: import("node:test").TestContext) {
  const id = randomUUID(); await f.database.insert(spaces).values({ id, prompt: "Crash recovery fixture" });
  const root = await ensureWorkspace(id); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "increment.cjs"), "const fs=require('node:fs');const n=Number(fs.existsSync('count')?fs.readFileSync('count','utf8'):0);fs.writeFileSync('count',String(n+1));console.log('committed count',n+1);");
  return { id, root };
}
function crash(id: string, boundary: string, actions = [increment] as unknown[], n = 1) {
  const child = spawnSync(process.execPath, ["--import", "./scripts/register-src-loader.mjs", "tests/fixtures/mission-crash.ts"], { env: { ...process.env, DATABASE_URL: f.url, RECOVERY_SPACE_ID: id, RECOVERY_BOUNDARY: boundary, RECOVERY_ACTIONS: JSON.stringify(actions), RECOVERY_BOUNDARY_N: String(n) }, encoding: "utf8", timeout: FIXTURE_TIMEOUT_MS });
  assertActuallyKilled(assert, child, `runtime killed at ${boundary}`);
}
const expired = () => new Promise((resolve) => setTimeout(resolve, 250));
for (const boundary of ["created", "model_requested", "model_recorded", "action_recorded", "turn_recorded", "before_completed"]) {
  test(`real PostgreSQL restart after ${boundary} preserves identity/results and executes command once`, async (t) => {
    const { id, root } = await setup(t); crash(id, boundary);
    const interrupted = await getLatestMission(id, f.database); assert.equal(interrupted?.persistence, "postgres");
    await expired(); let calls = 0;
    const resumed = await runMission(id, { goal: interrupted!.goal }, { database: f.database, generate: async () => { calls++; return result([increment]); } });
    assert.equal(resumed.id, interrupted!.id); assert.equal(resumed.status, "done");
    assert.equal(await readFile(path.join(root, "count"), "utf8"), "1");
    assert.equal(resumed.journal.flatMap((s) => s.actions).filter((a) => a.tool === "run_command").length, 1);
    assert.equal(calls, ["created", "model_requested"].includes(boundary) ? 1 : 0, "received model plans are not regenerated");
    assert.match(resumed.journal[0].actions[0].output, /committed count 1/);
    assert.equal(resumed.checkpoint?.lease, undefined);
  });
}
for (const boundary of ["action_started", "action_executed"]) {
  test(`interrupted command at ${boundary} stops for inspection, never blindly replays`, async (t) => {
    const { id, root } = await setup(t); crash(id, boundary); await expired();
    const before = await getLatestMission(id, f.database);
    const resumed = await runMission(id, { goal: before!.goal }, { database: f.database, generate: async () => { assert.fail("uncertain commands cannot replan"); } });
    assert.equal(resumed.id, before!.id); assert.equal(resumed.status, "needs_reconciliation");
    const count = await readFile(path.join(root, "count"), "utf8").catch(() => "0");
    assert.equal(count, boundary === "action_started" ? "0" : "1");
    assert.equal(resumed.journal[0].requestedActions?.[0].state, "uncertain");
    assert.equal(resumed.journal[0].actions.length, 0, "missing results are not fabricated");
  });
}
test("an authorised file write before result commit is recovered by actual bytes, then a real command continues", async (t) => {
  const { id, root } = await setup(t); crash(id, "action_executed", [report, increment]); await expired();
  const before = await getLatestMission(id, f.database);
  const resumed = await runMission(id, { goal: before!.goal }, { database: f.database, generate: async () => { assert.fail("saved file and command requests must be reused"); } });
  assert.equal(resumed.status, "done"); assert.equal(resumed.id, before!.id);
  assert.equal(await readFile(path.join(root, "report.json"), "utf8"), report.args.content);
  assert.equal(await readFile(path.join(root, "count"), "utf8"), "1");
  assert.equal(resumed.journal[0].actions[0].provenance, "file-postcondition");
  assert.match(resumed.journal[0].actions[0].output, /Original tool return was not committed/);
});
test("a drifted file is not mistaken for a committed intended write", async (t) => {
  const { id, root } = await setup(t); crash(id, "action_executed", [report, increment]);
  await writeFile(path.join(root, "report.json"), "user changed this\n"); await expired();
  const resumed = await runMission(id, { goal: "Durable increment and inspection" }, { database: f.database });
  assert.equal(resumed.status, "needs_reconciliation");
  assert.equal(await readFile(path.join(root, "report.json"), "utf8"), "user changed this\n");
  assert.equal(await readFile(path.join(root, "count"), "utf8").catch(() => "0"), "0");
});

test("owner review preserves a known command result, resumes saved work, and never repeats its effect", async (t) => {
  const { id, root } = await setup(t); crash(id, "action_executed", [increment, report]); await expired();
  const before = await runMission(id, { goal: "Durable increment and inspection" }, { database: f.database });
  const request = before.journal[0].requestedActions![0];
  await assert.rejects(reconcileMission(id, { missionId: before.id, requestId: request.id, resolution: "succeeded", evidence: "" }, f.database), /Describe the inspected outcome/);
  const reviewed = await reconcileMission(id, { missionId: before.id, requestId: request.id, resolution: "succeeded", evidence: "Inspected count file in the workspace; its exact contents are 1." }, f.database);
  assert.equal(reviewed.status, "checkpointed");
  assert.equal(await readFile(path.join(root, "report.json"), "utf8").catch(() => "absent"), "absent", "saving review dispatches nothing");
  const resumed = await runMission(id, { goal: reviewed.goal }, { database: f.database, generate: async () => { assert.fail("reuse recorded plan"); } });
  assert.equal(resumed.id, before.id); assert.equal(resumed.status, "done");
  assert.equal(await readFile(path.join(root, "count"), "utf8"), "1");
  assert.equal(await readFile(path.join(root, "report.json"), "utf8"), report.args.content);
  assert.equal(resumed.journal[0].actions[0].provenance, "human-reconciliation");
  assert.match(resumed.journal[0].actions[0].output, /NOT independently machine-verified/);
  const persisted = await getLatestMission(id, f.database);
  assert.equal(persisted?.journal[0].requestedActions![0].resolutions?.length, 1);
  await assert.rejects(reconcileMission(id, { missionId: before.id, requestId: request.id, resolution: "retry", evidence: "A stale browser repeats the earlier review request." }, f.database), /not waiting/);
});
test("only explicit reviewed retry can dispatch an uncertain command that never started", async (t) => {
  const { id, root } = await setup(t); crash(id, "action_started"); await expired();
  const before = await runMission(id, { goal: "Durable increment and inspection" }, { database: f.database });
  await reconcileMission(id, { missionId: before.id, requestId: before.journal[0].requestedActions![0].id, resolution: "retry", evidence: "Verified count is absent and the old command process is gone; authorise one retry." }, f.database);
  const resumed = await runMission(id, { goal: before.goal }, { database: f.database, generate: async () => { assert.fail("reuse recorded command"); } });
  assert.equal(resumed.status, "done"); assert.equal(await readFile(path.join(root, "count"), "utf8"), "1");
  assert.equal(resumed.journal[0].requestedActions![0].resolutions![0].resolution, "retry");
});
test("interrupted read-only requests replay safely before the next saved command", async (t) => {
  const { id, root } = await setup(t);
  crash(id, "action_started", [{ tool: "read_file", args: { path: "increment.cjs" } }, increment]); await expired();
  const resumed = await runMission(id, { goal: "Durable increment and inspection" }, { database: f.database });
  assert.equal(resumed.status, "done"); assert.equal(await readFile(path.join(root, "count"), "utf8"), "1");
  assert.match(resumed.journal[0].actions[0].output, /committed count/);
});

async function waitForFile(file: string, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { return await readFile(file, "utf8"); } catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
  }
  throw new Error(`Timed out waiting for ${file}`);
}
test("SIGKILL during a real command retains an uncertain request even when its orphan commits later", async (t) => {
  const { id, root } = await setup(t);
  await writeFile(path.join(root, "increment.cjs"), "const fs=require('node:fs');fs.writeFileSync('started','yes');setTimeout(()=>{fs.writeFileSync('count','1');},500);");
  const child = spawn(process.execPath, ["--import", "./scripts/register-src-loader.mjs", "tests/fixtures/mission-crash.ts"], { env: { ...process.env, DATABASE_URL: f.url, RECOVERY_SPACE_ID: id, RECOVERY_BOUNDARY: "parent-kills-in-flight" }, stdio: "ignore" });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  await waitForFile(path.join(root, "started"));
  const exited = new Promise((resolve) => child.once("exit", (_code, signal) => resolve(signal)));
  child.kill("SIGKILL"); assert.equal(await exited, "SIGKILL");
  assert.equal(await waitForFile(path.join(root, "count")), "1"); await expired();
  const resumed = await runMission(id, { goal: "Durable increment and inspection" }, { database: f.database });
  assert.equal(resumed.status, "needs_reconciliation");
  assert.equal(resumed.journal[0].requestedActions![0].state, "uncertain");
  assert.equal(resumed.journal[0].actions.length, 0);
  assert.equal(await readFile(path.join(root, "count"), "utf8"), "1");
});
test("a second native runtime cannot claim an active SQL lease", async (t) => {
  const { id, root } = await setup(t);
  let release!: () => void, requested!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { requested = resolve; });
  const first = runMission(id, { goal: "Durable increment and inspection", isolation: "host", agentPlan: [{ name: "Writer", role: "worker", modelId: "controlled" }] }, { database: f.database, leaseMs: 30000, onCheckpoint: async (point) => { if (point === "model_requested") { requested(); await hold; } }, generate: async () => result([increment]) });
  t.after(release); await ready;
  await assert.rejects(runMission(id, { goal: "Durable increment and inspection" }, { database: f.database }), MissionBusyError);
  const child = spawnSync(process.execPath, ["--import", "./scripts/register-src-loader.mjs", "tests/fixtures/mission-crash.ts"], { env: { ...process.env, DATABASE_URL: f.url, RECOVERY_SPACE_ID: id, RECOVERY_BOUNDARY: "never" }, encoding: "utf8", timeout: FIXTURE_TIMEOUT_MS });
  assert.equal(child.status, 74, child.stderr); assert.match(child.stderr, /active runner lease/);
  release(); const completed = await first; assert.equal(completed.status, "done");
  assert.equal(await readFile(path.join(root, "count"), "utf8"), "1");
});
test("cancellation fences out a late model reply before any requested command runs", async (t) => {
  const { id, root } = await setup(t);
  let release!: () => void, requested!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { requested = resolve; });
  const running = runMission(id, { goal: "Cancel late model", isolation: "host", agentPlan: [{ name: "Writer", role: "worker", modelId: "controlled" }] }, { database: f.database, generate: async () => { requested(); await hold; return result([increment]); } });
  const rejected = assert.rejects(running, /lease lost|cancelled/i); t.after(release); await ready;
  const before = await getLatestMission(id, f.database);
  const cancelled = await cancelMission(id, f.database, before!.id); assert.equal(cancelled?.status, "cancelled");
  release(); await rejected;
  assert.equal((await getLatestMission(id, f.database))?.status, "cancelled");
  assert.equal(await readFile(path.join(root, "count"), "utf8").catch(() => "0"), "0");
});
test("cancelling a running host command kills its process group and preserves uncertain effects", async (t) => {
  const { id, root } = await setup(t);
  await writeFile(path.join(root, "increment.cjs"), "const fs=require('node:fs');fs.writeFileSync('started','yes');setTimeout(()=>fs.writeFileSync('count','1'),10000);");
  const running = runMission(id, { goal: "Cancel real host command", isolation: "host", agentPlan: [{ name: "Writer", role: "worker", modelId: "controlled" }] }, { database: f.database, leaseMs: 200, generate: async () => result([increment]) });
  const rejected = assert.rejects(running, /lease lost|cancelled/i);
  await waitForFile(path.join(root, "started")); const before = await getLatestMission(id, f.database);
  await cancelMission(id, f.database, before!.id); await rejected;
  const cancelled = await getLatestMission(id, f.database); assert.equal(cancelled?.status, "cancelled");
  assert.equal(cancelled?.journal[0].requestedActions![0].state, "uncertain");
  assert.equal(await readFile(path.join(root, "count"), "utf8").catch(() => "0"), "0");
});
test("a real PostgreSQL outage after a committed effect cannot fork into memory; restart requires review", async (t) => {
  const sql = await missionPostgres(); t.after(() => sql.close());
  const id = randomUUID(); await sql.database.insert(spaces).values({ id, prompt: "Database outage" });
  const root = await ensureWorkspace(id); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "increment.cjs"), "require('node:fs').writeFileSync('count','1');");
  await assert.rejects(runMission(id, { goal: "Survive storage outage", isolation: "host", agentPlan: [{ name: "Writer", role: "worker", modelId: "controlled" }] }, { database: sql.database, leaseMs: 200, generate: async () => result([increment]), onCheckpoint: async (point) => { if (point === "action_executed") await sql.stop(); } }));
  assert.equal(await readFile(path.join(root, "count"), "utf8"), "1");
  await assert.rejects(runMission(id, { goal: "Survive storage outage" }, { database: sql.database }), /storage unavailable/);
  await sql.start(); await expired();
  const before = await getLatestMission(id, sql.database);
  const recovered = await runMission(id, { goal: before!.goal }, { database: sql.database });
  assert.equal(recovered.id, before!.id); assert.equal(recovered.status, "needs_reconciliation");
  assert.equal(recovered.persistence, "postgres"); assert.equal(await readFile(path.join(root, "count"), "utf8"), "1");
});

const publish = { tool: "github_publish", args: { repo: "owner/no-network-fixture", files: [] } };
for (const boundary of ["approval_claimed", "approval_result_recorded"]) {
  test(`real SQL approval recovery at ${boundary} preserves decision, earlier effects and authoritative results`, async (t) => {
    const { id, root } = await setup(t);
    const waiting = await runMission(id, { goal: "Durable increment and inspection", isolation: "host", maxTurnsPerAgent: 1, agentPlan: [{ name: "Writer", role: "worker", modelId: "controlled" }] }, { database: f.database, generate: async () => result([increment, publish, report]) });
    assert.equal(waiting.status, "awaiting_approval");
    const [approval] = await f.database.select().from(spaceActionApprovals).where(eq(spaceActionApprovals.missionId, waiting.id));
    assert.equal(approval.status, "pending");
    const stillWaiting = await runMission(id, { goal: waiting.goal }, { database: f.database, generate: async () => { assert.fail("waiting model request must not regenerate"); } });
    assert.equal(stillWaiting.status, "awaiting_approval"); assert.equal(await readFile(path.join(root, "count"), "utf8"), "1");
    await f.database.update(spaceActionApprovals).set({ status: "approved", decidedBy: "integration owner", decidedAt: new Date() }).where(eq(spaceActionApprovals.id, approval.id));
    crash(id, boundary); await expired();
    const recovered = await runMission(id, { goal: waiting.goal }, { database: f.database, generate: async () => { assert.fail("resume the existing saved plan"); } });
    assert.equal(recovered.id, waiting.id); assert.equal(await readFile(path.join(root, "count"), "utf8"), "1");
    if (boundary === "approval_claimed") {
      assert.equal(recovered.status, "needs_reconciliation");
      assert.equal(recovered.journal[0].requestedActions![1].state, "uncertain");
      await assert.rejects(reconcileMission(id, { missionId: recovered.id, requestId: recovered.journal[0].requestedActions![1].id, resolution: "retry", evidence: "Owner tries to reuse an interrupted approval." }, f.database), /cannot reuse/);
      await reconcileMission(id, { missionId: recovered.id, requestId: recovered.journal[0].requestedActions![1].id, resolution: "failed", evidence: "Confirmed no remote publication was attempted; runtime died immediately after claiming approval." }, f.database);
      const [receipt] = await f.database.select().from(spaceActionApprovals).where(eq(spaceActionApprovals.id, approval.id));
      assert.equal(receipt.status, "failed");
    } else {
      assert.equal(recovered.status, "incomplete", "an actual publish validation failure cannot become completion");
      const action = recovered.journal[0].actions.find((entry) => entry.provenance === "approval-ledger");
      assert.ok(action); assert.equal(action.ok, false); assert.match(action.output, /token|key|no files/i);
      assert.equal(await readFile(path.join(root, "report.json"), "utf8"), report.args.content);
      const [receipt] = await f.database.select().from(spaceActionApprovals).where(eq(spaceActionApprovals.id, approval.id));
      assert.ok(receipt.result, "failed tool results stay retrievable in the ledger too");
    }
  });
}
for (const response of [{ done: true, actions: "malformed" }, { done: true, actions: [{ tool: "write_file", args: [] }] }, { done: true, actions: [increment, increment] }]) {
  test(`invalid or oversized model action list cannot silently dispatch a truncated successful plan: ${JSON.stringify(response)}`, async (t) => {
    const { id, root } = await setup(t);
    const mission = await runMission(id, { goal: "Reject invalid action list", isolation: "host", maxActionsPerTurn: 1, agentPlan: [{ name: "Writer", role: "worker", modelId: "controlled" }] }, { database: f.database, generate: async () => ({ ...result([]), text: JSON.stringify(response) }) });
    assert.equal(mission.status, "failed"); assert.ok(mission.journal[0].contractError);
    assert.equal(mission.journal[0].modelResponse?.text, JSON.stringify(response));
    assert.equal(mission.journal[0].actions.length, 0);
    assert.equal(await readFile(path.join(root, "count"), "utf8").catch(() => "0"), "0");
  });
}

test("a real timed-out command retains its committed effect and timeout result, blocks the next action, and never auto-retries", { timeout: 30000 }, async (t) => {
  const { id, root } = await setup(t);
  await writeFile(path.join(root, "increment.cjs"), "require('node:fs').writeFileSync('count','1');setInterval(()=>{},1000);");
  const timed = await runMission(id, { goal: "Bound a command with a partial effect", isolation: "host", agentPlan: [{ name: "Writer", role: "worker", modelId: "controlled" }] }, { database: f.database, generate: async () => result([increment, report]) });
  assert.equal(timed.status, "needs_reconciliation"); assert.match(timed.journal[0].actions[0].output, /timed out/);
  assert.equal(timed.journal[0].actions[0].uncertain, true); assert.equal(await readFile(path.join(root, "count"), "utf8"), "1");
  assert.equal(await readFile(path.join(root, "report.json"), "utf8").catch(() => "absent"), "absent");
  const resumed = await runMission(id, { goal: timed.goal }, { database: f.database, generate: async () => { assert.fail("a timeout cannot silently replan or repeat a command"); } });
  assert.equal(resumed.status, "needs_reconciliation"); assert.equal(resumed.id, timed.id);
  assert.equal(resumed.journal[0].actions.length, 1, "actual timeout result survives recovery");
});
test("remaining mission deadline bounds a hung model; its later reply cannot dispatch tools or complete work", { timeout: 40000 }, async (t) => {
  const { id, root } = await setup(t); let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; }); t.after(release);
  const timed = await runMission(id, { goal: "Bound a model call", timeBudgetMs: 30000, isolation: "host", agentPlan: [{ name: "Writer", role: "worker", modelId: "controlled" }] }, { database: f.database, generate: async () => { await hold; return result([increment]); } });
  assert.equal(timed.status, "failed"); assert.match(timed.journal[0].thought, /deadline.*late reply will be ignored/);
  assert.equal(timed.journal[0].modelAttempts, 1); assert.equal(timed.journal[0].actions.length, 0);
  release(); await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(await readFile(path.join(root, "count"), "utf8").catch(() => "0"), "0");
  assert.equal((await getLatestMission(id, f.database))?.status, "failed");
});
