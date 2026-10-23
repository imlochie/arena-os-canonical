import { assertPrivateMedia } from "@/lib/waveyard/conversion/private-media";
import { Readable } from "node:stream";
import { requireApiAccess } from "@/lib/security/api-access";
import { requireUser } from "@/lib/waveyard/local-context";
import { isUuid } from "@/lib/api/ids";
import { ownedJob, metadata } from "@/lib/waveyard/conversion/jobs";
import { getStorage } from "@/lib/waveyard/storage";
import { formats } from "@/lib/waveyard/conversion/engine";
import { verifyStoredFile } from "../../../../../../../waveyard-worker/packages/dsp/src/verified-file";
export const runtime = "nodejs";
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireApiAccess(request); if (denied) return denied;
  try {
    const { id } = await params;
    if (!isUuid(id)) return Response.json({ error: "Invalid conversion identity." }, { status: 400 });
    const job = await ownedJob((await requireUser()).id, id), m = metadata(job), storage = getStorage();
    if (!m.verification) return Response.json({ error: "No verified publication yet. Retained partial work is not a completed audio file." }, { status: 409 });
    await assertPrivateMedia(storage, m.outputKey);
    await verifyStoredFile(storage, { storageKey: m.outputKey, ...m.verification });
    const file = await storage.openReadStream(m.outputKey);
    return new Response(Readable.toWeb(file.stream) as ReadableStream, { headers: { "content-type": formats[m.settings.format].mime, "content-length": String(file.size), "cache-control": "private, no-store", "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(m.name.split("/").at(-1)!)}` } });
  } catch { return Response.json({ error: "Verified output unavailable for this owner. Restore private storage or resume; no substitute audio was served." }, { status: 422 }); }
}
