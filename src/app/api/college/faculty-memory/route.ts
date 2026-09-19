import {
  FACULTY_MEMORY_KINDS,
  listFor,
  proposePromotion,
  recall,
  remember,
  type FacultyMemoryKind,
} from "@/lib/college/faculty-memory";
import { effectivePolicies } from "@/lib/college/attention-resolver";

export const dynamic = "force-dynamic";

/**
 * FACULTY MEMORY — what a teacher noticed, kept separate from what the
 * institution holds to be true.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const positionKey = url.searchParams.get("positionKey");
    const courseId = url.searchParams.get("courseId");

    if (!positionKey) {
      return Response.json({
        kinds: FACULTY_MEMORY_KINDS,
        note: "Specify ?positionKey= to read a position's memory.",
      });
    }

    if (url.searchParams.get("view") === "recall") {
      const entries = await recall({ positionKey, courseId, limit: 8 });
      return Response.json({
        entries,
        note: "Labelled faculty memory. These are prior observations, not institutional fact.",
      });
    }

    const rows = await listFor(positionKey, courseId);
    return Response.json({
      memory: rows,
      note: "Faculty memory is deliberately loose — remember generously, believe cautiously. Promotion into institutional memory passes the same corroboration gates as anything else.",
    });
  } catch (e) {
    console.error("faculty memory read error", e);
    return Response.json(
      { error: "faculty memory read failed", detail: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const action = String(body.action ?? "remember");

    if (action === "propose_promotion") {
      const id = String(body.id ?? "");
      if (!id) return Response.json({ error: "id required" }, { status: 400 });
      const result = await proposePromotion(id, String(body.reason ?? ""));
      return Response.json(result, { status: result.ok ? 201 : 200 });
    }

    const positionKey = String(body.positionKey ?? "");
    const content = String(body.content ?? "");
    if (!positionKey || !content) {
      return Response.json({ error: "positionKey and content required" }, { status: 400 });
    }

    // Respect the member's configured memory permissions.
    const policies = await effectivePolicies({
      courseId: body.courseId ?? null,
      positions: [positionKey],
    });
    const eff = policies.get(positionKey);

    const result = await remember({
      memberId: eff?.memberId ?? null,
      positionKey,
      courseId: body.courseId ?? null,
      sessionId: body.sessionId ?? null,
      content,
      kind: (String(body.kind ?? "teaching_observation") as FacultyMemoryKind),
      memoryEnabled: eff?.memoryEnabled ?? true,
      memoryScopeLimit: eff?.memoryScopeLimit ?? "course",
    });

    if (!result.ok) {
      return Response.json({ error: result.refused }, { status: 400 });
    }

    return Response.json(
      {
        entry: result.entry,
        note: "Recorded as faculty memory. It is not institutional truth and will not become so automatically.",
      },
      { status: 201 }
    );
  } catch (e) {
    console.error("faculty memory write error", e);
    return Response.json(
      { error: "faculty memory write failed", detail: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
