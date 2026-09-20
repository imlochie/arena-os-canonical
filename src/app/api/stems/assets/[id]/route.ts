import { eq } from "drizzle-orm";
import { db } from "@/db";
import { stemAssets } from "@/db/schema";
import { requireStemUser } from "@/lib/stems/auth";
import { requireStemProjectRole } from "@/lib/stems/permissions";
import { getStemStorage } from "@/lib/stems/storage";

export const runtime = "nodejs";

function requestedRange(header: string | null, size: number) {
  if (!header) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireStemUser();
    const { id } = await params;
    const [asset] = await db.select().from(stemAssets).where(eq(stemAssets.id, id)).limit(1);
    if (!asset) return Response.json({ error: "Stem asset not found." }, { status: 404 });
    await requireStemProjectRole(user.id, asset.projectId, "viewer");
    const range = requestedRange(request.headers.get("range"), asset.fileSizeBytes);
    if (range === null) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${asset.fileSizeBytes}` } });
    const object = await getStemStorage().read(asset.storageKey, range);
    // Copy into a browser-compatible ArrayBuffer rather than exposing a Node
    // Buffer backing store through the Response body.
    return new Response(new Uint8Array(object.bytes).buffer, {
      status: range ? 206 : 200,
      headers: {
        "Content-Type": "audio/wav",
        "Content-Length": String(object.bytes.byteLength),
        "Accept-Ranges": "bytes",
        ...(object.contentRange ? { "Content-Range": object.contentRange } : {}),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("Stem asset delivery failed", error);
    return Response.json({ error: "Could not read this private stem asset." }, { status: 500 });
  }
}
