import test from "node:test";
import assert from "node:assert/strict";
import { SessionSaveQueue } from "./session-save-queue";

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
