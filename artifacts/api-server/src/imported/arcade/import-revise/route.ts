import { reviseImportedHtmlWithAI } from "@workspace/arena/lib/games/forge-ai";
import { requireUser } from "@workspace/arena/lib/waveyard/local-context";
import { requireApiAccess } from "@workspace/arena/lib/security/api-access";

export const dynamic = "force-dynamic";
export const maxDuration = 240;

/** Imported source is sent only for this request and is never written to the shared game catalog. */
export async function POST(req: Request) {
  const denied = await requireApiAccess(req);
  if (denied) return denied;
  try {
    await requireUser();
  } catch {
    return Response.json({ error: "Sign in to revise an imported game." }, { status: 401 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const prompt = String(body?.prompt ?? "").trim();
  const source = typeof body?.priorCode === "string" ? body.priorCode : "";
  if (!prompt || prompt.length > 1000) {
    return Response.json({ error: "Describe one game change in 1–1,000 characters." }, { status: 400 });
  }
  if (!source || source.length > 50_000) {
    return Response.json({ error: "Game source sent for revision is limited to 50 KB after media is removed." }, { status: 413 });
  }

  try {
    const result = await reviseImportedHtmlWithAI(prompt, source, {
      keys: body?.localOnly === true ? undefined : body?.keys,
      localOnly: body?.localOnly === true,
      modelId: body?.modelId ? String(body.modelId) : undefined,
      signal: req.signal,
    });
    if (req.signal.aborted) return new Response(null, { status: 499 });
    return Response.json({ code: result.code, runtime: result.runtime });
  } catch (error) {
    if (req.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
      return new Response(null, { status: 499 });
    }
    const message = error instanceof Error ? error.message : "imported-game revision failed";
    const noModel = (error as any)?.noModel === true || /no connected code-writing model/i.test(message);
    return Response.json(
      { error: noModel ? "No connected code-writing model is available for this imported-game revision." : message },
      { status: noModel ? 503 : 422 },
    );
  }
}
