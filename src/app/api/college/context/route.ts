import { db } from "@/db";
import { collegeContextSignals } from "@/db/college";
import { desc, eq } from "drizzle-orm";
import { guard, refuse } from "@/lib/college/guard";

export const dynamic = "force-dynamic";

// GET → declared real-world conditions currently in effect.
export async function GET(req: Request) {
  const _g = await guard(req, "read_state");
  if (!_g.ok) return refuse(_g);

  try {
    const rows = await db
      .select()
      .from(collegeContextSignals)
      .orderBy(desc(collegeContextSignals.createdAt))
      .limit(100);
    return Response.json({ signals: rows });
  } catch (e) {
    console.error(e);
    return Response.json({ signals: [] });
  }
}

// POST → declare a real-world condition.
// Origin is constrained to declared/recorded: the College reasons from what it
// is told or what is filed. It does not infer hidden conditions, and this is
// contextual reasoning rather than surveillance.
export async function POST(req: Request) {
  const _g = await guard(req, "capture_evidence");
  if (!_g.ok) return refuse(_g);

  try {
    const body = await req.json();
    const content = String(body.content ?? "").trim();
    if (!content) return Response.json({ error: "content required" }, { status: 400 });
    const origin = body.origin === "recorded" ? "recorded" : "declared";
    const [row] = await db
      .insert(collegeContextSignals)
      .values({
        signalType: String(body.signalType ?? "other").slice(0, 40),
        content: content.slice(0, 2000),
        origin,
        effectiveFrom: body.effectiveFrom ?? null,
        effectiveTo: body.effectiveTo ?? null,
        impact: String(body.impact ?? "").slice(0, 1000),
        truthClass: "fact",
        confidence: "known",
      })
      .returning();
    return Response.json({ signal: row }, { status: 201 });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "signal create failed" }, { status: 500 });
  }
}

// PATCH → retire a condition that no longer applies.
export async function PATCH(req: Request) {
  const _g = await guard(req, "capture_evidence");
  if (!_g.ok) return refuse(_g);

  try {
    const body = await req.json();
    const id = String(body.id ?? "");
    if (!id) return Response.json({ error: "id required" }, { status: 400 });
    const [row] = await db
      .update(collegeContextSignals)
      .set({ active: Boolean(body.active) })
      .where(eq(collegeContextSignals.id, id))
      .returning();
    return Response.json({ signal: row });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "update failed" }, { status: 500 });
  }
}
