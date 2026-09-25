import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { exportAssets, exportJobs, getDb } from "@waveyard/database";
import { getStorage } from "@waveyard/storage";
import { requireUser } from "@/lib/auth";
import { requireProjectRole } from "@/lib/permissions";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const db = getDb();
    const [job] = await db
      .select()
      .from(exportJobs)
      .where(eq(exportJobs.id, id))
      .limit(1);
    if (!job)
      return NextResponse.json({ error: "Export job not found." }, { status: 404 });
    await requireProjectRole(user.id, job.projectId, "viewer");
    const [asset] = await db
      .select()
      .from(exportAssets)
      .where(eq(exportAssets.exportJobId, job.id))
      .limit(1);
    if (!asset)
      return NextResponse.json(
        { error: "Export media is not available." },
        { status: 409 },
      );

    const download = new URL(request.url).searchParams.get("download") === "1";
    const storage = getStorage();
    const signed = await storage.createDownloadUrl(
      asset.storageKey,
      60,
      download ? asset.filename : undefined,
    );
    if (signed) return NextResponse.redirect(signed);

    const localPath = storage.getLocalPath(asset.storageKey);
    if (!localPath)
      return NextResponse.json(
        { error: "Storage cannot serve this export." },
        { status: 500 },
      );
    const file = await stat(localPath);
    const range = request.headers.get("range");
    const disposition: Record<string, string> = download
      ? {
          "Content-Disposition": `attachment; filename="${asset.filename.replace(/[\\"\r\n]/g, "_")}"`,
        }
      : {};
    if (range) {
      const [startRaw, endRaw] = range.replace(/bytes=/, "").split("-");
      const start = Number(startRaw);
      const end = endRaw ? Number(endRaw) : file.size - 1;
      if (
        !Number.isInteger(start) ||
        !Number.isInteger(end) ||
        start < 0 ||
        end >= file.size ||
        start > end
      )
        return new Response(null, {
          status: 416,
          headers: { "Content-Range": `bytes */${file.size}` },
        });
      return new Response(
        Readable.toWeb(createReadStream(localPath, { start, end })) as ReadableStream,
        {
          status: 206,
          headers: {
            "Content-Type": "audio/wav",
            "Content-Length": String(end - start + 1),
            "Content-Range": `bytes ${start}-${end}/${file.size}`,
            "Accept-Ranges": "bytes",
            "Cache-Control": "private, no-store",
            ...disposition,
          },
        },
      );
    }
    return new Response(Readable.toWeb(createReadStream(localPath)) as ReadableStream, {
      headers: {
        "Content-Type": "audio/wav",
        "Content-Length": String(file.size),
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, no-store",
        ...disposition,
      },
    });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("export stream failed", error);
    return NextResponse.json(
      { error: "Export media could not be read." },
      { status: 500 },
    );
  }
}
