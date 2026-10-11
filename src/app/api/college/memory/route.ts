import { db } from "@/db";
import { collegeMemory, collegeMemoryEvidence } from "@/db/college";
import { and, desc, eq, sql } from "drizzle-orm";
import { canPromote, type EpistemicStatus } from "@/lib/college/truth";
import { guard, refuse } from "@/lib/college/guard";

export const dynamic = "force-dynamic";

// GET → educational memory. ?scope= ?status= ?type=
export async function GET(req: Request) {
  const _g = await guard(req, "read_state");
  if (!_g.ok) return refuse(_g);

  try {
    const url = new URL(req.url);
    const scope = url.searchParams.get("scope");
    const status = url.searchParams.get("status");
    const type = url.searchParams.get("type");
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), 300);

    const conds = [eq(collegeMemory.active, true)];
    if (scope) conds.push(eq(collegeMemory.scope, scope));
    if (status) conds.push(eq(collegeMemory.epistemicStatus, status));
    if (type) conds.push(eq(collegeMemory.memoryType, type));

    const rows = await db
      .select()
      .from(collegeMemory)
      .where(and(...conds))
      .orderBy(desc(collegeMemory.updatedAt))
      .limit(limit);
    return Response.json({ memory: rows });
  } catch (e) {
    console.error(e);
    return Response.json({ memory: [] });
  }
}

// POST → record an observation from teaching. Always enters at the lowest
// epistemic rung unless explicitly justified; never auto-promoted to truth.
export async function POST(req: Request) {
  const _g = await guard(req, "institutional_decision");
  if (!_g.ok) return refuse(_g);

  try {
    const body = await req.json();
    const content = String(body.content ?? "").trim();
    if (!content) return Response.json({ error: "content required" }, { status: 400 });

    const requested = String(body.epistemicStatus ?? "observation") as EpistemicStatus;
    // A brand-new entry cannot claim to be established knowledge.
    const status: EpistemicStatus =
      requested === "observation" || requested === "interpretation" ? requested : "observation";

    const [row] = await db
      .insert(collegeMemory)
      .values({
        scope: String(body.scope ?? "teaching").slice(0, 40),
        courseId: body.courseId ?? null,
        sessionId: body.sessionId ?? null,
        epistemicStatus: status,
        memoryType: String(body.memoryType ?? "observation").slice(0, 40),
        content: content.slice(0, 8000),
        corroborationCount: 1,
        authoredBy: String(body.authoredBy ?? "faculty").slice(0, 60),
        truthClass: status === "observation" ? "fact" : "interpretation",
        confidence: String(body.confidence ?? "known").slice(0, 20),
      })
      .returning();

    return Response.json(
      {
        memory: row,
        note:
          requested !== status
            ? `Entered as "${status}". New memory cannot be created directly as "${requested}" — promotion requires corroborating evidence.`
            : undefined,
      },
      { status: 201 }
    );
  } catch (e) {
    console.error(e);
    return Response.json({ error: "memory create failed" }, { status: 500 });
  }
}

// PATCH → corroborate or promote. The institution must be able to explain why
// its teaching approach changed, so promotion is gated and evidence-linked.
export async function PATCH(req: Request) {
  const _g = await guard(req, "institutional_decision");
  if (!_g.ok) return refuse(_g);

  try {
    const body = await req.json();
    const id = String(body.id ?? "");
    if (!id) return Response.json({ error: "id required" }, { status: 400 });
    const [existing] = await db.select().from(collegeMemory).where(eq(collegeMemory.id, id)).limit(1);
    if (!existing) return Response.json({ error: "not found" }, { status: 404 });

    // ---- corroborate: add supporting evidence ----
    if (body.action === "corroborate") {
      const [row] = await db
        .update(collegeMemory)
        .set({
          corroborationCount: existing.corroborationCount + 1,
          updatedAt: new Date(),
        })
        .where(eq(collegeMemory.id, id))
        .returning();
      await db.insert(collegeMemoryEvidence).values({
        memoryId: id,
        evidenceType: String(body.evidenceType ?? "session").slice(0, 40),
        evidenceId: String(body.evidenceId ?? "").slice(0, 80),
        note: String(body.note ?? "").slice(0, 1000),
      });
      const check = canPromote(row.epistemicStatus as EpistemicStatus, row.corroborationCount);
      return Response.json({ memory: row, promotionAvailable: check });
    }

    // ---- promote: move up the epistemic ladder, if evidence allows ----
    if (body.action === "promote") {
      const check = canPromote(
        existing.epistemicStatus as EpistemicStatus,
        existing.corroborationCount
      );
      if (!check.allowed) {
        return Response.json(
          {
            promoted: false,
            reason: check.reason,
            message:
              "Promotion refused. A one-off observation does not become permanent truth automatically.",
          },
          { status: 200 }
        );
      }
      const [row] = await db
        .update(collegeMemory)
        .set({
          epistemicStatus: check.next!,
          truthClass: check.next === "established" ? "fact" : "interpretation",
          updatedAt: new Date(),
        })
        .where(eq(collegeMemory.id, id))
        .returning();
      return Response.json({ promoted: true, memory: row, rationale: check.reason });
    }

    // ---- supersede: revise without destroying the original ----
    if (body.action === "supersede") {
      const newContent = String(body.content ?? "").trim();
      if (!newContent) return Response.json({ error: "content required" }, { status: 400 });
      const [replacement] = await db
        .insert(collegeMemory)
        .values({
          scope: existing.scope,
          courseId: existing.courseId,
          sessionId: existing.sessionId,
          epistemicStatus: "observation",
          memoryType: existing.memoryType,
          content: newContent.slice(0, 8000),
          authoredBy: String(body.authoredBy ?? "faculty").slice(0, 60),
        })
        .returning();
      await db
        .update(collegeMemory)
        .set({ supersededById: replacement.id, active: false, updatedAt: new Date() })
        .where(eq(collegeMemory.id, id));
      return Response.json({ superseded: true, replacement });
    }

    return Response.json({ error: "unknown action" }, { status: 400 });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "memory update failed" }, { status: 500 });
  }
}
