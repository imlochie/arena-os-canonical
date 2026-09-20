import { NextResponse } from "next/server";
import { asc, eq, inArray } from "drizzle-orm";
import { getDb, remixClips, remixSessions, remixTracks, remixVersions } from "@waveyard/database";
import { requireUser } from "@/lib/auth";
import { requireProjectRole } from "@/lib/permissions";

async function access(userId: string, id: string, minimum: "viewer" | "editor") {
  const [remix] = await getDb().select().from(remixSessions).where(eq(remixSessions.id, id)).limit(1);
  if (!remix) throw new Response("Remix session not found.", { status: 404 });
  await requireProjectRole(userId, remix.projectId, minimum);
  return remix;
}

async function snapshot(remix: typeof remixSessions.$inferSelect) {
  const db = getDb();
  const tracks = await db.select().from(remixTracks).where(eq(remixTracks.remixSessionId, remix.id)).orderBy(asc(remixTracks.sortOrder));
  const clips = tracks.length ? await db.select().from(remixClips).where(inArray(remixClips.remixTrackId, tracks.map((track) => track.id))) : [];
  return {
    name: remix.name, masterVolume: remix.masterVolume, loopStartMs: remix.loopStartMs, loopEndMs: remix.loopEndMs,
    tracks: tracks.map((track) => ({ ...track, clips: clips.filter((clip) => clip.remixTrackId === track.id) })),
  };
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(); const { id } = await params;
    await access(user.id, id, "viewer");
    const versions = await getDb().select({ id: remixVersions.id, name: remixVersions.name, createdAt: remixVersions.createdAt, createdById: remixVersions.createdById }).from(remixVersions).where(eq(remixVersions.remixSessionId, id)).orderBy(asc(remixVersions.createdAt));
    return NextResponse.json({ versions });
  } catch (error) { if (error instanceof Response) return error; throw error; }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(); const { id } = await params;
    const remix = await access(user.id, id, "editor");
    const body = await request.json().catch(() => ({}));
    const name = String(body.name ?? `Version ${remix.version}`).trim().slice(0, 120) || `Version ${remix.version}`;
    const [version] = await getDb().insert(remixVersions).values({ remixSessionId: remix.id, createdById: user.id, name, snapshot: JSON.stringify(await snapshot(remix)) }).returning({ id: remixVersions.id, name: remixVersions.name, createdAt: remixVersions.createdAt });
    return NextResponse.json({ version }, { status: 201 });
  } catch (error) { if (error instanceof Response) return error; console.error("remix version failed", error); return NextResponse.json({ error: "Could not create a remix version." }, { status: 500 }); }
}
