import { defaultWangpUrl, wangpModels } from "@/lib/studio/wangp";
import { comfyModels } from "@/lib/studio/comfyui";
import { hostedModelCatalog } from "@/lib/studio/hosted";
import { wangpCatalog } from "@/lib/studio/catalog";
import type { StudioModelInfo } from "@/lib/studio/types";

export const dynamic = "force-dynamic";

// Merged model catalog. If the WanGP bridge is online we use WanGP's own live
// model metadata; otherwise the curated offline catalog stands in (marked
// source "demo" so the UI can badge it). ComfyUI templates + hosted models
// are always listed.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const modalityParam = url.searchParams.get("modality") || undefined;
  const modality =
    modalityParam === "video" || modalityParam === "image" || modalityParam === "audio" ? modalityParam : undefined;
  const wangpUrl = url.searchParams.get("wangpUrl") || defaultWangpUrl();

  let wangpOnline = false;
  let wangpList: StudioModelInfo[] = [];
  try {
    wangpList = await wangpModels(modality, wangpUrl);
    wangpOnline = true;
  } catch {
    wangpList = [];
  }

  const demoList = wangpCatalog(modality).map((m) => ({ ...m, source: "demo" as const }));
  const comfyList = comfyModels(modality);
  const hostedList = hostedModelCatalog(modality);

  return Response.json({
    wangpOnline,
    models: {
      wangp: wangpOnline ? wangpList : [],
      demo: wangpOnline ? [] : demoList,
      comfyui: comfyList,
      dashscope: hostedList,
    },
    // WanGP attribution (required by WanGP terms for integrations)
    attribution: {
      product: "WanGP (Wan2GP)",
      author: "DeepBeepMeep",
      url: "https://github.com/deepbeepmeep/Wan2GP",
    },
  });
}
