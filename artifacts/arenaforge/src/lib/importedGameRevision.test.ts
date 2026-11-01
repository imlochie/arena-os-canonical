import assert from "node:assert/strict";
import { test } from "node:test";
import { keepImportedRevision, restoreImportedRevision, undoImportedRevision } from "./importedGameRevision";

test("keeping a legacy pending edit retains exactly one previous version", () => {
  const old = { id: "same-game", source: "new", revisionUndoSource: "old", provenance: { license: "MIT" } };
  const kept = keepImportedRevision(old, 123);
  assert.equal(kept.source, "new");
  assert.equal(kept.id, old.id);
  assert.equal(kept.provenance, old.provenance);
  assert.equal("revisionUndoSource" in kept, false);
  assert.deepEqual(kept.revisionRollback, { source: "old", savedAt: 123 });
  assert.equal(old.revisionUndoSource, "old", "input record must not be mutated");
});

test("each kept edit replaces, rather than appends to, the bounded rollback", () => {
  const first = keepImportedRevision({ source: "v2", revisionUndoSource: "v1" }, 10);
  const second = keepImportedRevision({ ...first, source: "v3", revisionUndoSource: "v2" }, 20);
  assert.deepEqual(second.revisionRollback, { source: "v2", savedAt: 20 });
  assert.equal(second.source, "v3");
  assert.deepEqual(first.revisionRollback, { source: "v1", savedAt: 10 });
});

test("restoration swaps code without losing the replaced version or identity", () => {
  const kept = keepImportedRevision({ source: "v2", revisionUndoSource: "v1", id: "stable", romData: undefined }, 10);
  const restored = restoreImportedRevision(kept, 20);
  assert.equal(restored.source, "v1");
  assert.equal(restored.id, "stable");
  assert.deepEqual(restored.revisionRollback, { source: "v2", savedAt: 20 });
  assert.equal(restoreImportedRevision(restored, 30).source, "v2");
  assert.equal(kept.source, "v2");
});

test("undoing an unkept edit preserves the earlier kept rollback", () => {
  const game = { source: "v3", revisionUndoSource: "v2", revisionRollback: { source: "v1", savedAt: 10 } };
  const undone = undoImportedRevision(game);
  assert.equal(undone.source, "v2");
  assert.deepEqual(undone.revisionRollback, game.revisionRollback);
  assert.equal("revisionUndoSource" in undone, false);
  assert.equal(restoreImportedRevision(game), game, "pending edits must be kept or undone before older restoration");
});

test("missing rollback or pending undo remains a no-op; snapshots retain exact source bytes", () => {
  const plain = { source: "<html>\n<!-- original -->\n</html>" };
  assert.equal(keepImportedRevision(plain), plain);
  assert.equal(undoImportedRevision(plain), plain);
  assert.equal(restoreImportedRevision(plain), plain);
  const kept = keepImportedRevision({ source: "new", revisionUndoSource: plain.source }, 10);
  const roundtrip = JSON.parse(JSON.stringify(kept));
  assert.equal(restoreImportedRevision(roundtrip).source, plain.source);
});
