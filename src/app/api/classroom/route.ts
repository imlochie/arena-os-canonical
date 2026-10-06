import { getClassroomState, localDateStr } from "@/lib/classroom";

export const dynamic = "force-dynamic";

// GET → the institutional state for a date (default: today, local).
// ?date=YYYY-MM-DD lets the owner browse/simulate any day of the semester.
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const dateParam = url.searchParams.get("date");
    const date = /^\d{4}-\d{2}-\d{2}$/.test(dateParam ?? "") ? dateParam! : localDateStr();
    const state = await getClassroomState(date);
    return Response.json(state);
  } catch (e) {
    console.error(e);
    return Response.json({ error: "failed to resolve classroom state" }, { status: 500 });
  }
}

// DELETE → remove a date's occurrence (+ its educational memory).
// ?date=YYYY-MM-DD (the collaboration itself is kept as a record).
export async function DELETE(req: Request) {
  try {
    const url = new URL(req.url);
    const dateParam = url.searchParams.get("date");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateParam ?? "")) {
      return Response.json({ error: "?date=YYYY-MM-DD is required" }, { status: 400 });
    }
    const { deleteOccurrence } = await import("@/lib/classroom");
    const ok = await deleteOccurrence(dateParam!);
    if (!ok) return Response.json({ error: "no occurrence for that date" }, { status: 404 });
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "failed" }, { status: 400 });
  }
}
