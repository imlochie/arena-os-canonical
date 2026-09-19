import {
  FACULTY_PRESETS,
  MANDATORY_LEVELS,
  assignMember,
  createMember,
  duplicateMember,
  getMember,
  getPreset,
  listMembers,
  memberVersions,
  setMemberStatus,
  updateMember,
  validateRoster,
  type MandatoryLevel,
} from "@/lib/college/members";
import {
  AUTHORITIES,
  POSITION_AUTHORITY_CEILING,
  RESPONSIBILITIES,
  defaultAuthorityFor,
  responsibilitiesFor,
} from "@/lib/college/authority";
import { FACULTY_POSITIONS } from "@/lib/college/faculty";
import { db } from "@/db";
import { collegeFacultyAssignments } from "@/db/college";
import { desc } from "drizzle-orm";

export const dynamic = "force-dynamic";

// GET → faculty members, presets, and the configuration vocabulary.
//   ?id=            one member with its version history
//   ?validate=1     roster validation for a session context
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const id = url.searchParams.get("id");

    if (id) {
      const member = await getMember(id);
      if (!member) return Response.json({ error: "member not found" }, { status: 404 });
      const versions = await memberVersions(id);
      return Response.json({
        member,
        versions,
        available: {
          authorities: AUTHORITIES,
          ceiling: POSITION_AUTHORITY_CEILING[member.positionKey] ?? [],
          responsibilities: responsibilitiesFor(member.positionKey),
        },
      });
    }

    if (url.searchParams.get("validate") === "1") {
      const validation = await validateRoster({
        courseId: url.searchParams.get("courseId"),
        sessionKind: url.searchParams.get("sessionKind") ?? "lesson",
        slotId: url.searchParams.get("slotId"),
      });
      return Response.json(validation);
    }

    const [members, assignments] = await Promise.all([
      listMembers(url.searchParams.get("includeArchived") === "1"),
      db.select().from(collegeFacultyAssignments).orderBy(desc(collegeFacultyAssignments.createdAt)),
    ]);

    return Response.json({
      members,
      assignments,
      presets: FACULTY_PRESETS,
      positions: FACULTY_POSITIONS.map((p) => ({
        key: p.key,
        name: p.name,
        emoji: p.emoji,
        branch: p.branch,
        question: p.question,
        ceiling: POSITION_AUTHORITY_CEILING[p.key] ?? [],
        responsibilities: responsibilitiesFor(p.key),
      })),
      authorities: AUTHORITIES,
      allResponsibilities: RESPONSIBILITIES,
      mandatoryLevels: MANDATORY_LEVELS,
      note: "A position defines institutional authority. A member defines how that position behaves. Personality never grants authority.",
    });
  } catch (e) {
    console.error("members read error", e);
    return Response.json(
      { error: "members read failed", detail: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}

// POST → create | from_preset | duplicate | assign
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const action = String(body.action ?? "create");

    if (action === "from_preset") {
      const preset = getPreset(String(body.presetKey ?? ""));
      if (!preset) return Response.json({ error: "unknown preset" }, { status: 400 });
      const result = await createMember({
        ...preset,
        name: String(body.name ?? preset.name),
        positionKey: String(body.positionKey ?? preset.positionKey),
        grantedAuthority: defaultAuthorityFor(String(body.positionKey ?? preset.positionKey)),
        responsibilities: responsibilitiesFor(String(body.positionKey ?? preset.positionKey)).map(
          (r) => r.key
        ),
        mandatoryLevel: (body.mandatoryLevel as MandatoryLevel) ?? "optional",
        presetKey: preset.key,
      });
      if (!result.ok) return Response.json({ error: result.error }, { status: 400 });
      return Response.json(
        {
          member: result.member,
          warnings: result.warnings,
          note: "Created from a preset. Presets are starting configurations — edit it freely.",
        },
        { status: 201 }
      );
    }

    if (action === "duplicate") {
      const copy = await duplicateMember(String(body.id ?? ""), String(body.name ?? "Copy"));
      if (!copy) return Response.json({ error: "member not found" }, { status: 404 });
      return Response.json({ member: copy }, { status: 201 });
    }

    if (action === "assign") {
      const memberId = String(body.memberId ?? "");
      const scope = String(body.scope ?? "college");
      const reason = String(body.reason ?? "").trim();
      if (!memberId || !reason) {
        return Response.json(
          { error: "memberId and reason required — an assignment is a configuration decision" },
          { status: 400 }
        );
      }
      const row = await assignMember({
        memberId,
        scope,
        scopeRef: String(body.scopeRef ?? ""),
        participation: String(body.participation ?? "optional"),
        temporary: body.temporary === true || scope === "session",
        reason,
      });
      return Response.json(
        {
          assignment: row,
          note:
            scope === "session"
              ? "Session-scoped assignment recorded as a TEMPORARY override. The normal configuration is unchanged and resumes automatically."
              : "Assignment recorded. The most specific valid scope wins at runtime.",
        },
        { status: 201 }
      );
    }

    // default: create
    const result = await createMember({
      name: String(body.name ?? ""),
      positionKey: String(body.positionKey ?? ""),
      temperament: body.temperament,
      communicationStyle: body.communicationStyle,
      teachingStyle: body.teachingStyle,
      questioningStyle: body.questioningStyle,
      directness: body.directness,
      warmth: body.warmth,
      formality: body.formality,
      ambiguityTolerance: body.ambiguityTolerance,
      personalityInstruction: body.personalityInstruction,
      responsibilities: body.responsibilities,
      grantedAuthority: body.grantedAuthority,
      mandatoryLevel: body.mandatoryLevel,
      missingSeverity: body.missingSeverity,
      canConsult: body.canConsult,
      canHandOffTo: body.canHandOffTo,
      canInterrupt: body.canInterrupt,
      activatesOnEvents: body.activatesOnEvents,
      activatesOnPhases: body.activatesOnPhases,
      notes: body.notes,
    });
    if (!result.ok) return Response.json({ error: result.error }, { status: 400 });
    return Response.json({ member: result.member, warnings: result.warnings }, { status: 201 });
  } catch (e) {
    console.error("members write error", e);
    return Response.json(
      { error: "members write failed", detail: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}

// PATCH → edit a member, or change its status. Never deletes.
export async function PATCH(req: Request) {
  try {
    const body = await req.json();
    const id = String(body.id ?? "");
    if (!id) return Response.json({ error: "id required" }, { status: 400 });
    const reason = String(body.reason ?? "").trim();

    if (body.status) {
      if (!reason) return Response.json({ error: "reason required" }, { status: 400 });
      const result = await setMemberStatus(id, body.status, reason);
      if (!result) return Response.json({ error: "member not found" }, { status: 404 });
      return Response.json(result);
    }

    const result = await updateMember(id, body, reason);
    if (!result.ok) return Response.json({ error: result.error }, { status: 400 });
    return Response.json({
      member: result.member,
      warnings: result.warnings,
      note: "Previous configuration preserved as a version. Historical sessions keep the configuration that applied when they occurred.",
    });
  } catch (e) {
    console.error("members patch error", e);
    return Response.json(
      { error: "members patch failed", detail: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}

// DELETE → refused by design.
export async function DELETE() {
  return Response.json(
    {
      error:
        "Faculty members are not deleted. Archive or retire the member instead — historical sessions must keep referencing who actually taught them.",
    },
    { status: 405 }
  );
}
