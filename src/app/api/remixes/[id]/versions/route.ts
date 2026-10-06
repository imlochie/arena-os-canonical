import { NextResponse } from "next/server";
import { asc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  remixAutomationPoints,
  remixClips,
  remixSessions,
  remixTracks,
  remixVersions,
} from "@/db/waveyardSchema";
import { requireUser } from "@/lib/waveyard/local-context";
import { requireProjectRole } from "@/lib/waveyard/local-context";
import { crossfadeError, normaliseRemixState } from "@/lib/waveyard/remix";

async function access(userId: string, id: string, minimum: "viewer" | "editor") {
  const [remix] = await db.select().from(remixSessions).where(eq(remixSessions.id, id)).limit(1);
  if (!remix) throw new Response("Remix session not found.", { status: 404 });
  await requireProjectRole(userId, remix.projectId, minimum);
  return remix;
}

async function snapshot(remix: typeof remixSessions.$inferSelect) {
  
  const tracks = await db.select().from(remixTracks).where(eq(remixTracks.remixSessionId, remix.id)).orderBy(asc(remixTracks.sortOrder));
  const clips = tracks.length ? await db.select().from(remixClips).where(inArray(remixClips.remixTrackId, tracks.map((track) => track.id))) : [];
  const automation = await db.select().from(remixAutomationPoints).where(eq(remixAutomationPoints.remixSessionId, remix.id)).orderBy(asc(remixAutomationPoints.timelineMs));
  return {
    name: remix.name,
    masterVolume: remix.masterVolume,
    loopStartMs: remix.loopStartMs,
    loopEndMs: remix.loopEndMs,
    tempoBpm: remix.tempoBpm,
    timeSignatureNumerator: remix.timeSignatureNumerator,
    timeSignatureDenominator: remix.timeSignatureDenominator,
    gridDivision: remix.gridDivision,
    snapEnabled: remix.snapEnabled,
    targetKey: remix.targetKey,
    tracks: tracks.map((track) => ({ ...track, clips: clips.filter((clip) => clip.remixTrackId === track.id) })),
    automation: [...new Map(automation.map((point) => [
      `${point.remixTrackId}:${point.parameter}`,
      {
        remixTrackId: point.remixTrackId,
        parameter: point.parameter,
        points: automation.filter((candidate) => candidate.remixTrackId === point.remixTrackId && candidate.parameter === point.parameter)
          .map(({ id: pointId, timelineMs, value }) => ({ id: pointId, timelineMs, value })),
      },
    ])).values()],
  };
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(); const { id } = await params;
    await access(user.id, id, "viewer");
    const versions = await db.select({ id: remixVersions.id, name: remixVersions.name, createdAt: remixVersions.createdAt, createdById: remixVersions.createdById }).from(remixVersions).where(eq(remixVersions.remixSessionId, id)).orderBy(asc(remixVersions.createdAt));
    return NextResponse.json({ versions });
  } catch (error) { if (error instanceof Response) return error; throw error; }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(); const { id } = await params;
    const remix = await access(user.id, id, "editor");
    const body = await request.json().catch(() => ({}));
    const name = String(body.name ?? `Version ${remix.version}`).trim().slice(0, 120) || `Version ${remix.version}`;
    const versionSnapshot = await snapshot(remix);
    const state = normaliseRemixState(versionSnapshot);
    if (!state)
      return NextResponse.json({ error: "Current remix state cannot be versioned." }, { status: 422 });
    const crossfadeMessage = state.tracks.map(crossfadeError).find(Boolean);
    if (crossfadeMessage)
      return NextResponse.json({ error: crossfadeMessage }, { status: 422 });
    const [version] = await db.insert(remixVersions).values({
      remixSessionId: remix.id,
      createdById: user.id,
      name,
      snapshot: JSON.stringify(versionSnapshot),
    }).returning({ id: remixVersions.id, name: remixVersions.name, createdAt: remixVersions.createdAt });
    return NextResponse.json({ version }, { status: 201 });
  } catch (error) { if (error instanceof Response) return error; console.error("remix version failed", error); return NextResponse.json({ error: "Could not create a remix version." }, { status: 500 }); }
}
