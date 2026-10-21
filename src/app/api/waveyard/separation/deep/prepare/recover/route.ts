/** Recover from an interrupted preparation (e.g. Arena was
 *  restarted mid-run). Clears a stale lock and resets the
 *  lifecycle so the owner can start again honestly. */

import { NextResponse } from "next/server";

import { requireUser } from "@/lib/waveyard/local-context";
import { getPreparationManager } from "@/lib/waveyard/separation/provision-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request?: Request) {
  try {
    await requireUser();
    const body = await request?.json().catch(() => ({}));
    const manager = getPreparationManager(body?.model);
    const result = await manager.recover();
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("deep preparation recover failed", error);
    return NextResponse.json({ error: "The interrupted preparation could not be recovered." }, { status: 500 });
  }
}
