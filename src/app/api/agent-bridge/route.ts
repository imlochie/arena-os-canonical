/**
 * Agent bridge — the polling surface for scripts/agent-bridge.mjs.
 *
 * GET  /api/agent-bridge          → heartbeat + take the next queued task
 * POST /api/agent-bridge          → { action: "heartbeat", name? }
 *
 * Auth: when ARENA_INTERNAL_API_KEY is set, requests must carry it in the
 * x-arena-internal-key header. When unset (the local-first default) the
 * bridge is open on the local machine — the same trust model as the rest of
 * the local app (the CSRF proxy gate blocks browser cross-site mutations).
 */

import { NextResponse } from "next/server";

import { bridgeStatus, takeNextTask, touchBridge } from "@/lib/modelHub/agentBridge";

export const dynamic = "force-dynamic";

function authorized(request: Request): boolean {
  const expected = process.env.ARENA_INTERNAL_API_KEY?.trim();
  if (expected === undefined || expected === "") return true; // local-first
  return request.headers.get("x-arena-internal-key") === expected;
}

export async function GET(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Bridge key required." }, { status: 401 });
  }
  const name = new URL(request.url).searchParams.get("name");
  await touchBridge(name?.slice(0, 80) ?? null);
  const task = await takeNextTask();
  return NextResponse.json({ task, status: await bridgeStatus() });
}

export async function POST(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Bridge key required." }, { status: 401 });
  }
  const body = (await request.json().catch(() => ({}))) as { name?: unknown };
  await touchBridge(typeof body.name === "string" ? body.name.slice(0, 80) : null);
  return NextResponse.json({ status: await bridgeStatus() });
}
