import { isUuid } from "@/lib/api/ids";
/**
 * Serve a generated arrangement layer WAV from project storage.
 * GET /api/waveyard/projects/[id]/arrangement-layers/[layerId]
 *
 * The key is reconstructed (never taken from the request) so containment
 * is guaranteed by construction.
 */

import { NextResponse } from "next/server";

import { requireProjectRole, requireUser } from "@/lib/waveyard/local-context";
import { getStorage } from "@/lib/waveyard/storage";

export const dynamic = "force-dynamic";

const MAX_WAV_BYTES = 64 * 1024 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; layerId: string }> },
) {
  try {
    const user = await requireUser();
    const { id: projectId, layerId } = await params;
    if (!isUuid(projectId) || !isUuid(layerId)) return NextResponse.json({ error: "Invalid id parameter" }, { status: 400 });
    await requireProjectRole(user.id, projectId, "viewer");
    if (!UUID_RE.test(layerId))
      return NextResponse.json({ error: "Invalid layer id." }, { status: 400 });

    const storageKey = `projects/${projectId}/generated/${layerId}.wav`;
    const storage = getStorage();
    try {
      const buffer = await storage.getBuffer(storageKey, MAX_WAV_BYTES);
      return new NextResponse(new Uint8Array(buffer), {
        status: 200,
        headers: {
          "content-type": "audio/wav",
          "cache-control": "private, max-age=60",
        },
      });
    } catch {
      return NextResponse.json({ error: "Layer not found." }, { status: 404 });
    }
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: "Could not load the layer." }, { status: 500 });
  }
}
