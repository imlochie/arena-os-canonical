import { isUuid } from "@workspace/arena/lib/api/ids";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";

import { eq } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  sourceAssets,
  stemAssets,
} from "@workspace/db/waveyardSchema";
import { getStorage } from "@workspace/arena/lib/waveyard/storage";
import { requireUser } from "@workspace/arena/lib/waveyard/local-context";
import { requireProjectRole } from "@workspace/arena/lib/waveyard/local-context";

export const runtime = "nodejs";
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(); const { id } = await params; 
    if (!isUuid(id)) return Response.json({ error: "Invalid id parameter" }, { status: 400 });
    const [stem] = await db.select().from(stemAssets).where(eq(stemAssets.id, id)).limit(1);
    const [source] = stem ? [undefined] : await db.select().from(sourceAssets).where(eq(sourceAssets.id, id)).limit(1);
    const asset = stem ?? source;
    if (!asset) return Response.json({ error: "Audio asset not found." }, { status: 404 });
    await requireProjectRole(user.id, asset.projectId, "viewer");
    const download = new URL(request.url).searchParams.get("download") === "1";
    const range = request.headers.get("range");
    const downloadName = source ? source.originalFilename : `${stem!.stemType}.wav`;
    const storage = getStorage();
    const signed = await storage.createDownloadUrl(asset.storageKey, 60, download ? downloadName : undefined);
    if (signed) {
      if (!range) return Response.redirect(signed);
      const upstream = await fetch(signed, { headers: { Range: range }, cache: "no-store" });
      if (upstream.status !== 206 || !upstream.body) {
        return Response.json({ error: "Audio storage does not support bounded preview reads." }, { status: 502 });
      }
      const headers = new Headers({
        "Content-Type": source ? (source.mimeType ?? "application/octet-stream") : "audio/wav",
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, no-store",
      });
      const contentLength = upstream.headers.get("content-length");
      const contentRange = upstream.headers.get("content-range");
      if (contentLength) headers.set("Content-Length", contentLength);
      if (contentRange) headers.set("Content-Range", contentRange);
      return new Response(upstream.body, {
        status: 206,
        headers,
      });
    }
    const localPath = storage.getLocalPath(asset.storageKey);
    if (!localPath) return Response.json({ error: "Storage cannot serve this asset." }, { status: 500 });
    const file = await stat(localPath); const contentType = stem ? "audio/wav" : (source?.mimeType ?? "application/octet-stream");
    if (range) {
      const [startRaw, endRaw] = range.replace(/bytes=/, "").split("-"); const start = Number(startRaw); const end = endRaw ? Number(endRaw) : file.size - 1;
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end >= file.size || start > end) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${file.size}` } });
      return new Response(Readable.toWeb(createReadStream(localPath, { start, end })) as ReadableStream, { status: 206, headers: { "Content-Type": contentType, "Content-Length": String(end - start + 1), "Content-Range": `bytes ${start}-${end}/${file.size}`, "Accept-Ranges": "bytes", "Cache-Control": "private, no-store", ...(download ? { "Content-Disposition": `attachment; filename="${downloadName.replace(/[\\"\r\n]/g, "_")}"` } : {}) } });
    }
    return new Response(Readable.toWeb(createReadStream(localPath)) as ReadableStream, { headers: { "Content-Type": contentType, "Content-Length": String(file.size), "Accept-Ranges": "bytes", "Cache-Control": "private, no-store", ...(download ? { "Content-Disposition": `attachment; filename="${downloadName.replace(/[\\"\r\n]/g, "_")}"` } : {}) } });
  } catch (error) { if (error instanceof Response) return error; console.error("asset stream failed", error); return Response.json({ error: "Audio could not be read." }, { status: 500 }); }
}
