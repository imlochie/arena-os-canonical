import assert from "node:assert/strict";
import test from "node:test";
import { createImportedSourceBackup, parseImportedSourceBackup, MAX_SOURCE_BACKUP_BYTES, type SourceBackupGame } from "./importedGameSourceBackup";
import { restoreImportedRevision, undoImportedRevision, getImportedRevisionHistory } from "./importedGameRevision";
import { withRepositoryAttribution } from "./importedRepositoryAttribution";

const html = (label: string) => `<!doctype html><html><body><p>${label}</p><img src="data:image/png;base64,aGVsbG8="><script>localStorage.setItem("score","7")</script></body></html>`;
const provenance = {
  repository: "owner/game", revision: "a".repeat(40),
  sourceUrl: `https://github.com/owner/game/tree/${"a".repeat(40)}`,
  license: { spdx: "MIT", path: "LICENSE", text: "Copyright Example\nMIT license text" },
};
const game: SourceBackupGame = {
  id: "stable-game-id", kind: "html", name: "My imported game.html", addedAt: 100,
  source: withRepositoryAttribution(html("active"), provenance), provenance,
  revisionLabel: "Latest", revisionUndoSource: withRepositoryAttribution(html("pending undo"), provenance),
  revisionUndoLabel: "Before edit",
  revisionRollback: { source: withRepositoryAttribution(html("rollback"), provenance), savedAt: 99, label: "Kept" },
  revisionHistory: [{ source: withRepositoryAttribution(html("older"), provenance), savedAt: 98, label: "Original" }],
};
const envelope = (g: unknown = game) => JSON.stringify({ format: "arenaforge-html-source", version: 1, exportedAt: 200, game: g });

test("portable source roundtrip preserves exact assets, attribution, identity, pending undo and every kept copy", () => {
  const text = createImportedSourceBackup({ ...game, __arenaShelfRevision: "private", progress: { score: "99" } } as SourceBackupGame);
  const restored = parseImportedSourceBackup(text).game;
  assert.deepEqual(restored, game);
  assert.equal(text.includes("__arenaShelfRevision"), false);
  assert.equal(text.includes('"progress"'), false);
  // Simulate another reload serialization before undoing and rolling back.
  const reloaded = JSON.parse(JSON.stringify(restored));
  const undone = undoImportedRevision(reloaded);
  assert.equal(undone.source, game.revisionUndoSource);
  assert.equal(restoreImportedRevision(undone).source, game.revisionRollback!.source);
  assert.equal(getImportedRevisionHistory(reloaded).length, 2);
  assert.equal(restoreImportedRevision(undone, 300, 1).source, game.revisionHistory![0].source);
  assert.equal(restored.id, game.id);
});

test("malformed formats, metadata and unexpected save data are rejected", () => {
  for (const text of ["not json", "null", "[]", "{}", envelope({ ...game, kind: "nes" }),
    envelope({ ...game, id: "" }), envelope({ ...game, id: "../other" }), envelope({ ...game, addedAt: -1 }),
    envelope({ ...game, name: "x".repeat(256) }), envelope({ ...game, progress: { score: 1 } }),
    envelope({ ...game, revisionUndoSource: null }), envelope({ ...game, revisionLabel: "x".repeat(121) }),
    envelope({ ...game, provenance: { ...provenance, sourceUrl: "https://example.com" } }),
    envelope().replace('"version":1', '"version":2')]) {
    assert.throws(() => parseImportedSourceBackup(text));
  }
});

test("unsafe source is rejected in active, undo, rollback and older history before any shelf mutation", () => {
  const unsafe = html("bad").replace("</body>", '<script>fetch("https://example.com")</script></body>');
  const original = JSON.stringify(game);
  for (const changed of [
    { ...game, source: unsafe }, { ...game, revisionUndoSource: unsafe },
    { ...game, revisionRollback: { source: unsafe, savedAt: 1 } },
    { ...game, revisionHistory: [{ source: unsafe, savedAt: 1 }] },
  ]) assert.throws(() => parseImportedSourceBackup(envelope(changed)), /rejected/);
  assert.equal(JSON.stringify(game), original);
});

test("conflicting or malformed embedded attribution is rejected in every revision", () => {
  const other = withRepositoryAttribution(html("other"), { ...provenance, license: { ...provenance.license, text: "Different license" } });
  for (const changed of [
    { ...game, source: other }, { ...game, revisionUndoSource: other },
    { ...game, revisionRollback: { source: other, savedAt: 1 } },
    { ...game, revisionHistory: [{ source: other, savedAt: 1 }] },
    { ...game, source: `${html("bad")}<script type="application/json" id="arena-repository-attribution">{}</script>` },
  ]) assert.throws(() => parseImportedSourceBackup(envelope(changed)), /attribution|license/);
});

test("per-source, history count, retained bytes and whole-file budgets are enforced", () => {
  assert.throws(() => parseImportedSourceBackup(envelope({ ...game, source: html("x".repeat(6 * 1024 * 1024)) })), /6 MB/);
  assert.throws(() => parseImportedSourceBackup(envelope({ ...game, revisionHistory: Array(6).fill(game.revisionRollback) })), /revision copies/);
  const largeCopy = { source: html("x".repeat(5 * 1024 * 1024)), savedAt: 1 };
  assert.throws(() => parseImportedSourceBackup(envelope({ ...game, revisionRollback: largeCopy, revisionHistory: Array(3).fill(largeCopy) })), /revision copies/);
  assert.throws(() => parseImportedSourceBackup(" ".repeat(MAX_SOURCE_BACKUP_BYTES + 1)), /40 MB/);
});

test("legacy rollback-only and history-free games remain portable", () => {
  const simple: SourceBackupGame = { id: "legacy", kind: "html", name: "Game.html", addedAt: 1, source: html("old") };
  assert.deepEqual(parseImportedSourceBackup(createImportedSourceBackup(simple)).game, simple);
  const rollback = { ...simple, revisionRollback: { source: html("older"), savedAt: 0 } };
  assert.deepEqual(parseImportedSourceBackup(createImportedSourceBackup(rollback)).game, rollback);
});
