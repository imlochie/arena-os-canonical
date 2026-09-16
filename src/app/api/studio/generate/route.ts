import { submitStudioJob, type CreateJobInput, type StudioBackendOpts } from "@/lib/studio/jobs";
import { logPrivacyEvent } from "@/lib/privacy";
import type { StudioBackend, StudioModality } from "@/lib/studio/types";

export const dynamic = "force-dynamic";

const BACKENDS = new Set(["wangp", "comfyui", "dashscope", "demo"]);
const MODALITIES = new Set(["video", "image", "audio"]);

function backendOpts(body: any, req: Request): StudioBackendOpts {
  const h = req.headers;
  return {
    wangpUrl: body?.backends?.wangpUrl || h.get("x-studio-wangp-url") || undefined,
    comfyUrl: body?.backends?.comfyUrl || h.get("x-studio-comfy-url") || undefined,
    hostedKey: body?.backends?.dashscopeKey || h.get("x-studio-dashscope-key") || undefined,
    hostedRegion: body?.backends?.dashscopeRegion || h.get("x-studio-dashscope-region") || undefined,
  };
}

export async function POST(req: Request) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const backend = String(body?.backend ?? "demo") as StudioBackend;
  const modality = String(body?.modality ?? "video") as StudioModality;
  if (!BACKENDS.has(backend)) return Response.json({ error: `unknown backend "${backend}"` }, { status: 400 });
  if (!MODALITIES.has(modality)) return Response.json({ error: `unknown modality "${modality}"` }, { status: 400 });
  if (!body?.modelType) return Response.json({ error: "modelType is required" }, { status: 400 });
  if (!String(body?.prompt ?? "").trim()) return Response.json({ error: "prompt is required" }, { status: 400 });

  const input: CreateJobInput = {
    backend,
    modality,
    modelType: String(body.modelType),
    modelName: body.modelName ? String(body.modelName) : undefined,
    prompt: String(body.prompt),
    negativePrompt: body.negativePrompt ? String(body.negativePrompt) : "",
    seed: body.seed === null || body.seed === undefined ? null : Number(body.seed),
    width: body.width ? Number(body.width) : undefined,
    height: body.height ? Number(body.height) : undefined,
    resolution: body.resolution ? String(body.resolution) : undefined,
    durationSeconds: body.durationSeconds ? Number(body.durationSeconds) : undefined,
    steps: body.steps ? Number(body.steps) : undefined,
    guidance: body.guidance !== undefined && body.guidance !== null ? Number(body.guidance) : undefined,
    fps: body.fps ? Number(body.fps) : undefined,
    size: body.size ? String(body.size) : undefined,
    settings: (body.settings && typeof body.settings === "object" ? body.settings : undefined) as
      | Record<string, unknown>
      | undefined,
    workflowJson: body.workflowJson ? String(body.workflowJson) : undefined,
    projectId: body.projectId ? String(body.projectId) : null,
  };

  try {
    const job = await submitStudioJob(input, backendOpts(body, req));
    // Privacy audit (metadata only, never content): the hosted path is the
    // only Studio backend that sends prompt content off-machine (BYOK).
    void logPrivacyEvent(
      backend === "dashscope" ? "studio.generate.egress" : "studio.generate.local",
      `backend=${backend} modality=${modality}`
    );
    return Response.json({ job });
  } catch (e) {
    const message = e instanceof Error ? e.message : "generation failed";
    return Response.json({ error: message }, { status: 502 });
  }
}
