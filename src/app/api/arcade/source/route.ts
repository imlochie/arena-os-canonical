import { requireApiAccess } from "@/lib/security/api-access";
import { requireUser } from "@/lib/waveyard/local-context";
import { create2048Mod, preview2048Mod, validate2048Bundle } from "@/lib/games/source-2048";
import { verify2048Rule } from "@/lib/games/source-rule-validation";
import { sandboxGameDocument } from "@/lib/games/sandbox";
import { artifactObjectSummary, writeArtifactObject, readArtifactObject } from "@/lib/artifact-objects";
import { insertArtifact, getArtifactRevision } from "@/lib/arcadeStore";
import { isUuid } from "@/lib/api/ids";
import { db } from "@/db";
import { isEphemeralBody, isLocalOnlyBody, logPrivacyEvent } from "@/lib/privacy";
export const dynamic = "force-dynamic";
export const maxDuration = 30;
export async function POST(request: Request) {
  const denied = await requireApiAccess(request); if (denied) return denied;
  let input;
  try { input = await request.json(); } catch { return Response.json({ error: "Valid JSON required." }, { status: 400 }); }
  const user = await requireUser();
  if (input?.action === "save" || input?.action === "reopen") {
    // Never replace/update an acknowledged revision. Every save is a new
    // immutable Artifact; failed attempts cannot change its parent/history.
    try {
      let candidate: unknown = input.bundle;
      if (input.action === "reopen") {
        if (!isUuid(input.artifactId) || !isUuid(input.revisionId)) return Response.json({ error: "Select a saved immutable revision." }, { status: 400 });
        const revision = await getArtifactRevision(db, input.artifactId, input.revisionId, user.id);
        if (!revision || revision.snapshot.sourceType !== "arcade-source" || !revision.snapshot.contentObject) return Response.json({ error: "Saved source revision not found." }, { status: 404 });
        if (revision.snapshot.contentObject.bytes > 100000) return Response.json({ error: "Unsupported source package size." }, { status: 422 });
        candidate = JSON.parse((await readArtifactObject(user.id, revision.snapshot.contentObject)).toString("utf8"));
      } else if (isEphemeralBody(input)) return Response.json({ error: "Ephemeral mode: generated package remains unsaved." }, { status: 400 });
      const bundle = validate2048Bundle(candidate);
      const runtime = await verify2048Rule(bundle);
      if (runtime.status !== "passed") return Response.json({ error: `Browser ${runtime.status}; existing saved games were not changed.`, runtime }, { status: runtime.status === "unavailable" ? 503 : 422 });
      if (input.action === "reopen") return Response.json({ bundle, runtime, preview: sandboxGameDocument(preview2048Mod(bundle)), artifactId: input.artifactId, revisionId: input.revisionId, artifactDownloadUrl: `/api/artifacts/${input.artifactId}?revision=${input.revisionId}&download=1` });
      // Recomputed report is bound to exact source+patch hashes; a client claim
      // is never a save authorization or an execution receipt.
      const savedPackage = { ...bundle, runtime };
      const object = await writeArtifactObject(user.id, JSON.stringify(savedPackage, null, 2), "application/json; charset=utf-8");
      const artifact = await insertArtifact(db, { ownerId: user.id, kind: "source-patch", title: `2048: ${bundle.modification.spawnRule}; ${bundle.modification.initialTiles} initial tiles`, sourceType: "arcade-source", sourceId: bundle.revision, body: artifactObjectSummary(object), contentObject: object });
      return Response.json({ bundle, runtime, preview: sandboxGameDocument(preview2048Mod(bundle)), artifactId: artifact.id, revisionId: artifact.currentRevisionId, artifactDownloadUrl: `/api/artifacts/${artifact.id}?revision=${artifact.currentRevisionId}&download=1` });
    } catch {
      return Response.json({ error: "Source validation, immutable storage or reopening failed. No existing saved revision was modified; keep this attempt and retry after inspecting the cause." }, { status: 422 });
    }
  }
  if (input?.adapter !== "2048" || !Number.isInteger(input.initialTiles) || input.initialTiles < 2 || input.initialTiles > 8) return Response.json({ error: "Supported adapter: 2048; initialTiles must be 2–8." }, { status: 400 });
  if (isLocalOnlyBody(input)) return Response.json({ error: "Public source acquisition is disabled in Local Mode. No network request was made." }, { status: 400 });
  if (input.spawnRule !== undefined && input.spawnRule !== "original" && input.spawnRule !== "guaranteed-four") return Response.json({ error: "Unsupported spawning rule." }, { status: 400 });
  try {
    const bundle = await create2048Mod(input.initialTiles, undefined, input.spawnRule ?? "original");
    if (!isEphemeralBody(input)) await logPrivacyEvent("arcade.source.acquire", `2048 revision ${bundle.revision}; four integrity pins`);
    let artifactId: string | undefined, artifactDownloadUrl: string | undefined, persistenceError: string | undefined;
    if (!isEphemeralBody(input) && !input.generateOnly) {
      try {
        const body = JSON.stringify(bundle, null, 2), object = await writeArtifactObject(user.id, body, "application/json; charset=utf-8");
        const artifact = await insertArtifact(db, { ownerId: user.id, kind: "source-patch", title: `2048 source mod: ${input.initialTiles} initial tiles`, sourceType: "arcade-source", sourceId: bundle.revision, body: artifactObjectSummary(object), contentObject: object });
        artifactId = artifact.id;
        artifactDownloadUrl = `/api/artifacts/${artifact.id}?revision=${artifact.currentRevisionId}&download=1`;
      } catch { persistenceError = "Source package generated but not saved; download it before leaving."; }
    }
    return Response.json({ bundle, preview: sandboxGameDocument(preview2048Mod(bundle)), artifactId, artifactDownloadUrl, persistenceError, scope: "Hash-pinned MIT 2048 with initial-tile and optional guaranteed-four modifications. Acquisition is not browser verification; no arbitrary mod ecosystem or in-progress board persistence." });
  } catch {
    return Response.json({ error: "Pinned upstream acquisition/integrity check failed. No package was acknowledged; check network access and retry. The pin was not changed." }, { status: 502 });
  }
}
