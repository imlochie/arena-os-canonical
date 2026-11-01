import { requireApiAccess } from "@workspace/arena/lib/security/api-access";
import { requireUser } from "@workspace/arena/lib/waveyard/local-context";
import { assessRepository, rememberRepositoryAssessment } from "../../repository-assessment";
import { RepositoryImportError } from "../../repository-source";

let active = 0;
export async function POST(req: Request) {
  const denied = await requireApiAccess(req);
  if (denied) return denied;
  let owner: string;
  try { owner = (await requireUser()).id; } catch { return Response.json({ error: "Sign in to review a repository." }, { status: 401 }); }
  let body: unknown;
  try { body = await req.json(); } catch { return Response.json({ error: "Invalid JSON." }, { status: 400 }); }
  const input = body as { url?: unknown; authorized?: unknown };
  if (input?.authorized !== true || typeof input.url !== "string" || !input.url.trim() || input.url.length > 1000) {
    return Response.json({ error: "Confirm your rights and provide a public repository URL of at most 1,000 characters." }, { status: 400 });
  }
  if (active >= 2) return Response.json({ error: "Repository reviews are busy. Try again shortly." }, { status: 429 });
  active++;
  try {
    const assessment = await assessRepository(input.url.trim(), AbortSignal.any([req.signal, AbortSignal.timeout(30_000)]));
    return Response.json(rememberRepositoryAssessment(owner, assessment), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof RepositoryImportError ? error.message : "Repository review failed or timed out. No files have been installed." },
      { status: error instanceof RepositoryImportError ? error.status : 502 });
  } finally { active--; }
}
