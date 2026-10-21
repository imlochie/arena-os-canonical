import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { requireApiAccess } from "@/lib/security/api-access";
import { requireUser } from "@/lib/waveyard/local-context";
import { isUuid } from "@/lib/api/ids";
import { ownedJob, metadata } from "@/lib/waveyard/conversion/jobs";
import { getStorage } from "@/lib/waveyard/storage";
import { assertPrivateMedia } from "@/lib/waveyard/conversion/private-media";
import { ArchiveInputError, createVerifiedZip, MAX_ARCHIVE_FILES, type ArchiveEntry } from "@/lib/waveyard/conversion/archive";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const denied = await requireApiAccess(request); if (denied) return denied;
  const ids = new URL(request.url).searchParams.get("ids")?.split(",") ?? [];
  if (!ids.length || ids.length > MAX_ARCHIVE_FILES || ids.some(id => !isUuid(id)) || new Set(ids).size !== ids.length) {
    return Response.json({ error: "Select 1–100 distinct completed conversion files." }, { status: 400 });
  }
  let archive: Awaited<ReturnType<typeof createVerifiedZip>> | undefined;
  try {
    const owner = (await requireUser()).id, storage = getStorage();
    const entries: ArchiveEntry[] = [], manifest = [];
    for (const id of ids) {
      const job = await ownedJob(owner, id), m = metadata(job);
      if (job.status !== "complete" || !m.verification?.fullyDecoded) {
        return Response.json({ error: "Every selected item must be completed and fully verified. Resume unfinished items first; no partial batch was downloaded." }, { status: 409 });
      }
      await assertPrivateMedia(storage, m.outputKey);
      const key = m.outputKey;
      entries.push({
        name: m.name, bytes: m.verification.fileSizeBytes, sha256: m.verification.checksumSha256,
        open: async () => {
          await assertPrivateMedia(storage, key);
          return (await storage.openReadStream(key)).stream;
        },
      });
      // No private volume paths or playback URLs in a portable download.
      manifest.push({
        path: m.name, conversionId: id, sourceTrackId: m.trackId, outputTrackId: m.outputTrackId,
        sourceSha256: m.sourceChecksum, outputSha256: m.verification.checksumSha256,
        bytes: m.verification.fileSizeBytes, settings: m.settings, fullyDecoded: true,
      });
    }
    const receipt = Buffer.from(JSON.stringify({ version: 1, files: manifest }, null, 2) + "\n");
    entries.push({ name: "conversion-manifest.json", bytes: receipt.length,
      sha256: createHash("sha256").update(receipt).digest("hex"), open: async () => Readable.from([receipt]) });
    archive = await createVerifiedZip(entries, request.signal);
    const stream = createReadStream(archive.path, { signal: request.signal });
    const cleanup = archive.dispose;
    stream.once("close", () => { void cleanup().catch(() => undefined); });
    return new Response(Readable.toWeb(stream) as ReadableStream, { headers: {
      "content-type": "application/zip", "content-length": String(archive.bytes),
      "content-disposition": 'attachment; filename="arena-converted-music.zip"',
      "cache-control": "private, no-store", "x-content-type-options": "nosniff",
    } });
  } catch (error) {
    await archive?.dispose();
    if (error instanceof ArchiveInputError) return Response.json({ error: error.message + " Originals and conversion history are unchanged." }, { status: error.status });
    return Response.json({ error: "Selected outputs could not all be verified for this owner, or the archive exceeds its limits (100 files / 2 GiB). No partial archive was served. Originals and conversion history are unchanged; retry a smaller selection or restore unavailable output storage." }, { status: 422 });
  }
}
