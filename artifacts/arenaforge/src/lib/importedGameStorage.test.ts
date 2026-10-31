import assert from "node:assert/strict";
import test from "node:test";
import { importedGameStorageChanges } from "./importedGameStorage";

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
