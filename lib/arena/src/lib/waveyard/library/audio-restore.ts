import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";

import { acceptedAudioFilename, MAX_UPLOAD_BYTES } from "../audio";
import { AudioBackupError, MAX_AUDIO_BACKUP_BYTES, MAX_AUDIO_BACKUP_FILES } from "./audio-backup";

export const AUDIO_RESTORE_UPLOAD_DIRECTORY_PREFIX = "waveyard-audio-restore-upload-";
export const AUDIO_RESTORE_UPLOAD_RETENTION_MS = 24 * 60 * 60 * 1_000;

const MAX_MANIFEST_BYTES = 512 * 1024;
const MAX_ZIP_ENTRIES = MAX_AUDIO_BACKUP_FILES + 1;
const CSV_HEADER = [
  "track_id", "title", "artist", "album", "duration_seconds", "codec",
  "original_filename", "backup_path", "file_size_bytes", "sha256",
];

export type AudioBackupManifestRow = {
  trackId: string;
  title: string;
  artist: string;
  album: string;
  durationSeconds: number;
  codec: string;
  originalFilename: string;
  backupPath: string;
  fileSizeBytes: number;
  sha256: string;
};

export type AudioRestoreProgress<T = unknown> = {
  phase: "validating" | "restoring";
  completedFiles: number;
  totalFiles: number;
  currentTitle?: string;
  result?: T;
};

type ZipEntry = {
  name: string;
  crc32: number;
  bytes: number;
  dataOffset: number;
  recordStart: number;
  recordEnd: number;
};

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return value >>> 0;
});

function fail(message: string, status = 422): never {
  throw new AudioBackupError(message, status);
}

function safeArchiveName(name: string) {
  if (
    !name ||
    Buffer.byteLength(name, "utf8") > 4096 ||
    name.startsWith("/") ||
    /[\\:<>"|?*\x00-\x1f\x7f]/.test(name) ||
    name.split("/").some((segment) =>
      !segment ||
      Buffer.byteLength(segment, "utf8") > 255 ||
      segment === "." ||
      segment === ".." ||
      /[. ]$/.test(segment) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(segment),
    )
  ) {
    fail("The backup contains an unsafe archive path.");
  }
}

async function readExact(file: Awaited<ReturnType<typeof open>>, position: number, length: number) {
  if (!Number.isSafeInteger(position) || !Number.isSafeInteger(length) || position < 0 || length < 0) {
    fail("The ZIP contains an invalid byte range.");
  }
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await file.read(buffer, 0, length, position);
  if (bytesRead !== length) fail("The ZIP is truncated or malformed.");
  return buffer;
}

function decodeUtf8(bytes: Buffer) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail("The ZIP contains a filename that is not valid UTF-8.");
  }
}

