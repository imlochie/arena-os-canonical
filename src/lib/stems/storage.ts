import { randomUUID } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

export type ObjectRead = { bytes: Uint8Array; size: number; contentRange?: string };

export interface StemStorage {
  readonly kind: "local" | "s3";
  putFile(key: string, source: string, contentType: string): Promise<void>;
  getToFile(key: string, destination: string): Promise<void>;
  read(key: string, range?: { start: number; end: number }): Promise<ObjectRead>;
  delete(key: string): Promise<void>;
  healthcheck(): Promise<void>;
}

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for S3 stem storage.`);
  return value;
}

function safeLocalPath(root: string, key: string) {
  const normalized = normalize(key).replace(/^([/\\])+/, "");
  const target = resolve(root, normalized);
  const resolvedRoot = resolve(root);
  if (!target.startsWith(`${resolvedRoot}/`)) throw new Error("Unsafe storage key.");
  return target;
}

export function privateObjectKey(projectId: string, kind: "source" | "stem", extension: string) {
  const safeExtension = extension.replace(/[^a-zA-Z0-9]/g, "").toLowerCase() || "bin";
  return `projects/${projectId}/${kind}/${randomUUID()}.${safeExtension}`;
}

class LocalStemStorage implements StemStorage {
  readonly kind = "local" as const;
  constructor(private readonly root: string) {}

  async putFile(key: string, source: string) {
    const destination = safeLocalPath(this.root, key);
    await fs.mkdir(dirname(destination), { recursive: true });
    await fs.copyFile(source, destination);
  }

  async getToFile(key: string, destination: string) {
    await fs.mkdir(dirname(destination), { recursive: true });
    await fs.copyFile(safeLocalPath(this.root, key), destination);
  }

  async read(key: string, range?: { start: number; end: number }): Promise<ObjectRead> {
    const source = safeLocalPath(this.root, key);
    const info = await fs.stat(source);
    const start = range?.start ?? 0;
    const end = range?.end ?? info.size - 1;
    if (start < 0 || end < start || end >= info.size) throw new Error("Requested byte range is invalid.");
    const bytes = await fs.readFile(source);
    return {
      bytes: bytes.subarray(start, end + 1),
      size: info.size,
      contentRange: range ? `bytes ${start}-${end}/${info.size}` : undefined,
    };
  }

  async delete(key: string) { await fs.rm(safeLocalPath(this.root, key), { force: true }); }
  async healthcheck() { await fs.mkdir(this.root, { recursive: true }); await fs.access(this.root); }
}

class S3StemStorage implements StemStorage {
  readonly kind = "s3" as const;
  private readonly client: S3Client;

  constructor(private readonly bucket: string) {
    this.client = new S3Client({
      region: process.env.STEM_S3_REGION ?? "us-east-1",
      endpoint: process.env.STEM_S3_ENDPOINT,
      forcePathStyle: process.env.STEM_S3_FORCE_PATH_STYLE === "true",
      credentials: { accessKeyId: required("STEM_S3_ACCESS_KEY"), secretAccessKey: required("STEM_S3_SECRET_KEY") },
    });
  }

  async putFile(key: string, source: string, contentType: string) {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: createReadStream(source), ContentType: contentType }));
  }

  async getToFile(key: string, destination: string) {
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!response.Body || !("transformToByteArray" in response.Body)) throw new Error("Storage object body is unavailable.");
    await fs.mkdir(dirname(destination), { recursive: true });
    await fs.writeFile(destination, await response.Body.transformToByteArray());
  }

  async read(key: string, range?: { start: number; end: number }): Promise<ObjectRead> {
    const response = await this.client.send(new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Range: range ? `bytes=${range.start}-${range.end}` : undefined,
    }));
    if (!response.Body || !("transformToByteArray" in response.Body)) throw new Error("Storage object body is unavailable.");
    const bytes = await response.Body.transformToByteArray();
    const size = Number(response.ContentRange?.split("/").at(-1) ?? response.ContentLength ?? bytes.byteLength);
    return { bytes, size, contentRange: response.ContentRange };
  }

  async delete(key: string) { await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key })); }
  async healthcheck() {
    const key = `.arena-stem-health/${randomUUID()}`;
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: "ok" }));
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

let provider: StemStorage | undefined;
export function getStemStorage() {
  if (provider) return provider;
  const kind = process.env.STEM_STORAGE_PROVIDER ?? "local";
  const localRoot = process.env.STEM_LOCAL_STORAGE_PATH
    ? resolve(/* turbopackIgnore: true */ process.env.STEM_LOCAL_STORAGE_PATH)
    : join(/* turbopackIgnore: true */ process.cwd(), ".arena-data", "stem-objects");
  provider = kind === "s3"
    ? new S3StemStorage(required("STEM_S3_BUCKET"))
    : new LocalStemStorage(localRoot);
  return provider;
}
