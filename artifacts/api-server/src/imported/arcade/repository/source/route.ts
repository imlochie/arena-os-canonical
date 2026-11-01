import { requireApiAccess } from "@workspace/arena/lib/security/api-access";
import { requireUser } from "@workspace/arena/lib/waveyard/local-context";
import { recallRepositoryAssessment } from "../../repository-assessment";
import { RepositoryImportError, readRepositoryFile } from "../../repository-source";

let active = 0;
/** Returns public, pinned source bytes only. It never extracts, builds or runs
 * them on the API host. Desktop build execution is a separate owner approval. */
export async function POST(req: Request) {
  const denied = await requireApiAccess(req);
  if (denied) return denied;
  let owner: string;
  try { owner = (await requireUser()).id; } catch { return Response.json({ error: "Sign in to acquire source." }, { status: 401 }); }
  let input: { token?: unknown; authorized?: unknown };
  try { input = await req.json(); } catch { return Response.json({ error: "Invalid JSON." }, { status: 400 }); }
  if (input?.authorized !== true || typeof input.token !== "string" || input.token.length > 100) {
    return Response.json({ error: "Approve an unexpired source review before acquisition." }, { status: 400 });
  }
  if (active >= 2) return Response.json({ error: "Source acquisition is busy. Try again shortly." }, { status: 429 });
  active++;
  try {
    const plan = recallRepositoryAssessment(owner, input.token);
    if (!plan.license || plan.blockers.length || !["godot", "sdl"].includes(plan.projectType)) {
      throw new RepositoryImportError("This source review is blocked or is not a supported native project. Resolve its blockers first.", 409);
    }
    const signal = AbortSignal.any([req.signal, AbortSignal.timeout(60_000)]);
    const files: Array<{ path: string; size: number; sha: string; contentBase64: string }> = [];
    for (let index = 0; index < plan.files.length; index += 4) {
      files.push(...await Promise.all(plan.files.slice(index, index + 4).map(async file => ({
        ...file, contentBase64: (await readRepositoryFile(plan.repository, plan.revision, file, signal)).toString("base64"),
      }))));
    }
    return Response.json({ provenance: { repository: plan.repository, revision: plan.revision, sourceUrl: plan.sourceUrl, license: plan.license },
      folder: plan.folder, projectType: plan.projectType, files }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof RepositoryImportError ? error.message : "Pinned source acquisition failed or timed out. No build was started." },
      { status: error instanceof RepositoryImportError ? error.status : 502 });
  } finally { active--; }
}
