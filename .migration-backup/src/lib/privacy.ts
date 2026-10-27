// Server-side data-protection core: the no-training contract,
// zero-egress enforcement for Local Mode, sealed ephemeral reveals,
// and the privacy audit log.

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { db } from "@/db";
import { privacyEvents } from "@/db/schema";

export const DATA_POLICY = {
  training: "never",
  retentionCloud: "zero-by-default",
  localModeEgress: "none",
  version: "2026-09-12",
} as const;

// Best-effort no-training / no-retention signals on every outbound AI call.
export const NO_TRAIN_HEADERS: Record<string, string> = {
  "X-Data-Policy": "no-train,no-retain",
  "X-No-Train": "true",
  "X-Provider-Use": "inference-only",
};

export function isLocalOnlyBody(body: any): boolean {
  return body?.localOnly === true || process.env.FORCE_LOCAL_MODE === "1";
}

export function isEphemeralBody(body: any): boolean {
  return body?.ephemeral === true;
}

// ---------- sealed reveal tokens (ephemeral battles stay blind, never stored) ----------

function sealSecret(): Buffer {
  const g = globalThis as typeof globalThis & { __afSeal?: Buffer };
  if (!g.__afSeal) {
    const base = process.env.SEAL_SECRET || process.env.DATABASE_URL || "arenaforge-local-seal";
    g.__afSeal = scryptSync(String(base), "arenaforge-seal-salt", 32);
  }
  return g.__afSeal;
}

export function sealReveal(payload: object): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", sealSecret(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, data]).toString("base64url");
}

export function openReveal(token: string): any | null {
  try {
    const raw = Buffer.from(token, "base64url");
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const data = raw.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", sealSecret(), iv);
    decipher.setAuthTag(tag);
    const json = Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// ---------- audit log (metadata only — never prompt/response content) ----------

export async function logPrivacyEvent(action: string, detail?: string) {
  try {
    await db.insert(privacyEvents).values({ action: action.slice(0, 64), detail: (detail ?? "").slice(0, 500) });
  } catch {
    // audit is best-effort; never break the request
  }
}
