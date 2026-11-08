/**
 * Immutable, SHA-bound content objects: bytes are published only when they
 * match the declared identity, identical bytes are stored once, and later
 * corruption is detected on read-back verification.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import {
  LocalStorageProvider,
  StorageIntegrityError,
  contentObjectKey,
} from "./storage";

const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const identityOf = (data: Buffer) => ({ sha256: sha(data), byteLength: data.length });

async function withStore(run: (store: LocalStorageProvider, dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), "wy-immutable-"));
  try {
    await run(new LocalStorageProvider(dir), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries.filter(entry => entry.isFile()).map(entry => entry.name);
}

const chunked = (data: Buffer, size = 7) =>
  Readable.from((function* () { for (let i = 0; i < data.length; i += size) yield data.subarray(i, i + size); })());

test("stores a matching stream under its SHA-256 and verifies it", () => withStore(async (store, dir) => {
  const data = Buffer.from("the quick brown fox ".repeat(100));
  const result = await store.putImmutableStream(chunked(data), identityOf(data));
  assert.equal(result.key, contentObjectKey(sha(data)));
  assert.equal(result.deduplicated, false);
  assert.deepEqual(await readFile(path.join(dir, result.key)), data);
  await store.verifyObject(result.key, identityOf(data));
}));

test("identical content is stored once and reported as deduplicated", () => withStore(async (store, dir) => {
  const data = Buffer.from("same bytes");
  const first = await store.putImmutableStream(chunked(data), identityOf(data));
  const second = await store.putImmutableStream(chunked(data), identityOf(data));
  assert.equal(second.key, first.key);
  assert.equal(second.deduplicated, true);
  assert.equal((await filesUnder(dir)).length, 1, "no duplicate or partial file remains");
}));

test("a stream whose bytes do not match the declared SHA-256 is rejected and leaves nothing", () => withStore(async (store, dir) => {
  const claimed = Buffer.from("what the caller says it sent");
  const actual = Buffer.from("what the caller really sent!");
  assert.equal(claimed.length, actual.length);
  await assert.rejects(
    store.putImmutableStream(chunked(actual), identityOf(claimed)),
    (error: unknown) => error instanceof StorageIntegrityError && error.reason === "sha256",
  );
  assert.deepEqual(await filesUnder(dir), []);
  assert.equal(await store.exists(contentObjectKey(sha(claimed))), false);
}));

test("a stream larger than declared is rejected without reading it all", () => withStore(async (store, dir) => {
  const declared = Buffer.from("short");
  let produced = 0;
  const endless = Readable.from((function* () {
    for (;;) { produced += 1024; yield Buffer.alloc(1024, 1); if (produced > 10_000_000) return; }
  })());
  await assert.rejects(
    store.putImmutableStream(endless, identityOf(declared)),
    (error: unknown) => error instanceof StorageIntegrityError && error.reason === "size",
  );
  assert.ok(produced < 1_000_000, `stopped early after ${produced} bytes`);
  assert.deepEqual(await filesUnder(dir), []);
}));

test("a stream shorter than declared is rejected", () => withStore(async (store, dir) => {
  const full = Buffer.from("complete content");
  await assert.rejects(
    store.putImmutableStream(chunked(full.subarray(0, 5)), identityOf(full)),
    (error: unknown) => error instanceof StorageIntegrityError && error.reason === "size",
  );
  assert.deepEqual(await filesUnder(dir), []);
}));

test("a source stream that errors mid-transfer leaves no partial object", () => withStore(async (store, dir) => {
  const data = Buffer.from("will be interrupted");
  const failing = new Readable({
    read() { this.push(data.subarray(0, 4)); this.destroy(new Error("connection reset")); },
  });
  await assert.rejects(store.putImmutableStream(failing, identityOf(data)), /connection reset/);
  assert.deepEqual(await filesUnder(dir), []);
}));

test("verifyObject detects missing, resized and same-size corrupted objects", () => withStore(async (store, dir) => {
  const data = Buffer.from("integrity matters");
  const { key } = await store.putImmutableStream(chunked(data), identityOf(data));
  const file = path.join(dir, key);

  await writeFile(file, Buffer.from("integrity matterz"));
  await assert.rejects(store.verifyObject(key, identityOf(data)),
    (error: unknown) => error instanceof StorageIntegrityError && error.reason === "sha256");

  await writeFile(file, Buffer.from("short"));
  await assert.rejects(store.verifyObject(key, identityOf(data)),
    (error: unknown) => error instanceof StorageIntegrityError && error.reason === "size");

  await store.delete(key);
  await assert.rejects(store.verifyObject(key, identityOf(data)),
    (error: unknown) => error instanceof StorageIntegrityError && error.reason === "missing");
}));

test("storing over a corrupted copy repairs it with the verified bytes", () => withStore(async (store, dir) => {
  const data = Buffer.from("repair me please");
  const { key } = await store.putImmutableStream(chunked(data), identityOf(data));
  await writeFile(path.join(dir, key), Buffer.from("garbage garbage!"));
  const again = await store.putImmutableStream(chunked(data), identityOf(data));
  assert.equal(again.deduplicated, false);
  await store.verifyObject(key, identityOf(data));
  assert.deepEqual(await filesUnder(dir), [path.basename(key)]);
}));

test("the empty object is a valid immutable object", () => withStore(async (store) => {
  const empty = Buffer.alloc(0);
  const { key } = await store.putImmutableStream(Readable.from([]), identityOf(empty));
  await store.verifyObject(key, identityOf(empty));
}));

test("malformed identities are refused before anything is written", () => withStore(async (store, dir) => {
  const data = Buffer.from("x");
  await assert.rejects(store.putImmutableStream(chunked(data), { sha256: "ABC", byteLength: 1 }), /SHA-256/);
  await assert.rejects(store.putImmutableStream(chunked(data), { sha256: sha(data), byteLength: -1 }), /byte length/);
  assert.deepEqual(await filesUnder(dir), []);
  assert.throws(() => contentObjectKey("../../etc/passwd"), /SHA-256/);
}));
