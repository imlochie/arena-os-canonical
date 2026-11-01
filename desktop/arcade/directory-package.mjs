import { createHash } from "node:crypto";
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";
import { safePackagePath, validatePackageDescriptor } from "./packages.mjs";

/** Bounded, deterministic USTAR writer. Never invokes a system archiver, follows
 * links, or buffers a compiler distribution/game executable in memory. */
export async function packageDirectory(directory, filename, metadata, signal) {
  const root = await lstat(directory);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("Build output root is not a regular directory.");
  const files = [];
  const paths = new Set();
  let total = 0, entries = 0;
  const walk = async (folder = "") => {
    for (const name of (await readdir(path.join(directory, folder))).sort()) {
      signal?.throwIfAborted();
      if (++entries > 20000) throw new Error("Build output has too many entries.");
      const relative = folder ? `${folder}/${name}` : name;
      safePackagePath(relative);
      const info = await lstat(path.join(directory, relative));
      if (info.isSymbolicLink()) throw new Error("Build output contains a link.");
      if (info.isDirectory()) { await walk(relative); continue; }
      if (!info.isFile() || relative.length > 100 || paths.has(relative.toLowerCase())) throw new Error("Build output is not a portable regular-file package.");
      paths.add(relative.toLowerCase());
      total += info.size;
      if (files.length >= 2000 || total > 450 * 1024 * 1024) throw new Error("Built package exceeds the 2,000-file / 450 MiB output budget.");
      files.push({ path: relative, bytes: info.size });
    }
  };
  await walk();
  const output = await open(filename, "wx");
  const archiveHash = createHash("sha256");
  let downloadBytes = 0;
  const write = async data => { await output.writeFile(data); archiveHash.update(data); downloadBytes += data.length; };
  try {
    for (const file of files) {
      signal?.throwIfAborted();
      const header = Buffer.alloc(512);
      header.write(file.path); header.write("0000600\0", 100); header.write("0000000\0", 108); header.write("0000000\0", 116);
      header.write(`${file.bytes.toString(8).padStart(11, "0")}\0`, 124); header.write("00000000000\0", 136);
      header.fill(32, 148, 156); header[156] = 48; header.write("ustar\0", 257); header.write("00", 263);
      header.write(`${[...header].reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0")}\0 `, 148);
      await write(header);
      const input = await open(path.join(directory, file.path), "r");
      const hash = createHash("sha256");
      let copied = 0;
      try {
        const info = await input.stat();
        if (!info.isFile() || info.size !== file.bytes) throw new Error("Build output changed during packaging.");
        for await (const chunk of input.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 })) {
          signal?.throwIfAborted(); copied += chunk.length;
          if (copied > file.bytes) throw new Error("Build output grew during packaging.");
          hash.update(chunk); await write(chunk);
        }
      } finally { await input.close(); }
      if (copied !== file.bytes) throw new Error("Build output was truncated during packaging.");
      file.sha256 = hash.digest("hex");
      await write(Buffer.alloc((512 - file.bytes % 512) % 512));
    }
    await write(Buffer.alloc(1024)); await output.sync();
    return validatePackageDescriptor({ schemaVersion: 1, host: "windows-x64", ...metadata,
      files, unpackedBytes: total, downloadBytes, sha256: archiveHash.digest("hex") });
  } finally { await output.close(); }
}
