import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import test from "node:test";

import {
  createAudioBackupCsv,
  createVerifiedAudioBackupZip,
  MAX_AUDIO_BACKUP_BYTES,
  safeAudioBackupSegment,
  type AudioBackupEntry,
} from "./audio-backup";

function entry(name: string, value = "123456789"): AudioBackupEntry {
  const bytes = Buffer.from(value);
  return {
    name,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    open: async () => Readable.from([bytes.subarray(0, 3), bytes.subarray(3)]),
  };
}

test("audio backup ZIP preserves exact bytes and emits valid stored ZIP records", async () => {
  const name = "audio/Artist 🎵/Album/track.flac";
  const zip = await createVerifiedAudioBackupZip([entry(name)]);
  try {
    const data = await readFile(zip.path);
    const nameBytes = Buffer.byteLength(name);
    assert.equal(data.length, zip.bytes);
    assert.equal(data.readUInt32LE(0), 0x04034b50);
    assert.equal(data.readUInt16LE(6), 0x0808);
    assert.equal(data.subarray(30, 30 + nameBytes).toString(), name);
    const end = data.length - 22;
    const centralOffset = data.readUInt32LE(end + 16);
    assert.equal(data.readUInt32LE(end), 0x06054b50);
    assert.equal(data.readUInt16LE(end + 10), 1);
    assert.equal(data.readUInt32LE(centralOffset), 0x02014b50);
    assert.equal(data.readUInt32LE(centralOffset + 16), 0xcbf43926);
    assert.equal(data.subarray(30 + nameBytes, 39 + nameBytes).toString(), "123456789");
    assert.equal(data.readUInt32LE(39 + nameBytes), 0x08074b50);
  } finally {
    await zip.dispose();
  }
  await assert.rejects(stat(zip.path), { code: "ENOENT" });
});

test("audio backup rejects unsafe paths, duplicate paths, and oversized archives", async () => {
  for (const name of ["../a", "/a", "a//b", "a/./b", "C:/a", "a\\b", "a\0b", "CON/a", "a./b"]) {
    await assert.rejects(createVerifiedAudioBackupZip([entry(name)]), /filename/i);
  }
  await assert.rejects(createVerifiedAudioBackupZip([entry("audio/A.flac"), entry("audio/a.flac")]), /same backup path/);
  await assert.rejects(
    createVerifiedAudioBackupZip([{
      ...entry("audio/large.flac"),
      bytes: MAX_AUDIO_BACKUP_BYTES,
      open: async () => { throw new Error("should not open"); },
    }]),
    /2 GiB/,
  );
});

test("audio backup refuses missing, extended, corrupt, or failed source streams", async () => {
  const good = entry("audio/track.flac");
  await assert.rejects(createVerifiedAudioBackupZip([{ ...good, bytes: good.bytes + 1 }]), /checksum verification/);
  await assert.rejects(createVerifiedAudioBackupZip([{ ...good, bytes: good.bytes - 1 }]), /changed size/);
  await assert.rejects(createVerifiedAudioBackupZip([{ ...good, sha256: "0".repeat(64) }]), /checksum verification/);
  await assert.rejects(
    createVerifiedAudioBackupZip([{
      ...good,
      open: async () => Readable.from((async function* () {
        yield Buffer.from("123");
        throw new Error("source read failed");
      })()),
    }]),
    /source read failed/,
  );
});

test("audio backup honors cancellation before and during archive creation", async () => {
  const before = new AbortController();
  before.abort();
  await assert.rejects(createVerifiedAudioBackupZip([entry("audio/a")], before.signal), { name: "AbortError" });

  const during = new AbortController();
  await assert.rejects(createVerifiedAudioBackupZip([{
    ...entry("audio/b"),
    open: async () => Readable.from((async function* () {
      yield Buffer.from("123");
      during.abort();
      yield Buffer.from("456789");
    })()),
  }], during.signal));
});

test("CSV manifest quotes metadata and archive paths without changing audio bytes", () => {
  const csv = createAudioBackupCsv([{
    trackId: "track-1",
    title: 'Title, "live"',
    artist: "Artist",
    album: "Album",
    durationSeconds: 92,
    codec: "flac",
    originalFilename: "source.flac",
    archivePath: "audio/Artist/Album/source.flac",
    fileSizeBytes: 1234,
    checksumSha256: "a".repeat(64),
  }]);
  assert.match(csv, /"Title, ""live"""/);
  assert.match(csv, /"audio\/Artist\/Album\/source\.flac"/);
  assert.equal(safeAudioBackupSegment("CON", "fallback"), "_CON");
  assert.equal(safeAudioBackupSegment("..", "fallback"), "fallback");
});
