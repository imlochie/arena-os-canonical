import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { getDb, processingJobs, sourceAssets, stemAssets } from "@waveyard/database";
import { requireUser } from "@/lib/auth";
import { requireProjectRole } from "@/lib/permissions";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(); const { id } = await params;
    const { project, role } = await requireProjectRole(user.id, id, "viewer");
    const db = getDb();
    const [sources, stems, jobs] = await Promise.all([
      db.select().from(sourceAssets).where(eq(sourceAssets.projectId, id)).orderBy(asc(sourceAssets.createdAt)),
      db.select().from(stemAssets).where(eq(stemAssets.projectId, id)).orderBy(asc(stemAssets.createdAt)),
      db.select().from(processingJobs).where(eq(processingJobs.projectId, id)).orderBy(asc(processingJobs.createdAt)),
    ]);
    return NextResponse.json({
      project,
      role,
      sources: sources.map(({ storageKey: _storageKey, ...source }) => source),
      stems: stems.map(({ storageKey: _storageKey, waveformKey: _waveformKey, ...stem }) => stem),
      jobs,
    });
  } catch (error) { if (error instanceof Response) return error; throw error; }
}
