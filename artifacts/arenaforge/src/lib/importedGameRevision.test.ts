import assert from "node:assert/strict";
import { test } from "node:test";
import { keepImportedRevision, restoreImportedRevision, undoImportedRevision, getImportedRevisionHistory, importedRevisionMetadataValid, MAX_IMPORTED_REVISION_COPIES, MAX_IMPORTED_REVISION_BYTES } from "./importedGameRevision";

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

test("each kept edit moves the former head into older history without duplicating its bytes", () => {
  const first = keepImportedRevision({ source: "v2", revisionUndoSource: "v1" }, 10);
  const second = keepImportedRevision({ ...first, source: "v3", revisionUndoSource: "v2" }, 20);
  assert.deepEqual(second.revisionRollback, { source: "v2", savedAt: 20 });
  assert.equal(second.source, "v3");
  assert.deepEqual(first.revisionRollback, { source: "v1", savedAt: 10 });
  assert.deepEqual(second.revisionHistory, [{ source: "v1", savedAt: 10 }]);
  assert.deepEqual(getImportedRevisionHistory(second).map(copy => copy.source), ["v2", "v1"]);
});

test("restore any retained copy, preserve identity and provenance, and recover the displaced source", () => {
  const first = keepImportedRevision({ id: "stable", source: "B", revisionLabel: "Add jumping", revisionUndoSource: "A", revisionUndoLabel: "Original", provenance: { license: "MIT" } }, 10);
  const second = keepImportedRevision({ ...first, source: "C", revisionLabel: "Add lives", revisionUndoSource: "B", revisionUndoLabel: first.revisionLabel }, 20);
  const restored = restoreImportedRevision(second, 30, 1);
  assert.equal(restored.source, "A");
  assert.equal(restored.revisionLabel, "Original");
  assert.equal(restored.id, second.id);
  assert.equal(restored.provenance, second.provenance);
  assert.deepEqual(getImportedRevisionHistory(restored).map(copy => [copy.source, copy.label]), [["C", "Add lives"], ["B", "Add jumping"]]);
  assert.equal(restoreImportedRevision(restored, 40).source, "C");
  assert.equal(second.source, "C", "restore must not mutate its input");
  assert.equal(restoreImportedRevision(second, 40, 99), second);
  assert.equal(restoreImportedRevision(second, 40, -1), second);
  assert.equal(restoreImportedRevision(second, 40, 0.5), second);
});

test("retention drops oldest copies at the count limit, including after JSON reload", () => {
  let game = keepImportedRevision({ source: "v1", revisionUndoSource: "v0" }, 1);
  for (let i = 2; i <= 10; i++) game = keepImportedRevision({ ...game, source: `v${i}`, revisionUndoSource: game.source }, i);
  const roundtrip = JSON.parse(JSON.stringify(game));
  assert.equal(getImportedRevisionHistory(roundtrip).length, MAX_IMPORTED_REVISION_COPIES);
  assert.deepEqual(getImportedRevisionHistory(roundtrip).map(copy => copy.source), ["v9", "v8", "v7", "v6", "v5"]);
  assert.equal(roundtrip.revisionHistory.length, MAX_IMPORTED_REVISION_COPIES - 1);
  assert.equal(restoreImportedRevision(roundtrip, 20, 4).source, "v5");
  assert.equal(getImportedRevisionHistory(restoreImportedRevision(roundtrip, 20, 4)).length, MAX_IMPORTED_REVISION_COPIES);
});

test("the byte budget is bounded independently of copy count", () => {
  const bytes = MAX_IMPORTED_REVISION_BYTES / 3;
  const full = keepImportedRevision({
    source: "new",
    revisionUndoSource: "x".repeat(bytes),
    revisionRollback: { source: "y".repeat(bytes), savedAt: 1 },
    revisionHistory: [{ source: "z".repeat(bytes), savedAt: 0 }],
  }, 2);
  assert.equal(getImportedRevisionHistory(full).length, 3);
  const next = keepImportedRevision({ ...full, source: "next", revisionUndoSource: full.source }, 3);
  const retained = getImportedRevisionHistory(next);
  assert.equal(retained.length, 3);
  assert.equal(retained[0].source, "new");
  assert.equal(retained.some(copy => copy.source.startsWith("z")), false);
  assert.ok(retained.reduce((sum, copy) => sum + new TextEncoder().encode(copy.source).byteLength, 0) <= MAX_IMPORTED_REVISION_BYTES);
});

test("duplicate or unchanged source does not consume history, and undo restores the label", () => {
  const kept = keepImportedRevision({ source: "B", revisionUndoSource: "A", revisionRollback: { source: "A", savedAt: 1 } }, 2);
  assert.equal(getImportedRevisionHistory(kept).length, 1);
  const same = keepImportedRevision({ ...kept, revisionUndoSource: "B" }, 3);
  assert.equal(getImportedRevisionHistory(same).length, 1);
  const undone = undoImportedRevision({ ...kept, source: "C", revisionLabel: "C edit", revisionUndoSource: "B", revisionUndoLabel: "B edit" });
  assert.equal(undone.revisionLabel, "B edit");
  assert.deepEqual(undone.revisionHistory, kept.revisionHistory);
  assert.equal("revisionUndoLabel" in undone, false);
});

test("shelf metadata accepts legacy rollback and rejects malformed, unsafe or over-limit history", () => {
  const safe = (source: string) => source !== "unsafe";
  assert.equal(importedRevisionMetadataValid({}, safe), true);
  assert.equal(importedRevisionMetadataValid({ revisionRollback: { source: "legacy", savedAt: 1 } }, safe), true);
  assert.equal(importedRevisionMetadataValid({ revisionHistory: [{ source: "unsafe", savedAt: 1 }] }, safe), false);
  assert.equal(importedRevisionMetadataValid({ revisionHistory: [{ source: "ok", savedAt: Infinity }] }, safe), false);
  assert.equal(importedRevisionMetadataValid({ revisionHistory: Array.from({ length: 6 }, () => ({ source: "ok", savedAt: 1 })) }, safe), false);
  assert.equal(importedRevisionMetadataValid({ revisionLabel: "x".repeat(121) }, safe), false);
  assert.equal(importedRevisionMetadataValid({ revisionHistory: "not-an-array" } as never, safe), false);
  const tooBig = { revisionRollback: { source: "x".repeat(MAX_IMPORTED_REVISION_BYTES + 1), savedAt: 1 } };
  assert.equal(importedRevisionMetadataValid(tooBig, safe), false);
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
