import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { processingJobs, sourceAssets, stemAssets } from "@/db/waveyardSchema";
import { requireUser } from "@/lib/waveyard/local-context";
import { requireProjectRole } from "@/lib/waveyard/local-context";

export const runtime = "nodejs";

/**
 * Honest unseparated-source bridge.
 *
 * Waveyard's arrangement model binds tracks to stems, and stems come from the
 * separation worker. When the worker is unavailable (queue offline), the user
 * can explicitly choose to arrange the FULL, UNSEPARATED source as one track.
 * This creates a real stem_assets row pointing at the source's own audio:
 *   stemType "source", engine "passthrough-unseparated", model "none"
 * — labeled provenance, linked to the failed separation job that caused it.
 * Real audio, honestly labeled; never presented as separated stems.
 */
export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const body = await request.json().catch(() => null);
    const sourceAssetId = typeof body?.sourceAssetId === "string" ? body.sourceAssetId : "";
    if (!sourceAssetId) return NextResponse.json({ error: "A source asset id is required." }, { status: 400 });

    const [source] = await db.select().from(sourceAssets).where(eq(sourceAssets.id, sourceAssetId)).limit(1);
    if (!source) return NextResponse.json({ error: "Source asset not found." }, { status: 404 });
    await requireProjectRole(user.id, source.projectId, "editor");

    // Only when real separation did not produce stems for this source.
    const realStems = await db.select().from(stemAssets).where(and(eq(stemAssets.sourceAssetId, source.id), eq(stemAssets.projectId, source.projectId)));
    if (realStems.some((stem) => stem.engine !== "passthrough-unseparated")) {
      return NextResponse.json({ error: "This source already has separated stems." }, { status: 409 });
    }
    if (realStems.length) {
      const existing = realStems[0];
      return NextResponse.json({ stem: existing }, { status: 200 });
    }

    // Provenance: attach to this source's separation job (the failed one).
    const [separationJob] = await db.select().from(processingJobs)
      .where(and(eq(processingJobs.sourceAssetId, source.id), eq(processingJobs.type, "separation")))
      .limit(1);
    if (!separationJob) {
      return NextResponse.json({ error: "No separation job exists for this source yet." }, { status: 409 });
    }

    const [stem] = await db.insert(stemAssets).values({
      projectId: source.projectId,
      sourceAssetId: source.id,
      separationJobId: separationJob.id,
      stemType: "source",
      engine: "passthrough-unseparated",
      model: "none",
      modelVersion: "0",
      storageKey: source.storageKey,
      checksumSha256: source.checksumSha256,
      durationSeconds: source.durationSeconds,
      sampleRate: source.sampleRate,
      channels: source.channels,
      codec: source.codec,
      format: source.mimeType,
      fileSizeBytes: source.fileSizeBytes,
    }).returning();
    return NextResponse.json({ stem }, { status: 201 });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("passthrough stem failed", error);
    return NextResponse.json({ error: "Unseparated source track could not be created." }, { status: 500 });
  }
}
