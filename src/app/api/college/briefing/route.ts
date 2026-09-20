// ============================================================================
// LAYER 7 — the arrival briefing.
// ============================================================================
// GET  → the computed briefing. Read-only by construction.
// GET ?format=text → the same briefing rendered for a terminal or a prompt.
//
// There is no POST. Arriving is not an institutional act: the briefing opens
// nothing, closes nothing and files nothing. Beginning a class remains an
// explicit, separate call into the Layer 6 runtime.
// ============================================================================

import { campusBriefing, renderBriefing } from "@/lib/college/campus-briefing";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);

    // `?at=` asks the briefing to resolve AS IF it were a different moment.
    // This is the same discipline as Layer 6's replay: it does not change any
    // record, it re-asks the question against a different clock. It exists so
    // elapsed-time behaviour is demonstrable rather than asserted — "what
    // would you say if I disappeared for three weeks?" is a question the
    // College should be able to answer before it happens.
    const at = url.searchParams.get("at");
    const asOf = at ? new Date(at) : new Date();
    if (at && Number.isNaN(asOf.getTime())) {
      return Response.json(
        { error: `unparseable "at" value: ${at}`, note: "Use an ISO date or datetime." },
        { status: 400 }
      );
    }

    const briefing = await campusBriefing(asOf);

    if (url.searchParams.get("format") === "text") {
      return new Response(renderBriefing(briefing), {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    return Response.json({
      briefing,
      asOf: asOf.toISOString(),
      simulated: Boolean(at),
      note:
        "Computed from recorded institutional state. No model runs here, so the briefing cannot invent an institution that does not exist.",
    });
  } catch (e) {
    return Response.json(
      {
        error: "briefing failed",
        detail: e instanceof Error ? e.message : String(e),
        note:
          "The briefing failed to resolve. It reports the failure rather than presenting a partial picture as if it were complete.",
      },
      { status: 500 }
    );
  }
}
