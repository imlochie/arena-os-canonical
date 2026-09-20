import { asc, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { stemAssets, stemProcessingJobs, stemSourceAssets } from "@/db/schema";
import { requireStemUser } from "@/lib/stems/auth";
import { requireStemProjectRole } from "@/lib/stems/permissions";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireStemUser();
    const { id } = await params;
    const access = await requireStemProjectRole(user.id, id, "viewer");
    const [sources, jobs, stems] = await Promise.all([
      db.select({
        id: stemSourceAssets.id, originalFilename: stemSourceAssets.originalFilename, mimeType: stemSourceAssets.mimeType,
        checksumSha256: stemSourceAssets.checksumSha256, durationSeconds: stemSourceAssets.durationSeconds,
        sampleRate: stemSourceAssets.sampleRate, channels: stemSourceAssets.channels, codec: stemSourceAssets.codec,
        fileSizeBytes: stemSourceAssets.fileSizeBytes, createdAt: stemSourceAssets.createdAt,
      }).from(stemSourceAssets).where(eq(stemSourceAssets.projectId, id)).orderBy(asc(stemSourceAssets.createdAt)),
      db.select().from(stemProcessingJobs).where(eq(stemProcessingJobs.projectId, id)).orderBy(desc(stemProcessingJobs.createdAt)),
      db.select({
        id: stemAssets.id, sourceAssetId: stemAssets.sourceAssetId, separationJobId: stemAssets.separationJobId,
        stemType: stemAssets.stemType, engine: stemAssets.engine, model: stemAssets.model, modelVersion: stemAssets.modelVersion,
        checksumSha256: stemAssets.checksumSha256, durationSeconds: stemAssets.durationSeconds, sampleRate: stemAssets.sampleRate,
        channels: stemAssets.channels, codec: stemAssets.codec, format: stemAssets.format, fileSizeBytes: stemAssets.fileSizeBytes,
        createdAt: stemAssets.createdAt,
      }).from(stemAssets).where(eq(stemAssets.projectId, id)).orderBy(asc(stemAssets.createdAt)),
    ]);
    return Response.json({ project: access.project, role: access.role, sources, jobs, stems });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("Stem project access failed", error);
    return Response.json({ error: "Could not open the private Stem Lab project." }, { status: 500 });
  }
}
