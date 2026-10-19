/** Durable deliverables use the existing object provider and Artifact revisions.
 * Paths are display/origin metadata only; retrieval never reopens the workspace.
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { spaceMissions, artifactRevisions, LOCAL_OWNER_ID } from "@/db/schema";
import { insertArtifact, getArtifactRevision } from "../arcadeStore";
import { getStorage } from "../waveyard/storage";
import { workspaceDir, type ToolOutcome } from "./tools";
export const MAX_MISSION_OUTPUT_BYTES = 32 * 1024 * 1024;
export type MissionOutput = { path: string; bytes: number; id?: string; artifactId?: string; revisionId?: string; checksumSha256?: string; mediaType?: string; ownerId?: string; requestId?: string; tool?: string; state?: "complete" | "unavailable"; error?: string; createdAt?: string };
function sha(bytes: Buffer | string) { return createHash("sha256").update(bytes).digest("hex"); }
function identity(seed: string) { const h = sha(seed); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`; }
function objectKey(checksum: string) { if (!/^[a-f0-9]{64}$/.test(checksum)) throw new Error("Invalid output checksum."); return `owners/${LOCAL_OWNER_ID}/mission-outputs/${checksum}.bin`; }
export async function containedOutputPath(root: string, name: string, allowMissing = false) {
  if (!name || path.isAbsolute(name)) throw new Error("Output path must be relative to its workspace.");
  const full = path.resolve(root, name); if (!full.startsWith(root + path.sep)) throw new Error("Output path escapes its workspace.");
  const parts = [root, ...path.relative(root, full).split(path.sep).map((_, index, all) => path.join(root, ...all.slice(0, index + 1)))];
  for (const part of parts) {
    try { if ((await lstat(part)).isSymbolicLink()) throw new Error("Symlink outputs are not authorised."); }
    catch (error) { if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") break; throw error; }
  }
  return full;
}
async function readFileOutput(spaceId: string, name: string) {
  const full = await containedOutputPath(workspaceDir(spaceId), name);
  const file = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > MAX_MISSION_OUTPUT_BYTES) throw new Error("Output must be a single regular file no larger than 32 MiB.");
    const bytes = await file.readFile(); const after = await file.stat();
    if (bytes.length !== before.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("Output changed while being captured; register it again when stable.");
    return bytes;
  } finally { await file.close(); }
}
export async function inspectOutput(spaceId: string, name: string) { const bytes = await readFileOutput(spaceId, name); return JSON.stringify({ path: name, bytes: bytes.length, checksumSha256: sha(bytes) }); }
export async function captureMissionOutput(database: typeof defaultDb, missionId: string, spaceId: string, action: ToolOutcome): Promise<MissionOutput> {
  const log = ["run_command", "run_tests"].includes(action.tool);
  const name = log ? `${action.tool}-${action.requestId}.log` : String(action.input.path ?? "");
  const id = identity(`${missionId}:${action.requestId}:${name}`);
  try {
    if (!action.ok && !log) throw new Error(`Operation failed: ${action.output}`);
    const bytes = log ? Buffer.from(action.output, "utf8") : await readFileOutput(spaceId, name);
    if (bytes.length > MAX_MISSION_OUTPUT_BYTES) throw new Error("Output exceeds the 32 MiB snapshot limit.");
    if (action.tool === "write_file" && !bytes.equals(Buffer.from(String(action.input.content ?? ""), "utf8"))) throw new Error("Output no longer matches the executed write; original bytes cannot be claimed.");
    const checksum = sha(bytes);
    if (action.tool === "publish_output" && JSON.parse(action.output).checksumSha256 !== checksum) throw new Error("Output changed after it was inspected; publish a new stable observation.");
    await getStorage().putImmutableBuffer(objectKey(checksum), bytes);
    const text = bytes.toString("utf8"); const isText = !bytes.includes(0) && Buffer.from(text, "utf8").equals(bytes);
    const mediaType = isText ? "text/plain; charset=utf-8" : "application/octet-stream";
    const artifactBody = isText && text.length <= 20000 ? text : JSON.stringify({ name, bytes: bytes.length, checksumSha256: checksum, mediaType, note: "Full content is in the mission output snapshot, not truncated into this metadata." });
    const artifact = await insertArtifact(database, { id: identity(`artifact:${id}:${checksum}`), ownerId: LOCAL_OWNER_ID, title: path.basename(name), kind: log ? "test-report" : "mission-file", sourceType: "mission-output", sourceId: missionId, body: artifactBody });
    const [originalRevision] = await database.select().from(artifactRevisions).where(and(eq(artifactRevisions.artifactId, artifact.id), eq(artifactRevisions.revision, 1))).limit(1);
    if (!originalRevision || originalRevision.snapshot.body !== artifactBody) throw new Error("Output Artifact baseline does not match the captured bytes.");
    return { id, artifactId: artifact.id, revisionId: originalRevision.id, path: name, bytes: bytes.length, checksumSha256: checksum, mediaType, ownerId: LOCAL_OWNER_ID, requestId: action.requestId, tool: action.tool, state: "complete", createdAt: new Date().toISOString() };
  } catch (error) { return { id, path: name, bytes: 0, requestId: action.requestId, tool: action.tool, state: "unavailable", error: error instanceof Error ? error.message : "Output capture unavailable." }; }
}
export async function retrieveMissionOutput(spaceId: string, missionId: string, outputId: string, database: typeof defaultDb = defaultDb) {
  const [mission] = await database.select().from(spaceMissions).where(and(eq(spaceMissions.id, missionId), eq(spaceMissions.spaceId, spaceId))).limit(1);
  const output = (mission?.artifacts as MissionOutput[] | null)?.find((item) => item.id === outputId);
  if (!output || output.ownerId !== LOCAL_OWNER_ID || output.state !== "complete" || !output.artifactId || !output.revisionId || !output.checksumSha256) throw new Error("Output unavailable, incomplete, or not authorised for this mission.");
  const revision = await getArtifactRevision(database, output.artifactId, output.revisionId, LOCAL_OWNER_ID);
  if (!revision || revision.snapshot.sourceId !== missionId || revision.snapshot.sourceType !== "mission-output") throw new Error("Output is not bound to an owned immutable Artifact revision.");
  const bytes = await getStorage().getBuffer(objectKey(output.checksumSha256), MAX_MISSION_OUTPUT_BYTES);
  if (bytes.length !== output.bytes || sha(bytes) !== output.checksumSha256) throw new Error("Output snapshot is corrupted or stale; checksum verification failed.");
  return { output, bytes };
}
