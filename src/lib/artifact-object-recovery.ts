/** Conservative owner-scoped reconciliation. Unbound and partial objects are
 * retained, not garbage-collected on a guessed absence of SQL metadata. */
import { createHash } from "node:crypto";
import { opendir, lstat } from "node:fs/promises";
import path from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
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
  const objects: Array<{ id: string; sha256?: string; bytes: number; modifiedAt: string; state: "unbound" | "referenced" | "incomplete"; references: number }> = [];
  let truncated = false;
  try {
    for await (const entry of await opendir(directory)) {
      if (!entry.isFile() || (!/^[a-f0-9]{64}\.bin$/.test(entry.name) && !/^[a-f0-9]{64}\.bin\.[a-f0-9-]+\.partial$/.test(entry.name))) continue;
      if (objects.length === 500) { truncated = true; break; }
      const info = await lstat(path.join(directory, entry.name)); if (!info.isFile() || info.isSymbolicLink()) continue;
      const complete = entry.name.endsWith(".bin");
      objects.push({ id: createHash("sha256").update(entry.name).digest("hex"), ...(complete ? { sha256: entry.name.slice(0, 64) } : {}), bytes: info.size, modifiedAt: info.mtime.toISOString(), state: complete ? "unbound" : "incomplete", references: 0 });
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new ArtifactObjectError("Private storage inventory unavailable; nothing was removed.", 503); }
  const hashes = objects.flatMap(object => object.sha256 ? [object.sha256] : []);
  if (hashes.length) {
    const hash = sql<string>`${artifactRevisions.snapshot}->'contentObject'->>'sha256'`;
    const rows = await db.select({ sha: hash, count: sql<string>`count(*)` }).from(artifactRevisions).innerJoin(artifacts, eq(artifacts.id, artifactRevisions.artifactId)).where(and(eq(artifacts.ownerId, ownerId), sql`${artifactRevisions.snapshot}->>'ownerId' = ${ownerId}`, inArray(hash, hashes))).groupBy(hash);
    for (const object of objects) { const count = Number(rows.find(row => row.sha === object.sha256)?.count ?? 0); if (count) { object.references = count; object.state = "referenced"; } }
  }
  return { objects: objects.sort((a, b) => a.id.localeCompare(b.id)), truncated, policy: "Referenced history, unbound uploads and incomplete writes are retained. No automatic deletion. Retry the original operation to adopt the same checksum, or explicitly recover verified unbound content as a new Artifact with unknown origin." };
}
export async function recoverArtifactObject(ownerId: string, sha: string) {
  let object = await inspectOwnedObject(ownerId, sha);
  const bytes = await readArtifactObject(ownerId, object); const text = bytes.toString("utf8");
  if (!bytes.includes(0) && Buffer.from(text, "utf8").equals(bytes)) object = { ...object, mediaType: "text/plain; charset=utf-8" };
  const hash = createHash("sha256").update(`recovered-object:${ownerId}:${sha}`).digest("hex");
  const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  return insertArtifact(db, { id, ownerId, body: artifactObjectSummary(object), contentObject: object, title: `Recovered retained content — ${sha.slice(0, 12)}`, kind: "archive", sourceType: "recovered-object", sourceId: sha });
}
