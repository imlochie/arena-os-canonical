import test from "node:test";
import assert from "node:assert/strict";
import { tapFailureAnnotations } from "./ci-tap-summary.mjs";
test("failed test identities survive without publishing tool output/private assertions", () => {
  const result = tapFailureAnnotations("ok 1 - works\nnot ok 2 - real Redis handoff\n  error: SECRET_PRIVATE_OUTPUT\n  not ok 3 - nested claim\nnot ok 2 - real Redis handoff\n");
  assert.equal(result.length, 2); assert.match(result[0], /real Redis handoff/); assert.ok(!result.join().includes("SECRET_PRIVATE_OUTPUT"));
});
test("annotation message escapes percent markers and bounds result size", () => {
  const result = tapFailureAnnotations(Array.from({ length: 100 }, (_, i) => `not ok ${i} - failure %0A${i}`).join("\n"));
  assert.equal(result.length, 20); assert.ok(result[0].includes("%250A"));
});
test("a passing or absent TAP is never relabelled a test failure", () => {
  assert.deepEqual(tapFailureAnnotations("ok 1 - good\n# fail 0\n"), []);
});
