import { NextResponse } from "next/server";
import { asc, desc, eq } from "drizzle-orm";
import { getDb, remixClips, remixSessions, remixTracks, stemAssets } from "@waveyard/database";
import { requireUser } from "@/lib/auth";
import { requireProjectRole } from "@/lib/permissions";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(); const { id } = await params;
    await requireProjectRole(user.id, id, "viewer");
    const sessions = await getDb().select().from(remixSessions).where(eq(remixSessions.projectId, id)).orderBy(desc(remixSessions.updatedAt));
    return NextResponse.json({ remixes: sessions });
  } catch (error) { if (error instanceof Response) return error; throw error; }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(); const { id: projectId } = await params;
    await requireProjectRole(user.id, projectId, "editor");
    const body = await request.json().catch(() => ({}));
    const name = String(body.name ?? "Untitled remix").trim().slice(0, 120) || "Untitled remix";
    const db = getDb();
    const stems = await db.select().from(stemAssets).where(eq(stemAssets.projectId, projectId)).orderBy(asc(stemAssets.createdAt));
    if (!stems.length) return NextResponse.json({ error: "A completed project with real stems is required before creating a remix." }, { status: 409 });
    const [session] = await db.transaction(async (tx) => {
      const [created] = await tx.insert(remixSessions).values({ projectId, ownerId: user.id, name }).returning();
      const tracks = await tx.insert(remixTracks).values(stems.map((stem, sortOrder) => ({
        remixSessionId: created.id, stemAssetId: stem.id, name: stem.stemType[0].toUpperCase() + stem.stemType.slice(1), sortOrder,
      }))).returning();
      await tx.insert(remixClips).values(tracks.map((track) => {
        const stem = stems.find((candidate) => candidate.id === track.stemAssetId)!;
        return { remixTrackId: track.id, stemAssetId: stem.id, timelineStartMs: 0, sourceOffsetMs: 0, durationMs: Math.max(1, Math.round(stem.durationSeconds * 1000)), gain: 1 };
      }));
      return [created];
    });
    return NextResponse.json({ remix: session }, { status: 201 });
  } catch (error) { if (error instanceof Response) return error; console.error("remix creation failed", error); return NextResponse.json({ error: "Could not create the remix session." }, { status: 500 }); }
}
