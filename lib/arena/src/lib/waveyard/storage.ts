/**
 * Waveyard storage — local filesystem provider.
 *
 * Ported from the original Waveyard packages/storage (LocalStorageProvider,
 * verbatim behavior) with the S3 provider intentionally dropped: Arena OS is
 * local-first and does not ship @aws-sdk. If object storage is ever needed,
 * port S3StorageProvider back from the original package.
 *
 * Files live under .data/waveyard-storage/ using the original key layout:
 *   projects/{projectId}/{source|stem|waveform|export}/{uuid}.{ext}
 */

import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  dirname,
  isAbsolute,
  normalize,
  relative,
  resolve,
  sep,
} from "node:path";
import { createHash, randomUUID } from "node:crypto";

export type StorageRead = { stream: Readable; size: number; start: number; end: number };
export type StorageObject = { key: string; lastModified: Date };

export type ContentObjectFailure = "missing" | "size" | "sha256";

/** An object's bytes do not match the identity it was stored or requested under. */
export class StorageIntegrityError extends Error {
  constructor(
    readonly reason: ContentObjectFailure,
    message: string,
  ) {
    super(message);
    this.name = "StorageIntegrityError";
  }
}

export type ContentObjectIdentity = { sha256: string; byteLength: number };
export type ImmutablePutResult = { key: string; deduplicated: boolean };

const SHA256_HEX = /^[0-9a-f]{64}$/;

function assertIdentity(identity: ContentObjectIdentity) {
  if (!SHA256_HEX.test(identity.sha256))
    throw new Error("A lowercase hex SHA-256 is required.");
  if (!Number.isSafeInteger(identity.byteLength) || identity.byteLength < 0)
    throw new Error("A non-negative byte length is required.");
}

/** Content-addressed key: the identity IS the location, so a key can never name other bytes. */
export function contentObjectKey(sha256: string) {
  if (!SHA256_HEX.test(sha256)) throw new Error("A lowercase hex SHA-256 is required.");
  return `objects/sha256/${sha256.slice(0, 2)}/${sha256}`;
}

async function digestFile(location: string) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(location)) {
    hash.update(chunk as Buffer);
    bytes += (chunk as Buffer).length;
  }
  return { sha256: hash.digest("hex"), bytes };
}

export interface StorageProvider {
  readonly kind: "local";
  putFile(key: string, localPath: string, contentType?: string): Promise<void>;
  putBuffer(key: string, data: string): Promise<void>;
  getToFile(key: string, localPath: string): Promise<void>;
  // Bounded derived metadata (waveforms), never large audio delivery.
  getBuffer(key: string, maxBytes: number): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  listObjects(prefix: string): Promise<StorageObject[]>;
  createDownloadUrl(
    key: string,
    expiresInSeconds: number,
    downloadName?: string,
  ): Promise<string | null>;
  getLocalPath(key: string): string | null;
  openReadStream(key: string, range?: { start: number; end: number }): Promise<StorageRead>;
  healthcheck(): Promise<void>;
  /**
   * Store bytes under their SHA-256. The stream is hashed and counted while it
   * is written to a private temporary file, and is published only if it matches
   * the declared identity exactly; a mismatch throws StorageIntegrityError and
   * leaves nothing behind. Identical content is stored once.
   */
  putImmutableStream(source: Readable, identity: ContentObjectIdentity): Promise<ImmutablePutResult>;
  /** Re-read the stored bytes and confirm they still match the identity. */
  verifyObject(key: string, identity: ContentObjectIdentity): Promise<void>;
}

export function privateObjectKey(
  projectId: string,
  category: "source" | "stem" | "waveform" | "export" | "chop",
  extension: string,
) {
  const safeExtension =
    extension.replace(/[^a-zA-Z0-9]/g, "").toLowerCase() || "bin";
  return `projects/${projectId}/${category}/${randomUUID()}.${safeExtension}`;
}

export function safeLocalPath(root: string, key: string) {
  const normalized = normalize(key).replace(/^([/\\])+/, "");
  const resolvedRoot = resolve(root);
  const target = resolve(resolvedRoot, normalized);
  const relativePath = relative(resolvedRoot, target);

  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error("Unsafe storage key.");
  }

  return target;
}

