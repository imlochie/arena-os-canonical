/**
 * Email inbox — real owner-side IMAP for the Subscriptions app.
 *
 * The user logs into their own mailbox (Gmail/Outlook/iCloud/Fastmail or any
 * IMAP server) from the Subscriptions page; credentials are stored sealed
 * (AES-256-GCM via secretBox) in the local database and are never returned to
 * the browser. A scan opens INBOX read-only, walks recent messages, parses
 * them with mailparser, and runs the same extraction pipeline as the
 * paste-a-receipt box (model → regex floor → honest "none").
 *
 * Nothing here sends email, deletes email, or mutates the mailbox: the scan is
 * read-only by construction (readOnly open, FETCH only).
 */

import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { emailAccounts } from "@/db/schema";
import { sealSecret, openSecret } from "./secretBox";
import {
  createSubscription,
  extractSubscriptionFromEmail,
  listSubscriptions,
  type Cadence,
  type ExtractedSubscription,
} from "./subscriptions";

/* ------------------------------- presets --------------------------------- */

export const PROVIDER_PRESETS = [
  { id: "gmail", label: "Gmail", host: "imap.gmail.com", port: 993, note: "Needs an App Password (2FA on)" },
  { id: "outlook", label: "Outlook / Microsoft 365", host: "outlook.office365.com", port: 993, note: "Needs an App Password" },
  { id: "icloud", label: "iCloud Mail", host: "imap.mail.me.com", port: 993, note: "Needs an App-Specific Password" },
  { id: "fastmail", label: "Fastmail", host: "imap.fastmail.com", port: 993, note: "Use your app password, not the login password" },
  { id: "custom", label: "Custom IMAP", host: "", port: 993, note: "Host, port and TLS are yours" },
] as const;

/* -------------------------------- types ---------------------------------- */

export type EmailAccountPublic = {
  id: string;
  address: string;
  displayName: string;
  host: string;
  port: number;
  tls: boolean;
  username: string;
  createdAt: string;
  lastScanAt: string | null;
  lastScanMessageCount: number | null;
  lastError: string | null;
};

export type ReceiptCandidate = {
  uid: number;
  messageId: string | null;
  subject: string;
  from: string;
  date: string | null;
  extracted: ExtractedSubscription;
  preview: string;
  alreadyTracked: boolean;
};

export type InboxErrorCode =
  | "auth_failed"
  | "connect_failed"
  | "dns_failed"
  | "timeout"
  | "scan_failed"
  | "not_found"
  | "bad_input";

export class EmailInboxError extends Error {
  readonly code: InboxErrorCode;
  constructor(code: InboxErrorCode, message: string) {
    super(message);
    this.name = "EmailInboxError";
    this.code = code;
  }
}

/* ------------------------------ credentials ------------------------------- */

type EmailAccountRow = typeof emailAccounts.$inferSelect;

function toPublic(row: EmailAccountRow): EmailAccountPublic {
  return {
    id: row.id,
    address: row.address,
    displayName: row.displayName,
    host: row.host,
    port: row.port,
    tls: row.tls,
    username: row.username,
    createdAt: row.createdAt.toISOString(),
    lastScanAt: row.lastScanAt ? row.lastScanAt.toISOString() : null,
    lastScanMessageCount: row.lastScanMessageCount,
    lastError: row.lastError,
  };
}

export async function listEmailAccounts(): Promise<EmailAccountPublic[]> {
  const rows = await db.select().from(emailAccounts).orderBy(emailAccounts.createdAt);
  return rows.map(toPublic);
}

export async function saveEmailAccount(input: {
  address: string;
  displayName?: string;
  host: string;
  port?: number;
  tls?: boolean;
  username: string;
  password: string;
}): Promise<EmailAccountPublic> {
  const address = input.address.trim().toLowerCase();
  const host = input.host.trim();
  const username = input.username.trim();
  if (!address || !address.includes("@")) throw new EmailInboxError("bad_input", "A valid email address is required.");
  if (!host) throw new EmailInboxError("bad_input", "IMAP host is required.");
  if (!username) throw new EmailInboxError("bad_input", "Username is required.");
  if (!input.password) throw new EmailInboxError("bad_input", "Password is required.");
  const port = Number(input.port ?? 993) || 993;
  const tls = input.tls !== false;
  const sealed = sealSecret(input.password);
  const existing = await db.select().from(emailAccounts).where(eq(emailAccounts.address, address)).limit(1);
  if (existing.length) {
    const [row] = await db
      .update(emailAccounts)
      .set({
        displayName: (input.displayName ?? "").trim(),
        host,
        port,
        tls,
        username,
        passwordSealed: sealed,
        updatedAt: new Date(),
        lastError: null,
      })
      .where(eq(emailAccounts.id, existing[0].id))
      .returning();
    return toPublic(row);
  }
  const [row] = await db
    .insert(emailAccounts)
    .values({
      address,
      displayName: (input.displayName ?? "").trim(),
      host,
      port,
      tls,
      username,
      passwordSealed: sealed,
    })
    .returning();
  return toPublic(row);
}

