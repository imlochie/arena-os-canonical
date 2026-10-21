import { attachmentDisposition } from "@/lib/http/download";
import { parseByteRange } from "@/lib/http/range";
import { isUuid } from "@/lib/api/ids";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import {
  sourceAssets,
  stemAssets,
} from "@/db/waveyardSchema";
import { getStorage } from "@/lib/waveyard/storage";
import { requireUser } from "@/lib/waveyard/local-context";
import { requireProjectRole } from "@/lib/waveyard/local-context";

export const runtime = "nodejs";
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(); const { id } = await params; 
    if (!isUuid(id)) return NextResponse.json({ error: "Invalid id parameter" }, { status: 400 });
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
    const file = await stat(localPath); const range = parseByteRange(request.headers.get("range"), file.size); const contentType = stem ? (stem.engine === "passthrough-unseparated" ? stem.format : "audio/wav") : (source?.mimeType ?? "application/octet-stream");
    if (range === "invalid") return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${file.size}`, "Accept-Ranges": "bytes" } });
    if (range) {
      const { start, end } = range;
      return new Response(Readable.toWeb(createReadStream(localPath, { start, end })) as ReadableStream, { status: 206, headers: { "Content-Type": contentType, "Content-Length": String(end - start + 1), "Content-Range": `bytes ${start}-${end}/${file.size}`, "Accept-Ranges": "bytes", "Cache-Control": "private, no-store", ...(download ? { "Content-Disposition": attachmentDisposition(downloadName) } : {}) } });
    }
    return new Response(Readable.toWeb(createReadStream(localPath)) as ReadableStream, { headers: { "Content-Type": contentType, "Content-Length": String(file.size), "Accept-Ranges": "bytes", "Cache-Control": "private, no-store", ...(download ? { "Content-Disposition": attachmentDisposition(downloadName) } : {}) } });
  } catch (error) { if (error instanceof Response) return error; console.error("asset stream failed", error); return NextResponse.json({ error: "Audio could not be read." }, { status: 500 }); }
}
