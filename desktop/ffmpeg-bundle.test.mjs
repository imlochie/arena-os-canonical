import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { stageWindowsMediaTools, verifyArchiveDigest } from "./ffmpeg-bundle.mjs";

function fakeWindowsX64Image() {
  const image = Buffer.alloc(256);
  image.write("MZ", 0, "ascii");
  image.writeUInt32LE(0x80, 0x3c);
  image.write("PE\u0000\u0000", 0x80, "ascii");
  image.writeUInt16LE(0x8664, 0x84);
  return image;
}

test("stages only the Windows x64 FFmpeg tools and their shared libraries", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arena-ffmpeg-stage-test-"));
  const sourceBin = path.join(root, "source");
  const destinationBin = path.join(root, "stage", "bin");
  await mkdir(sourceBin, { recursive: true });
  try {
    for (const name of ["ffmpeg.exe", "ffprobe.exe", "avcodec-63.dll", "avformat-63.dll"]) {
      await writeFile(path.join(sourceBin, name), fakeWindowsX64Image());
    }
    await writeFile(path.join(sourceBin, "ffplay.exe"), fakeWindowsX64Image());
    const staged = await stageWindowsMediaTools(sourceBin, destinationBin);
    assert.deepEqual(staged.dllNames, ["avcodec-63.dll", "avformat-63.dll"]);
    assert.deepEqual(
      (await readdir(destinationBin)).sort(),
      ["avcodec-63.dll", "avformat-63.dll", "ffmpeg.exe", "ffprobe.exe"],
    );
    assert.equal((await readFile(staged.ffmpeg)).subarray(0, 2).toString("ascii"), "MZ");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a non-x64 executable rather than packaging the wrong architecture", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arena-ffmpeg-arch-test-"));
  const sourceBin = path.join(root, "source");
  await mkdir(sourceBin, { recursive: true });
  try {
    const x86Image = fakeWindowsX64Image();
    x86Image.writeUInt16LE(0x014c, 0x84);
    await writeFile(path.join(sourceBin, "ffmpeg.exe"), x86Image);
    await writeFile(path.join(sourceBin, "ffprobe.exe"), fakeWindowsX64Image());
    await writeFile(path.join(sourceBin, "avcodec-63.dll"), fakeWindowsX64Image());
    await assert.rejects(stageWindowsMediaTools(sourceBin, path.join(root, "stage")), /Windows x64/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("checks the pinned archive digest", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arena-ffmpeg-digest-test-"));
  const archivePath = path.join(root, "archive.zip");
  const content = Buffer.from("verified ffmpeg archive fixture");
  const digest = createHash("sha256").update(content).digest("hex");
  try {
    await writeFile(archivePath, content);
    assert.equal(await verifyArchiveDigest(archivePath, digest), digest);
    await assert.rejects(verifyArchiveDigest(archivePath, "0".repeat(64)), /SHA-256 mismatch/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
