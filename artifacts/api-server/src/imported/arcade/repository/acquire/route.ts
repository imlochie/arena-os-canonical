import { requireApiAccess } from "@workspace/arena/lib/security/api-access";
import { requireUser } from "@workspace/arena/lib/waveyard/local-context";
import { acquireRepository, recalledRepositoryPlan, RepositoryImportError } from "../../repository-source";

let active = 0;
export async function POST(req: Request) {
  const denied = await requireApiAccess(req);
  if (denied) return denied;
  let owner: string;
  try { owner = (await requireUser()).id; } catch { return Response.json({ error: "Sign in to import a repository." }, { status: 401 }); }
  let body: any;
  try { body = await req.json(); } catch { return Response.json({ error: "Invalid JSON." }, { status: 400 }); }
  if (body?.authorized !== true || typeof body.token !== "string" || body.token.length > 100) {
    return Response.json({ error: "Confirm your rights and inspect the repository before importing." }, { status: 400 });
  }
  if (active >= 2) return Response.json({ error: "Repository downloads are busy. Try again shortly." }, { status: 429 });
  active++;
  try {
    const plan = recalledRepositoryPlan(owner, body.token);
    const snapshot = await acquireRepository(plan, AbortSignal.any([req.signal, AbortSignal.timeout(45_000)]));
    return Response.json(snapshot, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof RepositoryImportError ? error.message : "Repository acquisition failed or timed out. Your shelf has not been changed." },
      { status: error instanceof RepositoryImportError ? error.status : 502 });
  } finally { active--; }
}
