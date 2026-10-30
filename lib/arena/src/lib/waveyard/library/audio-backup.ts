import { createHash } from "node:crypto";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";

export const MAX_AUDIO_BACKUP_FILES = 100;
export const MAX_AUDIO_BACKUP_BYTES = 2 * 1024 ** 3;

export class AudioBackupError extends Error {
  constructor(message: string, readonly status = 422) {
    super(message);
  }
}

export type AudioBackupEntry = {
  name: string;
  bytes: number;
  sha256: string;
  open: () => Promise<Readable>;
};

let activeArchives = 0;

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return value >>> 0;
});

function encodedSafeName(name: string) {
  if (
    Buffer.byteLength(name) > 4096 ||
    !name ||
    /[\\:<>"|?*\x00-\x1f\x7f]/.test(name) ||
    name.split("/").some((part) =>
      !part ||
      Buffer.byteLength(part) > 255 ||
      part === "." ||
      part === ".." ||
      /[. ]$/.test(part) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(part),
    )
  ) {
    throw new AudioBackupError("An audio filename cannot be represented safely in the backup.");
  }
  return Buffer.from(name, "utf8");
}

export function safeAudioBackupSegment(value: string, fallback: string) {
  const safe = value
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "")
    .slice(0, 120);
  if (!safe) return fallback;
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(safe) ? `_${safe}` : safe;
}

export function createAudioBackupCsv(rows: Array<{
  trackId: string;
  title: string;
  artist: string;
  album: string;
  durationSeconds: number;
  codec: string;
  originalFilename: string;
  archivePath: string;
  fileSizeBytes: number;
  checksumSha256: string;
}>) {
  const quote = (value: string | number) => `"${String(value).replace(/"/g, '""')}"`;
  const lines = [
    ["track_id", "title", "artist", "album", "duration_seconds", "codec", "original_filename", "backup_path", "file_size_bytes", "sha256"]
      .map(quote)
      .join(","),
    ...rows.map((row) => [
      row.trackId,
      row.title,
      row.artist,
      row.album,
      row.durationSeconds,
      row.codec,
      row.originalFilename,
      row.archivePath,
      row.fileSizeBytes,
      row.checksumSha256,
    ].map(quote).join(",")),
  ];
  return `${lines.join("\r\n")}\r\n`;
}

export async function createVerifiedAudioBackupZip(
  entries: AudioBackupEntry[],
  signal?: AbortSignal,
) {
  if (!entries.length || entries.length > MAX_AUDIO_BACKUP_FILES + 1) {
    throw new AudioBackupError(`Select up to ${MAX_AUDIO_BACKUP_FILES} audio files.`);
  }
  const names = entries.map((entry) => encodedSafeName(entry.name));
  const unique = new Set(entries.map((entry) => entry.name.normalize("NFKC").toLowerCase()));
  if (unique.size !== entries.length) {
    throw new AudioBackupError("Two audio files would have the same backup path. Select a smaller or different set.");
  }

  let predictedBytes = 22;
  for (const [index, entry] of entries.entries()) {
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes <= 0 || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw new AudioBackupError("A valid audio size and checksum are required before backup.");
    }
    predictedBytes += entry.bytes + 92 + names[index].length * 2;
  }
  if (predictedBytes > MAX_AUDIO_BACKUP_BYTES) {
    throw new AudioBackupError("Selected audio exceeds the 2 GiB ZIP limit. Make a smaller selection.", 413);
  }

  signal?.throwIfAborted();
  if (activeArchives >= 2) {
    throw new AudioBackupError("Two audio backups are already being prepared. Wait for one to finish.", 429);
  }
  activeArchives += 1;

  let directory: string;
  try {
    directory = await mkdtemp(join(tmpdir(), "waveyard-audio-backup-"));
  } catch (error) {
    activeArchives -= 1;
    throw error;
  }
  const archivePath = join(directory, "waveyard-audio-backup.zip");
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    try {
      await rm(directory, { recursive: true, force: true });
    } finally {
      activeArchives -= 1;
    }
  };

  let file;
  try {
    file = await open(archivePath, "wx", 0o600);
    let position = 0;
    const write = async (bytes: Buffer) => {
      signal?.throwIfAborted();
      await file!.writeFile(bytes);
      position += bytes.length;
    };
    const centralDirectory: Buffer[] = [];

    for (const [index, entry] of entries.entries()) {
      const name = names[index];
      const localHeaderOffset = position;
      const localHeader = Buffer.alloc(30);
      localHeader.writeUInt32LE(0x04034b50, 0);
      localHeader.writeUInt16LE(20, 4);
      localHeader.writeUInt16LE(0x0808, 6); // UTF-8 filename + data descriptor.
      localHeader.writeUInt16LE(33, 12); // Stable 1980-01-01 timestamp.
      localHeader.writeUInt16LE(name.length, 26);
      await write(localHeader);
      await write(name);

      let crc = 0xffffffff;
      let bytesRead = 0;
      const sha256 = createHash("sha256");
      const stream = await entry.open();
      const abortStream = () => stream.destroy(new Error("Audio backup cancelled."));
      signal?.addEventListener("abort", abortStream, { once: true });
      try {
        signal?.throwIfAborted();
        for await (const value of stream) {
          const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
          bytesRead += chunk.length;
          if (bytesRead > entry.bytes) {
            throw new Error("An audio file changed size while the backup was being built.");
          }
          sha256.update(chunk);
          for (const byte of chunk) {
            crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
          }
          await write(chunk);
        }
      } finally {
        signal?.removeEventListener("abort", abortStream);
        stream.destroy();
      }

      if (bytesRead !== entry.bytes || sha256.digest("hex") !== entry.sha256) {
        throw new Error("An audio file failed checksum verification; no backup was served.");
      }
      crc = (crc ^ 0xffffffff) >>> 0;

      const descriptor = Buffer.alloc(16);
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(crc, 4);
      descriptor.writeUInt32LE(bytesRead, 8);
      descriptor.writeUInt32LE(bytesRead, 12);
      await write(descriptor);

      const centralHeader = Buffer.alloc(46);
      centralHeader.writeUInt32LE(0x02014b50, 0);
      centralHeader.writeUInt16LE(20, 4);
      centralHeader.writeUInt16LE(20, 6);
      centralHeader.writeUInt16LE(0x0808, 8);
      centralHeader.writeUInt16LE(33, 14);
      centralHeader.writeUInt32LE(crc, 16);
      centralHeader.writeUInt32LE(bytesRead, 20);
      centralHeader.writeUInt32LE(bytesRead, 24);
      centralHeader.writeUInt16LE(name.length, 28);
      centralHeader.writeUInt32LE(localHeaderOffset, 42);
      centralDirectory.push(centralHeader, name);
    }

    const centralStart = position;
    for (const record of centralDirectory) await write(record);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(position - centralStart, 12);
    end.writeUInt32LE(centralStart, 16);
    await write(end);
    await file.close();
    file = undefined;
    return { path: archivePath, bytes: position, dispose };
  } catch (error) {
    try {
      await file?.close();
    } finally {
      await dispose();
    }
    throw error;
  }
}
