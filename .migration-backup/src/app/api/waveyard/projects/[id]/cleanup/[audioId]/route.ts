import { isUuid } from "@/lib/api/ids";
/**
 * Serve cleanup audio (preview or applied version) from project storage.
 * Keys are reconstructed from validated ids — containment by construction.
 */

import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import { cleanupVersions } from "@/db/waveyardSchema";
import { requireProjectRole, requireUser } from "@/lib/waveyard/local-context";
import { getStorage } from "@/lib/waveyard/storage";

export const dynamic = "force-dynamic";

const MAX_WAV_BYTES = 128 * 1024 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PREVIEW_RE = /^preview-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; audioId: string }> },
) {
  try {
    const user = await requireUser();
    const { id: projectId, audioId } = await params;
    if (!isUuid(projectId) || !isUuid(audioId)) return NextResponse.json({ error: "Invalid id parameter" }, { status: 400 });
    await requireProjectRole(user.id, projectId, "viewer");

    let storageKey: string | null = null;
    if (UUID_RE.test(audioId)) {
      const [row] = await db
        .select({ storageKey: cleanupVersions.storageKey })
        .from(cleanupVersions)
        .where(and(eq(cleanupVersions.id, audioId), eq(cleanupVersions.projectId, projectId)))
        .limit(1);
      storageKey = row?.storageKey ?? null;
    } else if (PREVIEW_RE.test(audioId)) {
      storageKey = `projects/${projectId}/cleanup/${audioId}.wav`;
    }
    if (storageKey === null)
      return NextResponse.json({ error: "Invalid audio id." }, { status: 400 });

    try {
      const buffer = await getStorage().getBuffer(storageKey, MAX_WAV_BYTES);
      return new NextResponse(new Uint8Array(buffer), {
        status: 200,
        headers: { "content-type": "audio/wav", "cache-control": "private, max-age=60" },
      });
    } catch {
      return NextResponse.json({ error: "Audio not found." }, { status: 404 });
    }
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: "Could not load cleanup audio." }, { status: 500 });
  }
}