async function readZipEntries(archivePath: string): Promise<ZipEntry[]> {
  const details = await stat(archivePath);
  if (!Number.isSafeInteger(details.size) || details.size < 22 || details.size > MAX_AUDIO_BACKUP_BYTES) {
    fail("The backup ZIP must be between 22 bytes and 2 GiB.", 413);
  }

  const file = await open(archivePath, "r");
  try {
    const tailLength = Math.min(details.size, 65_557);
    const tail = await readExact(file, details.size - tailLength, tailLength);
    let endOffset = -1;
    for (let index = tail.length - 22; index >= 0; index -= 1) {
      if (tail.readUInt32LE(index) !== 0x06054b50) continue;
      const commentLength = tail.readUInt16LE(index + 20);
      if (index + 22 + commentLength === tail.length) {
        endOffset = index;
        break;
      }
    }
    if (endOffset < 0) fail("The file is not a supported Waveyard audio backup ZIP.");

    const end = tail.subarray(endOffset);
    const endAbsoluteOffset = details.size - tailLength + endOffset;
    const diskNumber = end.readUInt16LE(4);
    const centralDisk = end.readUInt16LE(6);
    const diskEntryCount = end.readUInt16LE(8);
    const entryCount = end.readUInt16LE(10);
    const centralBytes = end.readUInt32LE(12);
    const centralOffset = end.readUInt32LE(16);
    if (
      diskNumber !== 0 ||
      centralDisk !== 0 ||
      diskEntryCount !== entryCount ||
      entryCount < 2 ||
      entryCount > MAX_ZIP_ENTRIES ||
      centralOffset + centralBytes !== endAbsoluteOffset
    ) {
      fail("The ZIP layout is unsupported or its directory is inconsistent.");
    }

    const entries: ZipEntry[] = [];
    const names = new Set<string>();
    let cursor = centralOffset;
    for (let index = 0; index < entryCount; index += 1) {
      const header = await readExact(file, cursor, 46);
      if (header.readUInt32LE(0) !== 0x02014b50) fail("The ZIP central directory is malformed.");
      const flags = header.readUInt16LE(8);
      const method = header.readUInt16LE(10);
      const crc32 = header.readUInt32LE(16);
      const compressedBytes = header.readUInt32LE(20);
      const bytes = header.readUInt32LE(24);
      const nameLength = header.readUInt16LE(28);
      const extraLength = header.readUInt16LE(30);
      const commentLength = header.readUInt16LE(32);
      const diskStart = header.readUInt16LE(34);
      const externalAttributes = header.readUInt32LE(38);
      const localOffset = header.readUInt32LE(42);
      if (
        flags !== 0x0808 ||
        method !== 0 ||
        compressedBytes !== bytes ||
        extraLength !== 0 ||
        commentLength !== 0 ||
        diskStart !== 0 ||
        externalAttributes !== 0 ||
        nameLength < 1 ||
        nameLength > 4096
      ) {
        fail("The ZIP contains an unsupported or unsafe entry.");
      }
      const name = decodeUtf8(await readExact(file, cursor + 46, nameLength));
      safeArchiveName(name);
      const foldedName = name.normalize("NFKC").toLowerCase();
      if (names.has(foldedName)) fail("The ZIP contains duplicate archive paths.");
      names.add(foldedName);

      const local = await readExact(file, localOffset, 30);
      if (
        local.readUInt32LE(0) !== 0x04034b50 ||
        local.readUInt16LE(6) !== flags ||
        local.readUInt16LE(8) !== method ||
        local.readUInt16LE(26) !== nameLength ||
        local.readUInt16LE(28) !== 0
      ) {
        fail("The ZIP local header does not match its directory.");
      }
      const localName = decodeUtf8(await readExact(file, localOffset + 30, nameLength));
      if (localName !== name) fail("The ZIP local and central filenames do not match.");
      const dataOffset = localOffset + 30 + nameLength;
      const recordEnd = dataOffset + bytes + 16;
      if (!Number.isSafeInteger(recordEnd) || recordEnd > centralOffset) {
        fail("A ZIP entry extends outside the archive data region.");
      }
      const descriptor = await readExact(file, dataOffset + bytes, 16);
      if (
        descriptor.readUInt32LE(0) !== 0x08074b50 ||
        descriptor.readUInt32LE(4) !== crc32 ||
        descriptor.readUInt32LE(8) !== bytes ||
        descriptor.readUInt32LE(12) !== bytes
      ) {
        fail("A ZIP entry has an invalid data descriptor.");
      }
      entries.push({ name, crc32, bytes, dataOffset, recordStart: localOffset, recordEnd });
      cursor += 46 + nameLength;
    }
    if (cursor !== centralOffset + centralBytes) fail("The ZIP central directory has unexpected trailing data.");

    const orderedRecords = [...entries].sort((left, right) => left.recordStart - right.recordStart);
    for (let index = 1; index < orderedRecords.length; index += 1) {
      if (orderedRecords[index].recordStart < orderedRecords[index - 1].recordEnd) {
        fail("ZIP entries overlap.");
      }
    }
    return entries;
  } finally {
    await file.close();
  }
}

