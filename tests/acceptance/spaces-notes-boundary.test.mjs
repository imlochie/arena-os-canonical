import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { runMission } from "../../src/lib/spaces/mission.ts";
import { ensureWorkspace } from "../../src/lib/spaces/tools.ts";
test("actual mission context rejects host symlink notes and labels ordinary notes untrusted", async t => {
  const id = randomUUID(), root = await ensureWorkspace(id), outside = await mkdtemp(path.join(tmpdir(), "arena-note-boundary-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); });
  const fixture = path.join(outside, "outside.txt"); await writeFile(fixture, "HARMLESS_OUTSIDE_BOUNDARY_FIXTURE");
  const notes = path.join(root, "AGENT_NOTES.md"); await symlink(fixture, notes);
  const receipt = { revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), worktreeClean: !execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim(), scope: "POSIX actual dispatcher/model-context boundary with scripted provider, not general host isolation or live inference", calls: [], status: "running" };
  const run = (expected, requireText) => runMission(id, { goal: "Inspect workspace", isolation: "host", agentPlan: [{ name: "Probe", role: "worker", modelId: "controlled-contract" }] }, { memoryOnly: true, generate: async input => {
    const context = input.messages[0].content;
    assert.doesNotMatch(context, /HARMLESS_OUTSIDE_BOUNDARY_FIXTURE/); assert.match(context, expected);
    if (requireText) assert.match(context, /local bounded note/);
    receipt.calls.push({ outsideFixturePresent: false, expectedContextMarker: true });
    return { text: JSON.stringify({ thought: "Controlled notes boundary proof", actions: [{ tool: "list_files", args: {} }], done: true }), backend: "arena-local-engine", runtimeLevel: "arena-local", modelId: "controlled-contract", via: "controlled-test", fallback: false, ms: 0 };
  } });
  try {
    assert.equal((await run(/notes not loaded/, false)).status, "done");
    await rm(notes); await writeFile(notes, "local bounded note");
    assert.equal((await run(/UNTRUSTED WORKSPACE NOTES/, true)).status, "done");
    assert.equal(receipt.calls.length, 2); receipt.status = "passed";
  } catch (error) { receipt.status = "failed"; receipt.error = String(error); throw error; }
  finally { await mkdir(".data/spaces-workshop-acceptance", { recursive: true }); await writeFile(".data/spaces-workshop-acceptance/notes-boundary.json", JSON.stringify(receipt, null, 2)); }
});
