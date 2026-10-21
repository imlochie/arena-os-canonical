import test from "node:test";
import assert from "node:assert/strict";
import { installFailureAnnotation } from "./ci-install-summary.mjs";
test("npm preparation diagnostics retain dependency/error class without exposing raw logs", () => {
  const text = "npm error code 1\nnpm error path /home/private/node_modules/onnxruntime-node\nnpm error command sh -c node ./script/install\nError: read ECONNRESET https://user:SECRET@example.org?token=SECRET\n";
  const result = installFailureAnnotation(text, ["onnxruntime-node"]);
  assert.match(result, /package=onnxruntime-node; exitCode=1; transport=ECONNRESET/);
  assert.match(result, /Product tests did not start/);
  assert.ok(!/SECRET|private|https|command|user:/.test(result));
});
test("unknown install output never turns into a test pass or leaks unrecognized values", () => {
  for (const text of ["", "npm error code SECRET\nnpm error path /x/node_modules/SECRET", "npm ERR! code EACCES\nnpm ERR! path C:\\work\\node_modules\\@scope\\tool"]) {
    const result = installFailureAnnotation(text, ["@scope/tool"]);
    assert.ok(!result.includes("SECRET")); assert.ok(!/[\r\n]/.test(result));
    assert.match(result, /not a passing receipt/);
    if (text.includes("EACCES")) assert.match(result, /package=@scope\/tool; exitCode=EACCES/);
  }
});
