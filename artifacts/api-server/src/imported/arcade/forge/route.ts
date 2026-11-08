import { db } from "@workspace/db";
import { insertArcadeGame } from "@workspace/arena/lib/arcadeStore";
import { forgeGameWithAI, testRemoteGameModel } from "@workspace/arena/lib/games/forge-ai";
import { getModel } from "@workspace/arena/lib/models";
import { requireUser } from "@workspace/arena/lib/waveyard/local-context";
import { requireApiAccess } from "@workspace/arena/lib/security/api-access";
import { verifyArcadeRuntime } from "../runtime-verification";

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
  if (body?.remoteModelTest === true) {
    if (body?.localOnly === true) {
      return Response.json({ error: "Remote model tests are unavailable in Local Mode." }, { status: 403 });
    }
    const modelId = typeof body?.modelId === "string" ? body.modelId : "";
    const selected = getModel(modelId);
    const provider = selected.id === modelId ? selected.provider : "selected provider";
    try {
      const result = await testRemoteGameModel(modelId, { signal: req.signal });
      if (req.signal.aborted) return new Response(null, { status: 499 });
      return Response.json({ ephemeral: true, provider: result.runtime.backend, ...result });
    } catch (e) {
      if (req.signal.aborted || (e instanceof Error && e.name === "AbortError")) {
        return new Response(null, { status: 499 });
      }
      const message = e instanceof Error ? e.message : "The remote provider could not complete the test.";
      const statusCode = Number((e as any)?.status);
      const failureKind =
        statusCode === 401 || statusCode === 403 || /unauthorized|forbidden|authorization|api key/i.test(message)
          ? "authorization"
          : e instanceof TypeError || /network|fetch failed|timed? ?out|timeout|unreachable|aborterror|aborted/i.test(message)
            ? "network"
            : "provider";
      const detail = failureKind === "authorization"
        ? `${provider} rejected authorization${statusCode ? ` (HTTP ${statusCode})` : ""}. Check the provider's access requirements.`
        : failureKind === "network"
          ? `${provider} could not be reached. Check the network connection and retry.`
          : `${provider} could not complete the test: ${message}`;
      return Response.json(
        { error: detail, failureKind, provider, modelId, ephemeral: true },
        { status: failureKind === "network" ? 504 : 502 },
      );
    }
  }

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
      failedDraftCode: typeof body?.failedDraftCode === "string" && body.failedDraftCode.length <= 50_000 ? body.failedDraftCode : undefined,
      signal: req.signal,
    });
    if (req.signal.aborted) return new Response(null, { status: 499 });
    const runtimeVerification = await verifyArcadeRuntime(result.code, req.signal, { requireGameplay: true });
    if (req.signal.aborted) return new Response(null, { status: 499 });
    if (runtimeVerification.status !== "passed") {
      const message = runtimeVerification.status === "unavailable"
        ? "Arcade could not start its isolated browser check. The game was not published."
        : "The game did not pass its isolated browser check. The game was not published; the draft is retained for repair.";
      return Response.json({
        error: message,
        draft: {
          code: result.code,
          title: result.title,
          gameType: result.gameType,
          runtimeVerification,
        },
        runtimeVerification,
      }, { status: 422 });
    }
    let game: any = null;
    // Persist only code that passed static and isolated-browser startup checks.
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
        return Response.json({
          error: "The game passed startup checks but could not be saved to the game library.",
          draft: {
            code: result.code,
            title: result.title,
            gameType: result.gameType,
            runtimeVerification,
          },
          runtimeVerification,
        }, { status: 503 });
      }
    }
    return Response.json({
      game: game ? { ...game, code: result.code } : null,
      code: result.code,
      engine: result.engine,
      title: result.title,
      validation: result.validation,
      runtimeVerification,
      repairsUsed: result.repairsUsed,
      runtime: result.runtime,
    });
  } catch (e) {
    if (req.signal.aborted || (e instanceof Error && e.name === "AbortError")) {
      return new Response(null, { status: 499 });
    }
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
    return Response.json({ error: message, draft: (e as any)?.draft }, { status: 422 });
  }
}
