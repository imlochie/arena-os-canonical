import { generate, type ChatMsg } from "@/lib/ai";
import { getModel } from "@/lib/models";
import { isLocalOnlyBody } from "@/lib/privacy";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const modelId: string = body.modelId ?? "openai";
    const messages: ChatMsg[] = body.messages ?? [];
    const temperature: number | undefined = body.temperature;
    const system: string | undefined = body.system;
    const localOnly = isLocalOnlyBody(body);
    const keys = body.keys as { openrouter?: string; groq?: string; gemini?: string } | undefined;

    if (!Array.isArray(messages) || messages.length === 0) {
      return Response.json({ error: "messages[] is required" }, { status: 400 });
    }
    // Validate model exists
    getModel(modelId);

    // Local Mode: keys are ignored (zero egress beats BYOK quality).
    const result = await generate({
      modelId,
      messages,
      temperature,
      system,
      keys: localOnly ? undefined : keys,
      localOnly,
    });
    return Response.json({
      ...result,
      requestedModelId: modelId,
      localOnly,
      runtime: {
        level: result.runtimeLevel,
        backend: result.backend,
        provider: result.provider,
        modelId: result.modelId,
        requestedModelId: modelId,
        via: result.via,
        ms: result.ms,
        latencyMs: result.latencyMs ?? result.ms,
        firstTokenMs: result.firstTokenMs ?? null,
        fallback: result.fallback,
        fallbackFrom: result.fallbackFrom ?? null,
        fallbackReason: result.fallbackReason ?? null,
        note: result.note ?? null,
      },
    });
  } catch (e) {
    console.error("chat error");
    return Response.json({ error: "generation failed" }, { status: 500 });
  }
}
