import { apiErrorResponse, standardApiError } from "@/lib/apiErrors";
import type { ChatMsg } from "@/lib/ai";
import { parseExecutionConfig } from "@/lib/executionConfig";
import { executeWorker } from "@/lib/workerExecutor";
import { allocateWorkforce } from "@/lib/workforceRuntime";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const messages: ChatMsg[] = body.messages ?? [];
    if (!Array.isArray(messages) || messages.length === 0) {
      return standardApiError("INVALID_REQUEST", "Messages[] is required.", 400);
    }
    const config = parseExecutionConfig(body);
    const [assignment] = await allocateWorkforce([{
      slot: "assistant", requestedRole: "Personal Assistant", workforceRoleId: "strategist",
      pinnedModelId: body.modelId ? String(body.modelId) : undefined,
      requiredCapabilities: ["text_generation"],
    }], config.mode);
    const result = await executeWorker({
      assignment, messages, temperature: body.temperature, system: body.system,
      keys: config.localOnly ? undefined : body.keys,
    });
    return Response.json({ ...result, modelId: result.actualModelId, localOnly: config.localOnly, ephemeral: true });
  } catch (error) {
    return apiErrorResponse(error, { code: "CHAT_EXECUTION_FAILED", message: "Generation failed.", stage: "execution" });
  }
}
