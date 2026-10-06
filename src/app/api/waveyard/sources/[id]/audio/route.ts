import { readWaveyardSourceAudio } from "@/lib/waveyard";

export const dynamic = "force-dynamic";

// GET → serve the stored audio bytes for a source (same-origin playback).
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const audio = await readWaveyardSourceAudio(id);
  if (!audio) return Response.json({ error: "audio not available" }, { status: 404 });
  return new Response(new Uint8Array(audio.bytes), {
    headers: {
      "Content-Type": audio.mediaType,
      "Content-Length": String(audio.bytes.length),
      "Cache-Control": "private, max-age=3600",
      "Content-Disposition": `inline; filename="${encodeURIComponent(audio.name)}"`,
    },
  });
}
