import { isUuid } from "@workspace/arena/lib/api/ids";

import { desc, eq } from "drizzle-orm";
import { validateWaveform } from "@workspace/arena/lib/waveyard/audio";
import { db } from "@workspace/db";
import {
  sourceAssets,
  stemAssets,
  waveformAssets,
  waveformJobs,
} from "@workspace/db/waveyardSchema";
import type { WaveformDocument } from "@workspace/arena/lib/waveyard/types";
import { getStorage } from "@workspace/arena/lib/waveyard/storage";
import { requireUser } from "@workspace/arena/lib/waveyard/local-context";
import { requireProjectRole } from "@workspace/arena/lib/waveyard/local-context";

export const runtime = "nodejs";
const MAX_WAVEFORM_BYTES = 2_000_000;

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    if (!isUuid(id)) return Response.json({ error: "Invalid id parameter" }, { status: 400 });
    
    const [stem] = await db.select().from(stemAssets).where(eq(stemAssets.id, id)).limit(1);
    const [source] = stem ? [undefined] : await db.select().from(sourceAssets).where(eq(sourceAssets.id, id)).limit(1);
    const asset = stem ?? source;
    if (!asset) return Response.json({ error: "Audio asset not found." }, { status: 404 });
    await requireProjectRole(user.id, asset.projectId, "viewer");
    const [waveformRecord] = stem
      ? await db.select().from(waveformAssets).where(eq(waveformAssets.stemAssetId, stem.id)).limit(1)
      : await db.select().from(waveformAssets)
        .where(eq(waveformAssets.sourceAssetId, source!.id))
        .orderBy(desc(waveformAssets.createdAt))
        .limit(1);
    let waveform: typeof waveformAssets.$inferSelect | undefined = waveformRecord;
    if (source && waveformRecord) {
      let metadata: Record<string, unknown> | null = null;
      try {
        const parsed = JSON.parse(waveformRecord.metadata);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          metadata = parsed as Record<string, unknown>;
        }
      } catch {
        metadata = null;
      }
      const waveformSourceChecksum = metadata?.sourceChecksumSha256;
      // Legacy waveform rows have no provenance; restore removes these rows
      // before queuing work, while new workers pin the source checksum.
      const matchesCurrentSource = typeof waveformSourceChecksum !== "string"
        || waveformSourceChecksum === source.checksumSha256;
      if (!matchesCurrentSource) waveform = undefined;
    }
    if (!waveform) {
      const [job] = await db
        .select({
          id: waveformJobs.id,
          status: waveformJobs.status,
          errorCode: waveformJobs.errorCode,
        })
        .from(waveformJobs)
        .where(stem
          ? eq(waveformJobs.stemAssetId, stem.id)
          : eq(waveformJobs.sourceAssetId, source!.id))
        .orderBy(desc(waveformJobs.updatedAt))
        .limit(1);
      return Response.json({
        error: "Waveform is not available for this asset yet.",
        waveformJob: job ?? null,
      }, { status: 404 });
    }
    const document = JSON.parse((await getStorage().getBuffer(waveform.storageKey, MAX_WAVEFORM_BYTES)).toString("utf8")) as WaveformDocument;
    validateWaveform(document);
    return Response.json({ waveform: document, format: waveform.format, checksumSha256: waveform.checksumSha256 }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("waveform delivery failed", error);
    return Response.json({ error: "Waveform data could not be read." }, { status: 500 });
  }
}
