/**
 * Model seeding — first-run model acquisition for the stem machine.
 *
 * Vision §V1 distribution decision ("hybrid"): the app does NOT bundle model
 * weights by default (license is verify-before-bundling); it downloads the
 * registry-pinned file on first use, checksum-verifies it, and installs it
 * atomically into the models dir. After the first run everything is offline.
 *
 * Safety properties (tested):
 *  - The URL is ALWAYS the registry's own sourceUrl — user input never
 *    influences what is fetched (no SSRF surface).
 *  - The download lands at a temp path and is sha256-verified against the
 *    registry BEFORE the atomic rename — a truncated or corrupted download
 *    can never become the model file inference reads.
 *  - Recoverable partial bytes and validators survive interruption/process death.
 *  - Unsafe range responses restart, never append an incompatible entity.
 *  - Per-file filesystem locks protect cross-process publication.
 *  - Concurrent seeds of the same model share one download (in-process lock).
 */

import { createReadStream } from "node:fs";
import { mkdir, rm, stat, readFile, writeFile, open } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { Transform, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { hostname } from "node:os";
import { pipeline } from "node:stream/promises";
import { createHash, randomUUID } from "node:crypto";
import { replaceFile } from "../../fs-replace";

import { checksumFile } from "../audio";
import type { MdxModelSpec } from "./mdx";
import { resolveModelsDir } from "./session";

export class ModelSeedError extends Error {
  readonly errorCode = "MODEL_SEED_FAILED" as const;
  constructor(message: string) {
    super(message);
    this.name = "ModelSeedError";
  }
}

export type SeedState = "missing" | "downloading" | "interrupted" | "verifying" | "failed" | "ready";
export type ModelFileStatus = {
  acquisition?: ModelAcquisition | null;
  present: boolean;
  /** Only checksum-verified FINAL files may be used for inference. */
  verified: boolean;
  sizeBytes: number | null;
  provisioning: { state: SeedState; partialBytes: number; totalBytes: number | null; error: string | null };
};

export type ModelAcquisition = { kind: "registry-download" | "owner-supplied-file"; sourceUrl: string; sha256: string; licence: string; permission: "owner-asserted-not-verified" | "not-established"; installedAt: string };
type PartialRecord = {
  acquisition?: ModelAcquisition["kind"];
  revision: string; url: string; sha256: string; total: number | null;
  validator: string | null; state: SeedState; error: string | null;
};
type LockOwner = { pid: number; host: string; token: string };
const identity = (spec: MdxModelSpec) => createHash("sha256").update(JSON.stringify([spec.id, spec.file, spec.sourceUrl, spec.sha256])).digest("hex");
function paths(spec: MdxModelSpec, dir: string) {
  // Registry filenames only; reject paths before any filesystem writes.
  if (basename(spec.file) !== spec.file || spec.file === "." || spec.file === ".." || spec.file.includes("\\")) throw new ModelSeedError("Invalid registry model filename.");
  const final = join(dir, spec.file);
  return { final, partial: join(dir, `.download-${spec.file}.tmp`), metadata: join(dir, `.seed-${spec.file}.json`), lock: join(dir, `.seed-${spec.file}.lock`) };
}
async function record(path: string): Promise<PartialRecord | null> {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; }
}
async function save(path: string, data: PartialRecord | ModelAcquisition) {
  const temp = `${path}.${randomUUID()}`;
  await writeFile(temp, JSON.stringify(data));
  // A status poller reads this record while the download writes it. On Windows
  // `rename` over a file another handle is reading fails with EPERM, and the
  // download would be recorded as failed although the write was valid.
  await replaceFile(temp, path);
}
async function size(path: string) { try { return (await stat(path)).size; } catch { return 0; } }
function alive(owner: LockOwner) {
  if (owner.host !== hostname()) return true; // Never reap another machine's lock.
  try { process.kill(owner.pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
async function ownerAt(lock: string): Promise<LockOwner | null> {
  try { const owner = JSON.parse(await readFile(join(lock, "owner.json"), "utf8")); return Number.isInteger(owner.pid) && owner.pid > 0 && typeof owner.host === "string" ? owner : null; } catch { return null; }
}
/** Atomic mkdir serializes publication across processes, including process death.
 * Dead same-host PIDs are reaped; an ownerless startup crash has a grace period.
 * A nested reaper lock prevents two waiters from deleting a newly acquired lock.
 */
async function acquire(lock: string, signal?: AbortSignal) {
  const owner: LockOwner = { pid: process.pid, host: hostname(), token: randomUUID() };
  const start = Date.now();
  while (true) {
    signal?.throwIfAborted();
    if (Date.now() - start > 10 * 60_000) throw new ModelSeedError("Another process is preparing this model, or lock recovery was interrupted. Retry after checking the model lock owner.");
    try {
      await mkdir(lock);
      try { await writeFile(join(lock, "owner.json"), JSON.stringify(owner)); }
      catch (error) { await rm(lock, { recursive: true, force: true }); throw error; }
      return async () => { if ((await ownerAt(lock))?.token === owner.token) await rm(lock, { recursive: true, force: true }); };
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const stale = async () => {
      const old = await ownerAt(lock);
      if (old) return !alive(old);
      try { return Date.now() - (await stat(lock)).mtimeMs > 2000; } catch { return false; }
    };
    if (await stale()) {
      try {
        await mkdir(join(lock, "reaping"));
        if (await stale()) await rm(lock, { recursive: true, force: true });
        else await rm(join(lock, "reaping"), { recursive: true, force: true });
      } catch (error) { if (!["ENOENT", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
      await delay(100, undefined, { signal });
      continue;
    }
    if (Date.now() - start > 10 * 60_000) throw new ModelSeedError("Another process is preparing this model. Retry when it finishes.");
    await delay(100, undefined, { signal });
  }
}

/**
 * Digests of model files already verified against their pinned SHA-256.
 *
 * `getModelFileStatus` is polled by the models endpoint every two seconds while
 * the engine setup panel is open, and the four registry models total ~148 MB.
 * Re-hashing them on every poll measured 368 ms per poll on a fast Linux
 * container (more on Windows, where Defender scans every read), and it kept a
 * read handle on the very file the installer renames over — the EPERM
 * condition `fs-replace.ts` exists to survive.
 *
 * Keyed on the file identity a write always changes (size, mtime, ctime) — the
 * same evidence `deep.ts` already trusts for the deep checkpoint — and primed
 * from the digest verified at install time. The five-minute ceiling re-reads
 * the bytes even when the timestamps look untouched, so a filesystem with
 * coarse timestamp granularity cannot extend a stale verdict indefinitely.
 * The map is bounded. An explicit verify (session.verifyModelFile) bypasses
 * this cache entirely and always re-hashes the bytes.
 */
type VerifiedDigest = { size: number; mtimeMs: number; ctimeMs: number; at: number; sha256: string };
const verifiedDigests = new Map<string, VerifiedDigest>();
const VERIFIED_DIGEST_LIMIT = 32;
const VERIFIED_DIGEST_TTL_MS = 5 * 60_000;

async function verifiedDigest(file: string): Promise<string | null> {
  let info;
  try { info = await stat(file); } catch { return null; }
  const cached = verifiedDigests.get(file);
  if (cached !== undefined && cached.size === info.size && cached.mtimeMs === info.mtimeMs && cached.ctimeMs === info.ctimeMs && Date.now() - cached.at < VERIFIED_DIGEST_TTL_MS) return cached.sha256;
  const sha256 = await checksumFile(file);
  if (verifiedDigests.size >= VERIFIED_DIGEST_LIMIT) verifiedDigests.clear();
  verifiedDigests.set(file, { size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, at: Date.now(), sha256 });
  return sha256;
}

export async function getModelFileStatus(spec: MdxModelSpec, dir = resolveModelsDir()): Promise<ModelFileStatus> {
  const p = paths(spec, resolve(dir));
  let present = false, verified = false, sizeBytes: number | null = null;
  try { const details = await stat(p.final); present = details.isFile(); sizeBytes = details.size; if (present) verified = await verifiedDigest(p.final) === spec.sha256; } catch { /* missing is not ready */ }
  const meta = await record(p.metadata);
  const matching = meta?.revision === identity(spec);
  const partialBytes = matching ? await size(p.partial) : 0;
  const owner = await ownerAt(p.lock);
  const active = owner !== null && alive(owner);
  const state: SeedState = verified ? "ready" : matching && active ? (meta.state === "verifying" ? "verifying" : "downloading") : matching && meta.state === "failed" ? "failed" : partialBytes > 0 ? "interrupted" : "missing";
  let acquisition: ModelAcquisition | null = null;
  if (verified) try { const stored = JSON.parse(await readFile(`${p.final}.provenance.json`, "utf8")); if (stored.sha256 === spec.sha256 && stored.sourceUrl === spec.sourceUrl && ["owner-supplied-file", "registry-download"].includes(stored.kind)) acquisition = stored; } catch { /* Legacy provenance remains unknown. */ }
  return { present, verified, sizeBytes, acquisition, provisioning: { state, partialBytes, totalBytes: matching ? meta.total : null, error: matching ? meta.error : null } };
}

export type SeedProgress = { bytes: number; totalBytes: number | null };
export type SeedResult = { outcome: "already-present"; status: ModelFileStatus } | { outcome: "installed"; bytes: number };
type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
type SeedOptions = { permissionReviewed?: boolean; acquisition?: ModelAcquisition["kind"]; dir?: string; fetchImpl?: FetchLike; onProgress?: (p: SeedProgress) => void; signal?: AbortSignal };
/** Same file/revision/directory shares work. A cancelled caller does not cancel
 * other callers' transfer; cancellation belongs to the initiating operation. */
const inFlight = new Map<string, Promise<SeedResult>>();
export async function seedModelFile(spec: MdxModelSpec, opts: SeedOptions = {}): Promise<SeedResult> {
  const dir = resolve(opts.dir ?? resolveModelsDir());
  const key = `${dir}:${spec.file}:${identity(spec)}`;
  const existing = inFlight.get(key);
  if (existing) {
    if (!opts.signal) return existing;
    const signal = opts.signal;
    signal.throwIfAborted();
    return new Promise<SeedResult>((resolve, reject) => {
      const abort = () => reject(new ModelSeedError("This preparation request was cancelled; the shared transfer remains available to other callers."));
      signal.addEventListener("abort", abort, { once: true });
      existing.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  }
  const operation = seedModelFileUncached(spec, { ...opts, dir }).finally(() => inFlight.delete(key));
  inFlight.set(key, operation);
  return operation;
}

async function seedModelFileUncached(spec: MdxModelSpec, opts: SeedOptions): Promise<SeedResult> {
  const dir = resolve(opts.dir ?? resolveModelsDir());
  const p = paths(spec, dir);
  await mkdir(dir, { recursive: true });
  const release = await acquire(p.lock, opts.signal);
  let meta: PartialRecord = { acquisition: opts.acquisition ?? "registry-download", revision: identity(spec), url: spec.sourceUrl, sha256: spec.sha256, total: null, validator: null, state: "downloading", error: null };
  const discard = async () => { await rm(p.partial, { force: true }); };
  try {
    const current = await getModelFileStatus(spec, dir);
    if (current.verified) return { outcome: "already-present", status: current };
    const saved = await record(p.metadata);
    let offset = await size(p.partial);
    if ((saved?.acquisition ?? "registry-download") === meta.acquisition && saved?.revision === meta.revision && saved.url === spec.sourceUrl && saved.sha256 === spec.sha256 && (saved.validator || offset === saved.total) && saved.total !== null && offset > 0 && offset <= saved.total) meta = saved;
    else { await discard(); offset = 0; }
    meta.state = "downloading"; meta.error = null;
    await save(p.metadata, meta);
    // A killed process may have received all bytes before checksum/publication.
    if (!(offset > 0 && offset === meta.total)) {
      const fetchImpl = opts.fetchImpl ?? fetch;
      const request = async (resume: boolean) => {
        try { return await fetchImpl(spec.sourceUrl, { signal: opts.signal, headers: { "Accept-Encoding": "identity", ...(resume ? { Range: `bytes=${offset}-`, "If-Range": meta.validator! } : {}) } }); }
        catch (error) { throw new ModelSeedError(`The stem engine model could not be downloaded: ${String(error)}. Check your connection and try again.`); }
      };
      let response = await request(offset > 0);
      const validatorOf = (r: Response) => {
        const etag = r.headers.get("etag");
        return etag && !etag.startsWith("W/") ? etag : r.headers.get("last-modified");
      };
      const lengthOf = (r: Response) => { const raw = r.headers.get("content-length"); return raw !== null && /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : null; };
      const range = response.headers.get("content-range")?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
      const validRange = offset > 0 && response.status === 206 && range && Number(range[1]) === offset && Number(range[2]) === Number(range[3]) - 1 && Number(range[3]) === meta.total && validatorOf(response) === meta.validator && (lengthOf(response) === null || lengthOf(response) === meta.total! - offset);
      if (offset > 0 && !validRange) {
        // A 200 ignored If-Range: use its FULL body, never append it. Any
        // malformed/changed partial response is cancelled and fetched afresh.
        await discard(); offset = 0;
        if (response.status !== 200) { await response.body?.cancel(); response = await request(false); }
      }
      if (!response.ok || response.body === null || (offset === 0 && response.status !== 200)) {
        await response.body?.cancel();
        throw new ModelSeedError(`The model download was refused (HTTP ${response.status}). Try again later.`);
      }
      if (response.headers.get("content-encoding") && response.headers.get("content-encoding") !== "identity") {
        await response.body.cancel(); throw new ModelSeedError("Encoded model response cannot be resumed safely; request an identity representation.");
      }
      const declared = lengthOf(response);
      const total = offset > 0 ? meta.total : declared;
      // Registry sizes are approximate; SHA-256, not the estimate, is authority.
      if (total !== null && (total < spec.sizeBytes * 0.5 || total > spec.sizeBytes * 1.5)) {
        await response.body.cancel(); await discard();
        throw new ModelSeedError(`The download is ${total} bytes but the pinned model is ~${spec.sizeBytes} — not the registered model.`);
      }
      meta = { ...meta, total, validator: validatorOf(response), state: "downloading" };
      await save(p.metadata, meta); // Persist representation BEFORE any bytes.
      let bytes = offset;
      const source = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
      const guard = new Transform({ transform(chunk: Buffer, _encoding, done) {
        bytes += chunk.length;
        if (bytes > (total ?? spec.sizeBytes * 1.5)) { done(new ModelSeedError("Oversized model response; refusing installation.")); return; }
        done(null, chunk);
      } });
      // Progress follows completed file writes, not merely received chunks.
      const file = await open(p.partial, offset > 0 ? "a" : "w");
      let persisted = offset;
      const output = new Writable({ write(chunk: Buffer, _encoding, done) {
        file.writeFile(chunk).then(() => {
          persisted += chunk.length;
          try { opts.onProgress?.({ bytes: persisted, totalBytes: total }); done(); }
          catch (error) { done(error as Error); }
        }, done);
      } });
      try { await pipeline(source, guard, output, { signal: opts.signal }); }
      catch (error) { throw new ModelSeedError(`The model download was interrupted; retained bytes can be resumed: ${String(error)}.`); }
      finally { await file.close(); }
      opts.onProgress?.({ bytes, totalBytes: total });
      if (total !== null && bytes !== total) throw new ModelSeedError(`Truncated model response (${bytes}/${total} bytes); retry to resume.`);
    }
    meta.state = "verifying"; await save(p.metadata, meta);
    const sha = await checksumFile(p.partial);
    if (sha !== spec.sha256) {
      await discard();
      throw new ModelSeedError(`The downloaded model failed its integrity check (sha256 ${sha}, expected ${spec.sha256}). Nothing was installed — try again.`);
    }
    const bytes = await size(p.partial);
    opts.signal?.throwIfAborted();
    // Same Windows sharing-violation class as `save`: a status poll, an
    // antivirus scan or a reader can hold the destination momentarily.
    await replaceFile(p.partial, p.final);
    const installed = await stat(p.final);
    if (verifiedDigests.size >= VERIFIED_DIGEST_LIMIT) verifiedDigests.clear();
    verifiedDigests.set(p.final, { size: installed.size, mtimeMs: installed.mtimeMs, ctimeMs: installed.ctimeMs, at: Date.now(), sha256: sha });
    await save(`${p.final}.provenance.json`, { kind: opts.acquisition ?? "registry-download", sourceUrl: spec.sourceUrl, sha256: sha, licence: spec.license, permission: opts.acquisition === "owner-supplied-file" || opts.permissionReviewed ? "owner-asserted-not-verified" : "not-established", installedAt: new Date().toISOString() });
    await rm(p.metadata, { force: true });
    return { outcome: "installed", bytes };
  } catch (error) {
    meta.state = (await size(p.partial)) > 0 ? "interrupted" : "failed";
    meta.error = error instanceof Error ? error.message : String(error);
    await save(p.metadata, meta);
    throw error instanceof ModelSeedError ? error : new ModelSeedError(meta.error);
  } finally { await release(); }
}

/** Human-facing model labels are product vocabulary, never file names. */
export function modelLabel(spec: MdxModelSpec): string {
  return spec.label ?? spec.file.replace(/\.onnx$/i, "").replace(/_/g, " ");
}

export function modelsDirParent(dir: string): string {
  return dirname(dir);
}

/** Explicit owner-supplied exact model asset. Verification happens even when an
 * installed model already exists. Publication still uses the existing seeder's
 * file lock, size bounds, final SHA check and atomic rename; no network request.
 * This does not establish architecture execution, provenance rights or quality.
 */
export async function importModelFile(spec: MdxModelSpec, filePath: string, opts: { dir?: string; signal?: AbortSignal; rightsReviewed: boolean }) {
  if (opts.rightsReviewed !== true) throw new ModelSeedError("Owner must review source/licensing and attest authorised use before importing.");
  opts.signal?.throwIfAborted();
  const sha = await checksumFile(filePath);
  if (sha !== spec.sha256) throw new ModelSeedError(`Owner-supplied asset does not match pinned ${spec.id} SHA-256. Nothing installed.`);
  const bytes = await size(filePath);
  const result = await seedModelFile(spec, { ...opts, acquisition: "owner-supplied-file", fetchImpl: async () => new Response(Readable.toWeb(createReadStream(filePath)) as ReadableStream, { status: 200, headers: { "content-length": String(bytes) } }) });
  return { ...result, inputVerifiedFrom: "owner-supplied-file" as const, sha256: sha };
}
