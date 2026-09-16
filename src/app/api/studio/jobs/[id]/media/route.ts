import { studioJobMedia, type StudioBackendOpts } from "@/lib/studio/jobs";

export const dynamic = "force-dynamic";

// Stream a job's generated media. Supports HTTP Range so <video> seeking
// works through the proxy. Demo media is regenerated deterministically.
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const f = url.searchParams.get("f");
  if (!f) return Response.json({ error: "missing ?f= filename" }, { status: 400 });
  const h = req.headers;
  const opts: StudioBackendOpts = {
    wangpUrl: url.searchParams.get("wangpUrl") || h.get("x-studio-wangp-url") || undefined,
    comfyUrl: url.searchParams.get("comfyUrl") || h.get("x-studio-comfy-url") || undefined,
    hostedKey: h.get("x-studio-dashscope-key") || undefined,
  };
  const range = req.headers.get("range");
  try {
    const res = await studioJobMedia(id, f, range, opts);
    if (!res) return Response.json({ error: "file not found" }, { status: 404 });
    if (!res.ok && !res.status.toString().startsWith("2") && res.status !== 206) {
      return Response.json({ error: `backend returned ${res.status}` }, { status: 502 });
    }
    const headers = new Headers();
    const passthrough = ["content-type", "content-length", "content-range", "accept-ranges", "cache-control"];
    for (const k of passthrough) {
      const v = res.headers.get(k);
      if (v) headers.set(k, v);
    }
    if (!headers.has("cache-control")) headers.set("cache-control", "public, max-age=3600");
    return new Response(res.body, { status: res.status, headers });
  } catch (e) {
    const message = e instanceof Error ? e.message : "media fetch failed";
    return Response.json({ error: message }, { status: 502 });
  }
}
