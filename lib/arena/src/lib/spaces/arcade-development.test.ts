import test from "node:test";
import assert from "node:assert/strict";
import { ArcadeDevelopmentTools, developmentHash } from "./arcade-development";
import { runMission, getLatestMission, recordArcadeDevelopmentEvent } from "./mission";
import { listApprovals, decideApproval, classifyToolAction, approvalRequired } from "./governance";
import type { GenerateResult } from "../runtime";
import { createSpace, deleteSpace } from "../spaces";
import { db } from "@workspace/db";
import { spaceMissions } from "@workspace/db/schema";
import { eq } from "drizzle-orm";

const original = '<!doctype html><html><body><button id="coin">Collect</button><p id="score">0</p><script>let score=0;document.getElementById("coin").onclick=()=>{score+=1;document.getElementById("score").textContent=score};</script></body></html>';
const snapshot = () => ({ developmentId: crypto.randomUUID(), gameId: "owned-game", title: "Original authorized fixture",
  original, draft: original, provenance: "Original test fixture, authored for these tests." });
const reply = (actions: any[]): GenerateResult => ({ text: JSON.stringify({ thought: "PRIVATE_SOURCE_SENTINEL", handoff: original, actions, done: true }),
  backend: "local-server", modelId: "test-script-not-a-real-model", runtimeLevel: "on-device", ms: 1, fallback: false });
const plan = [{ name: "Fixture driver", role: "wiring test only", modelId: "local-engine" }];

test("request-scoped edits, static builds, stale artifacts and narrow permissions", async () => {
  const state = snapshot(), tools = new ArcadeDevelopmentTools(state, "owner");
  assert.equal((await tools.execute({ tool: "run_command", args: { command: "node bad.js" } })).ok, false);
  assert.equal((await tools.execute({ tool: "arcade_edit", args: { old_text: "not-present", new_text: "bad" } })).ok, false);
  assert.equal(tools.current.draft, original);
  const edited = await tools.execute({ tool: "arcade_edit", args: { old_text: "score+=1", new_text: "score+=5" } });
  assert.equal(edited.ok, true); assert.equal(state.original, original);
  assert.equal((await tools.execute({ tool: "arcade_build", args: {} })).ok, true);
  assert.throws(() => tools.canonicalAction({ tool: "arcade_install", args: { draftHash: developmentHash(original) } }), /stale/);
  assert.equal(approvalRequired(classifyToolAction("arcade_install")), true);
  assert.equal(approvalRequired(classifyToolAction("arcade_launch")), true);
  const broken = await tools.execute({ tool: "arcade_edit", args: { old_text: "score+=5", new_text: "score+=" } });
  assert.equal(broken.ok, true);
  assert.equal((await tools.execute({ tool: "arcade_build", args: {} })).ok, false);
  assert.throws(() => tools.canonicalAction({ tool: "arcade_install", args: { draftHash: tools.hash } }), /static build/);
});

