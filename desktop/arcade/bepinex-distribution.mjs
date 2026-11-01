// Prepare an exact upstream loader distribution as data, not executable code.
// This does NOT enable plugin loading or mutate any game/profile installation.
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import yauzl from "yauzl";
import { BEPINEX_RELEASES, identifyExecutable } from "./bepinex.mjs";
import { safePackagePath } from "./packages.mjs";

const MiB = 1024 * 1024;
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
export async function downloadBepInExDistribution({ host, destination }) {
  const pin = BEPINEX_RELEASES[host];
  if (!pin) throw new Error("No pinned loader download for this host.");
  await ordinaryAncestors(path.dirname(path.resolve(destination)));
  const signal = AbortSignal.timeout(60000);
  let url = new URL(pin.url), response;
  for (let redirects = 0; redirects <= 5; redirects++) {
    if (url.protocol !== "https:" || url.username || url.password ||
        !["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"].includes(url.hostname))
      throw new Error("Loader redirects must stay on official GitHub release hosting.");
    response = await fetch(url, { signal, credentials: "omit", redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location || redirects === 5) throw new Error("Too many or invalid loader download redirects.");
    url = new URL(location, url);
  }
  if (response.status !== 200 || !response.body) throw new Error("The official pinned loader download was unavailable.");
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > pin.bytes) throw new Error("Loader download exceeded its pinned byte budget.");
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (bytes.length !== pin.bytes || hash(bytes) !== pin.sha256) throw new Error("Downloaded loader bytes do not match the pinned release.");
  await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
  return { version: pin.version, bytes: pin.bytes, sha256: pin.sha256 };
}
async function ordinaryAncestors(directory) {
  const absolute = path.resolve(directory);
  let current = path.parse(absolute).root;
  for (const segment of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Loader destination ancestors must be ordinary directories.");
  }
}
function extract(archive, stage, host) {
  return new Promise((resolve, reject) => {
    yauzl.open(archive, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error) { reject(error); return; }
      let total = 0, count = 0, failed = false;
      const names = new Set(), files = [];
      const fail = error => { if (!failed) { failed = true; zip.close(); reject(error); } };
      zip.on("error", fail);
      zip.on("end", () => { if (!failed) resolve(files); });
      zip.on("entry", entry => {
        void (async () => {
          if (failed) return;
          if (++count > 128 || entry.generalPurposeBitFlag & 1) throw new Error("Oversized or encrypted loader archive.");
          const directory = entry.fileName.endsWith("/");
          const filename = directory ? entry.fileName.slice(0, -1) : entry.fileName;
          safePackagePath(filename);
          const kind = (entry.externalFileAttributes >>> 16) & 0xf000;
          if (kind && kind !== (directory ? 0x4000 : 0x8000)) throw new Error("Loader archive contains a link or special file.");
          const lower = filename.toLowerCase();
          if (names.has(lower)) throw new Error("Loader archive contains duplicate/case-colliding paths.");
          names.add(lower);
          const topLevel = host === "windows-x64"
            ? [".doorstop_version", "changelog.txt", "doorstop_config.ini", "winhttp.dll"]
            : [".doorstop_version", "changelog.txt", "libdoorstop.so", "run_bepinex.sh"];
          if (!filename.startsWith("BepInEx/core/") && !topLevel.includes(filename) &&
              !(directory && ["BepInEx", "BepInEx/core"].includes(filename)))
            throw new Error("Unexpected path in pinned loader layout.");
          if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize > 4 * MiB ||
              (total += entry.uncompressedSize) > 16 * MiB) throw new Error("Loader archive exceeds its extraction budget.");
          const destination = path.join(stage, ...filename.split("/"));
          if (directory) await mkdir(destination, { recursive: true });
          else {
            const bytes = await new Promise((resolve, reject) => {
              zip.openReadStream(entry, (error, stream) => {
                if (error) { reject(error); return; }
                const chunks = []; let size = 0;
                stream.on("error", reject);
                stream.on("data", chunk => {
                  size += chunk.length;
                  if (size > entry.uncompressedSize || size > 4 * MiB) stream.destroy(new Error("Loader ZIP stream exceeded declared size."));
                  else chunks.push(chunk);
                });
                stream.on("end", () => size === entry.uncompressedSize ? resolve(Buffer.concat(chunks)) : reject(new Error("Truncated loader ZIP entry.")));
              });
            });
            await mkdir(path.dirname(destination), { recursive: true });
            await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
            files.push({ path: filename, bytes: bytes.length, sha256: hash(bytes) });
          }
          if (!failed) zip.readEntry();
        })().catch(fail);
      });
      zip.readEntry();
    });
  });
}

export async function stageBepInExDistribution({ archive, destination, host }) {
  const pin = BEPINEX_RELEASES[host];
  if (!pin) throw new Error("No pinned loader for this host.");
  const parent = path.dirname(path.resolve(destination));
  await ordinaryAncestors(parent);
  try { await lstat(destination); throw new Error("Loader destination already exists; it will not be overwritten."); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const sourceInfo = await lstat(archive);
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink() || sourceInfo.nlink !== 1 || sourceInfo.size !== pin.bytes)
    throw new Error("Loader archive file/size does not match the pinned release.");
  const source = await open(archive, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let snapshot;
  try {
    const info = await source.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size !== pin.bytes ||
        info.ino !== sourceInfo.ino || info.dev !== sourceInfo.dev)
      throw new Error("Loader archive changed during verification.");
    const buffer = Buffer.alloc(pin.bytes + 1);
    let position = 0;
    while (position < buffer.length) {
      const { bytesRead } = await source.read(buffer, position, buffer.length - position, position);
      if (!bytesRead) break;
      position += bytesRead;
    }
    if (position !== pin.bytes) throw new Error("Loader archive changed size during verification.");
    snapshot = buffer.subarray(0, position);
  } finally { await source.close(); }
  if (hash(snapshot) !== pin.sha256) throw new Error("Loader archive SHA-256 does not match the pinned release.");
  const stage = path.join(parent, `.loader-stage-${randomUUID()}`);
  await mkdir(stage, { mode: 0o700 });
  try {
    // Extract only this bounded verified snapshot, never reopen caller bytes.
    const localArchive = path.join(stage, ".archive.zip");
    await writeFile(localArchive, snapshot, { flag: "wx", mode: 0o600 });
    const files = await extract(localArchive, stage, host);
    await rm(localArchive);
    for (const required of ["BepInEx/core/BepInEx.dll", "BepInEx/core/BepInEx.Preloader.dll",
      host === "windows-x64" ? "winhttp.dll" : "libdoorstop.so"]) {
      if (!files.some(file => file.path === required)) throw new Error("Pinned loader lacks required runtime files.");
    }
    const proxy = await readFile(path.join(stage, host === "windows-x64" ? "winhttp.dll" : "libdoorstop.so"));
    const identity = identifyExecutable(proxy);
    if (!identity || `${identity.platform}-${identity.arch}` !== host) throw new Error("Loader proxy executable architecture mismatch.");
    for (const file of files) await chmod(path.join(stage, ...file.path.split("/")), 0o444);
    // The caller owns a unique destination and must serialize operations.
    // Refuse an unexpected existing directory rather than replacing it.
    try { await lstat(destination); throw new Error("Loader destination appeared while preparing."); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await rename(stage, destination);
    return { status: "prepared-unverified", host, version: pin.version, archiveSha256: pin.sha256,
      files: files.sort((a, b) => a.path.localeCompare(b.path)), gameplayVerified: false };
  } finally { await rm(stage, { recursive: true, force: true }); }
}
