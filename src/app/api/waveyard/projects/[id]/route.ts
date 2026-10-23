import { projectAudio } from "@/lib/waveyard/project-audio";
import { isUuid } from "@/lib/api/ids";
import { NextResponse } from "next/server";
import { asc, desc, eq, inArray, or } from "drizzle-orm";
import { db } from "@/db";
import {
  drumAnalyses,
  drumEvents,
  harmonyAnalyses,
  harmonyEvents,
  processingJobs,
  projectBuilds,
  sourceAcquisitions,
  sourceAnalyses,
  sourceAssets,
  sourceEventAnalyses,
  sourceEvents,
  sourceSectionAnalyses,
  sourceSections,
  vocalAnalyses,
  vocalPhrases,
  vocalPitchFrames,
  waveformAssets,
  waveformJobs,
} from "@/db/waveyardSchema";
import { requireUser } from "@/lib/waveyard/local-context";
import { requireProjectRole } from "@/lib/waveyard/local-context";

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
    if (!isUuid(id)) return NextResponse.json({ error: "Invalid id parameter" }, { status: 400 });
    const { project, role } = await requireProjectRole(user.id, id, "viewer");
    
    const audio = await projectAudio(id);
    const sourceIds = audio.sources.map((source) => source.id);
    const stemIds = audio.stems.map((stem) => stem.id);
    const [sources, stems, jobs, waveformRows, waveformJobRows, analysisRows, sectionAnalysisRows, sectionRows, eventAnalysisRows, eventRows, harmonyAnalysisRows, harmonyEventRows, drumAnalysisRows, drumEventRows, vocalAnalysisRows, vocalFrameRows, vocalPhraseRows, acquisitionRows, buildRows] = await Promise.all([
      Promise.resolve(audio.sources),
      Promise.resolve(audio.stems),
      db.select().from(processingJobs).where(eq(processingJobs.projectId, id)).orderBy(asc(processingJobs.createdAt)),
      db.select().from(waveformAssets).where(or(inArray(waveformAssets.sourceAssetId, sourceIds), inArray(waveformAssets.stemAssetId, stemIds))).orderBy(asc(waveformAssets.createdAt)),
      db.select().from(waveformJobs).where(eq(waveformJobs.projectId, id)).orderBy(asc(waveformJobs.createdAt)),
      db.select().from(sourceAnalyses).where(inArray(sourceAnalyses.sourceAssetId, sourceIds)).orderBy(asc(sourceAnalyses.createdAt)),
      db.select().from(sourceSectionAnalyses).where(inArray(sourceSectionAnalyses.sourceAssetId, sourceIds)).orderBy(asc(sourceSectionAnalyses.createdAt)),
      db.select().from(sourceSections).where(inArray(sourceSections.sourceAssetId, sourceIds)).orderBy(asc(sourceSections.sourceAssetId), asc(sourceSections.sectionIndex)),
      db.select().from(sourceEventAnalyses).where(inArray(sourceEventAnalyses.sourceAssetId, sourceIds)).orderBy(asc(sourceEventAnalyses.createdAt)),
      db.select().from(sourceEvents).where(inArray(sourceEvents.sourceAssetId, sourceIds)).orderBy(asc(sourceEvents.sourceAssetId), asc(sourceEvents.timestampMs)),
      db.select().from(harmonyAnalyses).where(inArray(harmonyAnalyses.sourceAssetId, sourceIds)).orderBy(asc(harmonyAnalyses.createdAt)),
      db.select().from(harmonyEvents).innerJoin(harmonyAnalyses, eq(harmonyEvents.harmonyAnalysisId, harmonyAnalyses.id)).where(inArray(harmonyAnalyses.sourceAssetId, sourceIds)).orderBy(asc(harmonyAnalyses.sourceAssetId), asc(harmonyEvents.eventIndex)),
      db.select().from(drumAnalyses).where(inArray(drumAnalyses.stemAssetId, stemIds)).orderBy(asc(drumAnalyses.createdAt)),
      db.select().from(drumEvents).innerJoin(drumAnalyses, eq(drumEvents.drumAnalysisId, drumAnalyses.id)).where(inArray(drumAnalyses.stemAssetId, stemIds)).orderBy(asc(drumAnalyses.stemAssetId), asc(drumEvents.eventIndex)),
      db.select().from(vocalAnalyses).where(inArray(vocalAnalyses.stemAssetId, stemIds)).orderBy(asc(vocalAnalyses.createdAt)),
      db.select().from(vocalPitchFrames).innerJoin(vocalAnalyses, eq(vocalPitchFrames.vocalAnalysisId, vocalAnalyses.id)).where(inArray(vocalAnalyses.stemAssetId, stemIds)).orderBy(asc(vocalAnalyses.stemAssetId), asc(vocalPitchFrames.frameIndex)),
      db.select().from(vocalPhrases).innerJoin(vocalAnalyses, eq(vocalPhrases.vocalAnalysisId, vocalAnalyses.id)).where(inArray(vocalAnalyses.stemAssetId, stemIds)).orderBy(asc(vocalAnalyses.stemAssetId), asc(vocalPhrases.phraseIndex)),
      db.select().from(sourceAcquisitions).innerJoin(sourceAssets, eq(sourceAcquisitions.sourceAssetId, sourceAssets.id)).where(inArray(sourceAssets.id, sourceIds)),
      db.select().from(projectBuilds).where(eq(projectBuilds.projectId, id)).orderBy(desc(projectBuilds.updatedAt)).limit(1),
    ]);
    const analysisBySource = new Map(
      analysisRows.map((analysis) => [
        analysis.sourceAssetId,
        { ...analysis, beatGrid: parsedBeatGrid(analysis.beatGrid) },
      ]),
    );
    const sectionAnalysisBySource = new Map(sectionAnalysisRows.map((analysis) => [analysis.sourceAssetId, analysis]));
    const acquisitionBySource = new Map(acquisitionRows.map((row) => [row.source_acquisitions.sourceAssetId, row.source_acquisitions]));
    const eventAnalysisBySource = new Map(eventAnalysisRows.map((analysis) => [analysis.sourceAssetId, analysis]));
    const eventsBySource = new Map<string, typeof eventRows>();
    for (const event of eventRows) {
      const existing = eventsBySource.get(event.sourceAssetId) ?? [];
      existing.push(event);
      eventsBySource.set(event.sourceAssetId, existing);
    }
    const harmonyAnalysisBySource = new Map(harmonyAnalysisRows.map((analysis) => [analysis.sourceAssetId, analysis]));
    const harmonyEventsBySource = new Map<string, (typeof harmonyEventRows)[number]["harmony_events"][]>();
    for (const row of harmonyEventRows) {
      const sourceId = row.harmony_analyses.sourceAssetId;
      const existing = harmonyEventsBySource.get(sourceId) ?? [];
      existing.push(row.harmony_events);
      harmonyEventsBySource.set(sourceId, existing);
    }
    const sectionsBySource = new Map<string, typeof sectionRows>();
    for (const section of sectionRows) {
      const existing = sectionsBySource.get(section.sourceAssetId) ?? [];
      existing.push(section);
      sectionsBySource.set(section.sourceAssetId, existing);
    }
    const drumAnalysisByStem = new Map(drumAnalysisRows.map((analysis) => [analysis.stemAssetId, analysis]));
    const drumEventsByStem = new Map<string, (typeof drumEventRows)[number]["drum_events"][]>();
    for (const row of drumEventRows) {
      const stemId = row.drum_analyses.stemAssetId;
      const existing = drumEventsByStem.get(stemId) ?? [];
      existing.push(row.drum_events);
      drumEventsByStem.set(stemId, existing);
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
      build: buildRows[0] ?? null,
      sources: sources.map(({ storageKey: _storageKey, ...source }) => ({
        ...source,
        analysis: analysisBySource.get(source.id) ?? null,
        acquisition: acquisitionBySource.get(source.id) ?? null,
        sectionAnalysis: sectionAnalysisBySource.get(source.id) ?? null,
        sections: sectionsBySource.get(source.id) ?? [],
        eventAnalysis: eventAnalysisBySource.get(source.id) ?? null,
        events: eventsBySource.get(source.id) ?? [],
        harmonyAnalysis: harmonyAnalysisBySource.get(source.id) ?? null,
        harmonyEvents: harmonyEventsBySource.get(source.id) ?? [],
      })),
      stems: stems.map(({ storageKey: _storageKey, waveformKey: _waveformKey, ...stem }) => ({
        ...stem,
        drumAnalysis: drumAnalysisByStem.get(stem.id) ?? null,
        drumEvents: drumEventsByStem.get(stem.id) ?? [],
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
