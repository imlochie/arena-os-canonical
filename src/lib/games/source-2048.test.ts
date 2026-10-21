import test from "node:test";
import assert from "node:assert/strict";
import { create2048Mod, patchInitialTiles } from "./source-2048";
test("supported patch is exact, reviewable, bounded and never guesses an upstream conflict", () => {
  const source = "before\n  this.startTiles     = 2;\nafter\n";
  const patched = patchInitialTiles(source, 3);
  assert.equal(patched.modified, source.replace("= 2", "= 3"));
  assert.match(patched.patch, /@@ -1,3 \+1,3 @@/);
  assert.throws(() => patchInitialTiles(source, 17), /2 to 8/);
  assert.throws(() => patchInitialTiles(source + source, 3), /anchor changed/);
  assert.throws(() => patchInitialTiles(source.replace("= 2", "= 4"), 3), /anchor changed/);
});
test("invalid input cannot fetch; a synthetic substitute cannot masquerade as pinned upstream", async () => {
  let calls = 0;
  const fake = async () => { calls++; return new Response("synthetic substitute"); };
  await assert.rejects(create2048Mod(1, fake), /2 to 8/); assert.equal(calls, 0);
  await assert.rejects(create2048Mod(3, fake), /integrity mismatch/);
});
