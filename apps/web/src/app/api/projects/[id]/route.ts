import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { getDb, processingJobs, sourceAnalyses, sourceAssets, sourceEventAnalyses, sourceEvents, sourceSectionAnalyses, sourceSections, stemAssets, vocalAnalyses, vocalPhrases, vocalPitchFrames, waveformAssets, waveformJobs } from "@waveyard/database";
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
    const [sources, stems, jobs, waveformRows, waveformJobRows, analysisRows, sectionAnalysisRows, sectionRows, eventAnalysisRows, eventRows, vocalAnalysisRows, vocalFrameRows, vocalPhraseRows] = await Promise.all([
      db.select().from(sourceAssets).where(eq(sourceAssets.projectId, id)).orderBy(asc(sourceAssets.createdAt)),
      db.select().from(stemAssets).where(eq(stemAssets.projectId, id)).orderBy(asc(stemAssets.createdAt)),
      db.select().from(processingJobs).where(eq(processingJobs.projectId, id)).orderBy(asc(processingJobs.createdAt)),
      db.select().from(waveformAssets).where(eq(waveformAssets.projectId, id)).orderBy(asc(waveformAssets.createdAt)),
      db.select().from(waveformJobs).where(eq(waveformJobs.projectId, id)).orderBy(asc(waveformJobs.createdAt)),
      db.select().from(sourceAnalyses).where(eq(sourceAnalyses.projectId, id)).orderBy(asc(sourceAnalyses.createdAt)),
      db.select().from(sourceSectionAnalyses).where(eq(sourceSectionAnalyses.projectId, id)).orderBy(asc(sourceSectionAnalyses.createdAt)),
      db.select().from(sourceSections).where(eq(sourceSections.projectId, id)).orderBy(asc(sourceSections.sourceAssetId), asc(sourceSections.sectionIndex)),
      db.select().from(sourceEventAnalyses).where(eq(sourceEventAnalyses.projectId, id)).orderBy(asc(sourceEventAnalyses.createdAt)),
      db.select().from(sourceEvents).where(eq(sourceEvents.projectId, id)).orderBy(asc(sourceEvents.sourceAssetId), asc(sourceEvents.timestampMs)),
      db.select().from(vocalAnalyses).where(eq(vocalAnalyses.projectId, id)).orderBy(asc(vocalAnalyses.createdAt)),
      db.select().from(vocalPitchFrames).innerJoin(vocalAnalyses, eq(vocalPitchFrames.vocalAnalysisId, vocalAnalyses.id)).where(eq(vocalAnalyses.projectId, id)).orderBy(asc(vocalAnalyses.stemAssetId), asc(vocalPitchFrames.frameIndex)),
      db.select().from(vocalPhrases).innerJoin(vocalAnalyses, eq(vocalPhrases.vocalAnalysisId, vocalAnalyses.id)).where(eq(vocalAnalyses.projectId, id)).orderBy(asc(vocalAnalyses.stemAssetId), asc(vocalPhrases.phraseIndex)),
    ]);
    const analysisBySource = new Map(
      analysisRows.map((analysis) => [
        analysis.sourceAssetId,
        { ...analysis, beatGrid: parsedBeatGrid(analysis.beatGrid) },
      ]),
    );
    const sectionAnalysisBySource = new Map(sectionAnalysisRows.map((analysis) => [analysis.sourceAssetId, analysis]));
    const eventAnalysisBySource = new Map(eventAnalysisRows.map((analysis) => [analysis.sourceAssetId, analysis]));
    const eventsBySource = new Map<string, typeof eventRows>();
    for (const event of eventRows) {
      const existing = eventsBySource.get(event.sourceAssetId) ?? [];
      existing.push(event);
      eventsBySource.set(event.sourceAssetId, existing);
    }
    const sectionsBySource = new Map<string, typeof sectionRows>();
    for (const section of sectionRows) {
      const existing = sectionsBySource.get(section.sourceAssetId) ?? [];
      existing.push(section);
      sectionsBySource.set(section.sourceAssetId, existing);
    }
    const vocalAnalysisByStem = new Map(vocalAnalysisRows.map((analysis) => [analysis.stemAssetId, analysis]));
    const framesByStem = new Map<string, (typeof vocalFrameRows)[number]["vocal_pitch_frames"][]>();
    for (const row of vocalFrameRows) {
      const stemId = row.vocal_analyses.stemAssetId;
      const existing = framesByStem.get(stemId) ?? [];
      existing.push(row.vocal_pitch_frames);
      framesByStem.set(stemId, existing);
    }
    const phrasesByStem = new Map<string, (typeof vocalPhraseRows)[number]["vocal_phrases"][]>();
    for (const row of vocalPhraseRows) {
      const stemId = row.vocal_analyses.stemAssetId;
      const existing = phrasesByStem.get(stemId) ?? [];
      existing.push(row.vocal_phrases);
      phrasesByStem.set(stemId, existing);
    }
    return NextResponse.json({
      project,
      role,
      sources: sources.map(({ storageKey: _storageKey, ...source }) => ({
        ...source,
        analysis: analysisBySource.get(source.id) ?? null,
        sectionAnalysis: sectionAnalysisBySource.get(source.id) ?? null,
        sections: sectionsBySource.get(source.id) ?? [],
        eventAnalysis: eventAnalysisBySource.get(source.id) ?? null,
        events: eventsBySource.get(source.id) ?? [],
      })),
      stems: stems.map(({ storageKey: _storageKey, waveformKey: _waveformKey, ...stem }) => ({
        ...stem,
        vocalAnalysis: vocalAnalysisByStem.get(stem.id) ?? null,
        vocalFrames: framesByStem.get(stem.id) ?? [],
        vocalPhrases: phrasesByStem.get(stem.id) ?? [],
      })),
      waveforms: waveformRows.map(({ storageKey: _storageKey, ...waveform }) => waveform),
      waveformJobs: waveformJobRows,
      jobs,
    });
  } catch (error) { if (error instanceof Response) return error; throw error; }
}
