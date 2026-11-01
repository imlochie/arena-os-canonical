import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, rename, rm, statfs } from "node:fs/promises";
import path from "node:path";
const MiB = 1024 * 1024;
const digest = /^[a-f0-9]{64}$/;
const identifier = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const version = /^[a-zA-Z0-9][a-zA-Z0-9.+_-]{0,99}$/;
export const packageKey = descriptor => `${descriptor.id}@${descriptor.version}`;
export function safePackagePath(value) {
  if (typeof value !== "string" || value.length > 200 || !/^[a-zA-Z0-9._/+-]+$/.test(value) ||
    value.split("/").some(part => !part || part === "." || part === ".." || part.endsWith(".") || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part)))
    throw new Error("Package contains an unsafe or platform-ambiguous path.");
  return value;
}
export function validatePackageDescriptor(value) {
  if (!value || value.schemaVersion !== 1 || !identifier.test(value.id) || !version.test(value.version) ||
    !["game", "runtime"].includes(value.kind) || value.host !== "windows-x64" || !digest.test(value.sha256) ||
    !Number.isSafeInteger(value.downloadBytes) || value.downloadBytes < 1024 || value.downloadBytes > 512 * MiB ||
    !Number.isSafeInteger(value.unpackedBytes) || value.unpackedBytes < 1 || value.unpackedBytes > 2048 * MiB ||
    !Array.isArray(value.files) || !value.files.length || value.files.length > 2000 ||
    typeof value.license !== "string" || !value.license.trim() || value.license.length > 2000 ||
    !Array.isArray(value.runtimes) || value.runtimes.length > 16) throw new Error("Unsupported or malformed trusted package descriptor.");
  const paths = new Set();
  let bytes = 0;
  for (const file of value.files) {
    safePackagePath(file.path);
    const key = file.path.toLowerCase();
    if (paths.has(key) || !digest.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0) throw new Error("Duplicate or invalid package file.");
    paths.add(key); bytes += file.bytes;
  }
  if (bytes !== value.unpackedBytes || value.runtimes.some(key => typeof key !== "string" || !/^[a-z0-9._-]+@[a-zA-Z0-9.+_-]+$/.test(key))) throw new Error("Package sizes or dependency references do not match.");
  if (value.kind === "game") {
    if (value.workingDirectory !== undefined && value.workingDirectory !== "entry") throw new Error("Unsupported managed working directory.");
    safePackagePath(value.entry);
    if (value.runtimeEntry) {
      safePackagePath(value.runtimeEntry);
      if (value.runtimes.length !== 1 || !value.runtimeEntry.toLowerCase().endsWith(".exe") || !value.entry.endsWith(".pck")) throw new Error("An engine-backed game needs one pinned runtime executable and pack.");
    }
    if (!value.files.some(file => file.path === value.entry) || (!value.runtimeEntry && !value.entry.toLowerCase().endsWith(".exe")) ||
      !Array.isArray(value.arguments) || value.arguments.length > 32 || value.arguments.some(arg => typeof arg !== "string" || arg.length > 1000 || /[\0\r\n]/.test(arg)))
      throw new Error("A game needs an exact managed executable and bounded argument array.");
  }
  if (value.url) {
    const url = new URL(value.url);
    if (url.protocol !== "https:" || url.username || url.password || url.hash || !["github.com", "release-assets.githubusercontent.com"].includes(url.hostname))
      throw new Error("Package acquisition URL is not an approved HTTPS release host.");
  }
  return value;
}
export function validateReleaseUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash || !["github.com", "release-assets.githubusercontent.com"].includes(url.hostname))
    throw new Error("Package acquisition URL is not an approved HTTPS release host.");
  return url.href;
}
async function acquire(source, output, descriptor, signal) {
  const writer = await open(output, "wx", 0o600);
  let reader;
  let response;
  try {
    if (source) {
      const info = await lstat(source);
      if (!path.isAbsolute(source) || !info.isFile() || info.isSymbolicLink() || info.size !== descriptor.downloadBytes) throw new Error("Selected archive does not match the catalog size/type.");
      reader = createReadStream(source, { signal, highWaterMark: 64 * 1024 });
    } else {
      if (!descriptor.url) throw new Error("Choose the pinned archive through the desktop file picker.");
      let url = validateReleaseUrl(descriptor.url);
      for (let redirect = 0; redirect < 5; redirect++) {
        response = await fetch(url, { redirect: "manual", signal });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          await response.body?.cancel();
          url = validateReleaseUrl(new URL(response.headers.get("location") || "", url).href);
          continue;
        }
        break;
      }
      if (!response?.ok || !response.body) throw new Error("Pinned release download failed or exceeded its redirect limit.");
      if (response.headers.has("content-length") && Number(response.headers.get("content-length")) !== descriptor.downloadBytes) throw new Error("Release download size changed.");
      reader = response.body;
    }
    let bytes = 0;
    const hash = createHash("sha256");
    for await (const chunk of reader) {
      signal?.throwIfAborted(); bytes += chunk.length;
      if (bytes > descriptor.downloadBytes) throw new Error("Release download exceeded the pinned size.");
      hash.update(chunk); await writer.writeFile(chunk);
    }
    if (bytes !== descriptor.downloadBytes || hash.digest("hex") !== descriptor.sha256) throw new Error("Archive integrity check failed. No game was activated.");
    await writer.sync();
  } finally {
    reader?.destroy?.();
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
    await writer.close();
  }
}
async function hashFile(filename, signal) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename, { signal })) hash.update(chunk);
  return hash.digest("hex");
}
async function readExactly(handle, length, position) {
  const result = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(result, offset, length - offset, position + offset);
    if (!bytesRead) throw new Error("Truncated package.");
    offset += bytesRead;
  }
  return result;
}
const field = (header, start, length) => header.subarray(start, start + length).toString("ascii").replace(/\0.*$/s, "");
function octal(value) {
  if (!/^[ 0-7]*\0?[ ]*$/.test(value)) throw new Error("Unsupported archive numeric encoding.");
  const result = Number.parseInt(value.replace(/\0.*$/s, "").trim() || "0", 8);
  if (!Number.isSafeInteger(result)) throw new Error("Invalid archive size.");
  return result;
}
/** Deliberately supports only uncompressed USTAR regular files. No symlinks,
 * hardlinks, devices, PAX paths, permission changes or executable scripts run. */
