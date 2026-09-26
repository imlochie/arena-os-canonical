import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { getStorage } from "@waveyard/storage";
import { publicProjectResolution } from "@/lib/publication";

export const runtime = "nodejs";

function parseRange(value: string | null, size: number) {
  if (!value) return null;
  const match = /^bytes=(\d+)-(\d*)$/.exec(value);
  if (!match) return undefined;
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end >= size)
    return undefined;
  return { start, end };
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { project, asset } = await publicProjectResolution(id);
    const wantsDownload = new URL(request.url).searchParams.get("download") === "1";
    if (wantsDownload && project.downloadPermission !== "public")
      return NextResponse.json({ error: "Public download is not enabled for this release." }, { status: 403 });
    const range = parseRange(request.headers.get("range"), asset.fileSizeBytes);
    if (range === undefined)
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${asset.fileSizeBytes}` },
      });
    const read = await getStorage().openReadStream(asset.storageKey, range ?? undefined);
    const headers: Record<string, string> = {
      "Content-Type": "audio/wav",
      "Content-Length": String(range ? range.end - range.start + 1 : read.size),
      "Accept-Ranges": "bytes",
      "Cache-Control": "public, max-age=60",
      "X-Content-Type-Options": "nosniff",
    };
    if (range) headers["Content-Range"] = `bytes ${range.start}-${range.end}/${read.size}`;
    if (wantsDownload)
      headers["Content-Disposition"] = `attachment; filename="${asset.filename.replace(/[\\"\r\n]/g, "_")}"`;
    return new Response(Readable.toWeb(read.stream) as ReadableStream, {
      status: range ? 206 : 200,
      headers,
    });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("public release stream failed", error);
    return NextResponse.json({ error: "Public release could not be read." }, { status: 500 });
  }
}
