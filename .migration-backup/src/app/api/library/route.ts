import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { mediaLibraryItems } from "@/db/schema";
import {
  LOCAL_PROVIDER_KIND,
  ensurePlayableCopy,
  getLocalItem,
  getTranscodeState,
  recordWatchProgress,
  resolvePlayability,
} from "@/lib/mediaArchive/local";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * The local library API — the Plex-free watch path.
 *   GET  /api/library            → all local items (the shelf)
 *   GET  /api/library?id=12      → one item + playability + transcode state
 *   POST {action:"progress"}     → Arena's OWN watch state
 *   POST {action:"transcode"}    → build a browser-playable copy (Toolbox engine)
 */

function toShelfItem(row: typeof mediaLibraryItems.$inferSelect) {
  const raw = (row.raw ?? {}) as Record<string, unknown>;
  return {
    id: row.id,
    title: row.title,
    year: row.year,
    itemType: row.itemType,
    libraryName: row.libraryName,
    durationMs: row.durationMs,
    viewCount: row.viewCount,
    viewOffsetMs: row.viewOffsetMs,
    lastViewedAt: row.lastViewedAt,
    fileName: typeof raw.filePath === "string" ? (raw.filePath.split("/").pop() ?? "") : "",
    videoCodec: typeof raw.videoCodec === "string" ? raw.videoCodec : null,
  };
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const idRaw = url.searchParams.get("id");
    if (idRaw !== null) {
      const id = Number(idRaw);
      if (!Number.isInteger(id) || id <= 0) {
        return Response.json({ error: "bad_input", message: "id must be a positive integer." }, { status: 400 });
      }
      const item = await getLocalItem(id);
      if (!item) {
        return Response.json({ error: "not_found", message: "No local library item with that id." }, { status: 404 });
      }
      const playability = await resolvePlayability(item);
      return Response.json({
        item: toShelfItem(item),
        playability,
        transcode: getTranscodeState(id),
        streamUrl: `/api/library/stream/${id}`,
      });
    }
    const rows = await db
      .select()
      .from(mediaLibraryItems)
      .where(eq(mediaLibraryItems.providerKind, LOCAL_PROVIDER_KIND))
      .orderBy(desc(mediaLibraryItems.updatedAt))
      .limit(200);
    return Response.json({ items: rows.map(toShelfItem) });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "library_failed", message: String((e as Error)?.message ?? e).slice(0, 200) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "bad_input", message: "JSON body required." }, { status: 400 });
  }
  const action = String(body.action ?? "");
  const itemId = Number(body.itemId ?? 0);

  try {
    if (action === "progress") {
      if (!Number.isInteger(itemId) || itemId <= 0) {
        return Response.json({ error: "bad_input", message: "itemId must be a positive integer." }, { status: 400 });
      }
      const positionMs = Number(body.positionMs ?? NaN);
      if (!Number.isFinite(positionMs) || positionMs < 0) {
        return Response.json({ error: "bad_input", message: "positionMs must be a non-negative number." }, { status: 400 });
      }
      const result = await recordWatchProgress({
        itemId,
        positionMs,
        durationMs: body.durationMs === undefined ? undefined : Number(body.durationMs),
        finished: body.finished === true,
      });
      return Response.json(result);
    }
    if (action === "transcode") {
      if (!Number.isInteger(itemId) || itemId <= 0) {
        return Response.json({ error: "bad_input", message: "itemId must be a positive integer." }, { status: 400 });
      }
      const item = await getLocalItem(itemId);
      if (!item) {
        return Response.json({ error: "not_found", message: "No local library item with that id." }, { status: 404 });
      }
      const playability = await resolvePlayability(item);
      if (playability.mode === "direct") {
        return Response.json({ skipped: true, reason: "This file already plays natively in browsers." });
      }
      const state = await ensurePlayableCopy(item);
      return Response.json({ transcode: state });
    }
    return Response.json({ error: "bad_input", message: "Unknown action." }, { status: 400 });
  } catch (e) {
    return Response.json({ error: "action_failed", message: String((e as Error)?.message ?? e).slice(0, 300) }, { status: 400 });
  }
}