export class LocalStorageProvider implements StorageProvider {
  readonly kind = "local" as const;
  private readonly root: string;
  constructor(root: string) {
    this.root = root;
  }
  async putFile(key: string, localPath: string) {
    const destination = safeLocalPath(this.root, key);
    await fs.mkdir(dirname(destination), { recursive: true });
    await fs.copyFile(localPath, destination);
  }
  async putBuffer(key: string, data: string) {
    const destination = safeLocalPath(this.root, key);
    await fs.mkdir(dirname(destination), { recursive: true });
    await fs.writeFile(destination, data, "utf8");
  }
  async getToFile(key: string, localPath: string) {
    await fs.mkdir(dirname(localPath), { recursive: true });
    await fs.copyFile(safeLocalPath(this.root, key), localPath);
  }
  async getBuffer(key: string, maxBytes: number) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
      throw new Error("A positive metadata read limit is required.");
    const location = safeLocalPath(this.root, key);
    const details = await fs.stat(location);
    if (details.size > maxBytes)
      throw new Error("Derived metadata exceeds the allowed read size.");
    return fs.readFile(location);
  }
  async exists(key: string) {
    try {
      await fs.access(safeLocalPath(this.root, key));
      return true;
    } catch {
      return false;
    }
  }
  async delete(key: string) {
    await fs.rm(safeLocalPath(this.root, key), { force: true });
  }
  async listObjects(prefix: string): Promise<StorageObject[]> {
    const directory = safeLocalPath(this.root, prefix);
    const objects: StorageObject[] = [];
    const visit = async (currentDirectory: string) => {
      let entries;
      try {
        entries = await fs.readdir(currentDirectory, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      for (const entry of entries) {
        const location = resolve(currentDirectory, entry.name);
        if (entry.isDirectory()) {
          await visit(location);
        } else if (entry.isFile()) {
          const details = await fs.stat(location);
          const key = relative(this.root, location).split(sep).join("/");
          objects.push({ key, lastModified: details.mtime });
        }
      }
    };
    await visit(directory);
    return objects;
  }
  async createDownloadUrl(
    _key: string,
    _expiresInSeconds: number,
    _downloadName?: string,
  ) {
    // Local provider: routes stream bytes directly; no presigned URL exists.
    return null;
  }
  getLocalPath(key: string) {
    return safeLocalPath(this.root, key);
  }
  async openReadStream(key: string, range?: { start: number; end: number }) {
    const location = safeLocalPath(this.root, key);
    const details = await fs.stat(location);
    const start = range?.start ?? 0;
    const end = range?.end ?? details.size - 1;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end >= details.size)
      throw new Error("Invalid object byte range.");
    return { stream: createReadStream(location, { start, end }), size: details.size, start, end };
  }
  async healthcheck() {
    await fs.mkdir(this.root, { recursive: true });
    await fs.access(this.root);
  }
  async verifyObject(key: string, identity: ContentObjectIdentity) {
    assertIdentity(identity);
    const location = safeLocalPath(this.root, key);
    let details;
    try {
      details = await fs.stat(location);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new StorageIntegrityError("missing", "The stored object is missing.");
      throw error;
    }
    if (details.size !== identity.byteLength)
      throw new StorageIntegrityError("size", "The stored object has the wrong size.");
    const actual = await digestFile(location);
    if (actual.bytes !== identity.byteLength)
      throw new StorageIntegrityError("size", "The stored object changed while it was verified.");
    if (actual.sha256 !== identity.sha256)
      throw new StorageIntegrityError("sha256", "The stored object does not match its SHA-256.");
  }
  async putImmutableStream(source: Readable, identity: ContentObjectIdentity) {
    assertIdentity(identity);
    const key = contentObjectKey(identity.sha256);
    const destination = safeLocalPath(this.root, key);
    await fs.mkdir(dirname(destination), { recursive: true });
    const temporary = `${destination}.${randomUUID()}.partial`;
    const hash = createHash("sha256");
    let bytes = 0;
    try {
      await pipeline(
        source,
        async function* (chunks: AsyncIterable<Buffer>) {
          for await (const chunk of chunks) {
            bytes += chunk.length;
            // Stop reading as soon as the stream outgrows its declared size.
            if (bytes > identity.byteLength)
              throw new StorageIntegrityError("size", "The stream is larger than its declared size.");
            hash.update(chunk);
            yield chunk;
          }
        },
        createWriteStream(temporary, { flags: "wx" }),
      );
      if (bytes !== identity.byteLength)
        throw new StorageIntegrityError("size", "The stream is smaller than its declared size.");
      if (hash.digest("hex") !== identity.sha256)
        throw new StorageIntegrityError("sha256", "The stream does not match its declared SHA-256.");
      let deduplicated = false;
      try {
        await this.verifyObject(key, identity);
        deduplicated = true;
      } catch (error) {
        // A missing or corrupt existing object is replaced by the verified bytes.
        if (!(error instanceof StorageIntegrityError)) throw error;
      }
      if (!deduplicated) await fs.rename(temporary, destination);
      return { key, deduplicated };
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
}

let provider: StorageProvider | undefined;

export function getStorage(): StorageProvider {
  if (!provider) {
    // WAVEYARD_STORAGE_DIR is Arena's name; LOCAL_STORAGE_PATH is the
    // original worker's name. Accept either so web and worker containers
    // can be pointed at one shared directory.
    const root =
      process.env.WAVEYARD_STORAGE_DIR ??
      process.env.LOCAL_STORAGE_PATH ??
      ".data/waveyard-storage";
    provider = new LocalStorageProvider(
      resolve(/*turbopackIgnore: true*/ process.cwd(), root),
    );
  }
  return provider;
}
