
import { eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { db } from "@workspace/db";
import { sourceAssets, waveformAssets, waveformJobs } from "@workspace/db/waveyardSchema";
import { validateWaveform } from "@workspace/arena/lib/waveyard/audio";
import type { WaveformDocument } from "@workspace/arena/lib/waveyard/types";
import { getStorage, privateObjectKey } from "@workspace/arena/lib/waveyard/storage";
import { requireUser } from "@workspace/arena/lib/waveyard/local-context";
import { requireProjectRole } from "@workspace/arena/lib/waveyard/local-context";

export const runtime = "nodejs";

/**
 * The honest offline waveform path: the browser decoded the actual audio via
 * Web Audio and computed real peaks in the waveyard-peaks-v1 format. The
 * document passes the same validateWaveform() the worker output must pass and
 * is stored with job stage "browser-computed" so the provenance of every
 * waveform is explicit.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const [job] = await db.select().from(waveformJobs).where(eq(waveformJobs.id, id)).limit(1);
    if (!job) return Response.json({ error: "Waveform job not found." }, { status: 404 });
    await requireProjectRole(user.id, job.projectId, "editor");
    if (!job.sourceAssetId) return Response.json({ error: "Only source waveforms can be browser-computed." }, { status: 409 });
    if (job.status === "complete" || job.status === "cancelled") {
      return Response.json({ error: "This waveform job is no longer available." }, { status: 409 });
    }

    const body = await request.json().catch(() => null);
    const document = body?.waveform as WaveformDocument | undefined;
    if (!document) return Response.json({ error: "A waveform document is required." }, { status: 400 });
    try {
      validateWaveform(document);
    } catch {
      return Response.json({ error: "The browser waveform failed validation." }, { status: 422 });
    }

    const serialized = JSON.stringify(document);
    const checksum = createHash("sha256").update(serialized).digest("hex");
    const [source] = await db.select().from(sourceAssets).where(eq(sourceAssets.id, job.sourceAssetId)).limit(1);
    if (!source) return Response.json({ error: "The source audio is unavailable." }, { status: 404 });
    const storageKey = privateObjectKey(job.projectId, "waveform", "json");
    const storage = getStorage();
    await storage.putBuffer?.(storageKey, serialized);
    let asset;
    let updated;
    try {
      await db.transaction(async (tx) => {
        const [currentSource] = await tx.select().from(sourceAssets)
          .where(eq(sourceAssets.id, job.sourceAssetId!)).for("update").limit(1);
        const [currentJob] = await tx.select().from(waveformJobs)
          .where(eq(waveformJobs.id, job.id)).for("update").limit(1);
        if (!currentSource || currentJob?.status === "cancelled" || currentJob?.status === "complete") {
          throw new Error("The waveform job was replaced before it could be saved.");
        }
        [asset] = await tx.insert(waveformAssets).values({
          projectId: job.projectId,
          sourceAssetId: job.sourceAssetId,
          waveformJobId: job.id,
          storageKey,
          checksumSha256: checksum,
          format: "waveyard-peaks-v1",
          metadata: JSON.stringify({
            engine: "browser-webaudio",
            note: "Computed in the browser from the decoded audio; worker unavailable.",
            sourceChecksumSha256: currentSource.checksumSha256,
          }),
        }).returning();
        [updated] = await tx.update(waveformJobs).set({
          status: "complete",
          stage: "browser-computed",
          errorCode: null,
          errorMessage: null,
          completedAt: new Date(),
          updatedAt: new Date(),
        }).where(eq(waveformJobs.id, job.id)).returning();
      });
    } catch (error) {
      await storage.delete(storageKey).catch(() => undefined);
      throw error;
    }
    return Response.json({ waveformAsset: asset, waveformJob: updated }, { status: 201 });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("browser waveform failed", error);
    return Response.json({ error: "Browser waveform could not be stored." }, { status: 500 });
  }
}
