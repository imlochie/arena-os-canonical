/** Full immutable content behind the existing Artifact/revision registry.
 * Descriptor + body binding live in its owner-scoped immutable snapshot, never
 * a public storage key. SQL failure retains an object for deterministic retry;
 * no automatic collector deletes potentially recoverable work.
 */
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { getStorage, StorageIntegrityError } from "@/lib/waveyard/storage";
import type { ArtifactContentObject } from "@/db/schema";
export const MAX_ARTIFACT_OBJECT_BYTES = 32 * 1024 * 1024;
export class ArtifactObjectError extends Error {
  readonly status: number;
  constructor(message: string, status = 422) { super(message); this.status = status; }
}
function digest(bytes: string | Uint8Array) { return createHash("sha256").update(bytes).digest("hex"); }
function checked(object: ArtifactContentObject) {
  if (!object || object.version !== 1 || !/^[a-f0-9]{64}$/.test(object.sha256) || !Number.isSafeInteger(object.bytes) || object.bytes < 0 || object.bytes > MAX_ARTIFACT_OBJECT_BYTES || !["text/plain; charset=utf-8", "application/json; charset=utf-8", "application/octet-stream"].includes(object.mediaType)) throw new ArtifactObjectError("Immutable content descriptor is invalid; nothing was restored or executed.");
  return object;
}
export function artifactObjectKey(ownerId: string, object: ArtifactContentObject) {
  checked(object);
  return `owners/${digest(ownerId)}/artifact-objects/${object.sha256}.bin`;
}
export function artifactObjectSummary(object: ArtifactContentObject) {
  checked(object);
  return JSON.stringify({ note: "Complete immutable content is retained privately, not truncated into this preview. Download the selected revision to inspect every byte.", contentObject: { version: object.version, sha256: object.sha256, bytes: object.bytes, mediaType: object.mediaType } }, null, 2);
}
export function assertArtifactObjectBinding(body: string, object: ArtifactContentObject) {
  checked(object);
  if ((object.mediaType.startsWith("text/") || object.mediaType.startsWith("application/json")) && Buffer.byteLength(body, "utf8") === object.bytes && digest(body) === object.sha256) return;
  if (body !== artifactObjectSummary(object)) throw new ArtifactObjectError("Content pointer does not match the independently checksummed revision body.");
}
export async function writeArtifactObjectStream(ownerId: string, source: AsyncIterable<Uint8Array>, object: ArtifactContentObject) {
  checked(object);
  try { await getStorage().putImmutableStream(artifactObjectKey(ownerId, object), source, { bytes: object.bytes, sha256: object.sha256 }); }
  catch (error) { throw new ArtifactObjectError(error instanceof StorageIntegrityError ? error.message : "Private content upload was interrupted/unavailable. No metadata or completion was acknowledged; retained objects are safe to reconcile/retry.", error instanceof StorageIntegrityError ? 422 : 503); }
  return object;
}
export async function writeArtifactObject(ownerId: string, content: string | Buffer, mediaType = "text/plain; charset=utf-8") {
  const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  const object: ArtifactContentObject = { version: 1, sha256: digest(bytes), bytes: bytes.length, mediaType };
  return writeArtifactObjectStream(ownerId, Readable.from([bytes]), object);
}
export async function verifyArtifactObject(ownerId: string, object: ArtifactContentObject) {
  checked(object);
  try {
    if (!object.bytes) { const bytes = await getStorage().getBuffer(artifactObjectKey(ownerId, object), 1); if (bytes.length || digest(bytes) !== object.sha256) throw new ArtifactObjectError("Immutable content checksum/size mismatch."); return; }
    const opened = await getStorage().openReadStream(artifactObjectKey(ownerId, object));
    if (opened.size !== object.bytes) { opened.stream.destroy(); throw new ArtifactObjectError("Immutable content checksum/size mismatch; download/restore was not acknowledged."); }
    const hash = createHash("sha256"); let size = 0;
    for await (const chunk of opened.stream) { size += chunk.length; if (size > object.bytes) throw new ArtifactObjectError("Immutable content changed during verification."); hash.update(chunk); }
    if (size !== object.bytes || hash.digest("hex") !== object.sha256) throw new ArtifactObjectError("Immutable content checksum mismatch; download/restore was not acknowledged.");
  } catch (error) {
    if (error instanceof ArtifactObjectError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ArtifactObjectError("Immutable content is missing. Its metadata/history is retained; recover the private storage volume before retrying.", 410);
    throw new ArtifactObjectError("Private content storage unavailable. No excerpt was substituted; retry after storage recovers.", 503);
  }
}
export async function readArtifactObject(ownerId: string, object: ArtifactContentObject) {
  await verifyArtifactObject(ownerId, object);
  const bytes = await getStorage().getBuffer(artifactObjectKey(ownerId, object), MAX_ARTIFACT_OBJECT_BYTES);
  if (bytes.length !== object.bytes || digest(bytes) !== object.sha256) throw new ArtifactObjectError("Immutable content changed during retrieval.");
  return bytes;
}
export async function downloadArtifactObject(ownerId: string, object: ArtifactContentObject, filename: string) {
  await verifyArtifactObject(ownerId, object);
  const opened = object.bytes ? await getStorage().openReadStream(artifactObjectKey(ownerId, object)) : null;
  return new Response(opened ? Readable.toWeb(opened.stream) as ReadableStream<Uint8Array> : null, { headers: { "content-type": object.mediaType, "content-length": String(object.bytes), "content-disposition": `attachment; filename="${filename.replace(/[^a-zA-Z0-9._-]/g, "_")}"`, "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
}
/** A text consumer never mistakes a binary/large-file manifest for its data. */
export async function artifactRevisionText(ownerId: string, snapshot: { body: string; contentObject?: ArtifactContentObject | null }) {
  if (!snapshot.contentObject) return snapshot.body;
  if (snapshot.contentObject.bytes > 80000) throw new ArtifactObjectError("Complete content exceeds the inline input limit. Download/reuse the immutable file through an appropriate tool; its metadata preview was NOT consumed.", 413);
  if (!snapshot.contentObject.mediaType.startsWith("text/") && !snapshot.contentObject.mediaType.startsWith("application/json")) throw new ArtifactObjectError("Binary content is not a text prompt. Download it or use reuse_mission_output; no metadata preview was substituted.", 415);
  const bytes = await readArtifactObject(ownerId, snapshot.contentObject); const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes) || text.length > 20000) throw new ArtifactObjectError("Complete content is not a supported inline UTF-8 input. Download/reuse it explicitly; no excerpt was substituted.", 413);
  return text;
}
