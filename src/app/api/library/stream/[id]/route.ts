import { parseByteRange } from "@/lib/http/range";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { getLocalItem, mimeForFile, resolveStreamFile } from "@/lib/mediaArchive/local";

export const dynamic = "force-dynamic";

/**
 * Range-capable streaming for local library items — the "watch your own
 * files without Plex" endpoint. Serves the fresh transcode cache when one
 * exists, else the source file. Only files inside the configured local
 * library root can ever be served (realpath-checked).
 */


async function serve(req: Request, idRaw: string, includeBody: boolean): Promise<Response> {
  const id = Number(idRaw);
  if (!Number.isInteger(id) || id <= 0) {
    return Response.json({ error: "bad_input", message: "Item id must be a positive integer." }, { status: 400 });
  }
  const item = await getLocalItem(id);
  if (!item) {
    return Response.json({ error: "not_found", message: "No local library item with that id." }, { status: 404 });
  }
  const resolved = await resolveStreamFile(item);
  if (!resolved) {
    return Response.json(
      { error: "not_found", message: "The item's file is gone or outside the local library root." },
      { status: 404 },
    );
  }

  const info = await stat(resolved.path).catch(() => null);
  if (!info || !info.isFile()) {
    return Response.json({ error: "not_found", message: "The file is gone." }, { status: 404 });
  }

  const contentType = resolved.fromCache ? "video/mp4" : mimeForFile(resolved.path);
  const range = parseByteRange(req.headers.get("range"), info.size);

  if (range === "invalid") {
    return new Response(null, {
      status: 416,
      headers: { "content-range": `bytes */${info.size}`, "accept-ranges": "bytes" },
    });
  }

  if (range === null) {
    const headers = new Headers({
      "content-type": contentType,
      "content-length": String(info.size),
      "accept-ranges": "bytes",
      "cache-control": "no-store",
      "x-stream-source": resolved.fromCache ? "transcode-cache" : "source-file",
    });
    if (!includeBody) return new Response(null, { status: 200, headers });
    const stream = Readable.toWeb(createReadStream(resolved.path)) as ReadableStream<Uint8Array>;
    return new Response(stream, { status: 200, headers });
  }

  const headers = new Headers({
    "content-type": contentType,
    "content-length": String(range.end - range.start + 1),
    "content-range": `bytes ${range.start}-${range.end}/${info.size}`,
    "accept-ranges": "bytes",
    "cache-control": "no-store",
    "x-stream-source": resolved.fromCache ? "transcode-cache" : "source-file",
  });
  if (!includeBody) return new Response(null, { status: 206, headers });
  const stream = Readable.toWeb(
    createReadStream(resolved.path, { start: range.start, end: range.end }),
  ) as ReadableStream<Uint8Array>;
  return new Response(stream, { status: 206, headers });
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  return serve(req, id, true);
}

export async function HEAD(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  return serve(req, id, false);
}
