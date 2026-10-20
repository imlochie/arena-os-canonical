import { isUuid } from "@/lib/api/ids";
import { AttemptError, attemptCode, beginAttempt, checkpointAttempt, finishAttempt, getAttempt, type AttemptCursor } from "@/lib/games/attempts";
import type { ForgeDraft } from "@/lib/games/forge-ai";
import { db } from "@/db";
import { insertArcadeGame } from "@/lib/arcadeStore";
import { ForgeDraftError, forgeGameWithAI } from "@/lib/games/forge-ai";
import { requireUser } from "@/lib/waveyard/local-context";
import { isEphemeralBody } from "@/lib/privacy";
import { validateGameCode } from "@/lib/games";
import { requireApiAccess } from "@/lib/security/api-access";
import { validateGameRuntime } from "@/lib/games/runtime-validation";

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
  if(body.parentId!==undefined && !isUuid(body.parentId))return Response.json({error:"Valid parent game UUID required."},{status:400});
  const priorCode = body?.priorCode;
  if (priorCode !== undefined && (typeof priorCode !== "string" || !validateGameCode(priorCode).ok)) {
    return Response.json({ error: "priorCode must be a validated complete game HTML file" }, { status: 400 });
  }
  const ephemeral = isEphemeralBody(body);
  const localOnly = body?.localOnly === true;
  let cursor: AttemptCursor | undefined, lastDraft: ForgeDraft | undefined;
  try {
    let failedDraftCode: string | undefined, retryFromRevisionId: string | undefined;
    if(body.retryFromAttemptId) {const input=await getAttempt(user.id,String(body.retryFromAttemptId));failedDraftCode=await attemptCode(input);retryFromRevisionId=input.revisionId??undefined;}
    if (!ephemeral && body.attemptId) {
      const begun=await beginAttempt(user.id,String(body.attemptId),prompt,body.parentId,priorCode,body.retryFromAttemptId,retryFromRevisionId); cursor=begun.cursor;
      if(!begun.created) return Response.json({attempt:cursor,error:"This stable attempt already exists. Inspect/download it, retry saving validated code, or start a new attempt; generation was not replayed."},{status:409});
    }
    const result = await forgeGameWithAI(prompt, {
      validateRuntime: validateGameRuntime,
      priorCode, failedDraftCode,
      onDraft: async draft => { lastDraft=draft; if(cursor)cursor=await checkpointAttempt(cursor,{state:draft.validation.ok?"validated":"draft"},draft); },
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
        game = cursor ? await finishAttempt(cursor, result.code, result.gameType, "ai-codegen", result.runtimeValidation) : await insertArcadeGame(db, {
          prompt: prompt.slice(0, 2000),
          gameType: result.gameType,
          engine: "ai-codegen",
          code: result.code,
          parentId: body?.parentId ? String(body.parentId) : null,
          ownerId: user.id,
        });
      } catch (error) {
        if(error instanceof AttemptError) throw error;
        persistenceError = "Game generated but could not be saved. Download the HTML before leaving and retry saving later.";
      }
    }
    return Response.json({
      game: game ? { ...game, code: result.code } : ephemeral ? { id: `ephemeral-${Date.now().toString(36)}`, ephemeral: true, prompt, gameType: result.gameType, code: result.code } : null,
      persistenceError, attemptId: cursor?.id,
      code: result.code,
      engine: result.engine,
      title: result.title,
      validation: result.validation,
      repairsUsed: result.repairsUsed,
      runtime: result.runtime,
      runtimeValidation: result.runtimeValidation,
    });
  } catch (e) {
    if(cursor && !(e instanceof AttemptError)) { try { cursor=await checkpointAttempt(cursor,{state:"failed",error:e instanceof ForgeDraftError?e.message:"Generation unavailable/interrupted. Inspect retained partial work; original game unchanged."}); } catch { /* No false storage acknowledgement; retained last response is returned below. */ } }
    if(e instanceof AttemptError)return Response.json({error:e.message,attemptId:cursor?.id,draft:lastDraft},{status:e.status});
    if (e instanceof ForgeDraftError) return Response.json({ error: e.message, draft: e.draft, attemptId:cursor?.id }, { status: 422 });
    const message = e instanceof Error ? e.message : "generation failed";
    const noModel = (e as any)?.noModel === true || /no capable model|unavailable|not connected/i.test(message);
    if (noModel) {
      return Response.json(
        {
          attemptId:cursor?.id,
          error:
            "No model is reachable for generative codegen. Add a free key (Groq/OpenRouter) in Settings, run a TurboAgent local model server, or select on-device AI in Arcade — or use the instant offline forge for template cores.",
        },
        { status: 503 },
      );
    }
    return Response.json({ error: message, attemptId:cursor?.id, draft:lastDraft }, { status: lastDraft ? 503 : 422 });
  }
}
