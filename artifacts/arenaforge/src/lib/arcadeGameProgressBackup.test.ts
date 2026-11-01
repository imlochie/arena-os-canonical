import assert from "node:assert/strict";
import { test } from "node:test";
import { ARCADE_SAVE_PREFIX, MAX_PROGRESS_BACKUP_BYTES, createHtmlProgressBackup, parseHtmlProgressBackup, inspectHtmlProgressBackup, commitHtmlProgressRestore, validateGameSaveData } from "./arcadeGameProgressBackup";

function storage() {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}
const target = { id: "game-a", name: "A.html", source: "<html>Original</html>" };
async function fixture() {
  const store = storage();
  store.setItem(`${ARCADE_SAVE_PREFIX}game-a`, JSON.stringify({ progress: "42" }));
  return { store, backup: await createHtmlProgressBackup(target, store) };
}
test("export contains only versioned identity, fingerprint and exact progress, not source", async () => {
  const { backup } = await fixture();
  assert.equal(backup.version, 1);
  assert.match(backup.sourceSha256, /^[a-f0-9]{64}$/);
  assert.equal(backup.data.progress, "42");
  assert.equal(JSON.stringify(backup).includes("<html>"), false);
  assert.equal("source" in backup, false);
  assert.deepEqual(parseHtmlProgressBackup(JSON.stringify(backup)), backup);
});
test("matching identity accepts a source-version change but reports it for confirmation", async () => {
  const { backup, store } = await fixture();
  const inspected = await inspectHtmlProgressBackup(JSON.stringify(backup), { ...target, source: "<html>Revised</html>" }, store);
  assert.equal(inspected.sameIdentity, true);
  assert.equal(inspected.sameSource, false);
});
test("new import identities require exact source, independent of identical filenames", async () => {
  const { backup, store } = await fixture();
  const copy = await inspectHtmlProgressBackup(JSON.stringify(backup), { ...target, id: "new-import" }, store);
  assert.equal(copy.sameIdentity, false);
  assert.equal(copy.sameSource, true);
  await assert.rejects(inspectHtmlProgressBackup(JSON.stringify(backup), { ...target, id: "other", source: "<html>Other game</html>" }, store), /different game/);
});
test("restore writes only the selected namespace and preserves exact text data", async () => {
  const { backup, store } = await fixture();
  store.setItem(`${ARCADE_SAVE_PREFIX}other`, '{"progress":"untouched"}');
  const preview = await inspectHtmlProgressBackup(JSON.stringify(backup), target, store);
  commitHtmlProgressRestore(target.id, backup.data, preview.expectedRaw, store);
  assert.equal(store.getItem(`${ARCADE_SAVE_PREFIX}other`), '{"progress":"untouched"}');
  assert.equal(JSON.parse(store.getItem(`${ARCADE_SAVE_PREFIX}game-a`)!).progress, "42");
  assert.equal(store.values.size, 2);
});
test("stale preview and failed write leave the committed progress unchanged", async () => {
  const { backup, store } = await fixture();
  const expected = store.getItem(`${ARCADE_SAVE_PREFIX}game-a`);
  store.setItem(`${ARCADE_SAVE_PREFIX}game-a`, '{"progress":"newer"}');
  assert.throws(() => commitHtmlProgressRestore(target.id, backup.data, expected, store), /Progress changed/);
  const current = store.getItem(`${ARCADE_SAVE_PREFIX}game-a`);
  assert.throws(() => commitHtmlProgressRestore(target.id, backup.data, current, { getItem: store.getItem, setItem: () => { throw new Error("Quota failure"); } }), /Quota failure/);
  assert.equal(store.getItem(`${ARCADE_SAVE_PREFIX}game-a`), current);
});
test("malformed, unsupported, oversize and incorrectly typed backups are rejected", async () => {
  const { backup } = await fixture();
  for (const text of ["not JSON", "null", "[]", JSON.stringify({ ...backup, version: 2 }), JSON.stringify({ ...backup, sourceSha256: "invalid" }),
    JSON.stringify({ ...backup, data: { progress: 42 } }), JSON.stringify({ ...backup, data: [] }),
    JSON.stringify({ ...backup, exportedAt: 9e15 }), JSON.stringify({ ...backup, gameId: "" })]) {
    assert.throws(() => parseHtmlProgressBackup(text));
  }
  assert.throws(() => parseHtmlProgressBackup(" ".repeat(MAX_PROGRESS_BACKUP_BYTES + 1)), /256 KiB/);
  assert.throws(() => validateGameSaveData({ progress: "x".repeat(64 * 1024) }), /64 KiB/);
  assert.throws(() => validateGameSaveData({ ["k".repeat(257)]: "x" }), /invalid key/);
  assert.throws(() => validateGameSaveData({ "": "x" }), /invalid key/);
});
test("reserved keys and script-looking text stay literal and cannot alter prototypes", () => {
  const raw = '{"__proto__":"literal","constructor":"text","progress":"</script><script>bad()</script>"}';
  const data = validateGameSaveData(JSON.parse(raw));
  assert.equal(Object.getPrototypeOf(data), null);
  assert.equal(data.__proto__, "literal");
  assert.equal(data.constructor, "text");
  assert.equal(JSON.stringify(data), raw);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});
test("export never silently backs up absent or corrupt progress", async () => {
  const store = storage();
  await assert.rejects(createHtmlProgressBackup(target, store), /no saved progress/);
  store.setItem(`${ARCADE_SAVE_PREFIX}game-a`, "bad JSON");
  await assert.rejects(createHtmlProgressBackup(target, store));
});
