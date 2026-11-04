import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { requireUser } from "@workspace/arena/lib/waveyard/local-context";
import { getRecoverableAudioCapture } from "../../../../../../lib/waveyard/audio-capture-manager";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseRange(header: string | null, size: number): { start: number; end: number } | "invalid" | null {
  if (!header) return null;
  const match = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (!match[1] && !match[2]) || size <= 0) return "invalid";
  let start: number;
  let end: number;
  if (!match[1]) {
    const length = Number(match[2]);
    if (!Number.isSafeInteger(length) || length <= 0) return "invalid";
    start = Math.max(0, size - length);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size) {
    return "invalid";
  }
  return { start, end };
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const capture = await getRecoverableAudioCapture(user.id, id);
    if (!capture) return Response.json({ error: "No interrupted recording was found for this user." }, { status: 404 });

    const file = await stat(capture.path).catch(() => null);
    if (!file?.isFile()) return Response.json({ error: "The preserved recording file is no longer available." }, { status: 404 });

    const range = parseRange(request.headers.get("range"), file.size);
    if (range === "invalid") {
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${file.size}`, "Accept-Ranges": "bytes" },
      });
    }

    const headers = new Headers({
      "Content-Type": "audio/wav",
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, no-store",
      "Content-Disposition": "inline",
    });
    if (range) {
      headers.set("Content-Length", String(range.end - range.start + 1));
      headers.set("Content-Range", `bytes ${range.start}-${range.end}/${file.size}`);
      return new Response(
        Readable.toWeb(createReadStream(capture.path, { start: range.start, end: range.end })) as ReadableStream<Uint8Array>,
        { status: 206, headers },
      );
    }

    headers.set("Content-Length", String(file.size));
    return new Response(
      Readable.toWeb(createReadStream(capture.path)) as ReadableStream<Uint8Array>,
      { headers },
    );
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not preview the preserved recording." },
      { status: 500 },
    );
  }
}
