import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { getDb, processingJobs, sourceAnalyses, sourceAssets, sourceSectionAnalyses, sourceSections, stemAssets, waveformAssets, waveformJobs } from "@waveyard/database";
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
    const [sources, stems, jobs, waveformRows, waveformJobRows, analysisRows, sectionAnalysisRows, sectionRows] = await Promise.all([
      db.select().from(sourceAssets).where(eq(sourceAssets.projectId, id)).orderBy(asc(sourceAssets.createdAt)),
      db.select().from(stemAssets).where(eq(stemAssets.projectId, id)).orderBy(asc(stemAssets.createdAt)),
      db.select().from(processingJobs).where(eq(processingJobs.projectId, id)).orderBy(asc(processingJobs.createdAt)),
      db.select().from(waveformAssets).where(eq(waveformAssets.projectId, id)).orderBy(asc(waveformAssets.createdAt)),
      db.select().from(waveformJobs).where(eq(waveformJobs.projectId, id)).orderBy(asc(waveformJobs.createdAt)),
      db.select().from(sourceAnalyses).where(eq(sourceAnalyses.projectId, id)).orderBy(asc(sourceAnalyses.createdAt)),
      db.select().from(sourceSectionAnalyses).where(eq(sourceSectionAnalyses.projectId, id)).orderBy(asc(sourceSectionAnalyses.createdAt)),
      db.select().from(sourceSections).where(eq(sourceSections.projectId, id)).orderBy(asc(sourceSections.sourceAssetId), asc(sourceSections.sectionIndex)),
    ]);
    const analysisBySource = new Map(
      analysisRows.map((analysis) => [
        analysis.sourceAssetId,
        { ...analysis, beatGrid: parsedBeatGrid(analysis.beatGrid) },
      ]),
    );
    const sectionAnalysisBySource = new Map(sectionAnalysisRows.map((analysis) => [analysis.sourceAssetId, analysis]));
    const sectionsBySource = new Map<string, typeof sectionRows>();
    for (const section of sectionRows) {
      const existing = sectionsBySource.get(section.sourceAssetId) ?? [];
      existing.push(section);
      sectionsBySource.set(section.sourceAssetId, existing);
    }
    return NextResponse.json({
      project,
      role,
      sources: sources.map(({ storageKey: _storageKey, ...source }) => ({
        ...source,
        analysis: analysisBySource.get(source.id) ?? null,
        sectionAnalysis: sectionAnalysisBySource.get(source.id) ?? null,
        sections: sectionsBySource.get(source.id) ?? [],
      })),
      stems: stems.map(({ storageKey: _storageKey, waveformKey: _waveformKey, ...stem }) => stem),
      waveforms: waveformRows.map(({ storageKey: _storageKey, ...waveform }) => waveform),
      waveformJobs: waveformJobRows,
      jobs,
    });
  } catch (error) { if (error instanceof Response) return error; throw error; }
}
