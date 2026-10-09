/**
 * Shared reasoning core behind Arena's chat routes.
 *
 * Two entry legs, one engine:
 *
 *   /api/chat           browser leg  — optional Archive Assistant evidence
 *                        (user token forwarded server-to-server on request)
 *   /api/internal/chat  service leg  — authenticated machine callers
 *                        (ARENA_INTERNAL_API_KEY). An internal credential is
 *                        NOT a user identity, so it is never forwarded to
 *                        Archive Assistant: archiveContext is not honored on
 *                        the service leg.
 */

import { generate, type ChatMsg } from "./ai";
import { getModel } from "./models";
import { isLocalOnlyBody } from "./privacy";
import { getArchiveAssistantConfig } from "./archive-assistant/config";
import { createArchiveAssistantClient, resolveRequestAuth } from "./archive-assistant/client";
import { buildArchiveContext } from "./archive-assistant/context";
import {
  ARCHIVE_CONTEXT_UNAVAILABLE_NOTE,
  buildArchiveContextSystemPrompt,
} from "./archive-assistant/prompt";
import { isArchiveAssistantError } from "./archive-assistant/errors";

export type ChatCaller = "browser" | "internal_service";

export type ChatRunResult = {
  status: number;
  body: Record<string, unknown>;
};

export type ChatRunOptions = {
  /** Parsed JSON request body (already awaited by the route). */
  body: any;
  /** Raw Authorization header of the incoming request — only ever used as
   *  the user token forwarded to Archive Assistant on the browser leg. */
  authorization: string | null;
  /** Which leg the request arrived on. */
  caller: ChatCaller;
};

type ArchiveMeta =
  | { included: true; factCount: number; generatedAt: string }
  | { included: false; reason: string };

export async function runChat({ body, authorization, caller }: ChatRunOptions): Promise<ChatRunResult> {
  try {
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
      return { status: 400, body: { error: "messages[] is required" } };
    }
    // Validate model exists
    getModel(modelId);

    let archiveSystem: string | null = null;
    let archiveMeta: ArchiveMeta | null = null;

    if (wantsArchiveContext) {
      if (caller === "internal_service") {
        // Service-leg callers (e.g. Archive Assistant's canonical client)
        // send their own evidence in the request body; the internal
        // credential is not a user identity and must not be forwarded.
        archiveMeta = { included: false, reason: "internal_caller" };
      } else if (localOnly) {
        // Zero-egress wins: Local Mode never phones anywhere, including the
        // archive bridge. The model is told plainly that no archive evidence
        // was consulted.
        archiveSystem = ARCHIVE_CONTEXT_UNAVAILABLE_NOTE;
        archiveMeta = { included: false, reason: "local_only" };
      } else {
        try {
          const archiveConfig = getArchiveAssistantConfig();
          // resolveRequestAuth reads the Authorization header off a Request;
          // reconstruct the minimal view it needs from the raw header.
          const authReq = new Request("https://arena.internal/chat", {
            headers: authorization ? { authorization } : {},
          });
          const archiveAuth = resolveRequestAuth(authReq, archiveConfig);
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

    return {
      status: 200,
      body: {
        ...result,
        modelId,
        localOnly,
        ...(caller === "internal_service" ? { caller: "internal_service" } : {}),
        ...(archiveMeta ? { archiveContext: archiveMeta } : {}),
      },
    };
  } catch {
    console.error("chat error");
    return { status: 500, body: { error: "generation failed" } };
  }
}
