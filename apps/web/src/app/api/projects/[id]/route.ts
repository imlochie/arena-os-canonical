import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { getDb, processingJobs, sourceAnalyses, sourceAssets, stemAssets, waveformAssets, waveformJobs } from "@waveyard/database";
import { requireUser } from "@/lib/auth";
import { requireProjectRole } from "@/lib/permissions";

function parsedBeatGrid(value: string | null) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => Number.isInteger(item))
      ? parsed
      : null;
  } catch {
    return null;
  }
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(); const { id } = await params;
    const { project, role } = await requireProjectRole(user.id, id, "viewer");
    const db = getDb();
    const [sources, stems, jobs, waveformRows, waveformJobRows, analysisRows] = await Promise.all([
      db.select().from(sourceAssets).where(eq(sourceAssets.projectId, id)).orderBy(asc(sourceAssets.createdAt)),
      db.select().from(stemAssets).where(eq(stemAssets.projectId, id)).orderBy(asc(stemAssets.createdAt)),
      db.select().from(processingJobs).where(eq(processingJobs.projectId, id)).orderBy(asc(processingJobs.createdAt)),
      db.select().from(waveformAssets).where(eq(waveformAssets.projectId, id)).orderBy(asc(waveformAssets.createdAt)),
      db.select().from(waveformJobs).where(eq(waveformJobs.projectId, id)).orderBy(asc(waveformJobs.createdAt)),
      db.select().from(sourceAnalyses).where(eq(sourceAnalyses.projectId, id)).orderBy(asc(sourceAnalyses.createdAt)),
    ]);
    const analysisBySource = new Map(
      analysisRows.map((analysis) => [
        analysis.sourceAssetId,
        { ...analysis, beatGrid: parsedBeatGrid(analysis.beatGrid) },
      ]),
    );
    return NextResponse.json({
      project,
      role,
      sources: sources.map(({ storageKey: _storageKey, ...source }) => ({
        ...source,
        analysis: analysisBySource.get(source.id) ?? null,
      })),
      stems: stems.map(({ storageKey: _storageKey, waveformKey: _waveformKey, ...stem }) => stem),
      waveforms: waveformRows.map(({ storageKey: _storageKey, ...waveform }) => waveform),
      waveformJobs: waveformJobRows,
      jobs,
    });
  } catch (error) { if (error instanceof Response) return error; throw error; }
}
