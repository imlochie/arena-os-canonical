import { standardApiError } from "@/lib/apiErrors";
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
      return standardApiError("INVALID_REQUEST", "Messages[] is required.", 400);
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
    return Response.json({ ...result, modelId, localOnly });
  } catch (e) {
    console.error("chat error");
    return standardApiError("API_OPERATION_FAILED", "Generation failed.", 500);
  }
}
