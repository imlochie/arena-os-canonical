// ============================================================================
// GET /api/college/governance — everything awaiting an institutional decision
// ============================================================================
// LAYER 6 §31.
//
// Read-only. The queue is derived from the records that already hold each
// fact, so there is nothing here to create or mutate. Acting on an item means
// going to the surface that owns it — the curriculum editor, the decisions
// endpoint, the timetable — where the act is explicit and recorded.
// ============================================================================

import { governanceQueue } from "@/lib/college/governance";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const kind = url.searchParams.get("kind");
    const queue = await governanceQueue();

    const items = kind ? queue.items.filter((i) => i.kind === kind) : queue.items;

    return Response.json({
      items,
      byKind: queue.byKind,
      total: queue.items.length,
      actionable: queue.items.filter((i) => !i.informationalOnly).length,
      informational: queue.items.filter((i) => i.informationalOnly).length,
      note: queue.note,
    });
  } catch (e) {
    console.error("governance error", e);
    return Response.json(
      { error: "governance queue failed", detail: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
