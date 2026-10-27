import { isUuid } from "@workspace/arena/lib/api/ids";
/**
 * Serve a sound-design asset WAV from project storage.
 * Ids are validated UUIDs and re-checked against the DB row — containment
 * by construction.
 */


import { and, eq } from "drizzle-orm";

import { db } from "@workspace/db";
import { soundDesignAssets } from "@workspace/db/waveyardSchema";
import { requireProjectRole, requireUser } from "@workspace/arena/lib/waveyard/local-context";
import { getStorage } from "@workspace/arena/lib/waveyard/storage";

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
    if (!isUuid(projectId) || !isUuid(assetId)) return Response.json({ error: "Invalid id parameter" }, { status: 400 });
    await requireProjectRole(user.id, projectId, "viewer");
    if (!UUID_RE.test(assetId))
      return Response.json({ error: "Invalid asset id." }, { status: 400 });
    const [row] = await db
      .select({ storageKey: soundDesignAssets.storageKey })
      .from(soundDesignAssets)
      .where(and(eq(soundDesignAssets.id, assetId), eq(soundDesignAssets.projectId, projectId)))
      .limit(1);
    if (row === undefined)
      return Response.json({ error: "Asset not found." }, { status: 404 });
    try {
      const buffer = await getStorage().getBuffer(row.storageKey, MAX_WAV_BYTES);
      return new Response(new Uint8Array(buffer), {
        status: 200,
        headers: { "content-type": "audio/wav", "cache-control": "private, max-age=60" },
      });
    } catch {
      return Response.json({ error: "Audio not found." }, { status: 404 });
    }
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: "Could not load the asset." }, { status: 500 });
  }
}
