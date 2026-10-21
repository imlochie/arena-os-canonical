// Real production Chromium validator, scripted provider. No live-model claim.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { validateGameRuntime } from "../../src/lib/games/runtime-validation.ts";
import { forgeGameWithAI } from "../../src/lib/games/forge-ai.ts";
import { games, brokenControls, brokenRestart, brokenTerminal, withoutContract } from "../fixtures/arcade-mechanics.mjs";

const receipts = { scope: "Real browser mechanics; hand-authored games and scripted providers, NOT live-model performance or arbitrary prompt fidelity", commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), cases: [] };
const run = async (label, code, required = true) => {
  const result = await validateGameRuntime(code, { requireGameplay: required });
  receipts.cases.push({ label, ...result }); return result;
};
test("diverse real mechanics, negative controls, bounded browser-informed repair", { timeout: 240000 }, async () => {
  try {
    for (const [name, code] of Object.entries(games)) {
      const passed = await run(name, code); assert.equal(passed.ok, true, JSON.stringify(passed));
      assert.equal(passed.gameplay.scenarios.length, 4);
    }
    // Reproduce the precise old limit: animation can pass smoke with inert keys.
    const inert = brokenControls(games.maze);
    assert.equal((await run("inert-controls-old-smoke", withoutContract(inert), false)).ok, true);
    assert.equal((await run("inert-controls-rejected", inert)).ok, false);
    for (const [name, mutate] of Object.entries({ brokenRestart, brokenTerminal })) {
      const result = await run(name, mutate(games.puzzle));
      assert.equal(result.ok, false); assert.equal(result.gameplay.status, "failed");
    }
    const vacuousTerminal = brokenTerminal(games.puzzle).replace('"value":"won"', '"value":"playing"');
    const vacuous = await run("vacuous-terminal-rejected", vacuousTerminal);
    assert.equal(vacuous.ok, false);
    assert.ok(vacuous.gameplay.scenarios.find(s => s.kind === "terminal").issues.some(issue => issue.includes("no changed observable")));
    let calls = 0, failedRetained = false;
    const repaired = await forgeGameWithAI("A key maze with an exit behind a wall", {
      validateRuntime: code => validateGameRuntime(code, { requireGameplay: true }),
      onDraft: async draft => { if (draft.runtimeValidation?.gameplay?.status === "failed") failedRetained = true; },
    }, { generate: async input => {
      if (++calls === 2) { assert.equal(failedRetained, true); assert.match(input.messages[0].content, /controls\/Move through corridor/); }
      return { text: calls === 1 ? inert : games.maze, modelId: "scripted-eval", backend: "groq", runtimeLevel: "remote", ms: 1, fallback: false };
    } });
    receipts.repair = { calls, failedRetained, report: repaired.runtimeValidation };
    assert.equal(calls, 2); assert.equal(repaired.repairsUsed, 1); assert.equal(repaired.runtimeValidation.gameplay.status, "passed");
  } finally {
    await mkdir(".data/arcade-gameplay", { recursive: true });
    await writeFile(".data/arcade-gameplay/receipt.json", JSON.stringify(receipts, null, 2));
  }
});
