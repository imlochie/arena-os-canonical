import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import {
  MAX_INPUT_BYTES,
  createConversionJob,
  deleteJob,
  detectHardwareEncoder,
  getJob,
  listJobs,
  probeSource,
  storeUpload,
} from "@/lib/toolbox/convert";
import { isPresetId, presetCatalog } from "@/lib/toolbox/presets";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MIME: Record<string, string> = {
  mp4: "video/mp4",
  mkv: "video/x-matroska",
  webm: "video/webm",
  gif: "image/gif",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  opus: "audio/opus",
  wav: "audio/wav",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

// GET → job queue + hardware probe + preset catalog
export async function GET(req: Request) {
  const url = new URL(req.url);
  if (url.searchParams.get("file") === "1") {
    const id = url.searchParams.get("id") ?? "";
    const job = getJob(id);
    if (!job || job.status !== "done" || !job.outputPath) {
      return Response.json({ error: "not_found", message: "No finished output for that job." }, { status: 404 });
    }
    try {
      const info = await stat(job.outputPath);
      const ext = job.outputName.split(".").pop()?.toLowerCase() ?? "";
      const stream = Readable.toWeb(createReadStream(job.outputPath)) as ReadableStream<Uint8Array>;
      return new Response(stream, {
        headers: {
          "content-type": MIME[ext] ?? "application/octet-stream",
          "content-length": String(info.size),
          "content-disposition": `attachment; filename="${job.outputName.replace(/"/g, "")}"`,
          "cache-control": "no-store",
        },
      });
    } catch {
      return Response.json({ error: "not_found", message: "Output file is gone." }, { status: 404 });
    }
  }
  const hardware = await detectHardwareEncoder();
  return Response.json({
    jobs: listJobs(),
    hardware,
    presets: presetCatalog(),
  });
}

// POST — multipart upload (probe only, nothing converts until asked), or
// JSON {action: convert|delete}.
export async function POST(req: Request) {
  const contentType = req.headers.get("content-type") ?? "";

  if (contentType.includes("multipart/form-data")) {
    try {
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) {
        return Response.json({ error: "bad_input", message: "file field is required." }, { status: 400 });
      }
      if (file.size <= 0 || file.size > MAX_INPUT_BYTES) {
        return Response.json({ error: "bad_input", message: "File must be between 1 byte and 2 GB." }, { status: 413 });
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      const stored = await storeUpload({ name: file.name || "upload", bytes });
      try {
        const probe = await probeSource(stored.path);
        return Response.json({ ...stored, probe }, { status: 201 });
      } catch (error) {
        // ffmpeg genuinely can't parse it — say so instead of pretending.
        await import("node:fs/promises").then((fs) => fs.rm(stored.path, { force: true }).catch(() => {}));
        return Response.json(
          { error: "not_media", message: `ffmpeg can't read this file as media — ${String((error as Error)?.message ?? error).slice(0, 140)}` },
          { status: 400 },
        );
      }
    } catch (e) {
      console.error(e);
      return Response.json({ error: "upload_failed", message: String((e as Error)?.message ?? e).slice(0, 200) }, { status: 500 });
    }
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "bad_input", message: "JSON body required." }, { status: 400 });
  }
  const action = String(body.action ?? "");

  try {
    if (action === "convert") {
      const presetId = String(body.presetId ?? "");
      if (presetId !== "custom" && !isPresetId(presetId)) {
        return Response.json({ error: "bad_input", message: "Unknown preset." }, { status: 400 });
      }
      const custom =
        presetId === "custom"
          ? {
              width: body.width === undefined ? undefined : Number(body.width),
              fps: body.fps === undefined ? undefined : Number(body.fps),
              quality: body.quality === undefined ? undefined : Number(body.quality),
              targetExt: body.targetExt === undefined ? undefined : String(body.targetExt),
            }
          : undefined;
      const job = await createConversionJob({
        path: String(body.path ?? ""),
        name: String(body.name ?? "file"),
        presetId: presetId === "custom" ? "custom" : (presetId as never),
        custom,
      });
      return Response.json({ job }, { status: 201 });
    }
    if (action === "delete") {
      const removed = await deleteJob(String(body.id ?? ""));
      if (!removed) {
        return Response.json({ error: "not_deletable", message: "Job not found or still running." }, { status: 409 });
      }
      return Response.json({ removed: true });
    }
    return Response.json({ error: "bad_input", message: "Unknown action." }, { status: 400 });
  } catch (e) {
    return Response.json({ error: "convert_failed", message: String((e as Error)?.message ?? e).slice(0, 300) }, { status: 400 });
  }
}
