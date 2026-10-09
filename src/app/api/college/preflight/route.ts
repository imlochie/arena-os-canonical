// ============================================================================
// GET /api/college/preflight — can this class begin, and on what footing?
// ============================================================================
// LAYER 6 §2. Runs the full resolution chain WITHOUT creating a session.
//
// This is deliberately a GET with no side effects. Checking whether a class
// can start must never itself start one, and must never write to the ledger —
// a preflight that leaves traces would corrupt the record of what actually
// happened.
// ============================================================================

import { preflightClass, renderPreflight } from "@/lib/college/class-runtime";
import { guard, refuse } from "@/lib/college/guard";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const _g = await guard(req, "read_state");
  if (!_g.ok) return refuse(_g);

  try {
    const url = new URL(req.url);
    const preflight = await preflightClass({
      courseId: url.searchParams.get("courseId"),
      slotId: url.searchParams.get("slotId"),
      sessionKind: url.searchParams.get("sessionKind") ?? "lesson",
      weekIndex: url.searchParams.get("weekIndex")
        ? Number(url.searchParams.get("weekIndex"))
        : null,
      atIso: url.searchParams.get("at") ?? undefined,
    });

    // ?format=text returns the printed form from the brief.
    if (url.searchParams.get("format") === "text") {
      return new Response(renderPreflight(preflight), {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    return Response.json({
      preflight,
      rendered: renderPreflight(preflight),
      note: "This is a read-only check. No session was created and nothing was recorded.",
    });
  } catch (e) {
    console.error("preflight error", e);
    return Response.json(
      { error: "preflight failed", detail: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
