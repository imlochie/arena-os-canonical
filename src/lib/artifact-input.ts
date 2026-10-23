import { ArtifactObjectError, artifactRevisionText } from "@/lib/artifact-objects";
import { createHash } from "node:crypto";
import { db } from "@/db";
import { ArtifactIntegrityError, getArtifactRevision } from "@/lib/arcadeStore";
import { parseArtifactReference } from "@/lib/handoffs";
import { requireUser } from "@/lib/waveyard/local-context";

export class ArtifactInputError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}
/** Shared ingress boundary. A pinned input replaces, never supplements or
 * trusts, the client's editable excerpt. Owned tombstones retain readable
 * history; deletion does not reinterpret an already selected revision. */
export async function resolveArtifactInput(source: unknown, excerpt: unknown) {
  if (source === undefined || source === null || source === "") return { text: String(excerpt ?? "").trim(), inputReference: null };
  if (typeof source !== "string") throw new ArtifactInputError("Source must be an immutable Artifact reference.");
  const parsed = parseArtifactReference(source);
  if (!parsed) throw new ArtifactInputError("Open the Artifact Library, load revision history and select artifact:<id>@<revisionId>. Unpinned or other room references must be explicitly converted to an Artifact first, or cleared to submit plain text.");
  const user = await requireUser();
  let revision;
  try { revision = await getArtifactRevision(db, parsed.artifactId, parsed.revisionId, user.id); }
  catch (error) { if (error instanceof ArtifactIntegrityError || error instanceof ArtifactObjectError) throw new ArtifactInputError(error.message, error.status); throw new ArtifactInputError("Artifact storage unavailable; no execution started. Retry after storage recovers.", 503); }
  if (!revision) throw new ArtifactInputError("Artifact revision unavailable or not owned by this caller. Select an accessible revision from the Library.", 404);
  const snapshot = revision.snapshot;
  if (!snapshot || typeof snapshot.body !== "string" || !snapshot.body.trim() || snapshot.ownerId !== user.id || typeof snapshot.title !== "string" || !Number.isInteger(revision.revision) || revision.revision < 1) throw new ArtifactInputError("Artifact revision is corrupt or has invalid ownership metadata; no execution was started.", 422);
  const bytes = Buffer.from(snapshot.body, "utf8");
  if (bytes.length > 80000 || snapshot.body.length > 20000) throw new ArtifactInputError("This revision exceeds the inline execution input limit. Download and explicitly prepare a supported input; no excerpt was substituted.", 413);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (revision.bodySha256 !== sha256) throw new ArtifactInputError("Artifact revision checksum is absent or mismatched; no execution started. Recover a verified revision in the Library.", 422);
  let text;
  try { text = await artifactRevisionText(user.id, snapshot); }
  catch (error) { throw new ArtifactInputError(error instanceof Error ? error.message : "Content storage unavailable.", error instanceof ArtifactObjectError ? error.status : 503); }
  return { text, inputReference: { reference: source, artifactId: parsed.artifactId, revisionId: revision.id, revision: revision.revision, sha256: snapshot.contentObject?.sha256 ?? sha256, bytes: snapshot.contentObject?.bytes ?? bytes.length, ownerId: user.id } };
}
