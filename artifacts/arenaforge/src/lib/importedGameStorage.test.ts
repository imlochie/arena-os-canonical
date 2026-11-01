import assert from "node:assert/strict";
import test from "node:test";
import { importedGameRecordsMatch, importedGameStorageChanges } from "./importedGameStorage";

test("updating one imported game leaves unchanged ROM records untouched", () => {
  const largeRom = { id: "rom", kind: "emulator", romData: { byteLength: 64 * 1024 * 1024 } };
  const html = { id: "html", kind: "html", source: "<main>old</main>" };
  const removed = { id: "removed", kind: "nes", source: "rom-data" };
  const revisedHtml = { ...html, source: "<main>revised</main>" };

  const changes = importedGameStorageChanges(
    [largeRom, html, removed],
    [largeRom, revisedHtml],
  );

  assert.deepEqual(changes.upsert, [revisedHtml]);
  assert.deepEqual(changes.remove, ["removed"]);
  assert.equal(changes.upsert.some((record) => record.id === largeRom.id), false);
});

test("adding an import upserts only the new record", () => {
  const existing = { id: "existing", source: "kept" };
  const added = { id: "added", source: "new" };

  assert.deepEqual(importedGameStorageChanges([existing], [existing, added]), {
    upsert: [added],
    remove: [],
  });
});

test("changed or removed records do not match a stale baseline", () => {
  const previous = { id: "game", source: "old", __arenaShelfRevision: "one" };
  assert.equal(importedGameRecordsMatch(previous, { ...previous, source: "new", __arenaShelfRevision: "two" }), false);
  assert.equal(importedGameRecordsMatch(previous, undefined), false);
  assert.equal(importedGameRecordsMatch(undefined, previous), false);
  assert.equal(importedGameRecordsMatch(undefined, undefined), true);
});

test("legacy records compare source metadata and tolerate structured-cloned ROM buffers", () => {
  const previous = { id: "game", source: "old", romData: new ArrayBuffer(32) };
  assert.equal(importedGameRecordsMatch(previous, structuredClone(previous)), true);
  assert.equal(importedGameRecordsMatch(previous, { ...previous, source: "changed" }), false);
  assert.equal(importedGameRecordsMatch(previous, { ...previous, romData: new ArrayBuffer(64) }), false);
});
