/** Cancel a running preparation. Cancelling is safe by design:
 *  no pointer is published until the engine is verified, so a
 *  cancelled run can never leave Arena reporting a usable engine
 *  it does not have. */

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
    const cancelled = await manager.cancel();
    return NextResponse.json({ cancelled }, { status: cancelled ? 200 : 409 });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("deep preparation cancel failed", error);
    return NextResponse.json({ error: "Preparation could not be cancelled." }, { status: 500 });
  }
}
