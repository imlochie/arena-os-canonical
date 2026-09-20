import { db } from "@/db";
import { collegeGoalLinks, collegeGoals } from "@/db/college";
import { desc, eq } from "drizzle-orm";
import { guard, refuse } from "@/lib/college/guard";

export const dynamic = "force-dynamic";

// GET → goals as living institutional state (never a productivity score).
export async function GET(req: Request) {
  const _g = await guard(req, "read_state");
  if (!_g.ok) return refuse(_g);

  try {
    const url = new URL(req.url);
    const id = url.searchParams.get("id");
    if (id) {
      const [goal] = await db.select().from(collegeGoals).where(eq(collegeGoals.id, id)).limit(1);
      if (!goal) return Response.json({ error: "not found" }, { status: 404 });
      const links = await db.select().from(collegeGoalLinks).where(eq(collegeGoalLinks.goalId, id));
      return Response.json({ goal, links });
    }
    const rows = await db.select().from(collegeGoals).orderBy(desc(collegeGoals.updatedAt)).limit(100);
    return Response.json({ goals: rows });
  } catch (e) {
    console.error(e);
    return Response.json({ goals: [] });
  }
}

// POST → create a goal with origin and purpose (not a checklist item).
export async function POST(req: Request) {
  const _g = await guard(req, "record_commitment");
  if (!_g.ok) return refuse(_g);

  try {
    const body = await req.json();
    const title = String(body.title ?? "").trim();
    if (!title) return Response.json({ error: "title required" }, { status: 400 });
    const [row] = await db
      .insert(collegeGoals)
      .values({
        title: title.slice(0, 300),
        scope: String(body.scope ?? "student").slice(0, 40),
        origin: String(body.origin ?? "").slice(0, 500),
        purpose: String(body.purpose ?? "").slice(0, 1000),
        timeframe: String(body.timeframe ?? "open").slice(0, 40),
        status: String(body.status ?? "proposed").slice(0, 40),
        progressNote: String(body.progressNote ?? "").slice(0, 2000),
        obstacles: String(body.obstacles ?? "").slice(0, 2000),
        sourceKey: String(body.sourceKey ?? "").slice(0, 80),
      })
      .returning();
    return Response.json({ goal: row }, { status: 201 });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "goal create failed" }, { status: 500 });
  }
}

// PATCH → update status/progress, or link a goal to institutional activity so
// the College can tell which activity serves which goal.
export async function PATCH(req: Request) {
  const _g = await guard(req, "record_commitment");
  if (!_g.ok) return refuse(_g);

  try {
    const body = await req.json();
    const id = String(body.id ?? "");
    if (!id) return Response.json({ error: "id required" }, { status: 400 });

    if (body.action === "link") {
      const [link] = await db
        .insert(collegeGoalLinks)
        .values({
          goalId: id,
          targetType: String(body.targetType ?? "session").slice(0, 40),
          targetId: String(body.targetId ?? "").slice(0, 80),
          relation: String(body.relation ?? "contributes_to").slice(0, 40),
          note: String(body.note ?? "").slice(0, 500),
        })
        .returning();
      return Response.json({ link }, { status: 201 });
    }

    const [existing] = await db.select().from(collegeGoals).where(eq(collegeGoals.id, id)).limit(1);
    if (!existing) return Response.json({ error: "not found" }, { status: 404 });

    const [row] = await db
      .update(collegeGoals)
      .set({
        status: body.status ? String(body.status).slice(0, 40) : existing.status,
        progressNote:
          body.progressNote !== undefined
            ? String(body.progressNote).slice(0, 2000)
            : existing.progressNote,
        obstacles:
          body.obstacles !== undefined ? String(body.obstacles).slice(0, 2000) : existing.obstacles,
        lastReviewedAt: body.reviewed ? new Date() : existing.lastReviewedAt,
        updatedAt: new Date(),
      })
      .where(eq(collegeGoals.id, id))
      .returning();
    return Response.json({ goal: row });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "goal update failed" }, { status: 500 });
  }
}
