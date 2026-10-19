/** Conservative owner-scoped reconciliation. Unbound and partial objects are
 * retained, not garbage-collected on a guessed absence of SQL metadata. */
import { createHash } from "node:crypto";
import { opendir, lstat } from "node:fs/promises";
import path from "node:path";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { artifacts, artifactRevisions } from "@/db/schema";
import { insertArtifact } from "@/lib/arcadeStore";
import { getStorage } from "@/lib/waveyard/storage";
import { artifactObjectKey, artifactObjectSummary, readArtifactObject, ArtifactObjectError, MAX_ARTIFACT_OBJECT_BYTES } from "@/lib/artifact-objects";
const descriptor = (sha256: string, bytes = 0) => ({ version: 1 as const, sha256, bytes, mediaType: "application/octet-stream" });
function location(ownerId: string, sha: string) {
  if (!/^[a-f0-9]{64}$/.test(sha)) throw new ArtifactObjectError("A valid retained-content SHA256 is required.", 400);
  const location = getStorage().getLocalPath(artifactObjectKey(ownerId, descriptor(sha)));
  if (!location) throw new ArtifactObjectError("Storage inspection is unavailable for this provider.", 503);
  return location;
}
export async function inspectOwnedObject(ownerId: string, sha: string) {
  let info;
  try { info = await lstat(location(ownerId, sha)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ArtifactObjectError("Retained content unavailable or not owned by this caller.", 404); throw new ArtifactObjectError("Private storage unavailable; retained content was not removed.", 503); }
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_ARTIFACT_OBJECT_BYTES) throw new ArtifactObjectError("Retained content is not a supported bounded regular file.");
  return descriptor(sha, info.size);
}
export async function inventoryArtifactObjects(ownerId: string) {
  const directory = path.dirname(location(ownerId, "0".repeat(64)));
  const objects: Array<{ id: string; sha256?: string; bytes: number; modifiedAt: string; state: "unbound" | "referenced" | "incomplete" | "uncertain"; references: number; referenceKinds: string[] }> = [];
  let truncated = false;
  try {
    for await (const entry of await opendir(directory)) {
      if (!entry.isFile() || (!/^[a-f0-9]{64}\.bin$/.test(entry.name) && !/^[a-f0-9]{64}\.bin\.[a-f0-9-]+\.partial$/.test(entry.name))) continue;
      if (objects.length === 500) { truncated = true; break; }
      const info = await lstat(path.join(directory, entry.name)); if (!info.isFile() || info.isSymbolicLink()) continue;
      const complete = entry.name.endsWith(".bin");
      objects.push({ id: createHash("sha256").update(entry.name).digest("hex"), ...(complete ? { sha256: entry.name.slice(0, 64) } : {}), bytes: info.size, modifiedAt: info.mtime.toISOString(), state: complete ? "unbound" : "incomplete", references: 0, referenceKinds: [] });
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new ArtifactObjectError("Private storage inventory unavailable; nothing was removed.", 503); }
  const hashes = objects.flatMap(object => object.sha256 ? [object.sha256] : []);
  if (hashes.length) {
    // One SQL snapshot of the EXISTING graph. Current legacy rows are roots
    // too. A mismatched owner/baseline is evidence to preserve, never absence.
    // Do not double-count a current row already represented by its revision.
    const rows = await db.execute<{ sha: string; count: number; uncertain: boolean; kinds: string[] }>(sql`
      WITH roots AS (
        SELECT r.snapshot->'contentObject'->>'sha256' AS sha,
          (a.owner_id IS DISTINCT FROM ${ownerId} OR r.snapshot->>'ownerId' IS DISTINCT FROM ${ownerId} OR r.body_sha256 IS NULL) AS uncertain,
          CASE WHEN a.deleted_at IS NOT NULL THEN 'tombstone'
            WHEN a.current_revision_id = r.id THEN 'current' ELSE 'history' END AS kind
        FROM ${artifactRevisions} r LEFT JOIN ${artifacts} a ON a.id = r.artifact_id
        WHERE a.owner_id = ${ownerId} OR r.snapshot->>'ownerId' = ${ownerId}
        UNION ALL
        SELECT a.content_object->>'sha256', TRUE, 'current'
        FROM ${artifacts} a WHERE a.owner_id = ${ownerId} AND a.content_object IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM ${artifactRevisions} r WHERE r.id = a.current_revision_id
            AND r.artifact_id = a.id AND r.snapshot->'contentObject'->>'sha256' = a.content_object->>'sha256')
      )
      SELECT sha, count(*)::integer AS count, bool_or(uncertain) AS uncertain, array_agg(DISTINCT kind) AS kinds
      FROM roots WHERE sha IN (${sql.join(hashes.map(hash => sql`${hash}`), sql`, `)}) GROUP BY sha
    `);
    const byHash = new Map(rows.rows.map(row => [row.sha, row]));
    for (const object of objects) {
      const root = object.sha256 ? byHash.get(object.sha256) : undefined;
      if (root) { object.references = root.count; object.referenceKinds = root.kinds.sort(); object.state = root.uncertain ? "uncertain" : "referenced"; }
    }
  }
  return { objects: objects.sort((a, b) => a.id.localeCompare(b.id)), truncated, policy: "Current state, immutable history/tombstones and uncertain metadata are retained. Unbound uploads/incomplete writes may be pending or recoverable, not deletion candidates. This bounded inventory is not a reclamation certificate. No automatic deletion. Retry the original operation to adopt the same checksum, or explicitly recover verified unbound content as a new Artifact with unknown origin." };
}
export async function recoverArtifactObject(ownerId: string, sha: string) {
  let object = await inspectOwnedObject(ownerId, sha);
  const bytes = await readArtifactObject(ownerId, object); const text = bytes.toString("utf8");
  if (!bytes.includes(0) && Buffer.from(text, "utf8").equals(bytes)) object = { ...object, mediaType: "text/plain; charset=utf-8" };
  const hash = createHash("sha256").update(`recovered-object:${ownerId}:${sha}`).digest("hex");
  const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  return insertArtifact(db, { id, ownerId, body: artifactObjectSummary(object), contentObject: object, title: `Recovered retained content — ${sha.slice(0, 12)}`, kind: "archive", sourceType: "recovered-object", sourceId: sha });
}
