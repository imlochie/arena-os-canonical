import { db } from "@/db";
import { collegeFaculty } from "@/db/college";
import { asc } from "drizzle-orm";
import {
  deriveFacultyComposition,
  FACULTY_POSITIONS,
  SESSION_KINDS,
} from "@/lib/college/faculty";
import { buildContextPacket } from "@/lib/college/context";

export const dynamic = "force-dynamic";

// GET → faculty positions, session kinds, and (optionally) the derived
// composition for a session kind: ?sessionKind=research
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const sessionKind = url.searchParams.get("sessionKind");
    const rows = await db.select().from(collegeFaculty).orderBy(asc(collegeFaculty.positionKey));
    const composition = sessionKind
      ? deriveFacultyComposition(sessionKind, {
          hasOpenDeviation: url.searchParams.get("deviation") === "1",
          isRevisit: url.searchParams.get("revisit") === "1",
        })
      : null;
    return Response.json({
      faculty: rows,
      definitions: FACULTY_POSITIONS,
      sessionKinds: SESSION_KINDS,
      composition,
    });
  } catch (e) {
    console.error(e);
    return Response.json({ faculty: [], definitions: FACULTY_POSITIONS, sessionKinds: SESSION_KINDS });
  }
}

// POST → build the bounded context packet for one faculty position.
// Returns exactly what the model would receive, including its visibility
// limitations. Inspectable by design: the institution should be able to
// explain what its faculty knew.
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const positionKey = String(body.positionKey ?? "");
    if (!positionKey) return Response.json({ error: "positionKey required" }, { status: 400 });
    const packet = await buildContextPacket({
      positionKey,
      courseId: body.courseId ?? null,
      weekIndex: body.weekIndex ?? null,
      sessionObjective: body.sessionObjective ?? undefined,
    });
    return Response.json({ packet });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "packet build failed" }, { status: 500 });
  }
}
