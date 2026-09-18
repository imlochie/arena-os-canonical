import { generate, type ChatMsg } from "@/lib/ai";
import { getModel } from "@/lib/models";
import { isLocalOnlyBody } from "@/lib/privacy";
import { getArchiveAssistantConfig } from "../../../lib/archive-assistant/config";
import { createArchiveAssistantClient, resolveRequestAuth } from "../../../lib/archive-assistant/client";
import { buildArchiveContext } from "../../../lib/archive-assistant/context";
import {
  ARCHIVE_CONTEXT_UNAVAILABLE_NOTE,
  buildArchiveContextSystemPrompt,
} from "../../../lib/archive-assistant/prompt";
import { isArchiveAssistantError } from "../../../lib/archive-assistant/errors";

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
    // Opt-in: fold read-only Archive Assistant evidence into the reasoning
    // prompt. The chat route remains the reasoning backend; Archive Assistant
    // only supplies bounded, normalized facts (never raw rows, never a
    // mutation path). OFF when not requested — behaviour unchanged.
    const wantsArchiveContext: boolean = body.archiveContext === true;

    if (!Array.isArray(messages) || messages.length === 0) {
      return Response.json({ error: "messages[] is required" }, { status: 400 });
    }
    // Validate model exists
    getModel(modelId);

    let archiveSystem: string | null = null;
    let archiveMeta:
      | { included: true; factCount: number; generatedAt: string }
      | { included: false; reason: string }
      | null = null;

    if (wantsArchiveContext) {
      if (localOnly) {
        // Zero-egress wins: Local Mode never phones anywhere, including the
        // archive bridge. The model is told plainly that no archive evidence
        // was consulted.
        archiveSystem = ARCHIVE_CONTEXT_UNAVAILABLE_NOTE;
        archiveMeta = { included: false, reason: "local_only" };
      } else {
        try {
          const archiveConfig = getArchiveAssistantConfig();
          const archiveAuth = resolveRequestAuth(req, archiveConfig);
          const archiveClient = createArchiveAssistantClient(archiveConfig, archiveAuth);
          const built = await buildArchiveContext(archiveClient);
          archiveSystem = buildArchiveContextSystemPrompt(built.context, built.facts);
          archiveMeta = {
            included: true,
            factCount: built.facts.length,
            generatedAt: built.context.generatedAt,
          };
        } catch (error) {
          // Fail soft: chat still answers, explicitly told not to invent
          // archive facts. Reason is surfaced as a kind, never a stack.
          archiveSystem = ARCHIVE_CONTEXT_UNAVAILABLE_NOTE;
          archiveMeta = {
            included: false,
            reason: isArchiveAssistantError(error) ? error.kind : "unexpected",
          };
        }
      }
    }

    const combinedSystem =
      [system?.trim(), archiveSystem].filter((part): part is string => Boolean(part)).join("\n\n") ||
      undefined;

    // Local Mode: keys are ignored (zero egress beats BYOK quality).
    const result = await generate({
      modelId,
      messages,
      temperature,
      system: combinedSystem,
      keys: localOnly ? undefined : keys,
      localOnly,
    });
    return Response.json({
      ...result,
      modelId,
      localOnly,
      ...(archiveMeta ? { archiveContext: archiveMeta } : {}),
    });
  } catch (e) {
    console.error("chat error");
    return Response.json({ error: "generation failed" }, { status: 500 });
  }
}
