/** Transient, authorised clip preparation. The exact export tempo/pitch filters
 * run locally; nothing is published as an immutable export or Artifact. */
import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { sourceAssets, sourceAnalyses, stemAssets } from "@/db/waveyardSchema";
import { isUuid } from "@/lib/api/ids";
import { requireApiAccess } from "@/lib/security/api-access";
import { requireUser, requireProjectRole } from "@/lib/waveyard/local-context";
import { getStorage } from "@/lib/waveyard/storage";
import { execTool, FfmpegMissingError } from "@/lib/waveyard/ffmpeg";
import { verifyStoredFile, PublishedFileError } from "../../../../../../waveyard-worker/packages/dsp/src/verified-file";
import { isCurrentSourceAnalysis, atempoFilterChain, pitchFilterChain, requiredSourceDurationMs, resolveKeySync, sourceDurationFits, tempoRatio } from "../../../../../../waveyard-worker/packages/dsp/src/render";
import { normaliseMusicalKey } from "@/lib/waveyard/types";
export const runtime = "nodejs";
export const maxDuration = 120;
class InputError extends Error { readonly status: number; constructor(message: string, status = 422) { super(message); this.status = status; } }
async function body(req: Request) {
  const reader = req.body?.getReader(); if (!reader) throw new InputError("Clip settings required.", 400);
  const chunks: Uint8Array[] = []; let bytes = 0;
  try { while (true) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.length; if (bytes > 4096) throw new InputError("Clip settings exceed 4096 bytes.", 413); chunks.push(chunk.value); } }
  catch (error) { await reader.cancel(); throw error; }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new InputError("Valid JSON clip settings required.", 400); }
}
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireApiAccess(req); if (denied) return denied;
  let temporary: string | undefined;
  try {
    const { id } = await params; if (!isUuid(id)) throw new InputError("Valid stem ID required.", 400);
    const input = await body(req);
    if (!input || !Number.isInteger(input.sourceOffsetMs) || input.sourceOffsetMs < 0 || !Number.isInteger(input.durationMs) || input.durationMs <= 0 || input.durationMs > 300000 || ![44100, 48000].includes(input.sampleRate) || typeof input.tempoSyncEnabled !== "boolean" || typeof input.keySyncEnabled !== "boolean") throw new InputError("Audition requires a valid source range (up to 5 minutes), 44.1/48 kHz, and explicit sync flags.", 400);
    const user = await requireUser();
    const [stem] = await db.select().from(stemAssets).where(eq(stemAssets.id, id)).limit(1);
    if (!stem) throw new InputError("Stem unavailable.", 404);
    const { project } = await requireProjectRole(user.id, stem.projectId, "viewer");
    if (project.ownerId !== user.id) throw new InputError("Stem unavailable.", 404);
    const [source] = await db.select().from(sourceAssets).where(eq(sourceAssets.id, stem.sourceAssetId)).limit(1);
    if (!source || (await requireProjectRole(user.id, source.projectId, "viewer")).project.ownerId !== user.id) throw new InputError("Source unavailable.", 404);
    const [analysis] = await db.select().from(sourceAnalyses).where(eq(sourceAnalyses.sourceAssetId, stem.sourceAssetId)).limit(1);
    const analysisValid = isCurrentSourceAnalysis(analysis, source);
    let ratio = 1, shift: number | undefined;
    if (input.tempoSyncEnabled) {
      if (!analysisValid) throw new InputError("Tempo sync requires complete analysis of the current source. Run source analysis and retry.");
      try { ratio = tempoRatio(input.tempoBpm, analysis.bpm!); } catch { throw new InputError("Tempo sync requires source BPM 40–300 and target BPM 20–300."); }
    }
    if (input.keySyncEnabled) {
      const result = resolveKeySync(analysisValid ? "complete" : undefined, normaliseMusicalKey(analysis?.musicalKey), normaliseMusicalKey(input.targetKey));
      if ("errorCode" in result) throw new InputError("Key sync requires complete current-source key analysis and a usable target key.");
      shift = result.semitones;
    }
    if (!sourceDurationFits(input.sourceOffsetMs, input.durationMs, ratio, stem.durationSeconds * 1000)) throw new InputError("The synchronised clip requires more source audio than is available.");
    const storage = getStorage(); await verifyStoredFile(storage, stem); req.signal.throwIfAborted();
    temporary = await mkdtemp(join(tmpdir(), "arena-audition-"));
    let filename = storage.getLocalPath(stem.storageKey);
    if (!filename) { filename = join(temporary, "input.wav"); await storage.getToFile(stem.storageKey, filename); }
    const seconds = (ms: number) => (ms / 1000).toFixed(3);
    const filters = [`atrim=start=${seconds(input.sourceOffsetMs)}:duration=${seconds(requiredSourceDurationMs(input.durationMs, ratio))}`, "asetpts=PTS-STARTPTS"];
    if (input.tempoSyncEnabled) filters.push(atempoFilterChain(ratio));
    filters.push(`aformat=sample_rates=${input.sampleRate}:channel_layouts=stereo`);
    if (shift !== undefined) filters.push(pitchFilterChain(shift, input.sampleRate));
    filters.push(`atrim=duration=${seconds(input.durationMs)}`, "apad", `atrim=duration=${seconds(input.durationMs)}`);
    const output = join(temporary, "clip.wav");
    await execTool("ffmpeg", ["-v", "error", "-y", "-i", filename, "-af", filters.join(","), "-ar", String(input.sampleRate), "-ac", "2", "-c:a", "pcm_s16le", output], { signal: req.signal });
    req.signal.throwIfAborted(); const info = await stat(output);
    const stream = createReadStream(output); const directory = temporary;
    const abort = () => stream.destroy(new Error("Audition request cancelled.")); req.signal.addEventListener("abort", abort, { once: true });
    stream.once("close", () => { req.signal.removeEventListener("abort", abort); void rm(directory, { recursive: true, force: true }); });
    const response = new Response(Readable.toWeb(stream, { strategy: { highWaterMark: 65536, size: (chunk: Buffer) => chunk.byteLength } }) as ReadableStream, { headers: { "content-type": "audio/wav", "content-length": String(info.size), "cache-control": "private, no-store", "x-content-type-options": "nosniff", "x-audition-tempo-ratio": String(ratio), "x-audition-key-semitones": String(shift ?? 0), "x-source-checksum-sha256": stem.checksumSha256 } });
    temporary = undefined; return response;
  } catch (error) {
    if (error instanceof Response) return error;
    if (req.signal.aborted) return Response.json({ error: "Audition preparation cancelled." }, { status: 499 });
    const status = error instanceof InputError || error instanceof PublishedFileError ? error.status : error instanceof FfmpegMissingError ? 503 : 503;
    return Response.json({ error: error instanceof InputError || error instanceof PublishedFileError || error instanceof FfmpegMissingError ? error.message : "Local clip transformation failed; no untransformed substitute was played." }, { status });
  } finally { if (temporary) await rm(temporary, { recursive: true, force: true }); }
}
