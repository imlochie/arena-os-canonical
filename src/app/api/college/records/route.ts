import { db } from "@/db";
import { collegeRecords } from "@/db/college";
import { desc, eq } from "drizzle-orm";
import {
  assessRecordWorthiness,
  fileRecord,
  proposeRecord,
} from "@/lib/college/registrar";
import { guard, refuse } from "@/lib/college/guard";

export const dynamic = "force-dynamic";

// GET → institutional record. ?status=filed|proposed|superseded
export async function GET(req: Request) {
  const _g = await guard(req, "read_state");
  if (!_g.ok) return refuse(_g);

  try {
    const url = new URL(req.url);
    const status = url.searchParams.get("status");
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);
    const base = db.select().from(collegeRecords);
    const rows = status
      ? await base.where(eq(collegeRecords.status, status)).orderBy(desc(collegeRecords.recordedAt)).limit(limit)
      : await base.orderBy(desc(collegeRecords.recordedAt)).limit(limit);
    return Response.json({ records: rows });
  } catch (e) {
    console.error(e);
    return Response.json({ records: [] });
  }
}

// POST → Registrar proposes a record (never files it).
// Record-worthiness is tested first: routine working material is refused.
export async function POST(req: Request) {
  const _g = await guard(req, "institutional_decision");
  if (!_g.ok) return refuse(_g);

  try {
    const body = await req.json();
    const subject = String(body.subject ?? "").trim();
    const content = String(body.content ?? "").trim();
    if (!subject) return Response.json({ error: "subject required" }, { status: 400 });

    const worthiness = assessRecordWorthiness({
      recordType: body.recordType,
      subject,
      content,
      producedMilestone: Boolean(body.producedMilestone),
      producedDecision: Boolean(body.producedDecision),
      producedDiscovery: Boolean(body.producedDiscovery),
      changedCurriculum: Boolean(body.changedCurriculum),
      changedGoal: Boolean(body.changedGoal),
      changedTeachingStrategy: Boolean(body.changedTeachingStrategy),
      isCorrection: Boolean(body.supersedesId),
      sessionCompleted: Boolean(body.sessionCompleted),
    });

    if (!worthiness.recordWorthy && !body.force) {
      return Response.json(
        {
          proposed: false,
          worthiness,
          message:
            "Not recorded. The Registrar does not file routine working material into institutional history.",
        },
        { status: 200 }
      );
    }

    const provenance = String(body.provenance ?? "").trim();
    if (!provenance) {
      return Response.json(
        { error: "provenance required — a record without provenance is not a record" },
        { status: 400 }
      );
    }

    const record = await proposeRecord({
      recordType: body.recordType ?? worthiness.suggestedType ?? "session_record",
      subject,
      content,
      occurredOn: body.occurredOn ?? null,
      termId: body.termId ?? null,
      weekIndex: body.weekIndex ?? null,
      courseId: body.courseId ?? null,
      sourceSessionId: body.sourceSessionId ?? null,
      authoringFaculty: body.authoringFaculty ?? "registrar",
      provenance,
      truthClass: body.truthClass,
      confidence: body.confidence,
      supersedesId: body.supersedesId ?? null,
      correctionReason: body.correctionReason,
    });

    return Response.json({ proposed: true, worthiness, record }, { status: 201 });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "propose failed" }, { status: 500 });
  }
}

// PATCH → file a proposed record. This is the institutional act.
export async function PATCH(req: Request) {
  const _g = await guard(req, "institutional_decision");
  if (!_g.ok) return refuse(_g);

  try {
    const body = await req.json();
    const id = String(body.id ?? "");
    if (!id) return Response.json({ error: "id required" }, { status: 400 });
    if (body.action !== "file") {
      return Response.json(
        { error: "only action=file is supported; records are never edited in place" },
        { status: 400 }
      );
    }
    const result = await fileRecord(id);
    if (!result.ok) return Response.json({ error: result.error }, { status: 400 });
    return Response.json({ ok: true, record: result.record });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "file failed" }, { status: 500 });
  }
}
