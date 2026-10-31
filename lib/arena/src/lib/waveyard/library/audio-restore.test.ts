import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createAudioBackupCsv, createVerifiedAudioBackupZip, type AudioBackupEntry } from "./audio-backup";
import { restoreVerifiedAudioBackupZip } from "./audio-restore";

const trackId = "c1de0f38-9b43-4fa0-8f0d-963f58a0ac73";
const audioName = `audio/Artist/Album/${trackId} - Song.wav`;

function audioEntry(bytes: Buffer): AudioBackupEntry {
  return {
    name: audioName,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    open: async () => (await import("node:stream")).Readable.from([bytes]),
  };
}

function manifestEntry(bytes: Buffer): AudioBackupEntry {
  return {
    name: "manifest.csv",
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    open: async () => (await import("node:stream")).Readable.from([bytes]),
  };
}

function manifest(audio: Buffer) {
  return Buffer.from(createAudioBackupCsv([{
    trackId,
    title: "Song",
    artist: "Artist",
    album: "Album",
    durationSeconds: 3.25,
    codec: "pcm_s16le",
    originalFilename: "song.wav",
    archivePath: audioName,
    fileSizeBytes: audio.length,
    checksumSha256: createHash("sha256").update(audio).digest("hex"),
  }]));
}

test("audio restore verifies a Waveyard ZIP, imports manifest metadata, and preserves exact bytes", async () => {
  const original = Buffer.from([0, 1, 2, 255, 254, 128, 9]);
  const csv = manifest(original);
  const zip = await createVerifiedAudioBackupZip([audioEntry(original), manifestEntry(csv)]);
  try {
    const received: Array<{ title: string; artist: string; path: string; bytes: Buffer }> = [];
    const result = await restoreVerifiedAudioBackupZip(zip.path, async (row, localPath) => {
      received.push({
        title: row.title,
        artist: row.artist,
        path: localPath,
        bytes: await readFile(localPath),
      });
      return row.trackId;
    });
    assert.equal(result.totalBytes, original.length);
    assert.deepEqual(result.results, [trackId]);
    assert.equal(received[0].title, "Song");
    assert.equal(received[0].artist, "Artist");
    assert.deepEqual(received[0].bytes, original);
    await assert.rejects(readFile(received[0].path), { code: "ENOENT" }, "temporary extracted audio is removed");
  } finally {
    await zip.dispose();
  }
});

test("audio restore rejects a checksum-corrupt archive before importing any file", async () => {
  const original = Buffer.from("original bytes");
  const csv = manifest(original);
  const zip = await createVerifiedAudioBackupZip([audioEntry(original), manifestEntry(csv)]);
  const tampered = `${zip.path}.tampered`;
  try {
    const bytes = await readFile(zip.path);
    const archiveNameOffset = bytes.indexOf(Buffer.from(audioName));
    assert.notEqual(archiveNameOffset, -1);
    const payloadOffset = archiveNameOffset + Buffer.byteLength(audioName);
    bytes[payloadOffset] ^= 0xff;
    await writeFile(tampered, bytes);
    let callbacks = 0;
    await assert.rejects(
      restoreVerifiedAudioBackupZip(tampered, async () => { callbacks += 1; }),
      /checksum verification/i,
    );
    assert.equal(callbacks, 0, "the full archive is verified before any library changes");
  } finally {
    await rm(tampered, { force: true });
    await zip.dispose();
  }
});

test("audio restore rejects ZIP path traversal in the local and central directory", async () => {
  const original = Buffer.from("safe audio");
  const csv = manifest(original);
  const zip = await createVerifiedAudioBackupZip([audioEntry(original), manifestEntry(csv)]);
  const tampered = `${zip.path}.unsafe`;
  try {
    const bytes = await readFile(zip.path);
    const needle = Buffer.from(audioName);
    const locations: number[] = [];
    let cursor = 0;
    while (true) {
      const location = bytes.indexOf(needle, cursor);
      if (location < 0) break;
      locations.push(location);
      cursor = location + needle.length;
    }
    assert.equal(locations.length, 3, "the path is present in the local header, manifest, and central directory");
    // Keep the encoded path length unchanged while replacing its leading
    // "audio/" segment with a traversal prefix in the two ZIP headers.
    bytes.write("../../", locations[0], "utf8");
    bytes.write("../../", locations[2], "utf8");
    await writeFile(tampered, bytes);
    await assert.rejects(restoreVerifiedAudioBackupZip(tampered, async () => true), /unsafe archive path/i);
  } finally {
    await rm(tampered, { force: true });
    await zip.dispose();
  }
});
