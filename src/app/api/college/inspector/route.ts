// ============================================================================
// GET /api/college/inspector — runtime inspection and session replay
// ============================================================================
// LAYER 6 §35 §36. Read-only by construction: there is no POST here, because
// an inspection that could change something would not be an inspection.
//
//   ?sessionId=…   full reconstruction of one session
//   ?at=<iso>      what the College knew at a moment
//   (no params)    the list of inspectable sessions
// ============================================================================

import { inspectSession, inspectableSessions, knowledgeAsAt } from "@/lib/college/inspector";
import { guard, refuse } from "@/lib/college/guard";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const _g = await guard(req, "read_state");
  if (!_g.ok) return refuse(_g);

  try {
    const url = new URL(req.url);
    const sessionId = url.searchParams.get("sessionId");
    const at = url.searchParams.get("at");

    if (sessionId) {
      const inspection = await inspectSession(sessionId);
      if (!inspection) {
        return Response.json({ error: "session not found" }, { status: 404 });
      }
      return Response.json({ inspection });
    }

    if (at) {
      return Response.json({ knowledge: await knowledgeAsAt(at) });
    }

    return Response.json({
      sessions: await inspectableSessions(30),
      note: "Pass ?sessionId= to reconstruct one session, or ?at=<iso timestamp> to ask what the College knew at a moment.",
    });
  } catch (e) {
    console.error("inspector error", e);
    return Response.json(
      { error: "inspection failed", detail: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
