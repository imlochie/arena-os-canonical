import { db } from "@/db";
import { insertArcadeGame } from "@/lib/arcadeStore";
import { forgeGameWithAI } from "@/lib/games/forge-ai";
import { requireUser } from "@/lib/waveyard/local-context";
import { isEphemeralBody } from "@/lib/privacy";
import { validateGameCode } from "@/lib/games";
import { requireApiAccess } from "@/lib/security/api-access";

export const dynamic = "force-dynamic";
export const maxDuration = 240;

// Generative forge: ANY game, real codegen via any reachable model.
// Body: { prompt, keys?, localOnly?, modelId?, parentId? }
// Honest 503 when no model is reachable — the offline template forge is the
// separate instant path.
export async function POST(req: Request) {
  const denied = await requireApiAccess(req);
  if (denied) return denied;
  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const user = await requireUser();
  const prompt = String(body?.prompt ?? "").trim();
  if (!prompt) return Response.json({ error: "prompt is required" }, { status: 400 });

  if (prompt.length > 2000) return Response.json({ error: "prompt too long" }, { status: 400 });
  const priorCode = body?.priorCode;
  if (priorCode !== undefined && (typeof priorCode !== "string" || !validateGameCode(priorCode).ok)) {
    return Response.json({ error: "priorCode must be a validated complete game HTML file" }, { status: 400 });
  }
  const ephemeral = isEphemeralBody(body);
  const localOnly = body?.localOnly === true;
  try {
    const result = await forgeGameWithAI(prompt, {
      priorCode,
      keys: localOnly ? undefined : body?.keys,
      localOnly,
      modelId: body?.modelId ? String(body.modelId) : undefined,
    });
    let game: any = null;
    // Persist only code that passed validation. The response still carries
    // the generated code either way — the code is the deliverable — but a
    // failed validation never becomes a stored catalogue entry.
    let persistenceError: string | undefined;
    if (result.validation?.ok && !ephemeral) {
      try {
        game = await insertArcadeGame(db, {
          prompt: prompt.slice(0, 2000),
          gameType: result.gameType,
          engine: "ai-codegen",
          code: result.code,
          parentId: body?.parentId ? String(body.parentId) : null,
          ownerId: user.id,
        });
      } catch {
        persistenceError = "Game generated but could not be saved. Download the HTML before leaving and retry saving later.";
      }
    }
    return Response.json({
      game: game ? { ...game, code: result.code } : ephemeral ? { id: `ephemeral-${Date.now().toString(36)}`, ephemeral: true, prompt, gameType: result.gameType, code: result.code } : null,
      persistenceError,
      code: result.code,
      engine: result.engine,
      title: result.title,
      validation: result.validation,
      repairsUsed: result.repairsUsed,
      runtime: result.runtime,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "generation failed";
    const noModel = (e as any)?.noModel === true || /no capable model|unavailable|not connected/i.test(message);
    if (noModel) {
      return Response.json(
        {
          error:
            "No model is reachable for generative codegen. Add a free key (Groq/OpenRouter) in Settings, run a TurboAgent local model server, or select on-device AI in Arcade — or use the instant offline forge for template cores.",
        },
        { status: 503 },
      );
    }
    return Response.json({ error: message }, { status: 422 });
  }
}
