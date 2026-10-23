/** Bounded, disk-backed ZIP (STORE). No audio is recompressed or buffered in RAM.
 * The archive is served only after every byte matches its conversion receipt.
 * Classic ZIP is intentional: a 2 GiB archive limit avoids ambiguous ZIP64 support.
 */
import { createHash } from "node:crypto";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";

export const MAX_ARCHIVE_FILES = 100;
export const MAX_ARCHIVE_BYTES = 2 * 1024 ** 3;
export class ArchiveInputError extends Error {
  readonly status: number;
  constructor(message: string, status = 422) { super(message); this.status = status; }
}
let activeArchives = 0;
export type ArchiveEntry = {
  name: string;
  bytes: number;
  sha256: string;
  open: () => Promise<Readable>;
};
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});
function safeName(name: string) {
  if (Buffer.byteLength(name) > 4096 || !name || /[\\:<>"|?*\x00-\x1f\x7f]/.test(name) ||
    name.split("/").some(part => !part || Buffer.byteLength(part) > 255 || part === "." || part === ".." || /[. ]$/.test(part) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(part))) {
    throw new ArchiveInputError("Unsafe archive filename. Review the naming template and shorten long folder names; no files were renamed or overwritten.");
  }
  return Buffer.from(name, "utf8");
}

export async function createVerifiedZip(entries: ArchiveEntry[], signal?: AbortSignal) {
  // One additional entry is reserved for the bounded conversion manifest.
  if (!entries.length || entries.length > MAX_ARCHIVE_FILES + 1) throw new ArchiveInputError("Select at most 100 completed files.");
  const names = entries.map(entry => safeName(entry.name));
  const unique = new Set(entries.map(entry => entry.name.normalize("NFKC").toLowerCase()));
  if (unique.size !== entries.length) throw new ArchiveInputError("Archive filenames collide. Download the affected files individually.");
  let predicted = 22;
  for (const [index, entry] of entries.entries()) {
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new ArchiveInputError("A complete checksum/size receipt is required.");
    predicted += entry.bytes + 92 + names[index].length * 2;
  }
  if (predicted > MAX_ARCHIVE_BYTES) throw new ArchiveInputError("Selected archive exceeds 2 GiB. Download a smaller selection.", 413);
  signal?.throwIfAborted();
  if (activeArchives >= 2) throw new ArchiveInputError("Two archives are already being prepared or downloaded. Wait for one to finish and retry.", 429);
  activeArchives++;
  let directory: string;
  try { directory = await mkdtemp(join(tmpdir(), "arena-conversion-zip-")); }
  catch (error) { activeArchives--; throw error; }
  const path = join(directory, "converted-music.zip");
  let disposed = false;
  const dispose = async () => {
    if (disposed) return; disposed = true;
    try { await rm(directory, { recursive: true, force: true }); } finally { activeArchives--; }
  };
  let file;
  try {
    file = await open(path, "wx", 0o600);
    let position = 0;
    const write = async (bytes: Buffer) => { signal?.throwIfAborted(); await file!.writeFile(bytes); position += bytes.length; };
    const central: Buffer[] = [];
    for (const [index, entry] of entries.entries()) {
      const name = names[index], offset = position;
      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
      header.writeUInt16LE(0x0808, 6); // UTF-8 names + trailing data descriptor
      header.writeUInt16LE(33, 12); // 1980-01-01, stable rather than invented capture time
      header.writeUInt16LE(name.length, 26);
      await write(header); await write(name);
      let crc = 0xffffffff, bytes = 0;
      const sha = createHash("sha256"), stream = await entry.open();
      const abort = () => stream.destroy(new Error("Archive download cancelled."));
      signal?.addEventListener("abort", abort, { once: true });
      try {
        signal?.throwIfAborted();
        for await (const value of stream) {
          const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
          bytes += chunk.length;
          if (bytes > entry.bytes) throw new Error("Output size changed; no archive was served.");
          sha.update(chunk);
          for (const byte of chunk) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
          await write(chunk);
        }
      } finally { signal?.removeEventListener("abort", abort); stream.destroy(); }
      if (bytes !== entry.bytes || sha.digest("hex") !== entry.sha256) throw new Error("Output checksum/size changed; no archive was served.");
      crc = (crc ^ 0xffffffff) >>> 0;
      const descriptor = Buffer.alloc(16);
      descriptor.writeUInt32LE(0x08074b50); descriptor.writeUInt32LE(crc, 4);
      descriptor.writeUInt32LE(bytes, 8); descriptor.writeUInt32LE(bytes, 12);
      await write(descriptor);
      const record = Buffer.alloc(46);
      record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6);
      record.writeUInt16LE(0x0808, 8); record.writeUInt16LE(33, 14);
      record.writeUInt32LE(crc, 16); record.writeUInt32LE(bytes, 20); record.writeUInt32LE(bytes, 24);
      record.writeUInt16LE(name.length, 28); record.writeUInt32LE(offset, 42);
      central.push(record, name);
    }
    const start = position;
    for (const record of central) await write(record);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(position - start, 12); end.writeUInt32LE(start, 16);
    await write(end); await file.close(); file = undefined;
    return { path, bytes: position, dispose };
  } catch (error) {
    try { await file?.close(); } finally { await dispose(); }
    throw error;
  }
}
