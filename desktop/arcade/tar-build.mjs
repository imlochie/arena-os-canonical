import { createHash } from "node:crypto";
import { safePackagePath, validatePackageDescriptor } from "./packages.mjs";
// For trusted build inputs only; the import path is the strict streaming parser.
export function buildPinnedPackage({ id, version, kind, files, entry, arguments: args = [], runtimes = [], license }) {
  const chunks = [];
  const declarations = [];
  for (const file of files) {
    safePackagePath(file.path);
    if (Buffer.byteLength(file.path) > 100) throw new Error("Build fixture uses an overlong tar name.");
    const data = Buffer.from(file.data);
    const header = Buffer.alloc(512);
    header.write(file.path); header.write("0000600\0", 100);
    header.write("0000000\0", 108); header.write("0000000\0", 116);
    header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write("00000000000\0", 136); header.fill(32, 148, 156);
    header[156] = 48; header.write("ustar\0", 257); header.write("00", 263);
    const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148);
    chunks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
    declarations.push({ path: file.path, bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") });
  }
  chunks.push(Buffer.alloc(1024));
  const archive = Buffer.concat(chunks);
  const descriptor = validatePackageDescriptor({
    schemaVersion: 1, id, version, kind, host: "windows-x64", sha256: createHash("sha256").update(archive).digest("hex"),
    downloadBytes: archive.length, unpackedBytes: declarations.reduce((sum, file) => sum + file.bytes, 0), files: declarations,
    entry, arguments: args, runtimes, license,
  });
  return { archive, descriptor };
}