export async function extractPinnedTar(filename, destination, descriptor, signal) {
  validatePackageDescriptor(descriptor);
  const expected = new Map(descriptor.files.map(file => [file.path, file]));
  const handle = await open(filename, "r");
  let position = 0;
  try {
    while (position + 512 <= descriptor.downloadBytes) {
      signal?.throwIfAborted();
      const header = await readExactly(handle, 512, position); position += 512;
      if (header.every(byte => byte === 0)) {
        const remainder = descriptor.downloadBytes - position;
        if (remainder < 512 || remainder > 10240) throw new Error("Invalid archive terminator.");
        if (!(await readExactly(handle, remainder, position)).every(byte => byte === 0)) throw new Error("Unexpected data after archive terminator.");
        if (expected.size) throw new Error("Package is missing declared files.");
        return;
      }
      const storedChecksum = octal(header.subarray(148, 156).toString("ascii"));
      const sum = [...header].reduce((total, byte, index) => total + (index >= 148 && index < 156 ? 32 : byte), 0);
      if (header.some(byte => byte > 127) || sum !== storedChecksum || field(header, 257, 5) !== "ustar" || ![0, 48].includes(header[156])) throw new Error("Unsupported archive entry, encoding or checksum.");
      const prefix = field(header, 345, 155);
      const filenameInArchive = safePackagePath(`${prefix ? `${prefix}/` : ""}${field(header, 0, 100)}`);
      const file = expected.get(filenameInArchive);
      const bytes = octal(header.subarray(124, 136).toString("ascii"));
      if (!file || file.bytes !== bytes || position + Math.ceil(bytes / 512) * 512 > descriptor.downloadBytes) throw new Error("Archive entry does not match the pinned file list.");
      const output = path.join(destination, ...filenameInArchive.split("/"));
      await mkdir(path.dirname(output), { recursive: true });
      const writer = await open(output, "wx", 0o600);
      const hash = createHash("sha256");
      try {
        for (let offset = 0; offset < bytes;) {
          signal?.throwIfAborted();
          const chunk = await readExactly(handle, Math.min(64 * 1024, bytes - offset), position + offset);
          hash.update(chunk); await writer.writeFile(chunk); offset += chunk.length;
        }
        await writer.sync();
      } finally { await writer.close(); }
      if (hash.digest("hex") !== file.sha256) throw new Error(`Integrity check failed for ${filenameInArchive}.`);
      expected.delete(filenameInArchive);
      position += Math.ceil(bytes / 512) * 512;
    }
    throw new Error("Package has no valid archive terminator.");
  } finally { await handle.close(); }
}
async function atomicJson(filename, value) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
  try { await rename(temporary, filename); } catch (error) { await rm(temporary, { force: true }); throw error; }
}
async function directoryBytes(root, budget = { entries: 0 }) {
  let bytes = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (++budget.entries > 100000) throw new Error("Storage accounting exceeded its bounded file scan; cleanup needs review.");
    if (entry.isSymbolicLink()) throw new Error("Unexpected symbolic link in managed package storage.");
    const filename = path.join(root, entry.name);
    bytes += entry.isDirectory() ? await directoryBytes(filename, budget) : (await lstat(filename)).size;
  }
  return bytes;
}
export class ArcadePackages {
  constructor({ root, catalog, reserveBytes = 512 * MiB, budgetBytes = 8 * 1024 * MiB, beforePromote = async () => {} }) {
    if (!path.isAbsolute(root)) throw new Error("Managed Arcade storage requires an absolute root.");
    this.root = root;
    this.catalog = new Map(catalog.map(item => { validatePackageDescriptor(item); return [packageKey(item), structuredClone(item)]; }));
    if (this.catalog.size !== catalog.length) throw new Error("Duplicate catalog package identity/version.");
    for (const item of this.catalog.values()) for (const key of item.runtimes)
      if (this.catalog.get(key)?.kind !== "runtime") throw new Error("Catalog dependency is not a pinned runtime.");
    this.reserveBytes = reserveBytes; this.budgetBytes = budgetBytes; this.beforePromote = beforePromote;
    this.state = { schemaVersion: 1, packages: {} }; this.busy = false;
  }
  filename(key) {
    if (!this.catalog.has(key)) throw new Error("This package is not in the trusted catalog.");
    return path.join(this.root, "installed", key);
  }
  async initialize() {
    for (const name of ["downloads", "staging", "installed", "profiles", "build-cache"]) await mkdir(path.join(this.root, name), { recursive: true });
    try {
      const raw = await readFile(path.join(this.root, "state.json"), "utf8");
      if (raw.length > 1024 * 1024) throw new Error("Managed package state is oversized.");
      const state = JSON.parse(raw);
      if (state.schemaVersion !== 1 || !state.packages || typeof state.packages !== "object" || Array.isArray(state.packages)) throw new Error("Unsupported package state; original files retained.");
      for (const [key, row] of Object.entries(state.packages)) {
        if (!this.catalog.has(key)) { this.state.packages[key] = { ...row, phase: "unavailable", detail: "Retained installation from another build; not executable without its trusted catalog descriptor." }; continue; }
        if (!row || !["ready", "failed", "installing", "interrupted", "unavailable"].includes(row.phase)) throw new Error("Invalid package lifecycle state.");
        this.state.packages[key] = ["installing", "unavailable"].includes(row.phase) ? { phase: "interrupted", detail: "Installation/catalog activation was interrupted. Retry verifies existing bytes before continuing." } : row;
      }
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    // These private temporary paths never contain profiles or installed games.
    for (const entry of await readdir(path.join(this.root, "staging")))
      if (/^[a-f0-9-]{36}$/.test(entry)) await rm(path.join(this.root, "staging", entry), { recursive: true, force: true });
    for (const entry of await readdir(path.join(this.root, "downloads")))
      if (/^[a-f0-9-]{36}\.partial$/.test(entry)) await rm(path.join(this.root, "downloads", entry), { force: true });
    await this.persist();
    return this.snapshot();
  }
  snapshot() { return structuredClone({ ...this.state, busy: this.busy, catalog: [...this.catalog.values()] }); }
  async persist() { await atomicJson(path.join(this.root, "state.json"), this.state); }
  async storage() {
    const result = {};
    for (const name of ["downloads", "staging", "installed", "profiles", "build-cache"]) {
      try { result[name] = await directoryBytes(path.join(this.root, name)); }
      catch { result[name] = null; result.warning = "Some storage could not be safely counted. Stop/remove controls remain available; new installations are blocked until accounting is complete."; }
    }
    const volume = await statfs(this.root, { bigint: true });
    return { ...result, freeBytes: Number(volume.bavail * volume.bsize), reserveBytes: this.reserveBytes, budgetBytes: this.budgetBytes };
  }
  async verify(key, signal) {
    const descriptor = this.catalog.get(key);
    if (!descriptor) throw new Error("Unknown managed package.");
    for (const file of descriptor.files) {
      signal?.throwIfAborted();
      const filename = path.join(this.filename(key), ...file.path.split("/"));
      let cursor = this.filename(key);
      if ((await lstat(cursor)).isSymbolicLink()) throw new Error("Installation was replaced by a symbolic link.");
      for (const part of file.path.split("/")) {
        cursor = path.join(cursor, part);
        if ((await lstat(cursor)).isSymbolicLink()) throw new Error("Installation contains a symbolic link.");
      }
      const info = await lstat(filename);
      if (!info.isFile() || info.size !== file.bytes || await hashFile(filename, signal) !== file.sha256) throw new Error(`Installed file integrity failed: ${file.path}`);
    }
    return descriptor;
  }
  async install(key, source, { signal } = {}) {
    if (this.busy) throw new Error("Another package operation is still active.");
    const descriptor = this.catalog.get(key);
    if (!descriptor) throw new Error("Unknown managed package.");
    this.busy = true;
    const staging = path.join(this.root, "staging", randomUUID());
    const partial = path.join(this.root, "downloads", `${randomUUID()}.partial`);
    const cache = path.join(this.root, "downloads", `${descriptor.sha256}.tar`);
    let promoted = false;
    try {
      signal?.throwIfAborted();
      let present = false;
      try { await lstat(this.filename(key)); present = true; } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (present) {
        await this.verify(key, signal);
        this.state.packages[key] = { phase: "ready", at: Date.now() }; await this.persist();
        return { ...this.snapshot(), busy: false };
      }
      let cached = false;
      try { const info = await lstat(cache); cached = info.isFile() && !info.isSymbolicLink() && info.size === descriptor.downloadBytes && await hashFile(cache, signal) === descriptor.sha256; } catch (error) { if (error.code !== "ENOENT") throw error; }
      const usage = await this.storage();
      if (usage.warning) throw new Error(usage.warning);
      const used = usage.downloads + usage.staging + usage.installed + usage["build-cache"];
      const acquisitionBytes = cached ? 0 : descriptor.downloadBytes;
      if (used + acquisitionBytes + descriptor.unpackedBytes > this.budgetBytes ||
        usage.freeBytes < acquisitionBytes + descriptor.unpackedBytes + this.reserveBytes) throw new Error("Not enough disk budget/free space for download and staging; no installed game or save was removed.");
      this.state.packages[key] = { phase: "installing", at: Date.now() }; await this.persist();
      if (!cached) {
        const acquisitionSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(120_000)]);
        await acquire(source, partial, descriptor, acquisitionSignal);
        signal?.throwIfAborted();
        await rename(partial, cache);
      }
      await mkdir(staging, { recursive: false });
      await extractPinnedTar(cache, staging, descriptor, signal);
      await this.beforePromote({ key, staging, descriptor });
      signal?.throwIfAborted();
      await rename(staging, this.filename(key)); promoted = true;
      this.state.packages[key] = { phase: "ready", at: Date.now() }; await this.persist();
      return { ...this.snapshot(), busy: false };
    } catch (error) {
      this.state.packages[key] = { phase: "failed", at: Date.now(), detail: `${error.message}`.slice(0, 1000), ...(promoted ? { activationPresent: true } : {}) };
      await this.persist().catch(() => {});
      throw error;
    } finally {
      await rm(partial, { force: true }).catch(() => {});
      await rm(staging, { recursive: true, force: true }).catch(() => {});
      this.busy = false;
    }
  }
  async remove(key, runningKeys = []) {
    if (this.busy) throw new Error("Another package operation is still active.");
    if (runningKeys.includes(key)) throw new Error("Stop this package's running game before removal.");
    if (!this.catalog.has(key)) throw new Error("Unknown managed package.");
    for (const [id, row] of Object.entries(this.state.packages))
      if (row.phase === "ready" && this.catalog.get(id)?.runtimes.includes(key)) throw new Error("An installed game still references this runtime. Saves will not be deleted.");
    this.busy = true;
    try {
      await rm(this.filename(key), { recursive: true, force: true });
      delete this.state.packages[key]; await this.persist();
      return this.snapshot();
    } finally { this.busy = false; }
  }
}
