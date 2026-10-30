import assert from "node:assert/strict";
import test from "node:test";
import { generateGameOffline } from "@workspace/arena/lib/games";
import { verifyArcadeRuntime } from "./runtime-verification";

test("isolated browser check reports an animation-loop canvas startup", async () => {
  const code = generateGameOffline("Pong", "pong").code;
  const report = await verifyArcadeRuntime(code);

  assert.equal(report.status, "passed", JSON.stringify(report));
  assert.equal(report.scope, "startup-render-only");
  assert.ok((report.canvas?.width ?? 0) >= 32);
  assert.ok((report.animationFrames ?? 0) >= 2);
  assert.equal(report.blockedRequests, 0);
});

test("isolated browser check catches uncaught startup errors without publishing", async () => {
  const code = generateGameOffline("Pong", "pong").code.replace(
    "</body>",
    `<script>document.addEventListener("DOMContentLoaded",function(){throw new Error("intentional startup failure")});</script></body>`,
  );
  const report = await verifyArcadeRuntime(code);

  assert.equal(report.status, "failed", JSON.stringify(report));
  assert.match(report.issues.join(" "), /intentional startup failure/);
});
