import { deleteWaveyardSource, getWaveyardProject, MAX_UPLOAD_BYTES, ACCEPTED_AUDIO, storeWaveyardSource } from "@/lib/waveyard";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST → upload an audio source (multipart: file, projectId, durationMs, peaks JSON).
// The browser decodes the audio (Web Audio) and computes real waveform peaks;
// the server stores the bytes + metadata. The Waveyard worker's separation /
// analysis pipelines are NOT part of this mount — see the room UI for honest
// availability.
export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    const projectId = String(form.get("projectId") ?? "");
    const durationMs = Number(form.get("durationMs") ?? 0);
    const peaksRaw = form.get("peaks");
    if (!(file instanceof File)) return Response.json({ error: "file required" }, { status: 400 });
    if (!projectId) return Response.json({ error: "projectId required" }, { status: 400 });
    const project = await getWaveyardProject(projectId);
    if (!project) return Response.json({ error: "project not found" }, { status: 404 });
    if (file.size > MAX_UPLOAD_BYTES) {
      return Response.json({ error: `file too large (max ${Math.round(MAX_UPLOAD_BYTES / 1048576)} MB)` }, { status: 413 });
    }
    const mediaType = file.type || "audio/mpeg";
    if (!ACCEPTED_AUDIO.has(mediaType)) {
      return Response.json({ error: `unsupported audio type: ${mediaType}` }, { status: 415 });
    }
    let peaks: { min: number; max: number }[] = [];
    if (typeof peaksRaw === "string") {
      try {
        const parsed = JSON.parse(peaksRaw);
        if (Array.isArray(parsed)) {
          peaks = parsed
            .filter((p: any) => typeof p?.min === "number" && typeof p?.max === "number")
            .slice(0, 4000);
        }
      } catch {}
    }
    const bytes = Buffer.from(await file.arrayBuffer());
    const source = await storeWaveyardSource({
      projectId,
      name: file.name || "audio",
      mediaType,
      bytes,
      durationMs,
      peaks,
    });
    return Response.json({ source }, { status: 201 });
  } catch (e) {
    console.error("waveyard upload failed", e);
    return Response.json({ error: "upload failed" }, { status: 500 });
  }
}

// DELETE ?id= → remove a source and its stored audio
export async function DELETE(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) return Response.json({ error: "id required" }, { status: 400 });
  const ok = await deleteWaveyardSource(id);
  if (!ok) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ ok: true });
}
