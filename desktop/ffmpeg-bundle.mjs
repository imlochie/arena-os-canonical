import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  access,
  copyFile,
  open,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const FFMPEG_RELEASE = {
  archiveName: "ffmpeg-n9.0-latest-win64-lgpl-shared-9.0.zip",
  directoryName: "ffmpeg-n9.0-latest-win64-lgpl-shared-9.0",
  url: "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n9.0-latest-win64-lgpl-shared-9.0.zip",
  sha256: "1c4784a901a068e2d834ef5c262995b12f3734de72b15ec821eb13196c5f18d2",
};

async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

export async function verifyArchiveDigest(filePath, expectedDigest) {
  const actualDigest = await sha256File(filePath);
  if (actualDigest !== expectedDigest) {
    throw new Error(`FFmpeg archive SHA-256 mismatch: expected ${expectedDigest}, got ${actualDigest}.`);
  }
  return actualDigest;
}

async function cacheVerifiedArchive(cacheDir, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== "function") throw new Error("Node fetch is required to download the pinned FFmpeg build.");
  await mkdir(cacheDir, { recursive: true });
  const archivePath = path.join(cacheDir, FFMPEG_RELEASE.archiveName);
  const cached = await access(archivePath).then(() => true, () => false);
  if (cached) {
    try {
      await verifyArchiveDigest(archivePath, FFMPEG_RELEASE.sha256);
      return archivePath;
    } catch {
      await rm(archivePath, { force: true });
    }
  }

  const response = await fetchImpl(FFMPEG_RELEASE.url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`Could not download the pinned FFmpeg build (HTTP ${response.status}).`);
  }

  const partialPath = `${archivePath}.partial-${process.pid}`;
  try {
    await rm(partialPath, { force: true });
    await pipeline(
      Readable.fromWeb(response.body),
      createWriteStream(partialPath, { flags: "wx" }),
    );
    await verifyArchiveDigest(partialPath, FFMPEG_RELEASE.sha256);
    await rename(partialPath, archivePath);
  } finally {
    await rm(partialPath, { force: true });
  }
  return archivePath;
}

function powershellLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function assertWindowsX64PeFile(filePath) {
  const file = await open(filePath, "r");
  try {
    const dosHeader = Buffer.alloc(64);
    const { bytesRead } = await file.read(dosHeader, 0, dosHeader.length, 0);
    if (bytesRead < dosHeader.length || dosHeader.toString("ascii", 0, 2) !== "MZ") {
      throw new Error(`${path.basename(filePath)} is not a Windows PE file.`);
    }
    const peOffset = dosHeader.readUInt32LE(0x3c);
    const peHeader = Buffer.alloc(6);
    const pe = await file.read(peHeader, 0, peHeader.length, peOffset);
    if (pe.bytesRead !== peHeader.length || peHeader.toString("ascii", 0, 4) !== "PE\u0000\u0000") {
      throw new Error(`${path.basename(filePath)} has an invalid PE header.`);
    }
    if (peHeader.readUInt16LE(4) !== 0x8664) {
      throw new Error(`${path.basename(filePath)} is not a Windows x64 PE file.`);
    }
  } finally {
    await file.close();
  }
}

async function extractArchive(archivePath, destination, spawnSyncImpl = spawnSync) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `Expand-Archive -LiteralPath ${powershellLiteral(archivePath)} -DestinationPath ${powershellLiteral(destination)} -Force`,
  ].join("; ");
  const result = spawnSyncImpl(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { encoding: "utf8", windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Could not extract the FFmpeg build: ${(result.stderr || result.stdout || "PowerShell failed").slice(-2000)}`);
  }
}

export async function stageWindowsMediaTools(sourceBin, destinationBin) {
  const executableNames = ["ffmpeg.exe", "ffprobe.exe"];
  const dllNames = (await readdir(sourceBin, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /\.dll$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (dllNames.length === 0) throw new Error("The shared FFmpeg package contains no runtime DLLs.");

  await mkdir(destinationBin, { recursive: true });
  for (const name of [...executableNames, ...dllNames]) {
    const source = path.join(sourceBin, name);
    const destination = path.join(destinationBin, name);
    await access(source).catch(() => {
      throw new Error(`The pinned FFmpeg package is missing ${name}.`);
    });
    await copyFile(source, destination);
    await assertWindowsX64PeFile(destination);
  }
  return { ffmpeg: path.join(destinationBin, executableNames[0]), ffprobe: path.join(destinationBin, executableNames[1]), dllNames };
}

export async function stageFfmpegBundle({ cacheDir, destinationBin, spawnSyncImpl = spawnSync, fetchImpl = globalThis.fetch }) {
  const archivePath = await cacheVerifiedArchive(cacheDir, fetchImpl);
  const extractedRoot = await mkdtemp(path.join(tmpdir(), "arena-ffmpeg-stage-"));
  try {
    await extractArchive(archivePath, extractedRoot, spawnSyncImpl);
    const releaseRoot = path.join(extractedRoot, FFMPEG_RELEASE.directoryName);
    const sourceBin = path.join(releaseRoot, "bin");
    const staged = await stageWindowsMediaTools(sourceBin, destinationBin);
    await copyFile(path.join(releaseRoot, "LICENSE.txt"), path.join(destinationBin, "LICENSE-FFMPEG.txt"));
    return { ...staged, archivePath };
  } finally {
    await rm(extractedRoot, { recursive: true, force: true });
  }
}
