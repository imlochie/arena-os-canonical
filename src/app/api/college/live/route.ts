// ============================================================================
// GET /api/college/live — what the College is doing right now
// ============================================================================
// LAYER 6 §24. Read-only.
//
// ?format=text returns the printed form from the brief.
// ============================================================================

import { liveCollegeState, renderLiveState } from "@/lib/college/live-state";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const state = await liveCollegeState();
    if (new URL(req.url).searchParams.get("format") === "text") {
      return new Response(renderLiveState(state), {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    return Response.json({ state, rendered: renderLiveState(state) });
  } catch (e) {
    console.error("live state error", e);
    return Response.json(
      { error: "live state failed", detail: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
