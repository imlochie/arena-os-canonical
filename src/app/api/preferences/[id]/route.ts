import { deletePreference } from "@/lib/preferences";

export const dynamic = "force-dynamic";

// DELETE → forget a preference
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ok = await deletePreference(id);
  if (!ok) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ ok: true });
}
