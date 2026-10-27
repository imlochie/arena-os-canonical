import { db } from "@/db";
import { collegeDeviations } from "@/db/college";
import { desc, eq } from "drizzle-orm";
import { guard, refuse } from "@/lib/college/guard";

export const dynamic = "force-dynamic";

// GET → timetable-vs-reality deviations.
export async function GET(req: Request) {
  const _g = await guard(req, "read_state");
  if (!_g.ok) return refuse(_g);

  try {
    const url = new URL(req.url);
    const resolution = url.searchParams.get("resolution");
    const base = db.select().from(collegeDeviations);
    const rows = resolution
      ? await base.where(eq(collegeDeviations.resolution, resolution)).orderBy(desc(collegeDeviations.createdAt)).limit(100)
      : await base.orderBy(desc(collegeDeviations.createdAt)).limit(100);
    return Response.json({ deviations: rows });
  } catch (e) {
    console.error(e);
    return Response.json({ deviations: [] });
  }
}

// POST → record a difference between scheduled and observed reality.
// Recording a deviation does NOT decide the institutional response and does
// NOT mark the timetable wrong. Adjustment is a separate, explicit act.
export async function POST(req: Request) {
  const _g = await guard(req, "capture_evidence");
  if (!_g.ok) return refuse(_g);

  try {
    const body = await req.json();
    const scheduledState = String(body.scheduledState ?? "").trim();
    const observedState = String(body.observedState ?? "").trim();
    if (!scheduledState || !observedState) {
      return Response.json(
        { error: "both scheduledState and observedState are required — a deviation is a comparison" },
        { status: 400 }
      );
    }
    const [row] = await db
      .insert(collegeDeviations)
      .values({
        termId: body.termId ?? null,
        weekIndex: body.weekIndex ?? null,
        sessionId: body.sessionId ?? null,
        slotId: body.slotId ?? null,
        deviationType: String(body.deviationType ?? "other").slice(0, 40),
        scheduledState: scheduledState.slice(0, 2000),
        observedState: observedState.slice(0, 2000),
        adjustedState: "",
        resolution: "open",
        sourceKey: String(body.sourceKey ?? "").slice(0, 80),
      })
      .returning();
    return Response.json(
      {
        deviation: row,
        note: "Recorded as an open difference. No institutional response has been decided — adjustment requires an explicit decision.",
      },
      { status: 201 }
    );
  } catch (e) {
    console.error(e);
    return Response.json({ error: "deviation create failed" }, { status: 500 });
  }
}

// PATCH → decide the institutional response (the "therefore Z" step).
// Requires a decision basis: the system never invents the response itself.
export async function PATCH(req: Request) {
  const _g = await guard(req, "capture_evidence");
  if (!_g.ok) return refuse(_g);

  try {
    const body = await req.json();
    const id = String(body.id ?? "");
    if (!id) return Response.json({ error: "id required" }, { status: 400 });
    const adjustedState = String(body.adjustedState ?? "").trim();
    const decisionBasis = String(body.decisionBasis ?? "").trim();
    const resolution = String(body.resolution ?? "adjusted");

    if (resolution === "adjusted" && (!adjustedState || !decisionBasis)) {
      return Response.json(
        {
          error:
            "adjustedState and decisionBasis are required to adjust — the institution does not apply a response without a stated rule or decision",
        },
        { status: 400 }
      );
    }

    const [row] = await db
      .update(collegeDeviations)
      .set({
        adjustedState: adjustedState.slice(0, 2000),
        decisionBasis: decisionBasis.slice(0, 1000),
        decidedBy: String(body.decidedBy ?? "founder").slice(0, 80),
        resolution,
        truthClass: "decision",
        updatedAt: new Date(),
      })
      .where(eq(collegeDeviations.id, id))
      .returning();
    return Response.json({ deviation: row });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "deviation update failed" }, { status: 500 });
  }
}
