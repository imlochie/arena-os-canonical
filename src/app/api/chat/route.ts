import { runChat, type ChatCaller } from "@/lib/chatRunner";
import { internalAuthState, internalUnauthorizedResponse } from "@/lib/internal-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Browser leg of the reasoning route.
 *
 * Credential rules (server-only ARENA_INTERNAL_API_KEY):
 *   - no Authorization header            → browser call (the app's normal
 *                                          chat flow sends none);
 *   - Bearer == internal key             → internal service caller (kept for
 *                                          compatibility with Archive
 *                                          Assistant's canonical client,
 *                                          which posts Bearer $ARENA_CANONICAL_API_KEY
 *                                          to this path); archive evidence
 *                                          forwarding is NOT honored — a
 *                                          service credential is not a user
 *                                          identity;
 *   - Bearer != internal key             → only tolerated when the call
 *                                          requests archiveContext (it is
 *                                          then a user token forwarded to
 *                                          Archive Assistant, which validates
 *                                          it); otherwise 401.
 *
 * When the internal key is not configured, or a call carries no
 * Authorization header at all, behaviour is exactly the historical browser
 * chat flow — nothing about the app's own UI changes.
 */
export async function POST(req: Request) {
  const auth = internalAuthState(req);

  let wantsArchive = false;
  let body: any;
  try {
    body = await req.json();
    wantsArchive = body?.archiveContext === true;
  } catch {
    body = {};
  }

  if (auth.status === "invalid" && !wantsArchive) {
    return internalUnauthorizedResponse();
  }

  const caller: ChatCaller = auth.status === "ok" ? "internal_service" : "browser";
  const result = await runChat({ body, authorization: req.headers.get("authorization"), caller });

  if (caller === "internal_service" || result.status !== 200) {
    return Response.json(result.body, { status: result.status });
  }

  // Browser leg: preserve the historical response envelope (requestedModelId
  // + the structured runtime object) that the app UI reads, on top of
  // runChat's body — existing consumers see a strict superset of the old
  // fields, plus archiveContext when it was requested.
  const modelId: string = body?.modelId ?? "openai";
  const b = result.body as Record<string, any>;
  return Response.json(
    {
      ...b,
      requestedModelId: modelId,
      runtime: {
        level: b.runtimeLevel,
        backend: b.backend,
        provider: b.provider,
        modelId: b.modelId,
        requestedModelId: modelId,
        via: b.via,
        ms: b.ms,
        latencyMs: b.latencyMs ?? b.ms,
        firstTokenMs: b.firstTokenMs ?? null,
        fallback: b.fallback,
        fallbackFrom: b.fallbackFrom ?? null,
        fallbackReason: b.fallbackReason ?? null,
        note: b.note ?? null,
      },
    },
    { status: result.status },
  );
}
