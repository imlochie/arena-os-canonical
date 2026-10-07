/**
 * Serve a sound-design asset WAV from project storage.
 * Ids are validated UUIDs and re-checked against the DB row — containment
 * by construction.
 */

import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import { soundDesignAssets } from "@/db/waveyardSchema";
import { requireProjectRole, requireUser } from "@/lib/waveyard/local-context";
import { getStorage } from "@/lib/waveyard/storage";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_WAV_BYTES = 64 * 1024 * 1024;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; assetId: string }> },
) {
  try {
    const user = await requireUser();
    const { id: projectId, assetId } = await params;
    await requireProjectRole(user.id, projectId, "viewer");
    if (!UUID_RE.test(assetId))
      return NextResponse.json({ error: "Invalid asset id." }, { status: 400 });
    const [row] = await db
      .select({ storageKey: soundDesignAssets.storageKey })
      .from(soundDesignAssets)
      .where(and(eq(soundDesignAssets.id, assetId), eq(soundDesignAssets.projectId, projectId)))
      .limit(1);
    if (row === undefined)
      return NextResponse.json({ error: "Asset not found." }, { status: 404 });
    try {
      const buffer = await getStorage().getBuffer(row.storageKey, MAX_WAV_BYTES);
      return new NextResponse(new Uint8Array(buffer), {
        status: 200,
        headers: { "content-type": "audio/wav", "cache-control": "private, max-age=60" },
      });
    } catch {
      return NextResponse.json({ error: "Audio not found." }, { status: 404 });
    }
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: "Could not load the asset." }, { status: 500 });
  }
}
