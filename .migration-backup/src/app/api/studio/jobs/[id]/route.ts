import { refreshStudioJob, type StudioBackendOpts } from "@/lib/studio/jobs";

export const dynamic = "force-dynamic";

// Poll a job: refreshes from its backend (bridge poll / ComfyUI history /
// hosted task / demo simulation) and returns the latest snapshot.
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const h = req.headers;
  const opts: StudioBackendOpts = {
    wangpUrl: h.get("x-studio-wangp-url") || undefined,
    comfyUrl: h.get("x-studio-comfy-url") || undefined,
    hostedKey: h.get("x-studio-dashscope-key") || undefined,
    hostedRegion: h.get("x-studio-dashscope-region") || undefined,
  };
  try {
    const job = await refreshStudioJob(id, opts);
    if (!job) return Response.json({ error: "job not found" }, { status: 404 });
    return Response.json({ job });
  } catch (e) {
    const message = e instanceof Error ? e.message : "poll failed";
    return Response.json({ error: message }, { status: 502 });
  }
}
