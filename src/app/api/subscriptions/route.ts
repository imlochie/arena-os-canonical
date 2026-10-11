import { NextResponse } from "next/server";

import {
  computeStats,
  createSubscription,
  deleteSubscription,
  extractSubscriptionFromEmail,
  isCadence,
  listSubscriptions,
  normalizeDate,
  parseAmountCents,
  rollForward,
  updateSubscription,
} from "@/lib/subscriptions";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** GET → list + stats (monthly/yearly totals, next-30-days forecast). */
export async function GET() {
  try {
    const rows = await listSubscriptions();
    const rolled = rows.map((r) => ({ ...r, nextCharge: rollForward(r.nextCharge, r.cadence) }));
    return NextResponse.json({ subscriptions: rolled, stats: computeStats(rolled) });
  } catch {
    return NextResponse.json({ subscriptions: [], stats: { activeCount: 0, monthlyCents: 0, yearlyCents: 0, upcoming: [] }, error: "database unavailable" });
  }
}

/**
 * POST {action}:
 *   create  {name, amount, currency?, cadence, nextCharge, category?, notes?}
 *   update  {id, ...patch}
 *   delete  {id}
 *   extract {emailText, keys?} — the Mailopoly hook: paste a receipt → fields
 */
export async function POST(req: Request) {
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const action = String(body.action ?? "");

  if (action === "extract") {
    const emailText = String(body.emailText ?? "");
    if (!emailText.trim()) return NextResponse.json({ error: "emailText is required" }, { status: 400 });
    const extracted = await extractSubscriptionFromEmail(emailText, { keys: body.keys as Record<string, string> | undefined });
    return NextResponse.json({ extracted });
  }

  try {
    if (action === "create") {
      const amountCents = parseAmountCents(String(body.amount ?? ""));
      const nextCharge = normalizeDate(String(body.nextCharge ?? ""));
      const cadence = String(body.cadence ?? "monthly");
      if (!String(body.name ?? "").trim()) return NextResponse.json({ error: "name is required" }, { status: 400 });
      if (amountCents === null) return NextResponse.json({ error: "amount must look like a price (e.g. 12.99)" }, { status: 400 });
      if (!nextCharge) return NextResponse.json({ error: "nextCharge must be a date (YYYY-MM-DD)" }, { status: 400 });
      if (!isCadence(cadence)) return NextResponse.json({ error: "cadence must be weekly|monthly|quarterly|yearly" }, { status: 400 });
      const created = await createSubscription({
        name: String(body.name),
        amountCents,
        currency: body.currency ? String(body.currency) : undefined,
        cadence,
        nextCharge,
        category: body.category ? String(body.category) : undefined,
        notes: body.notes ? String(body.notes) : undefined,
      });
      return NextResponse.json({ subscription: created }, { status: 201 });
    }

    if (action === "update") {
      if (!body.id) return NextResponse.json({ error: "id is required" }, { status: 400 });
      const patch: Parameters<typeof updateSubscription>[1] = {};
      if (body.name !== undefined) patch.name = String(body.name);
      if (body.amount !== undefined) {
        const cents = parseAmountCents(String(body.amount));
        if (cents === null) return NextResponse.json({ error: "bad amount" }, { status: 400 });
        patch.amountCents = cents;
      }
      if (body.cadence !== undefined && isCadence(String(body.cadence))) patch.cadence = String(body.cadence) as never;
      if (body.nextCharge !== undefined) {
        const date = normalizeDate(String(body.nextCharge));
        if (!date) return NextResponse.json({ error: "bad date" }, { status: 400 });
        patch.nextCharge = date;
      }
      if (body.category !== undefined) patch.category = String(body.category);
      if (body.notes !== undefined) patch.notes = String(body.notes);
      if (body.active !== undefined) patch.active = Boolean(body.active);
      const updated = await updateSubscription(String(body.id), patch);
      if (!updated) return NextResponse.json({ error: "not found" }, { status: 404 });
      return NextResponse.json({ subscription: updated });
    }

    if (action === "delete") {
      if (!body.id) return NextResponse.json({ error: "id is required" }, { status: 400 });
      return NextResponse.json({ removed: await deleteSubscription(String(body.id)) });
    }
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "failed" }, { status: 500 });
  }

  return NextResponse.json({ error: "unknown action (create|update|delete|extract)" }, { status: 400 });
}
