/**
 * Subscriptions — the Bobby dupe: an offline, private recurring-cost tracker.
 * No accounts, no bank connections (Bobby's exact pitch), unlimited entries
 * (Bobby's paid tier), categories, multi-currency, and the Mailopoly hook:
 * paste a receipt/invoice email and the app's models extract the subscription
 * (name, amount, cadence, next charge) for one-tap saving.
 */

import { asc, eq } from "drizzle-orm";

import { db } from "@/db";
import { subscriptions } from "@/db/schema";
import { generate } from "@/lib/ai";

export type Cadence = "weekly" | "monthly" | "quarterly" | "yearly";
export const CADENCES: Cadence[] = ["weekly", "monthly", "quarterly", "yearly"];

export type Subscription = {
  id: string;
  name: string;
  amountCents: number;
  currency: string;
  cadence: Cadence;
  nextCharge: string; // yyyy-mm-dd
  category: string;
  notes: string;
  active: boolean;
};

const CADENCE_DAYS: Record<Cadence, number> = { weekly: 7, monthly: 30, quarterly: 91, yearly: 365 };
const CADENCE_PER_MONTH: Record<Cadence, number> = { weekly: 52 / 12, monthly: 1, quarterly: 1 / 3, yearly: 1 / 12 };

export function isCadence(value: string): value is Cadence {
  return (CADENCES as string[]).includes(value);
}

export function parseAmountCents(raw: string | number): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) && raw >= 0 ? Math.round(raw * 100) : null;
  const match = String(raw).replace(/,/g, "").match(/(?:[$€£¥]|sgd|aud|usd)?\s*(\d+(?:\.\d{1,2})?)/i);
  if (!match) return null;
  const cents = Math.round(parseFloat(match[1]) * 100);
  return Number.isFinite(cents) && cents >= 0 && cents <= 100_000_00 ? cents : null;
}

export function monthlyEquivalentCents(amountCents: number, cadence: Cadence): number {
  return Math.round(amountCents * CADENCE_PER_MONTH[cadence]);
}

export function normalizeDate(raw: string): string | null {
  const trimmed = String(raw).trim();
  const iso = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const date = new Date(`${trimmed}T00:00:00Z`);
    return Number.isNaN(date.getTime()) ? null : trimmed;
  }
  // Common email formats: "12 Oct 2026", "Oct 12, 2026", "12/10/2026".
  const parsed = new Date(trimmed);
  if (!Number.isNaN(parsed.getTime()) && parsed.getFullYear() > 2000) {
    return parsed.toISOString().slice(0, 10);
  }
  return null;
}

/** Roll a past next-charge forward until it is in the future. */
export function rollForward(dateIso: string, cadence: Cadence, now = new Date()): string {
  let date = new Date(`${dateIso}T00:00:00Z`);
  const horizon = new Date(now.getTime() + CADENCE_DAYS[cadence] * 86_400_000);
  let guard = 0;
  while (date < now && guard < 600) {
    if (cadence === "monthly") date = new Date(date.setUTCMonth(date.getUTCMonth() + 1));
    else if (cadence === "quarterly") date = new Date(date.setUTCMonth(date.getUTCMonth() + 3));
    else if (cadence === "yearly") date = new Date(date.setUTCFullYear(date.getUTCFullYear() + 1));
    else date = new Date(date.getTime() + 7 * 86_400_000);
    guard += 1;
  }
  if (date > horizon) return dateIso; // something is off; keep the stored value honestly
  return date.toISOString().slice(0, 10);
}

export function daysUntil(dateIso: string, now = new Date()): number {
  const target = new Date(`${dateIso}T00:00:00Z`).getTime();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).getTime();
  return Math.round((target - today) / 86_400_000);
}

export type SubscriptionStats = {
  activeCount: number;
  monthlyCents: number;
  yearlyCents: number;
  upcoming: { id: string; name: string; amountCents: number; currency: string; nextCharge: string; daysAway: number }[];
};

export function computeStats(rows: Subscription[], now = new Date()): SubscriptionStats {
  const active = rows.filter((r) => r.active);
  const monthly = active.reduce((sum, r) => sum + monthlyEquivalentCents(r.amountCents, r.cadence), 0);
  const upcoming = active
    .map((r) => ({ id: r.id, name: r.name, amountCents: r.amountCents, currency: r.currency, nextCharge: r.nextCharge, daysAway: daysUntil(r.nextCharge, now) }))
    .filter((r) => r.daysAway <= 30)
    .sort((a, b) => a.daysAway - b.daysAway);
  return { activeCount: active.length, monthlyCents: monthly, yearlyCents: monthly * 12, upcoming };
}

function toSubscription(row: typeof subscriptions.$inferSelect): Subscription {
  return {
    id: row.id,
    name: row.name,
    amountCents: row.amountCents,
    currency: row.currency,
    cadence: (isCadence(row.cadence) ? row.cadence : "monthly"),
    nextCharge: row.nextCharge,
    category: row.category,
    notes: row.notes,
    active: row.active,
  };
}

export async function listSubscriptions(): Promise<Subscription[]> {
  const rows = await db.select().from(subscriptions).orderBy(asc(subscriptions.nextCharge));
  return rows.map(toSubscription);
}

export async function createSubscription(input: {
  name: string;
  amountCents: number;
  currency?: string;
  cadence: Cadence;
  nextCharge: string;
  category?: string;
  notes?: string;
}): Promise<Subscription> {
  const [row] = await db
    .insert(subscriptions)
    .values({
      name: input.name.trim().slice(0, 120),
      amountCents: Math.max(0, Math.round(input.amountCents)),
      currency: (input.currency ?? "USD").trim().toUpperCase().slice(0, 4) || "USD",
      cadence: input.cadence,
      nextCharge: input.nextCharge,
      category: (input.category ?? "").trim().slice(0, 40),
      notes: (input.notes ?? "").trim().slice(0, 500),
    })
    .returning();
  return toSubscription(row);
}

