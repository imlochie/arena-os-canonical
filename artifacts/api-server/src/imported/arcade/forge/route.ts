import { db } from "@workspace/db";
import { insertArcadeGame } from "@workspace/arena/lib/arcadeStore";
import { forgeGameWithAI } from "@workspace/arena/lib/games/forge-ai";
import { requireUser } from "@workspace/arena/lib/waveyard/local-context";
import { requireApiAccess } from "@workspace/arena/lib/security/api-access";

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
  if (!prompt || prompt.length > 2000) return Response.json({ error: "Prompt must contain 1–2,000 characters." }, { status: 400 });
  const priorCode = typeof body?.priorCode === "string" ? body.priorCode : undefined;
  if (priorCode && priorCode.length > 50_000) {
    return Response.json({ error: "This game file is too large to revise in one pass (limit: 50KB)." }, { status: 413 });
  }

  const localOnly = body?.localOnly === true;
  try {
    const result = await forgeGameWithAI(prompt, {
      keys: localOnly ? undefined : body?.keys,
      localOnly,
      modelId: body?.modelId ? String(body.modelId) : undefined,
      priorCode,
    });
    let game: any = null;
    // Persist only code that passed validation. The response still carries
    // the generated code either way — the code is the deliverable — but a
    // failed validation never becomes a stored catalogue entry.
    if (result.validation?.ok && body?.ephemeral !== true) {
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
            "No code-writing model is reachable. Connect one in Settings or load an on-device game model. Quick offline cores cover the built-in classics.",
        },
        { status: 503 },
      );
    }
    return Response.json({ error: message }, { status: 422 });
  }
}
