import { deleteWaveyardProject, getWaveyardProject, updateWaveyardProject } from "@/lib/waveyard";

export const dynamic = "force-dynamic";

// GET → project detail (sources + versions) · PATCH → update · DELETE → remove
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await getWaveyardProject(id);
  if (!data) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json(data);
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const body = await req.json().catch(() => ({}));
    const project = await updateWaveyardProject(id, {
      ...(body.title !== undefined ? { title: String(body.title) } : {}),
      ...(body.notes !== undefined ? { notes: String(body.notes) } : {}),
      ...(body.bpm !== undefined ? { bpm: body.bpm == null ? null : Number(body.bpm) } : {}),
      ...(body.musicalKey !== undefined ? { musicalKey: body.musicalKey == null ? null : String(body.musicalKey) } : {}),
    });
    if (!project) return Response.json({ error: "not found" }, { status: 404 });
    return Response.json({ project });
  } catch {
    return Response.json({ error: "update failed" }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ok = await deleteWaveyardProject(id);
  if (!ok) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ ok: true });
}
