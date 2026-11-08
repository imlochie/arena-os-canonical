import assert from "node:assert/strict";
import test from "node:test";
import { create2048Mod, validate2048Bundle } from "@workspace/arena/lib/games/source-2048";
import { verify2048Rule } from "./source-rule-validation";

// Real hash-pinned upstream bytes (network) and a real Chromium run with the
// verifier's controlled random draws. Nothing here is mocked.
test("2048 guaranteed-four rule is proven by real keyboard moves in a fresh sandbox", { timeout: 60000 }, async () => {
  const bundle = await create2048Mod(3, undefined, "guaranteed-four");
  assert.equal(bundle.modification.spawnRule, "guaranteed-four");
  assert.ok(bundle.modification.content.includes("    var value = 4;"));
  const report = await verify2048Rule(bundle);
  assert.equal(report.status, "passed", JSON.stringify(report));
  assert.equal(report.observations.length, 4);
  assert.ok(report.observations.filter((o) => !o.baseline).every((o) => o.spawnedValue === 4 && o.initialValues.length === 3));
  assert.ok(report.observations.filter((o) => o.baseline).some((o) => o.spawnedValue === 2));
});

test("a package whose patch or source was tampered with is rejected before any browser run", async () => {
  const bundle = JSON.parse(JSON.stringify(await create2048Mod(2, undefined, "original")));
  assert.doesNotThrow(() => validate2048Bundle(bundle));
  const tampered = JSON.parse(JSON.stringify(bundle));
  tampered.modification.content = tampered.modification.content.replace("startTiles     = 2", "startTiles     = 7");
  assert.throws(() => validate2048Bundle(tampered));
  const forged = JSON.parse(JSON.stringify(bundle));
  forged.files[1].content += "\n// injected";
  assert.throws(() => validate2048Bundle(forged), /integrity/);
  const report = await verify2048Rule(tampered).catch((e: Error) => e);
  assert.ok(report instanceof Error, "tampered bundle must not reach verification");
});
