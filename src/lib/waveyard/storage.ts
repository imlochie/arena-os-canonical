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

import { createReadStream, promises as fs } from "node:fs";
import { Readable } from "node:stream";
import { dirname, normalize, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export type StorageRead = { stream: Readable; size: number; start: number; end: number };

export interface StorageProvider {
  readonly kind: "local";
  putFile(key: string, localPath: string, contentType?: string): Promise<void>;
  putBuffer(key: string, data: string): Promise<void>;
  getToFile(key: string, localPath: string): Promise<void>;
  // Bounded derived metadata (waveforms), never large audio delivery.
  getBuffer(key: string, maxBytes: number): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  createDownloadUrl(
    key: string,
    expiresInSeconds: number,
    downloadName?: string,
  ): Promise<string | null>;
  getLocalPath(key: string): string | null;
  openReadStream(key: string, range?: { start: number; end: number }): Promise<StorageRead>;
  healthcheck(): Promise<void>;
}

export function privateObjectKey(
  projectId: string,
  category: "source" | "stem" | "waveform" | "export",
  extension: string,
) {
  const safeExtension =
    extension.replace(/[^a-zA-Z0-9]/g, "").toLowerCase() || "bin";
  return `projects/${projectId}/${category}/${randomUUID()}.${safeExtension}`;
}

function safeLocalPath(root: string, key: string) {
  const normalized = normalize(key).replace(/^([/\\])+/, "");
  const target = resolve(root, normalized);
  const resolvedRoot = resolve(root);
  if (!target.startsWith(`${resolvedRoot}/`) && target !== resolvedRoot)
    throw new Error("Unsafe storage key.");
  return target;
}

class LocalStorageProvider implements StorageProvider {
  readonly kind = "local" as const;
  constructor(private readonly root: string) {}
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
