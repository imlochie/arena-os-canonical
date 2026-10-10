import { NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { foundryAppData, foundryApps } from "@/db/schema";
import { KV_KEY_PATTERN, KV_MAX_KEYS, KV_MAX_TOTAL_BYTES, KV_MAX_VALUE_BYTES } from "@/lib/foundry";

export const dynamic = "force-dynamic";

/**
 * The sandboxed "backend" for Foundry apps — strictly app-scoped KV.
 * The preview iframe cannot reach the network (CSP) or the app's origin
 * (sandbox); it talks postMessage to the parent page, which proxies here.
 * Caps: 64-char keys, 32KB values, 200 keys, 2MB total per app.
 */

async function appExists(appId: string): Promise<boolean> {
  const rows = await db.select({ id: foundryApps.id }).from(foundryApps).where(eq(foundryApps.id, appId)).limit(1);
  return rows.length > 0;
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await appExists(id))) return NextResponse.json({ error: "app not found" }, { status: 404 });
  const key = new URL(req.url).searchParams.get("key");
  if (key !== null) {
    if (!KV_KEY_PATTERN.test(key)) return NextResponse.json({ error: "bad key" }, { status: 400 });
    const [row] = await db
      .select()
      .from(foundryAppData)
      .where(and(eq(foundryAppData.appId, id), eq(foundryAppData.key, key)))
      .limit(1);
    return NextResponse.json({ value: row?.value ?? null });
  }
  const rows = await db
    .select({ key: foundryAppData.key, value: foundryAppData.value })
    .from(foundryAppData)
    .where(eq(foundryAppData.appId, id));
  return NextResponse.json({ keys: rows.map((r) => r.key), entries: rows.length, bytes: rows.reduce((n, r) => n + Buffer.byteLength(r.value), 0) });
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let body: { key?: string; value?: string } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const key = body.key ?? "";
  const value = body.value ?? "";
  if (!KV_KEY_PATTERN.test(key)) return NextResponse.json({ error: "key must match ^[a-zA-Z0-9_.-]{1,64}$" }, { status: 400 });
  if (Buffer.byteLength(value, "utf8") > KV_MAX_VALUE_BYTES)
    return NextResponse.json({ error: `value exceeds ${KV_MAX_VALUE_BYTES} bytes` }, { status: 413 });
  if (!(await appExists(id))) return NextResponse.json({ error: "app not found" }, { status: 404 });

  const totals = await db
    .select({ keys: sql<number>`count(*)::int`, bytes: sql<number>`coalesce(sum(octet_length(value)),0)::int` })
    .from(foundryAppData)
    .where(eq(foundryAppData.appId, id));
  const [row] = await db
    .select({ value: foundryAppData.value })
    .from(foundryAppData)
    .where(and(eq(foundryAppData.appId, id), eq(foundryAppData.key, key)))
    .limit(1);
  const isNew = row === undefined;
  const currentKeys = (totals[0]?.keys ?? 0) + (isNew ? 1 : 0);
  const currentBytes = (totals[0]?.bytes ?? 0) + (isNew ? 0 : -Buffer.byteLength(row.value, "utf8")) + Buffer.byteLength(value, "utf8");
  if (currentKeys > KV_MAX_KEYS) return NextResponse.json({ error: `app storage is capped at ${KV_MAX_KEYS} keys` }, { status: 413 });
  if (currentBytes > KV_MAX_TOTAL_BYTES) return NextResponse.json({ error: `app storage is capped at ${KV_MAX_TOTAL_BYTES} bytes` }, { status: 413 });

  await db
    .insert(foundryAppData)
    .values({ appId: id, key, value })
    .onConflictDoUpdate({ target: [foundryAppData.appId, foundryAppData.key], set: { value, updatedAt: new Date() } });
  return NextResponse.json({ ok: true, keys: currentKeys, bytes: currentBytes });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const key = new URL(req.url).searchParams.get("key");
  if (key === null || !KV_KEY_PATTERN.test(key)) return NextResponse.json({ error: "bad key" }, { status: 400 });
  const removed = await db
    .delete(foundryAppData)
    .where(and(eq(foundryAppData.appId, id), eq(foundryAppData.key, key)))
    .returning({ key: foundryAppData.key });
  return NextResponse.json({ ok: true, removed: removed.length > 0 });
}
