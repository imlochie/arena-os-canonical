import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { readFile, stat } from "node:fs/promises";
import { createVerifiedZip, MAX_ARCHIVE_BYTES, type ArchiveEntry } from "./archive";

function entry(name: string, value = "123456789"): ArchiveEntry {
  const bytes = Buffer.from(value);
  return { name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
    open: async () => Readable.from([bytes.subarray(0, 3), bytes.subarray(3)]) };
}
test("ZIP stores exact bytes, CRC32, UTF-8 folder names, data descriptors and central offsets", async () => {
  const name = "Artist 🎵/Album/01 - Song.flac", source = entry(name);
  const zip = await createVerifiedZip([source]);
  try {
    const data = await readFile(zip.path), namesize = Buffer.byteLength(name);
    assert.equal(data.length, zip.bytes);
    assert.equal(data.readUInt32LE(0), 0x04034b50);
    assert.equal(data.readUInt16LE(6), 0x0808);
    assert.equal(data.subarray(30, 30 + namesize).toString(), name);
    const end = data.length - 22, central = data.readUInt32LE(end + 16);
    assert.equal(data.readUInt32LE(end), 0x06054b50);
    assert.equal(data.readUInt16LE(end + 10), 1);
    assert.equal(data.readUInt32LE(central), 0x02014b50);
    assert.equal(data.readUInt32LE(central + 16), 0xcbf43926); // independent standard CRC vector
    assert.equal(data.readUInt32LE(central + 20), 9);
    assert.equal(data.readUInt32LE(central + 42), 0);
    assert.equal(data.subarray(30 + namesize, 39 + namesize).toString(), "123456789");
    assert.equal(data.readUInt32LE(39 + namesize), 0x08074b50);
  } finally { await zip.dispose(); }
  await assert.rejects(stat(zip.path), { code: "ENOENT" });
});
test("ZIP rejects traversal, portable-name collisions, unsafe names and declared archive overflow before opening media", async () => {
  for (const name of ["../a", "/a", "a//b", "a/./b", "C:/a", "a\\b", "a\0b", "CON/a", "a./b"]) {
    await assert.rejects(createVerifiedZip([entry(name)]), /Unsafe/);
  }
  await assert.rejects(createVerifiedZip([entry("A.flac"), entry("a.flac")]), /collide/);
  await assert.rejects(createVerifiedZip([entry("é.flac"), entry("e\u0301.flac")]), /collide/);
  let opened = false;
  await assert.rejects(createVerifiedZip([{ ...entry("large.flac"), bytes: MAX_ARCHIVE_BYTES, open: async () => { opened = true; return Readable.from([]); } }]), /2 GiB/);
  assert.equal(opened, false);
});
test("ZIP refuses truncated, extended, corrupt and failed reads rather than returning a partial archive", async () => {
  const good = entry("a.flac");
  await assert.rejects(createVerifiedZip([{ ...good, bytes: good.bytes + 1 }]), /checksum\/size/);
  await assert.rejects(createVerifiedZip([{ ...good, bytes: good.bytes - 1 }]), /size changed/);
  await assert.rejects(createVerifiedZip([{ ...good, sha256: "0".repeat(64) }]), /checksum\/size/);
  await assert.rejects(createVerifiedZip([{ ...good, open: async () => Readable.from((async function* () { yield Buffer.from("123"); throw Error("read failed"); })()) }]), /read failed/);
});
test("ZIP honours cancellation before acquisition and during a source stream", async () => {
  const before = new AbortController(); before.abort();
  await assert.rejects(createVerifiedZip([entry("a")], before.signal), { name: "AbortError" });
  const during = new AbortController();
  await assert.rejects(createVerifiedZip([{ ...entry("a"), open: async () => Readable.from((async function* () {
    yield Buffer.from("123"); during.abort(); yield Buffer.from("456789");
  })()) }], during.signal));
});
test("ZIP bounds concurrent temporary archives and releases capacity on disposal", async () => {
  const first = await createVerifiedZip([entry("a")]), second = await createVerifiedZip([entry("b")]);
  try { await assert.rejects(createVerifiedZip([entry("c")]), /already being prepared/); }
  finally { await first.dispose(); await second.dispose(); }
  const next = await createVerifiedZip([entry("d")]); await next.dispose();
});
