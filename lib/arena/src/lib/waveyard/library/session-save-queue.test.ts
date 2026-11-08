import test from "node:test";
import assert from "node:assert/strict";
import {
  localStorageSessionSaveJournal,
  sessionSavePatchAgainstPending,
  sessionSavePatchForTrack,
  SessionSaveQueue,
  type SessionSaveJournal,
} from "./session-save-queue";

test("a delayed acknowledged write cannot overtake the latest snapshot, including another deck", async () => {
  const writes: string[] = [];
  let acknowledge!: () => void;
  const queue = new SessionSaveQueue(async (url, body) => {
    writes.push(url + body);
    if (writes.length === 1) await new Promise<void>(resolve => { acknowledge = resolve; });
  }, () => {}, 60000);
  queue.enqueue("a", "old"); const flushing = queue.flush();
  queue.enqueue("a", "latest"); queue.enqueue("b", "other");
  assert.deepEqual(writes, ["aold"]);
  acknowledge(); assert.equal(await flushing, true);
  assert.deepEqual(writes, ["aold", "alatest", "bother"]);
  assert.equal(queue.unsaved, false);
  await queue.flush();
});

test("lost acknowledgement retains latest edits and requires explicit retry, not automatic replay", async () => {
  let attempts = 0, committed = "";
  const states: string[] = [];
  const queue = new SessionSaveQueue(async (_url, body) => {
    committed = body;
    if (++attempts === 1) throw new Error("server committed but response was lost");
  }, state => states.push(state), 60000);
  queue.enqueue("a", "old"); assert.equal(await queue.flush(), false);
  assert.equal(queue.unsaved, true); assert.equal(committed, "old");
  queue.enqueue("a", "new"); assert.equal(await queue.flush(), false);
  assert.equal(attempts, 1);
  assert.equal(await queue.flush(true), true);
  assert.equal(committed, "new"); assert.equal(queue.unsaved, false);
  assert.equal(states.at(-1), "saved");
});

test("acknowledged removal drops only that membership and an in-flight 404 cannot block other edits", async () => {
  let reject!: () => void;
  const writes: string[] = [];
  const queue = new SessionSaveQueue(async (url) => {
    writes.push(url);
    if (url === "removed") await new Promise<void>((_resolve, fail) => { reject = () => fail(new Error("404 after deletion")); });
  }, () => {}, 60000);
  queue.enqueue("removed", "old"); const flushing = queue.flush();
  queue.enqueue("retained", "new"); queue.forget("removed");
  reject(); assert.equal(await flushing, true);
  assert.deepEqual(writes, ["removed", "retained"]); assert.equal(queue.unsaved, false);
  await queue.flush();
});

test("replays a durable pending snapshot after controller restart and clears it only after acknowledgement", async () => {
  let entries: Array<[string, string]> = [];
  const journal: SessionSaveJournal = {
    read: () => entries.map(([url, body]) => [url, body]),
    write: (next) => { entries = next.map(([url, body]) => [url, body]); },
  };
  let attempts = 0;
  const first = new SessionSaveQueue(async () => {
    attempts += 1;
    throw new Error("commit may have succeeded but acknowledgement was lost");
  }, () => {}, 60_000, journal);
  first.enqueue("/api/library/sessions/s1/tracks/t1", "{\"stemMixPatch\":{\"drums\":0.4}}");
  assert.equal(await first.flush(), false);
  assert.equal(entries.length, 1);

  const recovered = new SessionSaveQueue(async () => { attempts += 1; }, () => {}, 60_000, journal);
  assert.equal(await recovered.flush(), true);
  assert.equal(attempts, 2);
  assert.deepEqual(entries, []);
  assert.equal(recovered.unsaved, false);
});

test("local journal rejects unrelated URLs and removes malformed stored data", () => {
  const values = new Map<string, string>([["queue", "not-json"]]);
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  const journal = localStorageSessionSaveJournal(storage, "queue");
  assert.deepEqual(journal.read(), []);
  journal.write([["https://example.invalid/", "secret"], ["/api/library/sessions/s1/tracks/t1", "{}"]]);
  assert.deepEqual(journal.read(), [["/api/library/sessions/s1/tracks/t1", "{}"]]);
});

