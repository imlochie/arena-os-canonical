import { db } from "@/db";
import { collegeTimetableSlots } from "@/db/college";
import { asc, eq } from "drizzle-orm";
import { guard, refuse } from "@/lib/college/guard";

export const dynamic = "force-dynamic";

// GET → the scheduled intent (what SHOULD be happening).
export async function GET(req: Request) {
  const _g = await guard(req, "read_state");
  if (!_g.ok) return refuse(_g);

  try {
    const rows = await db
      .select()
      .from(collegeTimetableSlots)
      .orderBy(asc(collegeTimetableSlots.dayOfWeek), asc(collegeTimetableSlots.startTime));
    return Response.json({
      slots: rows,
      note: rows.length
        ? undefined
        : "No timetable recorded. The authoritative Semester I day/time mapping was not verified — the College reports UNKNOWN rather than inventing a schedule.",
    });
  } catch (e) {
    console.error(e);
    return Response.json({ slots: [] });
  }
}

// POST → declare a timetable slot. Confidence must be stated honestly so the
// state engine can distinguish an established slot from a provisional one.
export async function POST(req: Request) {
  const _g = await guard(req, "edit_timetable");
  if (!_g.ok) return refuse(_g);

  try {
    const body = await req.json();
    const dayOfWeek = Number(body.dayOfWeek);
    if (!dayOfWeek || dayOfWeek < 1 || dayOfWeek > 7) {
      return Response.json({ error: "dayOfWeek must be 1 (Mon) .. 7 (Sun)" }, { status: 400 });
    }
    const label = String(body.label ?? "").trim();
    if (!label) return Response.json({ error: "label required" }, { status: 400 });
    const allowed = ["known", "inferred", "expected", "unknown", "conflicting"];
    const confidence = allowed.includes(String(body.confidence)) ? String(body.confidence) : "inferred";

    const [row] = await db
      .insert(collegeTimetableSlots)
      .values({
        termId: body.termId ?? null,
        dayOfWeek,
        startTime: String(body.startTime ?? "").slice(0, 10),
        courseId: body.courseId ?? null,
        label: label.slice(0, 200),
        sessionKind: String(body.sessionKind ?? "lesson").slice(0, 40),
        schoolKey: String(body.schoolKey ?? "").slice(0, 60),
        confidence,
        sourceKey: String(body.sourceKey ?? "").slice(0, 80),
        notes: String(body.notes ?? "").slice(0, 1000),
      })
      .returning();
    return Response.json({ slot: row }, { status: 201 });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "slot create failed" }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  const _g = await guard(req, "edit_timetable");
  if (!_g.ok) return refuse(_g);

  try {
    const url = new URL(req.url);
    const id = url.searchParams.get("id");
    if (!id) return Response.json({ error: "id required" }, { status: 400 });
    await db.delete(collegeTimetableSlots).where(eq(collegeTimetableSlots.id, id));
    return Response.json({ ok: true });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "delete failed" }, { status: 500 });
  }
}
