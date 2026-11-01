import { requireApiAccess } from "@workspace/arena/lib/security/api-access";
import { requireUser } from "@workspace/arena/lib/waveyard/local-context";
import { inspectRepository, rememberRepositoryPlan, RepositoryImportError } from "../../repository-source";

let active = 0;
export async function POST(req: Request) {
  const denied = await requireApiAccess(req);
  if (denied) return denied;
  let owner: string;
  try { owner = (await requireUser()).id; } catch { return Response.json({ error: "Sign in to import a repository." }, { status: 401 }); }
  let body: any;
  try { body = await req.json(); } catch { return Response.json({ error: "Invalid JSON." }, { status: 400 }); }
  if (body?.authorized !== true || typeof body.url !== "string" || body.url.length > 1000) {
    return Response.json({ error: "Confirm your rights and provide a GitHub link of at most 1,000 characters." }, { status: 400 });
  }
  if (active >= 2) return Response.json({ error: "Repository inspection is busy. Try again shortly." }, { status: 429 });
  active++;
  try {
    const plan = await inspectRepository(body.url, AbortSignal.any([req.signal, AbortSignal.timeout(30_000)]));
    return Response.json(rememberRepositoryPlan(owner, plan), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof RepositoryImportError ? error.message : "Repository inspection failed or timed out. Try again." },
      { status: error instanceof RepositoryImportError ? error.status : 502 });
  } finally { active--; }
}
