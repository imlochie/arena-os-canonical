/**
 * Serve / delete a single vocal chop.
 *
 * GET /api/waveyard/projects/[id]/vocal-chops/[chopId]
 *   → the chop's WAV (from project storage; the key is reconstructed from
 *     the row, never taken from the request). ?download=1 serves it as an
 *     attachment — every chop drops straight into FL Studio / any DAW.
 *
 * DELETE → removes the row and the stored WAV.
 */

import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import { vocalChops } from "@/db/waveyardSchema";
import { requireProjectRole, requireUser } from "@/lib/waveyard/local-context";
import { getStorage } from "@/lib/waveyard/storage";
import { isUuid } from "@/lib/api/ids";

export const dynamic = "force-dynamic";

const MAX_WAV_BYTES = 16 * 1024 * 1024;

export async function GET(request: Request, { params }: { params: Promise<{ id: string; chopId: string }> }) {
  try {
    const user = await requireUser();
    const { id: projectId, chopId } = await params;
    if (!isUuid(projectId) || !isUuid(chopId)) return NextResponse.json({ error: "Invalid id parameter." }, { status: 400 });
    await requireProjectRole(user.id, projectId, "viewer");

    const [row] = await db
      .select({ storageKey: vocalChops.storageKey, rootMidi: vocalChops.rootMidi })
      .from(vocalChops)
      .where(and(eq(vocalChops.id, chopId), eq(vocalChops.projectId, projectId)))
      .limit(1);
    if (!row) return NextResponse.json({ error: "Vocal chop not found." }, { status: 404 });

    const buffer = await getStorage().getBuffer(row.storageKey, MAX_WAV_BYTES);
    const download = new URL(request.url).searchParams.get("download") === "1";
    const noteNames = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
    const noteName = `${noteNames[row.rootMidi % 12]}${Math.floor(row.rootMidi / 12) - 1}`;
    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "content-type": "audio/wav",
        "cache-control": "private, max-age=60",
        ...(download ? { "content-disposition": `attachment; filename="vocal-chop-${noteName}.wav"` } : {}),
      },
    });
  } catch {
    return NextResponse.json({ error: "Vocal chop not found." }, { status: 404 });
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string; chopId: string }> }) {
  try {
    const user = await requireUser();
    const { id: projectId, chopId } = await params;
    if (!isUuid(projectId) || !isUuid(chopId)) return NextResponse.json({ error: "Invalid id parameter." }, { status: 400 });
    await requireProjectRole(user.id, projectId, "editor");

    const [row] = await db
      .select({ storageKey: vocalChops.storageKey })
      .from(vocalChops)
      .where(and(eq(vocalChops.id, chopId), eq(vocalChops.projectId, projectId)))
      .limit(1);
    if (!row) return NextResponse.json({ error: "Vocal chop not found." }, { status: 404 });

    await db.delete(vocalChops).where(eq(vocalChops.id, chopId));
    await getStorage().delete(row.storageKey).catch(() => undefined);
    return NextResponse.json({ deleted: chopId }, { status: 200 });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("vocal chop delete failed", error);
    return NextResponse.json({ error: "Could not delete the vocal chop." }, { status: 500 });
  }
}
