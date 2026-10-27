// ============================================================================
// LAYER 7 — the external academic world (TAFE and similar).
// ============================================================================
// GET  → what the College has been told, with evidence levels attached.
// POST → record or update an external commitment.
//
// The College does not own this data and does not verify it. Recording a TAFE
// deadline is an act of AWARENESS, not an academic judgement: Arena notes what
// it was told and by whom, and the provider remains the authority on whether
// the work is done, late, passed or failed.
// ============================================================================

import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { collegeExternalCommitments } from "@/db/college";
import { externalAcademicPicture } from "@/lib/college/external-academic";
import * as ledger from "@/lib/college/ledger";
import { brisbaneToday } from "@/lib/college/time";
import { guard, refuse } from "@/lib/college/guard";

const TYPES = ["course", "unit", "assessment", "placement", "exam", "class", "admin"];
const STATUSES = ["active", "upcoming", "completed", "withdrawn", "unknown"];
const EVIDENCE = ["reported", "documented", "verified"];

export async function GET(req: Request) {
  const _g = await guard(req, "read_state");
  if (!_g.ok) return refuse(_g);

  try {
    const picture = await externalAcademicPicture();
    return Response.json(picture);
  } catch (e) {
    return Response.json(
      { error: "external read failed", detail: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  const _g = await guard(req, "record_external");
  if (!_g.ok) return refuse(_g);

  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action ?? "record");

    // ---- update an existing commitment -----------------------------------
    if (action === "update") {
      const id = String(body.id ?? "");
      if (!id) return Response.json({ error: "id required" }, { status: 400 });

      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (body.progressState !== undefined) patch.progressState = String(body.progressState);
      if (body.status !== undefined) {
        const st = String(body.status);
        if (!STATUSES.includes(st)) {
          return Response.json({ error: `status must be one of ${STATUSES.join(", ")}` }, { status: 400 });
        }
        patch.status = st;
      }
      if (body.dueOn !== undefined) patch.dueOn = body.dueOn ? String(body.dueOn) : null;
      if (body.notes !== undefined) patch.notes = String(body.notes);
      if (body.evidenceLevel !== undefined) {
        const ev = String(body.evidenceLevel);
        if (!EVIDENCE.includes(ev)) {
          return Response.json({ error: `evidenceLevel must be one of ${EVIDENCE.join(", ")}` }, { status: 400 });
        }
        patch.evidenceLevel = ev;
      }
      if (body.confirmed === true) patch.lastConfirmedAt = new Date();

      const [row] = await db
        .update(collegeExternalCommitments)
        .set(patch)
        .where(eq(collegeExternalCommitments.id, id))
        .returning();

      if (!row) return Response.json({ error: "commitment not found" }, { status: 404 });

      await ledger.record({
        eventType: "external_academic_event",
        summary: `${row.provider} — ${row.title}: updated.`,
        detail: { commitmentId: row.id, status: row.status, progressState: row.progressState },
        actor: "founder",
      });

      return Response.json({
        commitment: row,
        note:
          "Updated from what the College was told. The provider remains the authority; Arena has not verified this.",
      });
    }

    // ---- archive (never hard-delete a commitment that shaped a briefing) --
    if (action === "archive") {
      const id = String(body.id ?? "");
      if (!id) return Response.json({ error: "id required" }, { status: 400 });
      const [row] = await db
        .update(collegeExternalCommitments)
        .set({ active: false, updatedAt: new Date() })
        .where(eq(collegeExternalCommitments.id, id))
        .returning();
      if (!row) return Response.json({ error: "commitment not found" }, { status: 404 });
      return Response.json({
        commitment: row,
        note:
          "Archived, not deleted. It may already have shaped a briefing, and that history stays intact.",
      });
    }

    // ---- record a new commitment -----------------------------------------
    const provider = String(body.provider ?? "").trim();
    const title = String(body.title ?? "").trim();
    if (!provider || !title) {
      return Response.json({ error: "provider and title are required" }, { status: 400 });
    }

    const commitmentType = String(body.commitmentType ?? "course");
    if (!TYPES.includes(commitmentType)) {
      return Response.json({ error: `commitmentType must be one of ${TYPES.join(", ")}` }, { status: 400 });
    }
    const status = String(body.status ?? "active");
    if (!STATUSES.includes(status)) {
      return Response.json({ error: `status must be one of ${STATUSES.join(", ")}` }, { status: 400 });
    }
    const evidenceLevel = String(body.evidenceLevel ?? "reported");
    if (!EVIDENCE.includes(evidenceLevel)) {
      return Response.json({ error: `evidenceLevel must be one of ${EVIDENCE.join(", ")}` }, { status: 400 });
    }

    const sourceNote = String(body.sourceNote ?? "").trim();
    if (!sourceNote) {
      return Response.json(
        {
          error: "sourceNote required",
          note:
            "The College records who told it. An external fact with no stated source becomes indistinguishable from an assumption.",
        },
        { status: 400 }
      );
    }

    const [row] = await db
      .insert(collegeExternalCommitments)
      .values({
        provider,
        title,
        commitmentType,
        progressState: String(body.progressState ?? ""),
        startsOn: body.startsOn ? String(body.startsOn) : null,
        dueOn: body.dueOn ? String(body.dueOn) : null,
        endsOn: body.endsOn ? String(body.endsOn) : null,
        status,
        sourceNote,
        evidenceLevel,
        notes: String(body.notes ?? ""),
      })
      .returning();

    await ledger.record({
      eventType: "external_academic_event",
      summary: `${provider} — ${title} recorded as an external ${commitmentType}.`,
      detail: {
        commitmentId: row.id,
        dueOn: row.dueOn,
        evidenceLevel,
        sourceNote,
      },
      date: brisbaneToday(),
      actor: "founder",
    });

    return Response.json(
      {
        commitment: row,
        note:
          "Recorded as external context. This is not a College course, does not enter the curriculum, and the College will not grade, reschedule or complete it.",
      },
      { status: 201 }
    );
  } catch (e) {
    return Response.json(
      { error: "external write failed", detail: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
