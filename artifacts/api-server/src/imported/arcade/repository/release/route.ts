import { requireApiAccess } from "@workspace/arena/lib/security/api-access";
import { requireUser } from "@workspace/arena/lib/waveyard/local-context";
import { recallRepositoryAssessment } from "../../repository-assessment";
import { RepositoryImportError } from "../../repository-source";

export async function POST(req: Request) {
  const denied = await requireApiAccess(req);
  if (denied) return denied;
  let owner: string;
  try { owner = (await requireUser()).id; } catch { return Response.json({ error: "Sign in to resolve a release." }, { status: 401 }); }
  let input: { token?: unknown; releaseIndex?: number; assetIndex?: number; authorized?: boolean };
  try { input = await req.json(); } catch { return Response.json({ error: "Invalid JSON." }, { status: 400 }); }
  if (input?.authorized !== true || typeof input.token !== "string" || input.token.length > 100 ||
      !Number.isInteger(input.releaseIndex) || !Number.isInteger(input.assetIndex)) return Response.json({ error: "Approve a reviewed release asset." }, { status: 400 });
  try {
    const review = recallRepositoryAssessment(owner, input.token);
    const release = review.releases[input.releaseIndex!], asset = release?.assets[input.assetIndex!];
    if (!review.license || !["godot", "sdl", "native"].includes(review.projectType)) throw new RepositoryImportError("A licensed native project must be identified before native release acquisition.", 409);
    if (!release || !asset || review.reference !== release.tag) throw new RepositoryImportError("Review this exact release tag before resolving an asset.", 409);
    if (!asset.sha256 || asset.bytes > 512 * 1024 * 1024 || !/\.zip$/i.test(asset.name) ||
        !/(?:win(?:dows)?[-_.]?(?:x64|x86_64)|win64|win32-x64|x86_64-pc-windows)/i.test(asset.name)) {
      throw new RepositoryImportError("Only publisher-digested Windows x64 portable ZIPs up to 512 MiB are supported. Installers, missing digests and ambiguous targets require a different recipe.", 422);
    }
    return Response.json({ provenance: { repository: review.repository, revision: review.revision, sourceUrl: review.sourceUrl, license: review.license },
      tag: release.tag, prerelease: release.prerelease, asset }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof RepositoryImportError ? error.message : "Release resolution failed." },
      { status: error instanceof RepositoryImportError ? error.status : 502 });
  }
}