async function verifyEntry(archivePath: string, entry: ZipEntry, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const hash = createHash("sha256");
  let crc = 0xffffffff;
  let bytesRead = 0;
  const stream = createReadStream(archivePath, {
    start: entry.dataOffset,
    end: entry.dataOffset + entry.bytes - 1,
  });
  const abort = () => stream.destroy(new Error("Audio restore cancelled."));
  signal?.addEventListener("abort", abort, { once: true });
  try {
    for await (const value of stream) {
      signal?.throwIfAborted();
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      bytesRead += chunk.length;
      hash.update(chunk);
      for (const byte of chunk) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    stream.destroy();
  }
  return { bytesRead, crc32: (crc ^ 0xffffffff) >>> 0, sha256: hash.digest("hex") };
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let closedQuote = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
          closedQuote = true;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (closedQuote && character !== "," && character !== "\r" && character !== "\n") {
      fail("The CSV manifest contains malformed quoting.");
    }
    if (character === '"') {
      if (field.length !== 0 || closedQuote) fail("The CSV manifest contains malformed quoting.");
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
      closedQuote = false;
    } else if (character === "\r" || character === "\n") {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      closedQuote = false;
    } else {
      field += character;
    }
  }
  if (quoted) fail("The CSV manifest contains an unterminated quoted field.");
  if (row.length > 0 || field.length > 0 || closedQuote) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function cleanMetadata(value: string, label: string, required = false) {
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (clean.length > 1024 || (required && clean.length === 0)) {
    fail(`The CSV manifest has an invalid ${label}.`);
  }
  return clean;
}

function parseManifest(bytes: Buffer, audioEntries: Map<string, ZipEntry>): AudioBackupManifestRow[] {
  if (bytes.length > MAX_MANIFEST_BYTES) fail("The CSV manifest is larger than the safe limit.");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail("The CSV manifest is not valid UTF-8.");
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const records = parseCsv(text);
  if (records.length < 2 || records[0].length !== CSV_HEADER.length || records[0].some((value, index) => value !== CSV_HEADER[index])) {
    fail("The backup manifest is missing the expected Waveyard CSV columns.");
  }

  const ids = new Set<string>();
  const paths = new Set<string>();
  const rows = records.slice(1).map((record): AudioBackupManifestRow => {
    if (record.length !== CSV_HEADER.length) fail("A CSV manifest row has the wrong number of columns.");
    const [trackId, rawTitle, rawArtist, rawAlbum, rawDuration, rawCodec, originalFilename, backupPath, rawSize, rawSha256] = record;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(trackId)) {
      fail("The CSV manifest contains an invalid track ID.");
    }
    const title = cleanMetadata(rawTitle, "title", true);
    const artist = cleanMetadata(rawArtist, "artist");
    const album = cleanMetadata(rawAlbum, "album");
    const codec = cleanMetadata(rawCodec, "codec", true);
    const durationSeconds = Number(rawDuration);
    const fileSizeBytes = Number(rawSize);
    if (
      !Number.isFinite(durationSeconds) ||
      durationSeconds <= 0 ||
      durationSeconds > 604_800 ||
      !Number.isSafeInteger(fileSizeBytes) ||
      fileSizeBytes <= 0 ||
      fileSizeBytes > MAX_UPLOAD_BYTES ||
      !/^[a-f0-9]{64}$/i.test(rawSha256)
    ) {
      fail("The CSV manifest contains an invalid duration, file size, or checksum.");
    }
    if (
      !originalFilename ||
      originalFilename.length > 180 ||
      /[\\/\x00-\x1f\x7f]/.test(originalFilename) ||
      !acceptedAudioFilename(originalFilename)
    ) {
      fail("The CSV manifest contains an unsafe or unsupported original filename.");
    }
    safeArchiveName(backupPath);
    const parts = backupPath.split("/");
    if (
      parts.length !== 4 ||
      parts[0] !== "audio" ||
      !parts[3].startsWith(`${trackId} - `) ||
      extname(parts[3]).toLowerCase() !== extname(originalFilename).toLowerCase()
    ) {
      fail("A manifest audio path does not match the Waveyard backup layout.");
    }
    if (ids.has(trackId) || paths.has(backupPath)) fail("The CSV manifest contains duplicate track IDs or audio paths.");
    ids.add(trackId);
    paths.add(backupPath);
    const entry = audioEntries.get(backupPath);
    if (entry === undefined || entry.bytes !== fileSizeBytes) {
      fail("The CSV manifest does not match the audio files in the ZIP.");
    }
    return {
      trackId,
      title,
      artist,
      album,
      durationSeconds,
      codec,
      originalFilename,
      backupPath,
      fileSizeBytes,
      sha256: rawSha256.toLowerCase(),
    };
  });
  if (rows.length < 1 || rows.length > MAX_AUDIO_BACKUP_FILES || rows.length !== audioEntries.size) {
    fail(`The backup must contain between 1 and ${MAX_AUDIO_BACKUP_FILES} matching audio files.`);
  }
  return rows;
}