test("existing mission runner gates exact artifacts, redacts persisted source and refuses autonomous restart", async t => {
  const tools = new ArcadeDevelopmentTools(snapshot(), "owner");
  const space = await createSpace({ title: "Governed Arcade wiring fixture", prompt: "Original authorized test fixture.", modelId: "local-engine", status: "paused" });
  const spaceId = space.id;
  t.after(() => deleteSpace(spaceId));
  let calls = 0;
  const mission = await runMission(spaceId, { mode: "arcade", goal: "Make collecting worth five points.", resume: false,
    agentPlan: plan, maxTurnsPerAgent: 3, isolation: "host" }, { arcade: tools, generate: async () => {
      calls++;
      return calls === 1 ? reply([
        { tool: "arcade_read", args: {} }, { tool: "arcade_edit", args: { old_text: "score+=1", new_text: "score+=5" } },
        { tool: "arcade_build", args: {} },
      ].map(a => a)) : reply([{ tool: "arcade_install", args: { draftHash: tools.hash } }]);
    } });
  // done=true ends this agent, so the explicit install is a separate request.
  const waiting = await runMission(spaceId, { mode: "arcade", goal: "Install the proposed five-point change.", resume: false,
    agentPlan: plan, isolation: "host" }, { arcade: tools, generate: async () => reply([{ tool: "arcade_install", args: { draftHash: tools.hash } }]) });
  assert.equal(mission.journal.some(step => step.actions.some(action => action.tool === "arcade_build" && action.ok)), true);
  assert.equal(waiting.status, "awaiting_approval"); assert.equal(tools.handoff, null);
  const serialized = JSON.stringify(waiting);
  assert.ok(!serialized.includes("score+=5") && !serialized.includes("PRIVATE_SOURCE_SENTINEL") && !serialized.includes("<script>"));
  const persisted = await db.select().from(spaceMissions).where(eq(spaceMissions.id, waiting.id));
  assert.equal(persisted.length, 1, "Privacy evidence must cover the real persisted journal, not only memory fallback.");
  assert.ok(!JSON.stringify(persisted).includes("score+=") && !JSON.stringify(persisted).includes("PRIVATE_SOURCE_SENTINEL"));
  const [approval] = (await listApprovals(spaceId)).filter(a => a.missionId === waiting.id);
  assert.ok(approval); assert.ok(!JSON.stringify(approval).includes("score+="));
  await assert.rejects(runMission(spaceId, { goal: "resume", resume: true }), /browser-local workspace/);
  await decideApproval(approval.id, "approve", "owner");
  const hydrated = new ArcadeDevelopmentTools(tools.current, "owner");
  const completed = await runMission(spaceId, { mode: "arcade", goal: "resume", resume: true, isolation: "host" },
    { arcade: hydrated, generate: async () => { throw new Error("Approved handoff must not need another model call."); } });
  assert.equal(completed.status, "done"); assert.equal(hydrated.handoff, "install");
  assert.equal(hydrated.current.original, original);
  const event = await recordArcadeDevelopmentEvent(spaceId, hydrated.binding, { type: "installed", draftHash: hydrated.hash, profileId: "independent-profile" });
  assert.match(event.journal.at(-1)!.actions[0].output, /owner-reported/);
  const wrongOwner = new ArcadeDevelopmentTools(tools.current, "different-owner");
  await assert.rejects(runMission(spaceId, { mode: "arcade", goal: "steal", resume: true }, { arcade: wrongOwner }), /owner/);
});

test("denial, changed approved artifacts, cancellation and deterministic fallback never install", async () => {
  for (const scenario of ["deny", "stale", "cancel", "fallback"] as const) {
    const state = snapshot(); state.draft = original.replace("score+=1", "score+=3");
    const tools = new ArcadeDevelopmentTools(state, "owner"), spaceId = crypto.randomUUID();
    const controller = new AbortController();
    if (scenario === "cancel") controller.abort();
    const waiting = await runMission(spaceId, { mode: "arcade", goal: scenario, agentPlan: plan, resume: false, isolation: "host" },
      { arcade: tools, signal: controller.signal, generate: async () => scenario === "fallback"
        ? { ...reply([]), backend: "arena-local-engine", fallback: true }
        : reply([{ tool: "arcade_install", args: { draftHash: tools.hash } }]) });
    if (scenario === "cancel" || scenario === "fallback") {
      assert.equal(waiting.status, scenario === "cancel" ? "cancelled" : "failed");
    } else {
      const [approval] = (await listApprovals(spaceId)).filter(a => a.missionId === waiting.id);
      await decideApproval(approval.id, scenario === "deny" ? "deny" : "approve", "owner");
      if (scenario === "stale") await tools.execute({ tool: "arcade_edit", args: { old_text: "score+=3", new_text: "score+=9" } });
      const resumed = await runMission(spaceId, { mode: "arcade", goal: scenario, resume: true, isolation: "host" }, { arcade: tools });
      assert.equal(resumed.status, "failed");
    }
    assert.equal(tools.handoff, null);
    assert.equal((await getLatestMission(spaceId))?.arcadeBinding?.baseHash, developmentHash(original));
  }
});
