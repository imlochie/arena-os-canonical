import { db } from "@/db";
import { insertArcadeGame } from "@/lib/arcadeStore";
import { forgeGameWithAI } from "@/lib/games/forge-ai";
import { requireUser } from "@/lib/waveyard/local-context";
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

  const localOnly = body?.localOnly === true;
  try {
    const result = await forgeGameWithAI(prompt, {
      keys: localOnly ? undefined : body?.keys,
      localOnly,
      modelId: body?.modelId ? String(body.modelId) : undefined,
    });
    let game: any = null;
    // Persist only code that passed validation. The response still carries
    // the generated code either way — the code is the deliverable — but a
    // failed validation never becomes a stored catalogue entry.
    if (result.validation?.ok) {
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
        /* persistence is best-effort; the code itself is the deliverable */
      }
    }
    return Response.json({
      game: game ? { ...game, code: result.code } : null,
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
            "No model is reachable for generative codegen. Add a free key (Groq/OpenRouter) in Settings, load on-device WebLLM, or run with your own model — or use the instant offline forge for template cores.",
        },
        { status: 503 },
      );
    }
    return Response.json({ error: message }, { status: 422 });
  }
}