test("restores only the latest journaled patch for the exact session track", () => {
  const entries: Array<[string, string]> = [
    ["/api/library/sessions/s1/tracks/t1", '{"stemMixPatch":{"drums":0.4}}'],
    ["/api/library/sessions/s2/tracks/t1", '{"stemMixPatch":{"drums":0.8}}'],
    ["/api/library/sessions/s1/tracks/t1", '{"transition":{"mode":"manual","crossfadeSeconds":2,"keepStems":[]}}'],
  ];
  assert.deepEqual(sessionSavePatchForTrack(entries, "s1", "t1"), {
    transition: { mode: "manual", crossfadeSeconds: 2, keepStems: [] },
  });
  assert.equal(sessionSavePatchForTrack(entries, "s1", "missing"), null);
  assert.equal(sessionSavePatchForTrack([["/api/library/sessions/s1/tracks/t1", "not-json"]], "s1", "t1"), null);
});

test("computes corrective writes against pending state when a control is reverted in flight", () => {
  const saved = {
    stemMix: { drums: 1, vocals: 1 },
    transitionJson: '{"mode":"manual","crossfadeSeconds":4,"keepStems":[]}',
  };
  const desired = { ...saved };
  const pending = { activeBody: '{"stemMixPatch":{"drums":0.4},"transition":{"mode":"manual","crossfadeSeconds":2,"keepStems":[]}}' };
  assert.equal(sessionSavePatchAgainstPending(saved, desired, pending),
    '{"stemMixPatch":{"drums":1},"transition":{"mode":"manual","crossfadeSeconds":4,"keepStems":[]}}');
  assert.equal(sessionSavePatchAgainstPending(saved, {
    stemMix: { drums: 0.4, vocals: 1 },
    transitionJson: '{"mode":"manual","crossfadeSeconds":2,"keepStems":[]}',
  }, pending), null);
});

test("replacement queued snapshots retain other fields that are still unsaved", () => {
  const saved = {
    stemMix: { drums: 1, vocals: 1 },
    transitionJson: '{"mode":"manual","crossfadeSeconds":4,"keepStems":[]}',
  };
  const desired = {
    stemMix: { drums: 0.7, vocals: 0.3 },
    transitionJson: saved.transitionJson,
  };
  const pending = {
    activeBody: '{"stemMixPatch":{"drums":0.4}}',
    queuedBody: '{"stemMixPatch":{"drums":0.6,"vocals":0.3}}',
  };
  assert.equal(sessionSavePatchAgainstPending(saved, desired, pending),
    '{"stemMixPatch":{"drums":0.7,"vocals":0.3}}');
});

test("replayed latest snapshot is correct even if the active request never committed", () => {
  const saved = {
    stemMix: { drums: 1, vocals: 1 },
    transitionJson: '{"mode":"manual","crossfadeSeconds":4,"keepStems":[]}',
  };
  const desired = {
    stemMix: { drums: 1, vocals: 0.5 },
    transitionJson: saved.transitionJson,
  };
  const pending = {
    activeBody: '{"stemMixPatch":{"drums":0.4,"vocals":0.2},"transition":{"mode":"manual","crossfadeSeconds":2,"keepStems":[]}}',
    queuedBody: '{"stemMixPatch":{"drums":0.8,"vocals":0.5}}',
  };
  assert.equal(sessionSavePatchAgainstPending(saved, desired, pending),
    '{"stemMixPatch":{"drums":1,"vocals":0.5},"transition":{"mode":"manual","crossfadeSeconds":4,"keepStems":[]}}');
});

test("reports the active request and replacement body in server order", async () => {
  let acknowledge!: () => void;
  let writes = 0;
  const queue = new SessionSaveQueue(async () => {
    writes += 1;
    if (writes === 1) await new Promise<void>((resolve) => { acknowledge = resolve; });
  }, () => {}, 60_000);
  queue.enqueue("track", '{"stemMixPatch":{"drums":0.4}}');
  const flushing = queue.flush();
  queue.enqueue("track", '{"stemMixPatch":{"drums":0.8}}');
  assert.deepEqual(queue.pendingWrites("track"), {
    activeBody: '{"stemMixPatch":{"drums":0.4}}',
    queuedBody: '{"stemMixPatch":{"drums":0.8}}',
  });
  acknowledge();
  assert.equal(await flushing, true);
  assert.deepEqual(queue.pendingWrites("track"), {});
  await queue.flush(); // Clear the debounce timer scheduled by the in-flight edit.
});
