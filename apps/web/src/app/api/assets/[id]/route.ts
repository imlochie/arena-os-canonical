import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb, sourceAssets, stemAssets } from "@waveyard/database";
import { getStorage } from "@waveyard/storage";
import { requireUser } from "@/lib/auth";
import { requireProjectRole } from "@/lib/permissions";

export const runtime = "nodejs";
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(); const { id } = await params; const db = getDb();
    const [stem] = await db.select().from(stemAssets).where(eq(stemAssets.id, id)).limit(1);
    const [source] = stem ? [undefined] : await db.select().from(sourceAssets).where(eq(sourceAssets.id, id)).limit(1);
    const asset = stem ?? source;
    if (!asset) return NextResponse.json({ error: "Audio asset not found." }, { status: 404 });
    await requireProjectRole(user.id, asset.projectId, "viewer");
    const download = new URL(request.url).searchParams.get("download") === "1";
    const downloadName = source ? source.originalFilename : `${stem!.stemType}.wav`;
    const storage = getStorage();
    const signed = await storage.createDownloadUrl(asset.storageKey, 60, download ? downloadName : undefined);
    if (signed) return NextResponse.redirect(signed);
    const localPath = storage.getLocalPath(asset.storageKey);
    if (!localPath) return NextResponse.json({ error: "Storage cannot serve this asset." }, { status: 500 });
    const file = await stat(localPath); const range = request.headers.get("range"); const contentType = stem ? "audio/wav" : (source?.mimeType ?? "application/octet-stream");
    if (range) {
      const [startRaw, endRaw] = range.replace(/bytes=/, "").split("-"); const start = Number(startRaw); const end = endRaw ? Number(endRaw) : file.size - 1;
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end >= file.size || start > end) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${file.size}` } });
      return new Response(Readable.toWeb(createReadStream(localPath, { start, end })) as ReadableStream, { status: 206, headers: { "Content-Type": contentType, "Content-Length": String(end - start + 1), "Content-Range": `bytes ${start}-${end}/${file.size}`, "Accept-Ranges": "bytes", "Cache-Control": "private, no-store", ...(download ? { "Content-Disposition": `attachment; filename="${downloadName.replace(/[\\"\r\n]/g, "_")}"` } : {}) } });
    }
    return new Response(Readable.toWeb(createReadStream(localPath)) as ReadableStream, { headers: { "Content-Type": contentType, "Content-Length": String(file.size), "Accept-Ranges": "bytes", "Cache-Control": "private, no-store", ...(download ? { "Content-Disposition": `attachment; filename="${downloadName.replace(/[\\"\r\n]/g, "_")}"` } : {}) } });
  } catch (error) { if (error instanceof Response) return error; console.error("asset stream failed", error); return NextResponse.json({ error: "Audio could not be read." }, { status: 500 }); }
}