export async function restoreVerifiedAudioBackupZip<T>(
  archivePath: string,
  onAudioFile: (row: AudioBackupManifestRow, localPath: string) => Promise<T>,
  signal?: AbortSignal,
  onProgress?: (progress: AudioRestoreProgress<T>) => void,
): Promise<{ totalBytes: number; results: T[] }> {
  signal?.throwIfAborted();
  const entries = await readZipEntries(archivePath);
  const manifestEntries = entries.filter((entry) => entry.name === "manifest.csv");
  const audioEntries = new Map(entries.filter((entry) => entry.name !== "manifest.csv").map((entry) => [entry.name, entry]));
  if (manifestEntries.length !== 1 || [...audioEntries.keys()].some((name) => !name.startsWith("audio/"))) {
    fail("The ZIP must contain one manifest.csv and only Waveyard audio entries.");
  }
  const [manifestEntry] = manifestEntries;
  if (manifestEntry.bytes < 1 || manifestEntry.bytes > MAX_MANIFEST_BYTES) {
    fail("The CSV manifest is empty or larger than the safe limit.");
  }

  const manifestVerification = await verifyEntry(archivePath, manifestEntry, signal);
  if (manifestVerification.bytesRead !== manifestEntry.bytes || manifestVerification.crc32 !== manifestEntry.crc32) {
    fail("The CSV manifest failed ZIP integrity verification.");
  }
  const manifestBytes = await (async () => {
    const chunks: Buffer[] = [];
    for await (const value of createReadStream(archivePath, {
      start: manifestEntry.dataOffset,
      end: manifestEntry.dataOffset + manifestEntry.bytes - 1,
    })) chunks.push(Buffer.isBuffer(value) ? value : Buffer.from(value));
    return Buffer.concat(chunks, manifestEntry.bytes);
  })();
  if (createHash("sha256").update(manifestBytes).digest("hex") !== manifestVerification.sha256) {
    fail("The CSV manifest changed during verification.");
  }
  const rows = parseManifest(manifestBytes, audioEntries);
  const totalBytes = rows.reduce((total, row) => total + row.fileSizeBytes, 0);
  if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_AUDIO_BACKUP_BYTES) {
    fail("The uncompressed audio exceeds the Waveyard restore limit.", 413);
  }

  // Verify every audio checksum before adding the first library entry. This
  // prevents a damaged archive from producing a misleading partial restore.
  onProgress?.({ phase: "validating", completedFiles: 0, totalFiles: rows.length });
  for (const [index, row] of rows.entries()) {
    signal?.throwIfAborted();
    const entry = audioEntries.get(row.backupPath)!;
    const verified = await verifyEntry(archivePath, entry, signal);
    if (
      verified.bytesRead !== row.fileSizeBytes ||
      verified.crc32 !== entry.crc32 ||
      verified.sha256 !== row.sha256
    ) {
      fail(`Audio failed checksum verification: ${row.title}.`);
    }
    onProgress?.({
      phase: "validating",
      completedFiles: index + 1,
      totalFiles: rows.length,
      currentTitle: row.title,
    });
  }

  const tempDirectory = await mkdtemp(join(tmpdir(), "waveyard-audio-restore-"));
  const results: T[] = [];
  try {
    onProgress?.({ phase: "restoring", completedFiles: 0, totalFiles: rows.length });
    for (const row of rows) {
      signal?.throwIfAborted();
      onProgress?.({
        phase: "restoring",
        completedFiles: results.length,
        totalFiles: rows.length,
        currentTitle: row.title,
      });
      const entry = audioEntries.get(row.backupPath)!;
      const localPath = join(tempDirectory, `${results.length}-${randomUUID()}${extname(row.originalFilename).toLowerCase()}`);
      const hash = createHash("sha256");
      let crc = 0xffffffff;
      let bytesWritten = 0;
      const verifier = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytesWritten += chunk.length;
          hash.update(chunk);
          for (const byte of chunk) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
          callback(null, chunk);
        },
      });
      await pipeline(
        createReadStream(archivePath, { start: entry.dataOffset, end: entry.dataOffset + entry.bytes - 1 }),
        verifier,
        createWriteStream(localPath, { flags: "wx", mode: 0o600 }),
        { signal },
      );
      if (bytesWritten !== row.fileSizeBytes || ((crc ^ 0xffffffff) >>> 0) !== entry.crc32 || hash.digest("hex") !== row.sha256) {
        fail(`Audio failed checksum verification during restore: ${row.title}.`);
      }
      const result = await onAudioFile(row, localPath);
      results.push(result);
      onProgress?.({
        phase: "restoring",
        completedFiles: results.length,
        totalFiles: rows.length,
        currentTitle: row.title,
        result,
      });
      await rm(localPath, { force: true });
    }
    return { totalBytes, results };
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

export async function writeIncomingAudioBackup(
  body: ReadableStream<Uint8Array>,
  destination: string,
  maximumBytes = MAX_AUDIO_BACKUP_BYTES,
  signal?: AbortSignal,
) {
  let totalBytes = 0;
  const reader = body.getReader();
  const source = Readable.from((async function* () {
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        totalBytes += next.value.byteLength;
        if (totalBytes > maximumBytes) fail("The backup ZIP exceeds the 2 GiB upload limit.", 413);
        yield Buffer.from(next.value);
      }
    } finally {
      reader.releaseLock();
    }
  })());
  await pipeline(source, createWriteStream(destination, { flags: "wx", mode: 0o600 }), { signal });
  if (totalBytes < 22) fail("The uploaded backup ZIP is empty or truncated.");
  return totalBytes;
}
