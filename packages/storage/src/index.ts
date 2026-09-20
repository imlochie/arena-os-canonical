import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createReadStream, existsSync, promises as fs } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export interface StorageProvider {
  readonly kind: "local" | "s3";
  putFile(key: string, localPath: string, contentType?: string): Promise<void>;
  getToFile(key: string, localPath: string): Promise<void>;
  delete(key: string): Promise<void>;
  createDownloadUrl(key: string, expiresInSeconds: number): Promise<string | null>;
  getLocalPath(key: string): string | null;
  healthcheck(): Promise<void>;
}

export function privateObjectKey(projectId: string, category: "source" | "stem" | "export", extension: string) {
  const safeExtension = extension.replace(/[^a-zA-Z0-9]/g, "").toLowerCase() || "bin";
  return `projects/${projectId}/${category}/${randomUUID()}.${safeExtension}`;
}

function safeLocalPath(root: string, key: string) {
  const normalized = normalize(key).replace(/^([/\\])+/, "");
  const target = resolve(root, normalized);
  const resolvedRoot = resolve(root);
  if (!target.startsWith(`${resolvedRoot}/`) && target !== resolvedRoot) throw new Error("Unsafe storage key.");
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
  async getToFile(key: string, localPath: string) {
    await fs.mkdir(dirname(localPath), { recursive: true });
    await fs.copyFile(safeLocalPath(this.root, key), localPath);
  }
  async delete(key: string) { await fs.rm(safeLocalPath(this.root, key), { force: true }); }
  async createDownloadUrl() { return null; }
  getLocalPath(key: string) { return safeLocalPath(this.root, key); }
  async healthcheck() { await fs.mkdir(this.root, { recursive: true }); await fs.access(this.root); }
}

class S3StorageProvider implements StorageProvider {
  readonly kind = "s3" as const;
  private readonly client: S3Client;
  constructor(private readonly bucket: string) {
    this.client = new S3Client({
      region: process.env.S3_REGION ?? "us-east-1",
      endpoint: process.env.S3_ENDPOINT,
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
      credentials: { accessKeyId: required("S3_ACCESS_KEY"), secretAccessKey: required("S3_SECRET_KEY") },
    });
  }
  async putFile(key: string, localPath: string, contentType?: string) {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: createReadStream(localPath), ContentType: contentType }));
  }
  async getToFile(key: string, localPath: string) {
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!response.Body || !("transformToByteArray" in response.Body)) throw new Error("Storage object body is unavailable.");
    await fs.mkdir(dirname(localPath), { recursive: true });
    await fs.writeFile(localPath, await response.Body.transformToByteArray());
  }
  async delete(key: string) { await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key })); }
  async createDownloadUrl(key: string, expiresInSeconds: number) {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn: expiresInSeconds });
  }
  getLocalPath() { return null; }
  async healthcheck() { await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: ".waveyard-healthcheck", Body: "ok" })); await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: ".waveyard-healthcheck" })); }
}

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for S3 storage.`);
  return value;
}

let provider: StorageProvider | undefined;
export function getStorage(): StorageProvider {
  if (provider) return provider;
  const kind = process.env.STORAGE_PROVIDER ?? "local";
  provider = kind === "local"
    ? new LocalStorageProvider(resolve(process.env.LOCAL_STORAGE_PATH ?? join(process.cwd(), ".waveyard-data/objects")))
    : new S3StorageProvider(required("S3_BUCKET"));
  return provider;
}
