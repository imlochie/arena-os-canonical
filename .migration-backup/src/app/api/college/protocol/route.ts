import {
  collegeDefaultProtocol,
  initialRoster,
  resolveProtocol,
  saveProtocol,
  type ProtocolPosition,
} from "@/lib/college/protocol";
import { SESSION_PHASES } from "@/lib/college/attention";
import { db } from "@/db";
import { collegeFacultyProtocols } from "@/db/college";
import { desc } from "drizzle-orm";
import { guard, refuse } from "@/lib/college/guard";

export const dynamic = "force-dynamic";

// GET → the protocol governing a course (or the College default).
export async function GET(req: Request) {
  const _g = await guard(req, "read_state");
  if (!_g.ok) return refuse(_g);

  try {
    const url = new URL(req.url);
    const courseId = url.searchParams.get("courseId");
    const sessionKind = url.searchParams.get("sessionKind") ?? "lesson";

    const protocol = await resolveProtocol(courseId, sessionKind);
    const all = await db
      .select()
      .from(collegeFacultyProtocols)
      .orderBy(desc(collegeFacultyProtocols.createdAt));

    return Response.json({
      protocol,
      roster: initialRoster(protocol),
      defaults: collegeDefaultProtocol(sessionKind),
      phases: SESSION_PHASES,
      stored: all.length,
      note: "A course declares which faculty are relevant to it. Attention is configuration, not code — another course may be configured completely differently.",
    });
  } catch (e) {
    console.error("protocol read error", e);
    return Response.json(
      { error: "protocol read failed", detail: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}

// POST → declare a course's faculty protocol.
export async function POST(req: Request) {
  const _g = await guard(req, "institutional_decision");
  if (!_g.ok) return refuse(_g);

  try {
    const body = await req.json();
    const reason = String(body.reason ?? "").trim();
    if (!reason) {
      return Response.json(
        { error: "reason required — a faculty protocol is an institutional configuration decision" },
        { status: 400 }
      );
    }
    const positions = body.positions as ProtocolPosition[] | undefined;
    if (!Array.isArray(positions) || !positions.length) {
      return Response.json({ error: "positions[] required" }, { status: 400 });
    }

    const result = await saveProtocol({
      courseId: body.courseId ? String(body.courseId) : null,
      sessionKind: String(body.sessionKind ?? ""),
      label: String(body.label ?? "Course faculty protocol"),
      positions: positions.map((p) => ({
        positionKey: String(p.positionKey),
        mode: p.mode,
        activatesOn: Array.isArray(p.activatesOn) ? p.activatesOn.map(String) : [],
        reason: String(p.reason ?? ""),
      })),
      phasePlan: body.phasePlan,
      reason,
    });

    if (!result.ok) return Response.json({ error: result.error }, { status: 400 });
    return Response.json(
      { protocol: result.protocol, roster: initialRoster(result.protocol) },
      { status: 201 }
    );
  } catch (e) {
    console.error("protocol write error", e);
    return Response.json(
      { error: "protocol write failed", detail: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
