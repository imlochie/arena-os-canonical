import test from "node:test";
import assert from "node:assert/strict";
import { create2048Mod, patchInitialTiles, patchGameplay } from "./source-2048";
test("supported patch is exact, reviewable, bounded and never guesses an upstream conflict", () => {
  const source = "before\n  this.startTiles     = 2;\nafter\n";
  const patched = patchInitialTiles(source, 3);
  assert.equal(patched.modified, source.replace("= 2", "= 3"));
  assert.match(patched.patch, /@@ -1,3 \+1,3 @@/);
  assert.throws(() => patchInitialTiles(source, 17), /2 to 8/);
  assert.throws(() => patchInitialTiles(source + source, 3), /anchor changed/);
  assert.throws(() => patchInitialTiles(source.replace("= 2", "= 4"), 3), /anchor changed/);
});
test("guaranteed-four changes the real spawn anchor and composes with the initial-tile patch", () => {
  const source = "constructor\n  this.startTiles     = 2;\nend\n\n\n\nspawn\n    var value = Math.random() < 0.9 ? 2 : 4;\nend\n";
  const changed = patchGameplay(source, 5, "guaranteed-four");
  assert.equal(changed.modified, source.replace("startTiles     = 2", "startTiles     = 5").replace("Math.random() < 0.9 ? 2 : 4", "4"));
  assert.equal(changed.patch.match(/^@@ /gm)?.length, 2);
  assert.deepEqual(patchGameplay(source, 3, "original"), patchInitialTiles(source, 3));
  assert.throws(() => patchGameplay(source.replace("< 0.9", "< 0.8"), 3, "guaranteed-four"), /anchor changed/);
  assert.throws(() => patchGameplay(source + source, 3, "guaranteed-four"), /anchor changed/);
  assert.throws(() => patchGameplay(source, 3, "unknown" as never), /Unsupported/);
});
test("invalid input cannot fetch; a synthetic substitute cannot masquerade as pinned upstream", async () => {
  let calls = 0;
  const fake = async () => { calls++; return new Response("synthetic substitute"); };
  await assert.rejects(create2048Mod(1, fake), /2 to 8/); assert.equal(calls, 0);
  await assert.rejects(create2048Mod(3, fake), /integrity mismatch/);
});
