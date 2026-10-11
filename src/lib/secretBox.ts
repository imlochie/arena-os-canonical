/**
 * Sealed secrets — small-string counterpart of encryptedBlobStore.
 *
 * AES-256-GCM, same key convention as the blob store (ARENA_ARTIFACT_MASTER_KEY,
 * base64 32 bytes; dev fallback unless NODE_ENV=production). Output format:
 *
 *   v1.<base64 nonce>.<base64 authTag>.<base64 ciphertext>
 *
 * Tampering with any segment throws on open. Used for email account
 * credentials (IMAP usernames never leave the local database unsealed
 * except to the IMAP server during a scan).
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

function key(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env.ARENA_ARTIFACT_MASTER_KEY;
  if (!raw) {
    if (env.NODE_ENV === "production") {
      throw new Error("ARTIFACT_MASTER_KEY_REQUIRED");
    }
    return createHash("sha256").update("arena-development-artifact-key-not-for-production").digest();
  }
  const b = Buffer.from(raw, "base64");
  if (b.length !== 32) throw new Error("ARTIFACT_MASTER_KEY_INVALID");
  return b;
}

export function sealSecret(plain: string, env: NodeJS.ProcessEnv = process.env): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(env), nonce);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plain, "utf8")), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", nonce.toString("base64"), tag.toString("base64"), ciphertext.toString("base64")].join(".");
}

export function openSecret(sealed: string, env: NodeJS.ProcessEnv = process.env): string {
  const parts = sealed.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new Error("SECRET_BOX_FORMAT_INVALID");
  }
  const nonce = Buffer.from(parts[1], "base64");
  const tag = Buffer.from(parts[2], "base64");
  const ciphertext = Buffer.from(parts[3], "base64");
  const decipher = createDecipheriv("aes-256-gcm", key(env), nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

/** Never log or serialize a sealed value's plaintext; this only checks shape. */
export function isSealedSecret(value: string): boolean {
  return /^v1\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/.test(value);
}