export async function updateSubscription(
  id: string,
  patch: { active?: boolean; amountCents?: number; cadence?: Cadence; nextCharge?: string; category?: string; notes?: string; name?: string },
): Promise<Subscription | null> {
  const [row] = await db
    .update(subscriptions)
    .set({
      ...(patch.name !== undefined ? { name: patch.name.trim().slice(0, 120) } : {}),
      ...(patch.amountCents !== undefined ? { amountCents: Math.max(0, Math.round(patch.amountCents)) } : {}),
      ...(patch.cadence !== undefined ? { cadence: patch.cadence } : {}),
      ...(patch.nextCharge !== undefined ? { nextCharge: patch.nextCharge } : {}),
      ...(patch.category !== undefined ? { category: patch.category.trim().slice(0, 40) } : {}),
      ...(patch.notes !== undefined ? { notes: patch.notes.trim().slice(0, 500) } : {}),
      ...(patch.active !== undefined ? { active: patch.active } : {}),
      updatedAt: new Date(),
    })
    .where(eq(subscriptions.id, id))
    .returning();
  return row ? toSubscription(row) : null;
}

export async function deleteSubscription(id: string): Promise<boolean> {
  const removed = await db.delete(subscriptions).where(eq(subscriptions.id, id)).returning({ id: subscriptions.id });
  return removed.length > 0;
}

// ------------------------------------------------- Mailopoly hook: extraction

export type ExtractedSubscription = {
  name: string;
  amountCents: number;
  currency: string;
  cadence: Cadence;
  nextCharge: string;
  confidence: "model" | "regex" | "none";
};

/** Deterministic floor: find "$X.XX" + cadence words in a receipt email. */
export function regexExtract(text: string): ExtractedSubscription | null {
  const amount = text.match(/(?:USD|\$|SGD|AUD|€|£)\s?(\d{1,4}(?:\.\d{1,2})?)/i) ?? text.match(/(\d{1,4}(?:\.\d{1,2})?)\s?(?:USD|SGD|AUD)/i);
  if (!amount) return null;
  const cents = parseAmountCents(amount[1]);
  if (cents === null) return null;
  const cadence: Cadence = /annual|yearly|per year|12 month/i.test(text)
    ? "yearly"
    : /quarter/i.test(text)
      ? "quarterly"
      : /week/i.test(text)
        ? "weekly"
        : "monthly";
  const dateMatch =
    text.match(/\b(\d{4}-\d{2}-\d{2})\b/) ??
    text.match(/\b(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4})\b/i) ??
    text.match(/\b((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4})\b/i);
  const nextCharge = dateMatch ? normalizeDate(dateMatch[1]) : null;
  if (!nextCharge) return null;
  const nameGuess =
    text.match(/(?:receipt|invoice|subscription|payment)\s*(?:for|from|:)\s*([A-Za-z0-9 .&'-]{2,40})/i)?.[1]?.trim() ??
    text.match(/your\s+([A-Za-z0-9 .&'-]{2,40}?)\s+(?:subscription|membership|plan)\b/i)?.[1]?.trim();
  return {
    name: nameGuess?.slice(0, 60) || "Extracted subscription",
    amountCents: cents,
    currency: /\$/.test(amount[0]) && /SGD/i.test(text) ? "SGD" : /SGD/i.test(amount[0]) ? "SGD" : /AUD/i.test(text) ? "AUD" : "USD",
    cadence,
    nextCharge,
    confidence: "regex",
  };
}

/** Paste a receipt/invoice email → subscription fields (model → regex → honest null). */
export async function extractSubscriptionFromEmail(
  emailText: string,
  opts: { keys?: Record<string, string>; modelId?: string } = {},
): Promise<ExtractedSubscription | { confidence: "none"; reason: string }> {
  const clipped = emailText.slice(0, 6000);
  const result = await generate({
    modelId: opts.modelId ?? "local-engine",
    messages: [
      {
        role: "user",
        content:
          `This is a receipt/subscription email. Extract the subscription as JSON:\n` +
          `{"name": "...", "amount": 12.34, "currency": "USD|SGD|AUD|EUR|GBP", "cadence": "weekly|monthly|quarterly|yearly", "next_charge": "YYYY-MM-DD"}\n` +
          `Use the NEXT billing date if present, else the next occurrence of the cadence. Reply with ONLY the JSON.\n\nEMAIL:\n${clipped}`,
      },
    ],
    keys: opts.keys as never,
    temperature: 0.2,
  });
  const fence = result.text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1] : result.text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>;
      const amountCents = parseAmountCents(String(parsed.amount ?? ""));
      const nextCharge = normalizeDate(String(parsed.next_charge ?? ""));
      const cadenceRaw = String(parsed.cadence ?? "monthly").toLowerCase();
      if (parsed.name && amountCents !== null && nextCharge && isCadence(cadenceRaw)) {
        return {
          name: String(parsed.name).slice(0, 60),
          amountCents,
          currency: String(parsed.currency ?? "USD").toUpperCase().slice(0, 4),
          cadence: cadenceRaw,
          nextCharge,
          confidence: "model",
        };
      }
    } catch {
      /* fall through */
    }
  }
  const fallback = regexExtract(clipped);
  if (fallback) return fallback;
  return { confidence: "none", reason: "could not find a subscription in that text — fill the form manually" };
}
