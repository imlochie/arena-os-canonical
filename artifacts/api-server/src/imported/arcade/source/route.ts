import { db } from "@workspace/db";
import { isUuid } from "@workspace/arena/lib/api/ids";
import { getArtifact, insertArtifact } from "@workspace/arena/lib/arcadeStore";
import { create2048Mod, preview2048Mod, validate2048Bundle } from "@workspace/arena/lib/games/source-2048";
import { sandboxGameDocument } from "@workspace/arena/lib/games/sandbox";
import { isEphemeralBody, isLocalOnlyBody, logPrivacyEvent } from "@workspace/arena/lib/privacy";
import { requireUser } from "@workspace/arena/lib/waveyard/local-context";
import { requireApiAccess } from "@workspace/arena/lib/security/api-access";
import { verify2048Rule } from "../source-rule-validation";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MAX_SAVED_PACKAGE_BYTES = 200_000;
const SCOPE =
  "Hash-pinned MIT 2048 with initial-tile and optional guaranteed-four modifications. Acquisition is not browser verification; no arbitrary mod ecosystem or in-progress board persistence.";

const downloadable = (artifactId: string) => `/api/artifacts/${artifactId}`;

// Body: { adapter:"2048", initialTiles, spawnRule?, generateOnly? }  → acquire + patch (+ save unless generateOnly/ephemeral)
//       { action:"save", bundle }       → re-validate, run the real browser rule check, then save as a NEW artifact
//       { action:"reopen", artifactId } → re-validate the saved package from the pins and re-run the rule check
// Saves never update an existing artifact. A saved package carries its own
// hashes and is reconstructed from the pinned upstream bytes on every reopen,
// so an edited artifact body is rejected rather than trusted.
// A rejected save is retained server-side so it survives refresh/restart;
// a failure to retain is reported, never swallowed.
async function retainFailedDraft(ownerId: string, candidate: unknown, reason: string) {
  try {
    const body = JSON.stringify({ reason, draft: candidate });
    if (body.length > MAX_SAVED_PACKAGE_BYTES) return { retainError: "Draft too large to retain; download it." };
    const artifact = await insertArtifact(db, {
      ownerId, kind: "source-patch", title: `Failed 2048 source draft: ${reason.slice(0, 80)}`,
      sourceType: "arcade-failed", sourceId: null, body,
    });
    return { failedDraftId: artifact.id };
  } catch {
    return { retainError: "Draft could not be retained on the server; download it before leaving." };
  }
}

export async function POST(request: Request) {
  const denied = await requireApiAccess(request);
  if (denied) return denied;
  let input: any;
  try { input = await request.json(); } catch { return Response.json({ error: "Valid JSON required." }, { status: 400 }); }
  const user = await requireUser();

  if (input?.action === "save" || input?.action === "reopen") {
    try {
      let candidate: unknown = input.bundle;
      if (input.action === "reopen") {
        if (typeof input.artifactId !== "string" || !isUuid(input.artifactId)) {
          return Response.json({ error: "Select a saved source package." }, { status: 400 });
        }
        const artifact = await getArtifact(db, input.artifactId, user.id);
        if (!artifact || artifact.sourceType !== "arcade-source") {
          return Response.json({ error: "Saved source package not found." }, { status: 404 });
        }
        if (artifact.body.length > MAX_SAVED_PACKAGE_BYTES) {
          return Response.json({ error: "Unsupported source package size." }, { status: 422 });
        }
        candidate = JSON.parse(artifact.body);
      } else if (isEphemeralBody(input)) {
        return Response.json({ error: "Ephemeral mode: generated package remains unsaved." }, { status: 400 });
      }
      const bundle = validate2048Bundle(candidate);
      const runtime = await verify2048Rule(bundle);
      if (runtime.status !== "passed") {
        const retained = input.action === "save" ? await retainFailedDraft(user.id, candidate, `browser ${runtime.status}`) : {};
        return Response.json(
          { error: `Browser ${runtime.status}; existing saved games were not changed.`, runtime, ...retained },
          { status: runtime.status === "unavailable" ? 503 : 422 },
        );
      }
      const preview = sandboxGameDocument(preview2048Mod(bundle));
      if (input.action === "reopen") {
        return Response.json({ bundle, runtime, preview, artifactId: input.artifactId, artifactDownloadUrl: downloadable(input.artifactId) });
      }
      // The report is recomputed here and bound to the exact source+patch hashes;
      // a client-supplied report is never a save authorisation.
      const artifact = await insertArtifact(db, {
        ownerId: user.id,
        kind: "source-patch",
        title: `2048: ${bundle.modification.spawnRule}; ${bundle.modification.initialTiles} initial tiles`,
        sourceType: "arcade-source",
        sourceId: bundle.revision,
        body: JSON.stringify({ ...bundle, runtime }),
      });
      return Response.json({ bundle, runtime, preview, artifactId: artifact.id, artifactDownloadUrl: downloadable(artifact.id) });
    } catch {
      const retained = input.action === "save" ? await retainFailedDraft(user.id, input.bundle, "validation or storage failed") : {};
      return Response.json({
        error: "Source validation, storage or reopening failed. No existing saved package was modified; keep this attempt and retry after inspecting the cause.",
        ...retained,
      }, { status: 422 });
    }
  }

  if (input?.adapter !== "2048" || !Number.isInteger(input.initialTiles) || input.initialTiles < 2 || input.initialTiles > 8) {
    return Response.json({ error: "Supported adapter: 2048; initialTiles must be 2–8." }, { status: 400 });
  }
  if (isLocalOnlyBody(input)) {
    return Response.json({ error: "Public source acquisition is disabled in Local Mode. No network request was made." }, { status: 400 });
  }
  if (input.spawnRule !== undefined && input.spawnRule !== "original" && input.spawnRule !== "guaranteed-four") {
    return Response.json({ error: "Unsupported spawning rule." }, { status: 400 });
  }
  try {
    const bundle = await create2048Mod(input.initialTiles, undefined, input.spawnRule ?? "original");
    if (!isEphemeralBody(input)) await logPrivacyEvent("arcade.source.acquire", `2048 revision ${bundle.revision}; four integrity pins`);
    let artifactId: string | undefined;
    let persistenceError: string | undefined;
    if (!isEphemeralBody(input) && !input.generateOnly) {
      try {
        const artifact = await insertArtifact(db, {
          ownerId: user.id,
          kind: "source-patch",
          title: `2048 source mod: ${input.initialTiles} initial tiles`,
          sourceType: "arcade-source",
          sourceId: bundle.revision,
          body: JSON.stringify(bundle),
        });
        artifactId = artifact.id;
      } catch {
        persistenceError = "Source package generated but not saved; download it before leaving.";
      }
    }
    return Response.json({
      bundle,
      preview: sandboxGameDocument(preview2048Mod(bundle)),
      artifactId,
      artifactDownloadUrl: artifactId ? downloadable(artifactId) : undefined,
      persistenceError,
      scope: SCOPE,
    });
  } catch {
    return Response.json({
      error: "Pinned upstream acquisition/integrity check failed. No package was acknowledged; check network access and retry. The pin was not changed.",
    }, { status: 502 });
  }
}
