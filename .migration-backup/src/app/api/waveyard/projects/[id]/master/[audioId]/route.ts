import { isUuid } from "@/lib/api/ids";
/**
 * Serve master preview WAVs from project storage. Ids are validated by
 * construction (preview-UUID format) and confined to the project prefix.
 */

import { NextResponse } from "next/server";

import { requireProjectRole, requireUser } from "@/lib/waveyard/local-context";
import { getStorage } from "@/lib/waveyard/storage";

export const dynamic = "force-dynamic";

const MAX_WAV_BYTES = 128 * 1024 * 1024;
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
    if (!PREVIEW_RE.test(audioId))
      return NextResponse.json({ error: "Invalid audio id." }, { status: 400 });
    try {
      const buffer = await getStorage().getBuffer(`projects/${projectId}/master/${audioId}.wav`, MAX_WAV_BYTES);
      return new NextResponse(new Uint8Array(buffer), {
        status: 200,
        headers: { "content-type": "audio/wav", "cache-control": "private, max-age=60" },
      });
    } catch {
      return NextResponse.json({ error: "Audio not found." }, { status: 404 });
    }
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: "Could not load master audio." }, { status: 500 });
  }
}
