import { isUuid } from "@/lib/api/ids";
import { NextResponse } from "next/server";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  remixClips,
  remixSessions,
  remixTracks,
  sourceSections,
  stemAssets,
} from "@/db/waveyardSchema";
import { ARRANGEMENT_EXTENSION_INTENTS, proposeArrangementExtension, type ArrangementExtensionIntent } from "@/lib/waveyard/types";
import { requireUser } from "@/lib/waveyard/local-context";
import { requireProjectRole } from "@/lib/waveyard/local-context";

async function access(userId: string, remixId: string, minimum: "viewer" | "editor") {
  const [remix] = await db.select().from(remixSessions).where(eq(remixSessions.id, remixId)).limit(1);
  if (!remix) throw new Response("Remix session not found.", { status: 404 });
  await requireProjectRole(userId, remix.projectId, minimum);
  return remix;
}

function intentFrom(value: unknown): ArrangementExtensionIntent | null {
  return ARRANGEMENT_EXTENSION_INTENTS.includes(value as ArrangementExtensionIntent) ? value as ArrangementExtensionIntent : null;
}

async function proposalFor(remix: typeof remixSessions.$inferSelect, anchorClipId: string, intent: ArrangementExtensionIntent) {
  
  const tracks = await db.select().from(remixTracks).where(eq(remixTracks.remixSessionId, remix.id));
  if (!tracks.length) return null;
  const clips = await db.select().from(remixClips).where(inArray(remixClips.remixTrackId, tracks.map((track) => track.id)));
  const anchor = clips.find((clip) => clip.id === anchorClipId);
  if (!anchor) return null;
  const track = tracks.find((candidate) => candidate.id === anchor.remixTrackId);
  const [stem] = await db.select().from(stemAssets).where(eq(stemAssets.id, anchor.stemAssetId)).limit(1);
  if (!track || !stem || stem.projectId !== remix.projectId) return null;
  const sections = await db.select().from(sourceSections).where(eq(sourceSections.projectId, remix.projectId));
  const sourceDurationMs = anchor.tempoSyncEnabled ? Math.round(anchor.durationMs * (remix.tempoBpm / Math.max(1, remix.tempoBpm))) : anchor.durationMs;
  const section = sections.find((candidate) => candidate.sourceAssetId === stem.sourceAssetId && candidate.startMs === anchor.sourceOffsetMs
    && candidate.endMs >= anchor.sourceOffsetMs + sourceDurationMs);
  const sectionBeats = section ? section.endBeatIndex - section.startBeatIndex : 0;
  const derivedBars = Math.round(anchor.durationMs / ((60_000 / remix.tempoBpm) * 4));
  const barCount = section && sectionBeats > 0 && sectionBeats % 4 === 0 ? sectionBeats / 4
    : Number.isFinite(derivedBars) && derivedBars > 0 ? derivedBars : null;
  const arrangementEndMs = Math.max(0, ...clips.map((clip) => clip.timelineStartMs + clip.durationMs));
  return proposeArrangementExtension({
    anchor: {
      clipId: anchor.id, remixTrackId: track.id, stemAssetId: stem.id, stemType: stem.stemType,
      timelineStartMs: anchor.timelineStartMs, durationMs: anchor.durationMs, sourceOffsetMs: anchor.sourceOffsetMs,
      gain: anchor.gain, fadeInMs: anchor.fadeInMs, fadeOutMs: anchor.fadeOutMs,
      tempoSyncEnabled: anchor.tempoSyncEnabled, keySyncEnabled: anchor.keySyncEnabled, beatSnapEnabled: anchor.beatSnapEnabled,
      barCount,
    },
    intent,
    arrangementEndMs,
  });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(); const { id } = await params;
    if (!isUuid(id)) return NextResponse.json({ error: "Invalid id parameter" }, { status: 400 });
    const remix = await access(user.id, id, "viewer");
    const body = await request.json().catch(() => ({}));
    const intent = intentFrom(body.intent);
    if (!intent) return NextResponse.json({ error: "Choose a supported extension intent." }, { status: 400 });
    const proposal = await proposalFor(remix, String(body.anchorClipId ?? ""), intent);
    if (!proposal) return NextResponse.json({ error: "Choose an existing arrangement clip as the extension anchor." }, { status: 409 });
    return NextResponse.json({ proposal });
  } catch (error) { if (error instanceof Response) return error; throw error; }
}

/** Inserts a user-confirmed ordinary clip and shifts later ordinary clips only when necessary. */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(); const { id } = await params;
    if (!isUuid(id)) return NextResponse.json({ error: "Invalid id parameter" }, { status: 400 });
    const remix = await access(user.id, id, "editor");
    const body = await request.json().catch(() => ({}));
    const intent = intentFrom(body.intent);
    if (!intent) return NextResponse.json({ error: "Choose a supported extension intent." }, { status: 400 });
    const anchorClipId = String(body.anchorClipId ?? "");
    const proposal = await proposalFor(remix, anchorClipId, intent);
    if (!proposal || proposal.id !== String(body.proposalId ?? "")) return NextResponse.json({ error: "This extension proposal is stale. Propose it again before adding." }, { status: 409 });
    
    await db.transaction(async (tx) => {
      const tracks = await tx.select().from(remixTracks).where(eq(remixTracks.remixSessionId, remix.id));
      const clips = await tx.select().from(remixClips).where(inArray(remixClips.remixTrackId, tracks.map((track) => track.id)));
      const anchor = clips.find((clip) => clip.id === anchorClipId);
      if (!anchor) throw new Response("Anchor clip is no longer available.", { status: 409 });
      if (proposal.shiftFollowingByMs > 0) {
        const threshold = proposal.intent === "extend-intro" ? 0 : anchor.timelineStartMs + anchor.durationMs;
        for (const clip of clips) {
          if (clip.id !== anchor.id && clip.timelineStartMs >= threshold)
            await tx.update(remixClips).set({ timelineStartMs: clip.timelineStartMs + proposal.shiftFollowingByMs, updatedAt: new Date() }).where(eq(remixClips.id, clip.id));
          if (clip.id === anchor.id && proposal.intent === "extend-intro")
            await tx.update(remixClips).set({ timelineStartMs: clip.timelineStartMs + proposal.shiftFollowingByMs, updatedAt: new Date() }).where(eq(remixClips.id, clip.id));
        }
      }
      await tx.insert(remixClips).values({
        remixTrackId: anchor.remixTrackId, stemAssetId: anchor.stemAssetId,
        timelineStartMs: proposal.insertionTimelineMs, durationMs: proposal.durationMs, sourceOffsetMs: proposal.sourceOffsetMs,
        gain: anchor.gain, fadeInMs: anchor.fadeInMs, fadeOutMs: anchor.fadeOutMs,
        tempoSyncEnabled: anchor.tempoSyncEnabled, keySyncEnabled: anchor.keySyncEnabled, beatSnapEnabled: anchor.beatSnapEnabled,
      });
      await tx.update(remixSessions).set({ version: remix.version + 1, updatedAt: new Date() }).where(eq(remixSessions.id, remix.id));
    });
    return NextResponse.json({ proposal }, { status: 201 });
  } catch (error) { if (error instanceof Response) return error; console.error("extension acceptance failed", error); return NextResponse.json({ error: "Could not extend this arrangement." }, { status: 500 }); }
}
