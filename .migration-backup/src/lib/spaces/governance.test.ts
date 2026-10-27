/**
 * Phase A governance tests (docs/spaces-autonomy.md) — the strict check-in
 * environment for space missions.
 *
 * Proven here against the REAL mission runner (generate stubbed to emit exact
 * action sequences; all tools real):
 *   1. action classification maps every tool to its action class
 *   2. an approval-gated action (github.publish) NEVER executes before a
 *      human decision — the mission checkpoints itself awaiting_approval and
 *      the ledger holds a pending request
 *   3. non-gated actions in the same turn still execute (per-action gate)
 *   4. approve → resume → the action executes exactly once; re-emitting the
 *      same action afterwards maps to the executed approval — never re-run
 *   5. deny → resume with the same action → refused, terminal, never executed
 *   6. ledger invariants: decisions are terminal, execution claims are single,
 *      signatures are stable (key order independent)
 */

import assert from "node:assert/strict";
import test from "node:test";
import { rm } from "node:fs/promises";
import path from "node:path";

import { runMission, type MissionAgentSpec } from "./mission";
import type { GenerateResult } from "@/lib/runtime";
import {
  APPROVAL_REQUIRED,
  actionSignature,
  claimExecution,
  classifyToolAction,
  decideApproval,
  listApprovals,
  requestApproval,
} from "./governance";
import { WORKSPACE_ROOT } from "./tools";

const PROBE_PLAN: MissionAgentSpec[] = [{ name: "Solo", role: "probe", modelId: "local-engine" }];

/** A generate stub that replays a fixed list of model replies (JSON action
 * bundles), then answers with an empty done turn. */
function scriptGenerate(script: string[]) {
  let call = 0;
  return async (): Promise<GenerateResult> => {
    const text = call < script.length ? script[call] : '{"thought":"done","actions":[],"done":true}';
    call += 1;
    return {
      text,
      runtimeLevel: "arena-local",
      backend: "arena-local-engine",
      modelId: "local-engine",
      via: "test-stub",
      ms: 1,
      fallback: false,
    };
  };
}

const GATED_TURN = JSON.stringify({
  thought: "write a note, then publish",
  actions: [
    { tool: "write_file", args: { path: "note.txt", content: "governance probe" } },
    { tool: "github_publish", args: { repo: "me/probe", message: "publish me", files: [{ path: "note.txt", content: "x" }] } },
  ],
  done: false,
});

function cleanup(spaceId: string) {
  return rm(path.join(WORKSPACE_ROOT, spaceId), { recursive: true, force: true }).catch(() => {});
}

test("classification: every mission tool maps to its action class", () => {
  assert.equal(classifyToolAction("write_file"), "filesystem.write");
  assert.equal(classifyToolAction("edit_file"), "filesystem.write");
  assert.equal(classifyToolAction("delete_file"), "filesystem.write");
  assert.equal(classifyToolAction("run_command"), "command.run");
  assert.equal(classifyToolAction("run_tests"), "command.run");
  assert.equal(classifyToolAction("fetch_url"), "network.fetch");
  assert.equal(classifyToolAction("github_publish"), "github.publish");
  assert.equal(classifyToolAction("browser_navigate"), "browser.view");
  assert.equal(classifyToolAction("browser_click"), "browser.interact");
  assert.equal(classifyToolAction("browser_fill"), "browser.interact");
  assert.equal(classifyToolAction("external_call"), "external.call");
  assert.equal(classifyToolAction("external_sms"), "external.sms");
  assert.equal(classifyToolAction("payment_link"), "payment.link");
  assert.equal(classifyToolAction("read_file"), "filesystem.read");
  assert.equal(classifyToolAction("list_files"), "filesystem.read");
  assert.equal(classifyToolAction("search_code"), "filesystem.read");
});

test("classification: the gated classes are exactly the consequential ones", () => {
  assert.deepEqual([...APPROVAL_REQUIRED].sort(), [
    "browser.interact",
    "external.call",
    "external.sms",
    "github.publish",
    "payment.link",
  ]);
});

test("ledger: decisions are terminal, claims are single, signatures stable", async () => {
  const sig = actionSignature("m-1", "github_publish", { repo: "a/b", files: [] });
  assert.equal(actionSignature("m-1", "github_publish", { files: [], repo: "a/b" }), sig, "key-order independent");
  assert.notEqual(actionSignature("m-2", "github_publish", { repo: "a/b", files: [] }), sig);

  const a = await requestApproval({ spaceId: "ledger-test", missionId: "m-1", signature: sig, actionClass: "github.publish", summary: "test" });
  assert.equal(a.status, "pending");
  // idempotent while active: the same signature returns the same approval
  const a2 = await requestApproval({ spaceId: "ledger-test", missionId: "m-1", signature: sig, actionClass: "github.publish", summary: "test" });
  assert.equal(a2.id, a.id);

  assert.equal((await decideApproval(a.id, "deny", "test-owner"))?.status, "denied");
  assert.equal(await decideApproval(a.id, "approve", "test-owner"), null, "decisions are terminal");
  assert.equal(await claimExecution(a.id), false, "a denied approval can never be claimed");

  const b = await requestApproval({ spaceId: "ledger-test", missionId: "m-2", signature: actionSignature("m-2", "github_publish", { repo: "c/d" }), actionClass: "github.publish", summary: "two" });
  assert.equal((await decideApproval(b.id, "approve", "test-owner"))?.status, "approved");
  assert.equal(await claimExecution(b.id), true, "first claim wins");
  assert.equal(await claimExecution(b.id), false, "second claim loses — exactly once");
});

