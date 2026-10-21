// Controlled validator/model orchestration tests, NOT real browser/model proof.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { forgeGameWithAI, ForgeDraftError } from "./forge-ai";
import { generateGameOffline } from "./index";
import { ARCADE_HOST_CSP, sandboxGameDocument, type GameRuntimeReport } from "./sandbox";
import type { generate } from "@/lib/ai";

const code = generateGameOffline("snake").code;
function report(html: string, status: GameRuntimeReport["status"]): GameRuntimeReport {
  return { policyVersion: 1, codeSha256: createHash("sha256").update(html).digest("hex"), ok: status === "passed", status, scope: "CONTROLLED UNIT FIXTURE, not browser evidence", issues: status === "passed" ? [] : [status === "failed" ? "CONTROLLED_RUNTIME_CRASH" : "Browser unavailable"] };
}
const model: typeof generate = async () => ({ text: code, modelId: "controlled-unit-fixture", backend: "groq", runtimeLevel: "remote", via: "fixture-not-inference", ms: 1, fallback: false });

test("sandbox policy precedes untrusted HTML and host forbids frame navigation", () => {
  assert.ok(sandboxGameDocument(code).indexOf("connect-src 'none'") < sandboxGameDocument(code).indexOf(code));
  assert.equal(ARCADE_HOST_CSP.includes("frame-src 'none'"), true);
});
test("actual runtime complaints feed exactly one repair and retain failed evidence before repair", async () => {
  let models = 0, checks = 0, failedCheckpoint = false;
  const result = await forgeGameWithAI("custom game", {
    validateRuntime: async html => report(html, ++checks === 1 ? "failed" : "passed"),
    onDraft: async draft => { if (draft.runtimeValidation?.status === "failed") failedCheckpoint = true; },
  }, { generate: async input => {
    if (++models === 2) { assert.equal(failedCheckpoint, true); assert.match(input.messages[0].content, /CONTROLLED_RUNTIME_CRASH/); }
    return model(input);
  } });
  assert.equal(models, 2); assert.equal(checks, 2); assert.equal(result.repairsUsed, 1);
  assert.equal(result.runtimeValidation?.ok, true);
});
test("two runtime failures retain the exact failed draft and never become a successful result", async () => {
  let calls = 0;
  await assert.rejects(forgeGameWithAI("custom game", { validateRuntime: async html => report(html, "failed") }, {
    generate: async input => { calls++; return model(input); },
  }), (error: unknown) => {
    assert.ok(error instanceof ForgeDraftError); assert.equal(error.draft.code, code);
    assert.equal(error.draft.runtimeValidation?.ok, false); return true;
  });
  assert.equal(calls, 2);
});
test("missing browser retains the draft without wasting another model call", async () => {
  let calls = 0;
  await assert.rejects(forgeGameWithAI("custom game", { validateRuntime: async html => report(html, "unavailable") }, {
    generate: async input => { calls++; return model(input); },
  }), /Browser unavailable/);
  assert.equal(calls, 1);
});
