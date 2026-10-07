import { isUuid } from "@/lib/api/ids";
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { requireUser } from "@/lib/waveyard/local-context";
import { requireProjectRole } from "@/lib/waveyard/local-context";
import { db as arenaDb } from "@/db";
import { artifacts as arenaArtifacts, projects as arenaProjects, roomHandoffs } from "@/db/schema";

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
  const existingLink = await findRoomProjectLink(waveyardProject.id);
  if (existingLink) {
    const existingProject = await arenaProjectForLink(existingLink);
    if (existingProject) return { link: existingLink, arenaProject: existingProject, created: false };
  }

  const [arenaProject] = await arenaDb
    .insert(arenaProjects)
    .values({
      name: waveyardProject.title,
      description: waveyardProject.description,
      emoji: "〰️",
      status: "active",
    })
    .returning();
  const [link] = await arenaDb
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
}

export async function GET(_request: Request, { params }: Params) {
  try {
    const user = await requireUser();
    const { id } = await params;
    if (!isUuid(id)) return NextResponse.json({ error: "Invalid id parameter" }, { status: 400 });
    await requireProjectRole(user.id, id, "viewer");
    const link = await findRoomProjectLink(id);
    if (!link) return NextResponse.json({ linked: false });
    const arenaProject = await arenaProjectForLink(link);
    if (!arenaProject) return NextResponse.json({ linked: false });
    return NextResponse.json({ linked: true, link, arenaProject });
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
}

export async function POST(request: Request, { params }: Params) {
  try {
    const user = await requireUser();
    const { id } = await params;
    if (!isUuid(id)) return NextResponse.json({ error: "Invalid id parameter" }, { status: 400 });
    const { project } = await requireProjectRole(user.id, id, "editor");
    const body = await request.json().catch(() => ({})) as { action?: string; title?: unknown; summary?: unknown };
    const attachment = await attachRoomProject(project);

    if (body.action !== "handoff") {
      return NextResponse.json({ linked: true, ...attachment }, attachment.created ? { status: 201 } : undefined);
    }

    const title = typeof body.title === "string" ? body.title.trim().slice(0, 180) : "Waveyard handoff";
    const summary = typeof body.summary === "string" ? body.summary.trim().slice(0, 8_000) : "";
    if (!summary) return NextResponse.json({ error: "Describe the decision or output to hand off." }, { status: 400 });

    const [artifact] = await arenaDb
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
    const [handoff] = await arenaDb
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
    return NextResponse.json({ linked: true, ...attachment, artifact, handoff }, { status: 201 });
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
}