test("mission gate: a gated action never executes before a human decision; the mission awaits", async (t) => {
  const spaceId = `govtest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  t.after(() => cleanup(spaceId));

  const mission = await runMission(spaceId, {
    goal: "governance probe",
    timeBudgetMs: 30_000,
    agentPlan: PROBE_PLAN,
    maxTurnsPerAgent: 1,
    maxActionsPerTurn: 4,
  }, { generate: scriptGenerate([GATED_TURN]) });

  assert.equal(mission.status, "awaiting_approval");
  const gated = mission.journal.flatMap((s) => s.actions).filter((a) => a.tool === "github_publish");
  assert.equal(gated.length, 1, "the gated action is journaled exactly once");
  assert.match(gated[0].output, /awaiting human approval/);
  assert.equal(gated[0].ok, false, "the gated action did NOT execute");

  const pending = (await listApprovals(spaceId, "pending")).filter((p) => p.missionId === mission.id);
  assert.equal(pending.length, 1, "exactly one pending approval for this mission");
  assert.equal(pending[0].actionClass, "github.publish");

  const wrote = mission.journal.flatMap((s) => s.actions).filter((a) => a.tool === "write_file");
  assert.ok(wrote.length >= 1 && wrote.every((a) => a.ok), "ungated actions in the same turn still execute");
});

test("mission gate: approve → executes exactly once; re-emission never re-runs it", async (t) => {
  const spaceId = `govtest2-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  t.after(() => cleanup(spaceId));

  const m1 = await runMission(spaceId, {
    goal: "approval decision probe",
    timeBudgetMs: 30_000,
    agentPlan: PROBE_PLAN,
    maxTurnsPerAgent: 1,
    maxActionsPerTurn: 4,
  }, { generate: scriptGenerate([GATED_TURN]) });
  assert.equal(m1.status, "awaiting_approval");
  const pending = (await listApprovals(spaceId, "pending")).filter((p) => p.missionId === m1.id);
  assert.equal(pending.length, 1);

  await decideApproval(pending[0].id, "approve", "test-owner");

  // Resume: the agent RE-EMITS the same gated action on its next turn (its
  // plan says publish). The approved approval is claimed and executed ONCE;
  // the second emission maps to the executed approval and is skipped.
  const m2 = await runMission(spaceId, { goal: "approval decision probe", timeBudgetMs: 30_000, maxTurnsPerAgent: 2 },
    { generate: scriptGenerate([GATED_TURN, GATED_TURN]) });
  assert.notEqual(m2.status, "awaiting_approval", "a decided approval no longer blocks");

  const executedApproval = (await listApprovals(spaceId)).find((p) => p.id === pending[0].id);
  assert.ok(executedApproval && (executedApproval.status === "executed" || executedApproval.status === "failed"),
    `the approval reaches a terminal executed/failed state (no token → honest failure), got ${executedApproval?.status}`);

  // The journal is cumulative across the resume: the original awaiting
  // outcome, exactly ONE real execution, and the skipped re-emission.
  const gated2 = m2.journal.flatMap((s) => s.actions).filter((a) => a.tool === "github_publish");
  assert.equal(gated2.length, 3, "awaiting + executed + skipped re-emission, all journaled");
  assert.equal(gated2.filter((a) => /awaiting human approval/.test(a.output)).length, 1);
  const realRuns = gated2.filter((a) => !/awaiting human approval|already executed/.test(a.output));
  assert.equal(realRuns.length, 1, "the action executed exactly once across all emissions");
  assert.ok(realRuns[0].output.length > 0 && realRuns[0].output !== gated2[0].output,
    "the single execution really ran the tool (its own honest output — e.g. a no-token/no-files error — not a governance message)");
  assert.equal(gated2.filter((a) => /already executed/.test(a.output)).length, 1, "the re-emission was skipped, not re-run");
  const approvalsForMission = (await listApprovals(spaceId)).filter((p) => p.signature === pending[0].signature);
  assert.equal(approvalsForMission.length, 1, "no duplicate approval was created for the same action");
});

test("mission gate: deny → refused, terminal, never executed", async (t) => {
  const spaceId = `govtest3-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  t.after(() => cleanup(spaceId));

  const m1 = await runMission(spaceId, {
    goal: "denial probe",
    timeBudgetMs: 30_000,
    agentPlan: PROBE_PLAN,
    maxTurnsPerAgent: 1,
    maxActionsPerTurn: 4,
  }, { generate: scriptGenerate([GATED_TURN]) });
  assert.equal(m1.status, "awaiting_approval");
  const pending = (await listApprovals(spaceId, "pending")).filter((p) => p.missionId === m1.id);
  assert.equal(pending.length, 1);

  await decideApproval(pending[0].id, "deny", "test-owner");

  // The agent retries the same action on its next turn; the denial is
  // terminal — refused without a fresh approval request, never executed.
  const m2 = await runMission(spaceId, { goal: "denial probe", timeBudgetMs: 30_000, maxTurnsPerAgent: 2 },
    { generate: scriptGenerate([GATED_TURN, GATED_TURN]) });
  const refused = m2.journal.flatMap((s) => s.actions).filter((a) => a.tool === "github_publish");
  assert.equal(refused.length, 3, "the original awaiting outcome + two refused retries, all journaled");
  assert.equal(refused.filter((a) => /awaiting human approval/.test(a.output)).length, 1);
  assert.equal(refused.filter((a) => /denied/.test(a.output)).length, 2,
    "every re-emission is refused, referencing the human denial");

  const all = (await listApprovals(spaceId)).filter((p) => p.signature === pending[0].signature);
  assert.equal(all.length, 1, "the denial created no fresh approval for the same action");
  assert.equal(all[0].status, "denied", "a denied action never reaches executed");
});
