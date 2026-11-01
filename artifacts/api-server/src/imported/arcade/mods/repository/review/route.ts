import { requireApiAccess } from "@workspace/arena/lib/security/api-access";
import { requireUser } from "@workspace/arena/lib/waveyard/local-context";
import { acquireModRepository } from "../../../mod-repository";
let active = 0;
export async function POST(req: Request) {
  const denied = await requireApiAccess(req); if (denied) return denied;
  try { await requireUser(); } catch { return Response.json({ error: "Sign in to review a mod repository." }, { status: 401 }); }
  if (active >= 2) return Response.json({ error: "Mod review is busy. Retry shortly." }, { status: 429 });
  active++;
  try {
    if (Number(req.headers.get("content-length") ?? 0) > 2048) throw new Error("Repository request is oversized.");
    const text = await req.text(); if (text.length > 2048) throw new Error("Repository request is oversized.");
    const body = JSON.parse(text);
    if (body?.authorized !== true || typeof body.url !== "string" || body.url.length > 1000) throw new Error("Confirm your rights and provide a repository URL.");
    return Response.json(await acquireModRepository(body.url, AbortSignal.any([req.signal, AbortSignal.timeout(45000)])));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Mod review failed." }, { status: 422 });
  } finally { active--; }
}
