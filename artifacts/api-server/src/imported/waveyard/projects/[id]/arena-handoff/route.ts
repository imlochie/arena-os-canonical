import { isUuid } from "@workspace/arena/lib/api/ids";

import { and, eq, sql } from "drizzle-orm";
import { requireUser } from "@workspace/arena/lib/waveyard/local-context";
import { requireProjectRole } from "@workspace/arena/lib/waveyard/local-context";
import { db as arenaDb } from "@workspace/db";
import { artifacts as arenaArtifacts, projects as arenaProjects, roomHandoffs } from "@workspace/db/schema";

const ROOM = "waveyard";
const ROOM_PROJECT_LINK = "room-project";

type Params = { params: Promise<{ id: string }> };

async function findRoomProjectLink(waveyardProjectId: string) {
  const rows = await arenaDb
    .select()
    .from(roomHandoffs)
    .where(and(
      eq(roomHandoffs.room, ROOM),
      eq(roomHandoffs.roomProjectId, waveyardProjectId),
      eq(roomHandoffs.kind, ROOM_PROJECT_LINK),
    ))
    .limit(1);
  return rows[0] ?? null;
}

async function arenaProjectForLink(link: typeof roomHandoffs.$inferSelect) {
  const rows = await arenaDb.select().from(arenaProjects).where(eq(arenaProjects.id, link.arenaProjectId)).limit(1);
  return rows[0] ?? null;
}

async function attachRoomProject(waveyardProject: { id: string; title: string; description: string }) {
  return arenaDb.transaction(async (tx) => {
    // Serialize first-time attachment across API requests and desktop restarts.
    // The lock is transaction-scoped, so no separate lock service is needed.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${ROOM}), hashtext(${waveyardProject.id}))`);
    const existingRows = await tx
      .select()
      .from(roomHandoffs)
      .where(and(
        eq(roomHandoffs.room, ROOM),
        eq(roomHandoffs.roomProjectId, waveyardProject.id),
        eq(roomHandoffs.kind, ROOM_PROJECT_LINK),
      ))
      .limit(1);
    const existingLink = existingRows[0];
    if (existingLink) {
      const projectRows = await tx.select().from(arenaProjects).where(eq(arenaProjects.id, existingLink.arenaProjectId)).limit(1);
      if (projectRows[0]) return { link: existingLink, arenaProject: projectRows[0], created: false };
    }

    const [arenaProject] = await tx
      .insert(arenaProjects)
      .values({
        name: waveyardProject.title,
        description: waveyardProject.description,
        emoji: "〰️",
        status: "active",
      })
      .returning();
    const [link] = await tx
      .insert(roomHandoffs)
      .values({
        arenaProjectId: arenaProject.id,
        room: ROOM,
        roomProjectId: waveyardProject.id,
        kind: ROOM_PROJECT_LINK,
        title: waveyardProject.title,
        summary: "Waveyard project attached to its Arena project container. Private audio and stems remain in Waveyard.",
        payload: JSON.stringify({ version: 1, room: ROOM, transport: "metadata-only" }),
      })
      .returning();
    return { link, arenaProject, created: true };
  });
}

export async function GET(_request: Request, { params }: Params) {
  try {
    const user = await requireUser();
    const { id } = await params;
    if (!isUuid(id)) return Response.json({ error: "Invalid id parameter" }, { status: 400 });
    await requireProjectRole(user.id, id, "viewer");
    const link = await findRoomProjectLink(id);
    if (!link) return Response.json({ linked: false });
    const arenaProject = await arenaProjectForLink(link);
    if (!arenaProject) return Response.json({ linked: false });
    return Response.json({ linked: true, link, arenaProject });
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
}

export async function POST(request: Request, { params }: Params) {
  try {
    const user = await requireUser();
    const { id } = await params;
    if (!isUuid(id)) return Response.json({ error: "Invalid id parameter" }, { status: 400 });
    const { project } = await requireProjectRole(user.id, id, "editor");
    const body = await request.json().catch(() => ({})) as { action?: string; title?: unknown; summary?: unknown };
    if (body.action !== "handoff") {
      const attachment = await attachRoomProject(project);
      return Response.json({ linked: true, ...attachment }, attachment.created ? { status: 201 } : undefined);
    }

    const title = typeof body.title === "string" ? body.title.trim().slice(0, 180) : "Waveyard handoff";
    const summary = typeof body.summary === "string" ? body.summary.trim().slice(0, 8_000) : "";
    if (!summary) return Response.json({ error: "Describe the decision or output to hand off." }, { status: 400 });

    const attachment = await attachRoomProject(project);
    const { artifact, handoff } = await arenaDb.transaction(async (tx) => {
      const [artifact] = await tx
        .insert(arenaArtifacts)
        .values({
          projectId: attachment.arenaProject.id,
          kind: "room-handoff",
          title: title || "Waveyard handoff",
          body: summary,
          sourceType: ROOM,
          sourceId: project.id,
        })
        .returning();
      const [handoff] = await tx
        .insert(roomHandoffs)
        .values({
          arenaProjectId: attachment.arenaProject.id,
          room: ROOM,
          roomProjectId: project.id,
          sourceId: artifact.id,
          kind: "artifact",
          title: artifact.title,
          summary,
          payload: JSON.stringify({ version: 1, room: ROOM, artifactId: artifact.id, transport: "metadata-only" }),
        })
        .returning();
      return { artifact, handoff };
    });
    return Response.json({ linked: true, ...attachment, artifact, handoff }, { status: 201 });
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
}