export async function deleteEmailAccount(id: string): Promise<boolean> {
  const rows = await db.delete(emailAccounts).where(eq(emailAccounts.id, id)).returning();
  return rows.length > 0;
}

async function getAccount(id: string): Promise<EmailAccountRow> {
  const rows = await db.select().from(emailAccounts).where(eq(emailAccounts.id, id)).limit(1);
  if (!rows.length) throw new EmailInboxError("not_found", "Email account not found.");
  return rows[0];
}

/* -------------------------------- IMAP ------------------------------------ */

function classifyImapError(error: unknown): InboxErrorCode {
  const e = error as { authenticationFailed?: boolean; code?: string; message?: string };
  if (e?.authenticationFailed) return "auth_failed";
  const text = String(e?.message ?? "");
  if (/AUTHENTICATIONFAILED|INVALID CREDENTIALS|LOGIN FAILED|AUTHORIZATIONFAILED|password/i.test(text)) {
    return "auth_failed";
  }
  if (e?.code === "ENOTFOUND" || e?.code === "EAI_AGAIN") return "dns_failed";
  if (e?.code === "ETIMEDOUT" || /timeout/i.test(text)) return "timeout";
  return "connect_failed";
}

function normalizeEnvelopeDate(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function makeClient(opts: { host: string; port: number; tls: boolean; username: string; password: string }): ImapFlow {
  return new ImapFlow({
    host: opts.host,
    port: opts.port,
    secure: opts.tls,
    auth: { user: opts.username, pass: opts.password },
    logger: false,
    greetingTimeout: 20_000,
    socketTimeout: 90_000,
    tls: { minVersion: "TLSv1.2" },
  });
}

/** Connect + authenticate + list mailboxes. Touches nothing else. */
export async function testImapConnection(
  opts: { host: string; port?: number; tls?: boolean; username: string; password: string },
): Promise<{ ok: true; mailboxes: string[] } | { ok: false; code: InboxErrorCode; detail: string }> {
  const client = makeClient({
    host: opts.host.trim(),
    port: Number(opts.port ?? 993) || 993,
    tls: opts.tls !== false,
    username: opts.username,
    password: opts.password,
  });
  let asyncError: unknown = null;
  client.on("error", (err: unknown) => {
    asyncError = asyncError ?? err;
  });
  try {
    await client.connect();
    const mailboxes: string[] = [];
    for (const box of await client.list()) {
      if (box && !box.specialUse && !box.path.includes("/")) mailboxes.push(box.path);
      if (box?.specialUse) mailboxes.push(`${box.path} (${String(box.specialUse).replace(/\\/g, "").toLowerCase()})`);
      if (mailboxes.length >= 30) break;
    }
    await client.logout();
    return { ok: true, mailboxes };
  } catch (error) {
    try {
      client.close();
    } catch {
      /* already gone */
    }
    return {
      ok: false,
      code: classifyImapError(asyncError ?? error),
      detail: String((error as Error)?.message ?? error),
    };
  }
}

/* ------------------------------ HTML → text ------------------------------- */

/** Coarse HTML strip for extraction purposes (plain part preferred upstream). */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|tr|h[1-6]|li)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/* ------------------------------ the scan --------------------------------- */

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export async function scanInboxForReceipts(
  accountId: string,
  opts: { days?: number; maxMessages?: number; keys?: Record<string, string>; modelId?: string } = {},
): Promise<{ scanned: number; candidates: ReceiptCandidate[]; account: EmailAccountPublic }> {
  const account = await getAccount(accountId);
  const days = Math.min(Math.max(Number(opts.days ?? 60) || 60, 1), 365);
  const maxMessages = Math.min(Math.max(Number(opts.maxMessages ?? 120) || 120, 1), 300);
  const since = new Date(Date.now() - days * 86_400_000);
  const password = openSecret(account.passwordSealed);

  const client = makeClient({
    host: account.host,
    port: account.port,
    tls: account.tls,
    username: account.username,
    password,
  });
  let asyncError: unknown = null;
  client.on("error", (err: unknown) => {
    asyncError = asyncError ?? err;
  });

  const candidates: ReceiptCandidate[] = [];
  let scanned = 0;

  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      const uids = (await client.search({ since }, { uid: true })) as number[];
      if (!Array.isArray(uids) || uids.length === 0) {
        // Nothing in range — still a successful, honest scan.
      } else {
        const window = uids.slice(-maxMessages);
        for await (const message of client.fetch(window, { uid: true, envelope: true, source: true }, { uid: true })) {
          scanned += 1;
          try {
            const parsed = await simpleParser(message.source ?? Buffer.alloc(0));
            const text = (parsed.text || htmlToText(parsed.html || "")).trim();
            if (!text) continue;
            const extracted = await extractSubscriptionFromEmail(text.slice(0, 6000), {
              keys: opts.keys,
              modelId: opts.modelId,
            });
            if (extracted.confidence === "none") continue;
            const envelopeFrom = message.envelope?.from?.[0];
            const fromText = envelopeFrom
              ? envelopeFrom.name && envelopeFrom.address
                ? `${envelopeFrom.name} <${envelopeFrom.address}>`
                : String(envelopeFrom.name || envelopeFrom.address || "")
              : String((parsed.from?.text ?? "").slice(0, 160));
            candidates.push({
              uid: message.uid,
              messageId: message.envelope?.messageId ?? null,
              subject: String(message.envelope?.subject ?? parsed.subject ?? "").slice(0, 200),
              from: fromText,
              date: normalizeEnvelopeDate(message.envelope?.date) ?? normalizeEnvelopeDate(parsed.date ?? null),
              extracted,
              preview: text.slice(0, 200),
              alreadyTracked: false,
            });
          } catch {
            /* one unparseable message never aborts the scan */
          }
        }
      }
    } finally {
      lock.release();
    }
    await client.logout();
  } catch (error) {
    try {
      client.close();
    } catch {
      /* already gone */
    }
    const code = classifyImapError(asyncError ?? error);
    await db
      .update(emailAccounts)
      .set({ lastError: `${code}: ${String((error as Error)?.message ?? error)}`.slice(0, 400), updatedAt: new Date() })
      .where(eq(emailAccounts.id, account.id));
    throw new EmailInboxError(code, `Inbox scan failed (${code}).`);
  }

  // Mark candidates whose subscription is already tracked (by normalized name).
  const existing = await listSubscriptions();
  const known = new Set(existing.map((s) => normalizeName(s.name)).filter(Boolean));
  for (const c of candidates) {
    const n = normalizeName(c.extracted.name);
    c.alreadyTracked = n.length > 0 && known.has(n);
  }

  const [updated] = await db
    .update(emailAccounts)
    .set({ lastScanAt: new Date(), lastScanMessageCount: scanned, lastError: null, updatedAt: new Date() })
    .where(eq(emailAccounts.id, account.id))
    .returning();
  return { scanned, candidates, account: toPublic(updated) };
}

/** One-tap "add as subscription" from a scanned candidate. */
export async function importReceiptCandidate(input: {
  name: string;
  amountCents: number;
  currency: string;
  cadence: Cadence;
  nextCharge: string;
  category?: string;
  notes?: string;
}): Promise<{ id: string }> {
  if (!input.name?.trim()) throw new EmailInboxError("bad_input", "name is required");
  if (!Number.isFinite(input.amountCents) || input.amountCents <= 0) {
    throw new EmailInboxError("bad_input", "amountCents must be positive");
  }
  const sub = await createSubscription({
    name: input.name.trim().slice(0, 60),
    amountCents: Math.round(input.amountCents),
    currency: (input.currency || "USD").toUpperCase().slice(0, 4),
    cadence: input.cadence,
    nextCharge: input.nextCharge,
    category: (input.category ?? "").slice(0, 60),
    notes: (input.notes ?? "Added from email scan").slice(0, 400),
  });
  return { id: sub.id };
}

/** Test-only helper for suite isolation: remove every account. */
export async function clearEmailAccountsForTests(): Promise<void> {
  if (process.env.NODE_ENV === "production") throw new Error("test helper refused in production");
  await db.delete(emailAccounts);
}
