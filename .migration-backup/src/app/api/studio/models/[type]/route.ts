import { defaultWangpUrl, wangpModelDetail } from "@/lib/studio/wangp";
import { wangpCatalog } from "@/lib/studio/catalog";
import type { StudioModelDetail, StudioModality } from "@/lib/studio/types";

export const dynamic = "force-dynamic";

// Model detail: live WanGP defaults + schema when the bridge is online,
// otherwise sensible offline defaults for the curated catalog entry.
export async function GET(req: Request, ctx: { params: Promise<{ type: string }> }) {
  const { type } = await ctx.params;
  const url = new URL(req.url);
  const wangpUrl = url.searchParams.get("wangpUrl") || defaultWangpUrl();

  try {
    const detail = await wangpModelDetail(type, wangpUrl);
    return Response.json({ detail, live: true });
  } catch {
    const entry = wangpCatalog().find((m) => m.modelType === type);
    if (!entry) return Response.json({ error: "unknown model" }, { status: 404 });
    const modality = entry.modality as StudioModality;
    const defaults: Record<string, unknown> =
      modality === "video"
        ? {
            model_type: type,
            resolution: "832x480",
            num_inference_steps: 20,
            duration_seconds: 5,
            force_fps: 16,
          }
        : modality === "image"
          ? { model_type: type, resolution: "1024x1024", num_inference_steps: 20 }
          : { model_type: type, duration_seconds: 6 };
    const detail: StudioModelDetail = {
      modelType: type,
      name: entry.name,
      modality,
      source: "demo",
      defaults,
      notes: [
        "Offline defaults — connect the WanGP bridge to load this model's real settings schema.",
        entry.description || "",
      ].filter(Boolean),
    };
    return Response.json({ detail, live: false });
  }
}
