import { isUuid } from "@workspace/arena/lib/api/ids";

import { asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  drumAnalyses,
  drumEvents,
  harmonyAnalyses,
  harmonyEvents,
  processingJobs,
  projectBuilds,
  remixClips,
  remixSessions,
  remixTracks,
  sourceAcquisitions,
  sourceAnalyses,
  sourceAssets,
  sourceEventAnalyses,
  sourceEvents,
  sourceSectionAnalyses,
  sourceSections,
  stemAssets,
  vocalAnalyses,
  vocalPhrases,
  vocalPitchFrames,
  waveformAssets,
  waveformJobs,
} from "@workspace/db/waveyardSchema";
import { requireUser } from "@workspace/arena/lib/waveyard/local-context";
import { requireProjectRole } from "@workspace/arena/lib/waveyard/local-context";

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
    if (!isUuid(id)) return Response.json({ error: "Invalid id parameter" }, { status: 400 });
    const { project, role } = await requireProjectRole(user.id, id, "viewer");
    
    const [sources, stems, jobs, waveformRows, waveformJobRows, analysisRows, sectionAnalysisRows, sectionRows, eventAnalysisRows, eventRows, harmonyAnalysisRows, harmonyEventRows, drumAnalysisRows, drumEventRows, vocalAnalysisRows, vocalFrameRows, vocalPhraseRows, acquisitionRows, buildRows] = await Promise.all([
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
      db.select().from(harmonyAnalyses).where(eq(harmonyAnalyses.projectId, id)).orderBy(asc(harmonyAnalyses.createdAt)),
      db.select().from(harmonyEvents).innerJoin(harmonyAnalyses, eq(harmonyEvents.harmonyAnalysisId, harmonyAnalyses.id)).where(eq(harmonyAnalyses.projectId, id)).orderBy(asc(harmonyAnalyses.sourceAssetId), asc(harmonyEvents.eventIndex)),
      db.select().from(drumAnalyses).where(eq(drumAnalyses.projectId, id)).orderBy(asc(drumAnalyses.createdAt)),
      db.select().from(drumEvents).innerJoin(drumAnalyses, eq(drumEvents.drumAnalysisId, drumAnalyses.id)).where(eq(drumAnalyses.projectId, id)).orderBy(asc(drumAnalyses.stemAssetId), asc(drumEvents.eventIndex)),
      db.select().from(vocalAnalyses).where(eq(vocalAnalyses.projectId, id)).orderBy(asc(vocalAnalyses.createdAt)),
      db.select().from(vocalPitchFrames).innerJoin(vocalAnalyses, eq(vocalPitchFrames.vocalAnalysisId, vocalAnalyses.id)).where(eq(vocalAnalyses.projectId, id)).orderBy(asc(vocalAnalyses.stemAssetId), asc(vocalPitchFrames.frameIndex)),
      db.select().from(vocalPhrases).innerJoin(vocalAnalyses, eq(vocalPhrases.vocalAnalysisId, vocalAnalyses.id)).where(eq(vocalAnalyses.projectId, id)).orderBy(asc(vocalAnalyses.stemAssetId), asc(vocalPhrases.phraseIndex)),
      db.select().from(sourceAcquisitions).innerJoin(sourceAssets, eq(sourceAcquisitions.sourceAssetId, sourceAssets.id)).where(eq(sourceAssets.projectId, id)),
      db.select().from(projectBuilds).where(eq(projectBuilds.projectId, id)).orderBy(desc(projectBuilds.updatedAt)).limit(1),
    ]);
    const projectRemixes = await db.select({ id: remixSessions.id })
      .from(remixSessions)
      .where(eq(remixSessions.projectId, id));
    const linkedStemIds = projectRemixes.length
      ? await (async () => {
        const remixSessionIds = projectRemixes.map((remix) => remix.id);
        const [laneStems, clipStems] = await Promise.all([
          db.select({ stemAssetId: remixTracks.stemAssetId })
            .from(remixTracks)
            .where(inArray(remixTracks.remixSessionId, remixSessionIds)),
          db.select({ stemAssetId: remixClips.stemAssetId })
            .from(remixClips)
            .innerJoin(remixTracks, eq(remixTracks.id, remixClips.remixTrackId))
            .where(inArray(remixTracks.remixSessionId, remixSessionIds)),
        ]);
        return [...new Set([
          ...laneStems.map((track) => track.stemAssetId),
          ...clipStems.map((clip) => clip.stemAssetId),
        ])];
      })()
      : [];
    const projectStemIds = new Set(stems.map((stem) => stem.id));
    const externalStemRows = linkedStemIds.length
      ? await db.select().from(stemAssets).where(inArray(stemAssets.id, linkedStemIds))
      : [];
    const linkedStems = externalStemRows.filter((stem) => !projectStemIds.has(stem.id));
    const linkedProjectIds = [...new Set(linkedStems.map((stem) => stem.projectId))];
    await Promise.all(linkedProjectIds.map((linkedProjectId) =>
      requireProjectRole(user.id, linkedProjectId, "viewer"),
    ));
    const linkedSourceIds = [...new Set(linkedStems.map((stem) => stem.sourceAssetId))];
    const linkedSources = linkedSourceIds.length
      ? await db.select().from(sourceAssets).where(inArray(sourceAssets.id, linkedSourceIds))
      : [];
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
    const projectSources = sources.map(({ storageKey: _storageKey, ...source }) => ({
      ...source,
      analysis: analysisBySource.get(source.id) ?? null,
      acquisition: acquisitionBySource.get(source.id) ?? null,
      sectionAnalysis: sectionAnalysisBySource.get(source.id) ?? null,
      sections: sectionsBySource.get(source.id) ?? [],
      eventAnalysis: eventAnalysisBySource.get(source.id) ?? null,
      events: eventsBySource.get(source.id) ?? [],
      harmonyAnalysis: harmonyAnalysisBySource.get(source.id) ?? null,
      harmonyEvents: harmonyEventsBySource.get(source.id) ?? [],
    }));
    const studioSources = [
      ...projectSources,
      ...linkedSources
        .filter((source) => !sources.some((projectSource) => projectSource.id === source.id))
        .map(({ storageKey: _storageKey, ...source }) => ({
          ...source,
          linkedFromLibrary: true,
          analysis: null,
          acquisition: null,
          sectionAnalysis: null,
          sections: [],
          eventAnalysis: null,
          events: [],
          harmonyAnalysis: null,
          harmonyEvents: [],
        })),
    ];
    return Response.json({
      project,
      role,
      build: buildRows[0] ?? null,
      sources: projectSources,
      studioSources,
      stems: [...stems, ...linkedStems].map(({ storageKey: _storageKey, waveformKey: _waveformKey, ...stem }) => ({
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
