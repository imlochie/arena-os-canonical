import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { db } from "@/db";
import { waveformAssets, waveformJobs } from "@/db/waveyardSchema";
import { validateWaveform } from "@/lib/waveyard/audio";
import type { WaveformDocument } from "@/lib/waveyard/types";
import { getStorage, privateObjectKey } from "@/lib/waveyard/storage";
import { requireUser } from "@/lib/waveyard/local-context";
import { requireProjectRole } from "@/lib/waveyard/local-context";

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
    if (!job) return NextResponse.json({ error: "Waveform job not found." }, { status: 404 });
    await requireProjectRole(user.id, job.projectId, "editor");
    if (!job.sourceAssetId) return NextResponse.json({ error: "Only source waveforms can be browser-computed." }, { status: 409 });
    if (job.status === "complete") return NextResponse.json({ error: "This waveform already exists." }, { status: 409 });

    const body = await request.json().catch(() => null);
    const document = body?.waveform as WaveformDocument | undefined;
    if (!document) return NextResponse.json({ error: "A waveform document is required." }, { status: 400 });
    try {
      validateWaveform(document);
    } catch {
      return NextResponse.json({ error: "The browser waveform failed validation." }, { status: 422 });
    }

    const serialized = JSON.stringify(document);
    const checksum = createHash("sha256").update(serialized).digest("hex");
    const storageKey = privateObjectKey(job.projectId, "waveform", "json");
    const storage = getStorage();
    await storage.putBuffer?.(storageKey, serialized);
    const [asset] = await db.insert(waveformAssets).values({
      projectId: job.projectId,
      sourceAssetId: job.sourceAssetId,
      waveformJobId: job.id,
      storageKey,
      checksumSha256: checksum,
      format: "waveyard-peaks-v1",
      metadata: JSON.stringify({ engine: "browser-webaudio", note: "Computed in the browser from the decoded audio; worker unavailable." }),
    }).returning();
    const [updated] = await db.update(waveformJobs).set({
      status: "complete",
      stage: "browser-computed",
      errorCode: null,
      errorMessage: null,
      completedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(waveformJobs.id, job.id)).returning();
    return NextResponse.json({ waveformAsset: asset, waveformJob: updated }, { status: 201 });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("browser waveform failed", error);
    return NextResponse.json({ error: "Browser waveform could not be stored." }, { status: 500 });
  }
}
