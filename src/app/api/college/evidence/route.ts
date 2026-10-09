import { db } from "@/db";
import { collegeFormativeEvidence } from "@/db/college";
import { desc, eq } from "drizzle-orm";
import { recordFormativeEvidence } from "@/lib/college/teaching";
import { guard, refuse } from "@/lib/college/guard";

export const dynamic = "force-dynamic";

// GET → formative evidence. Never formal attainment.
export async function GET(req: Request) {
  const _g = await guard(req, "read_state");
  if (!_g.ok) return refuse(_g);

  try {
    const url = new URL(req.url);
    const sessionId = url.searchParams.get("sessionId");
    const base = db.select().from(collegeFormativeEvidence);
    const rows = sessionId
      ? await base
          .where(eq(collegeFormativeEvidence.sessionId, sessionId))
          .orderBy(desc(collegeFormativeEvidence.createdAt))
      : await base.orderBy(desc(collegeFormativeEvidence.createdAt)).limit(100);
    return Response.json({
      evidence: rows,
      note: "Formative observations only. None of these constitutes a formal assessment of attainment.",
    });
  } catch (e) {
    console.error(e);
    return Response.json({ evidence: [] });
  }
}

// POST → record a formative observation about learning.
export async function POST(req: Request) {
  const _g = await guard(req, "capture_evidence");
  if (!_g.ok) return refuse(_g);

  try {
    const body = await req.json();
    const content = String(body.content ?? "").trim();
    if (!content) return Response.json({ error: "content required" }, { status: 400 });

    // Guard the boundary the founder drew: formative ≠ formal.
    if (body.assessmentKind === "formal" || body.formal === true) {
      return Response.json(
        {
          error:
            "Formal assessment is not available. Faculty may record formative observations; declaring a learning outcome officially achieved requires institutional authority the College has not yet defined.",
        },
        { status: 403 }
      );
    }

    const r = await recordFormativeEvidence({
      sessionId: body.sessionId ?? null,
      courseId: body.courseId ?? null,
      weekIndex: body.weekIndex ?? null,
      positionKey: String(body.positionKey ?? "instructor"),
      evidenceType: String(body.evidenceType ?? "demonstrated_understanding"),
      content,
      capabilityKey: body.capabilityKey,
    });
    if (!r.ok) return Response.json({ error: r.error }, { status: 403 });
    return Response.json({ evidence: r.evidence }, { status: 201 });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "evidence create failed" }, { status: 500 });
  }
}
