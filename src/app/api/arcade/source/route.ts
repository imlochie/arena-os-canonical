import { requireApiAccess } from "@/lib/security/api-access";
import { requireUser } from "@/lib/waveyard/local-context";
import { create2048Mod, preview2048Mod } from "@/lib/games/source-2048";
import { sandboxGameDocument } from "@/lib/games/sandbox";
import { artifactObjectSummary, writeArtifactObject } from "@/lib/artifact-objects";
import { insertArtifact } from "@/lib/arcadeStore";
import { db } from "@/db";
import { isEphemeralBody, isLocalOnlyBody, logPrivacyEvent } from "@/lib/privacy";
export const dynamic = "force-dynamic";
export const maxDuration = 30;
export async function POST(request: Request) {
  const denied = await requireApiAccess(request); if (denied) return denied;
  let input;
  try { input = await request.json(); } catch { return Response.json({ error: "Valid JSON required." }, { status: 400 }); }
  if (input?.adapter !== "2048" || !Number.isInteger(input.initialTiles) || input.initialTiles < 2 || input.initialTiles > 8) return Response.json({ error: "Supported adapter: 2048; initialTiles must be 2–8." }, { status: 400 });
  if (isLocalOnlyBody(input)) return Response.json({ error: "Public source acquisition is disabled in Local Mode. No network request was made." }, { status: 400 });
  const user = await requireUser();
  try {
    const bundle = await create2048Mod(input.initialTiles);
    if (!isEphemeralBody(input)) await logPrivacyEvent("arcade.source.acquire", `2048 revision ${bundle.revision}; four integrity pins`);
    let artifactId: string | undefined, artifactDownloadUrl: string | undefined, persistenceError: string | undefined;
    if (!isEphemeralBody(input)) {
      try {
        const body = JSON.stringify(bundle, null, 2), object = await writeArtifactObject(user.id, body, "application/json");
        const artifact = await insertArtifact(db, { ownerId: user.id, kind: "source-patch", title: `2048 source mod: ${input.initialTiles} initial tiles`, sourceType: "arcade-source", sourceId: bundle.revision, body: artifactObjectSummary(object), contentObject: object });
        artifactId = artifact.id;
        artifactDownloadUrl = `/api/artifacts/${artifact.id}?revision=${artifact.currentRevisionId}&download=1`;
      } catch { persistenceError = "Source package generated but not saved; download it before leaving."; }
    }
    return Response.json({ bundle, preview: sandboxGameDocument(preview2048Mod(bundle)), artifactId, artifactDownloadUrl, persistenceError, scope: "One hash-pinned MIT upstream and one supported constructor modification. No arbitrary mod ecosystem, official UI, installation or per-output runtime-pass claim." });
  } catch {
    return Response.json({ error: "Pinned upstream acquisition/integrity check failed. No package was acknowledged; check network access and retry. The pin was not changed." }, { status: 502 });
  }
}
