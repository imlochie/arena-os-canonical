import { defaultWangpUrl, wangpHealth } from "@/lib/studio/wangp";
import { defaultComfyUrl, comfyHealth } from "@/lib/studio/comfyui";
import type { StudioBackendStatus } from "@/lib/studio/types";

export const dynamic = "force-dynamic";

// Probe every Studio backend. Local backends (bridge / ComfyUI) never leave
// the machine; the hosted path is strictly BYOK and only used on request.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const wangpUrl = url.searchParams.get("wangpUrl") || defaultWangpUrl();
  const comfyUrl = url.searchParams.get("comfyUrl") || defaultComfyUrl();

  const [wangp, comfyui] = await Promise.all([
    wangpHealth(wangpUrl)
      .then((h) => ({ online: true, url: wangpUrl, detail: h.mock ? "bridge (mock)" : "bridge · WanGP", version: h.wangp_version }))
      .catch(() => ({ online: false, url: wangpUrl, detail: "not running — demo mode covers generation" })),
    comfyHealth(comfyUrl)
      .then((h) => ({ online: true, url: comfyUrl, detail: "ComfyUI", version: h.version }))
      .catch(() => ({ online: false, url: comfyUrl, detail: "not running" })),
  ]);

  const statuses: StudioBackendStatus[] = [
    { backend: "wangp", ...wangp },
    { backend: "comfyui", ...comfyui },
    { backend: "dashscope", online: false, url: "dashscope", detail: "BYOK — add a key in Studio settings" },
    { backend: "demo", online: true, url: "local", detail: "procedural previews — always available" },
  ];

  return Response.json({ backends: statuses });
}
