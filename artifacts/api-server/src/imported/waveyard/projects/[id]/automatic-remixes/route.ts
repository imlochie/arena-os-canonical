import { isUuid } from "@workspace/arena/lib/api/ids";

import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  automaticRemixGenerations,
  bassAnalyses,
  bassPitchSegments,
  harmonyAnalyses,
  harmonyEvents,
  remixClips,
  remixSessions,
  remixTracks,
  remixVersions,
  sourceAnalyses,
  sourceAssets,
  sourceSectionAnalyses,
  sourceSections,
  stemAssets,
  stemHarmonyAnalyses,
  stemHarmonyEvents,
  vocalActivityIntervals,
  vocalAnalyses,
  vocalPhrases,
  vocalPitchFrames,
} from "@workspace/db/waveyardSchema";
import { buildAutomaticRemixPlan, parsePassageFingerprint, type AutomaticRemixConstraints, type PassageFingerprint } from "@workspace/arena/lib/waveyard/types";
import {
  LOCAL_VOCAL_ANALYSIS_ENGINE,
  LOCAL_VOCAL_ANALYSIS_ENGINE_VERSION,
  vocalAnalysisProvenanceReason,
} from "@workspace/arena/lib/waveyard/types/vocal-analysis";
import {
  currentBeatConfidence,
  currentBpmConfidence,
  currentKeyConfidence,
  isCurrentDesktopAnalysis,
  isCurrentDesktopSectionAnalysis,
} from "@workspace/arena/lib/waveyard/types/analysis-provenance";
import { requireUser } from "@workspace/arena/lib/waveyard/local-context";
import { requireProjectRole } from "@workspace/arena/lib/waveyard/local-context";
import {
  LOCAL_HARMONY_ANALYSIS_ENGINE,
  LOCAL_HARMONY_ANALYSIS_ENGINE_VERSION,
  normaliseHarmonyEvents,
} from "@workspace/arena/lib/waveyard/types/harmony-analysis";
import {
  LOCAL_STEM_HARMONY_ANALYSIS_ENGINE,
  LOCAL_STEM_HARMONY_ANALYSIS_ENGINE_VERSION,
  normaliseStemHarmonyEvents,
  stemHarmonyAnalysisProvenanceReason,
} from "@workspace/arena/lib/waveyard/types/stem-harmony-analysis";
import {
  LOCAL_BASS_ANALYSIS_ENGINE,
  LOCAL_BASS_ANALYSIS_ENGINE_VERSION,
  bassAnalysisProvenanceReason,
  normaliseBassPitchSegments,
} from "@workspace/arena/lib/waveyard/types/bass-analysis";
import { chooseStemForHarmony } from "@workspace/arena/lib/waveyard/stem-harmony-analysis";
import { placedVocalNotes } from "@workspace/arena/lib/waveyard/types/stem-harmonic-adapter";

function parseBeatGrid(value: string | null) {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function constraintsFrom(value: unknown): AutomaticRemixConstraints {
  if (!value || typeof value !== "object") return {};
  const input = value as Record<string, unknown>;
  return {
    variant: input.variant === "hybrid" ? "hybrid" : "original",
    ...(typeof input.anchorSourceId === "string" ? { anchorSourceId: input.anchorSourceId } : {}),
    ...(typeof input.vocalStemId === "string" ? { vocalStemId: input.vocalStemId } : {}),
    ...(typeof input.drumsStemId === "string" ? { drumsStemId: input.drumsStemId } : {}),
    instrumental: input.instrumental === true,
  };
}

function vocalCoverage(phrases: Array<{ startMs: number; endMs: number; confidence: number }>, startMs: number, endMs: number) {
  const ranges = phrases
    .map((phrase) => ({ start: Math.max(startMs, phrase.startMs), end: Math.min(endMs, phrase.endMs), confidence: phrase.confidence }))
    .filter((phrase) => phrase.end > phrase.start)
    .sort((left, right) => left.start - right.start);
  let covered = 0;
  let rangeStart = -1;
  let rangeEnd = -1;
  for (const range of ranges) {
    if (rangeStart < 0) { rangeStart = range.start; rangeEnd = range.end; continue; }
    if (range.start <= rangeEnd) rangeEnd = Math.max(rangeEnd, range.end);
    else { covered += rangeEnd - rangeStart; rangeStart = range.start; rangeEnd = range.end; }
  }
  if (rangeStart >= 0) covered += rangeEnd - rangeStart;
  const duration = endMs - startMs;
  return {
    voicedCoverage: duration > 0 ? Math.max(0, Math.min(1, covered / duration)) : 0,
    meanConfidence: ranges.length ? ranges.reduce((total, range) => total + range.confidence, 0) / ranges.length : 0,
  };
}

/**
 * Materializes a deterministic plan directly into the existing RemixSession,
 * RemixTrack and RemixClip tables. The generation row is explanation only,
 * never a competing arrangement or browser-side audio authority.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id: projectId } = await params;
    if (!isUuid(projectId)) return Response.json({ error: "Invalid id parameter" }, { status: 400 });
    await requireProjectRole(user.id, projectId, "editor");
    const constraints = constraintsFrom(await request.json().catch(() => ({})));
    
    const [sources, stems, analyses, sectionAnalyses, sections, vocalAnalysisRows, harmonyAnalysisRows, stemHarmonyAnalysisRows, bassAnalysisRows] = await Promise.all([
      db.select().from(sourceAssets).where(eq(sourceAssets.projectId, projectId)).orderBy(asc(sourceAssets.createdAt)),
      db.select().from(stemAssets).where(eq(stemAssets.projectId, projectId)).orderBy(asc(stemAssets.createdAt)),
      db.select().from(sourceAnalyses).where(eq(sourceAnalyses.projectId, projectId)).orderBy(asc(sourceAnalyses.createdAt)),
      db.select().from(sourceSectionAnalyses).where(eq(sourceSectionAnalyses.projectId, projectId)).orderBy(asc(sourceSectionAnalyses.createdAt)),
      db.select().from(sourceSections).where(eq(sourceSections.projectId, projectId)).orderBy(asc(sourceSections.sourceAssetId), asc(sourceSections.sectionIndex)),
      db.select().from(vocalAnalyses).where(eq(vocalAnalyses.projectId, projectId)).orderBy(asc(vocalAnalyses.createdAt)),
      db.select().from(harmonyAnalyses).where(eq(harmonyAnalyses.projectId, projectId)).orderBy(asc(harmonyAnalyses.createdAt)),
      db.select().from(stemHarmonyAnalyses).where(eq(stemHarmonyAnalyses.projectId, projectId)).orderBy(asc(stemHarmonyAnalyses.createdAt)),
      db.select().from(bassAnalyses).where(eq(bassAnalyses.projectId, projectId)).orderBy(asc(bassAnalyses.createdAt)),
    ]);
    const analysisBySource = new Map(analyses.map((analysis) => [analysis.sourceAssetId, analysis]));
    const sectionAnalysisBySource = new Map(sectionAnalyses.map((analysis) => [analysis.sourceAssetId, analysis]));
    const sectionsBySource = new Map<string, typeof sections>();
    for (const section of sections) {
      const existing = sectionsBySource.get(section.sourceAssetId) ?? [];
      existing.push(section);
      sectionsBySource.set(section.sourceAssetId, existing);
    }
    const sourceById = new Map(sources.map((source) => [source.id, source]));
    const stemById = new Map(stems.map((stem) => [stem.id, stem]));
    const currentHarmonyBySource = new Map<string, (typeof harmonyAnalysisRows)[number]>();
    for (const harmonyAnalysis of [...harmonyAnalysisRows].reverse()) {
      const source = sourceById.get(harmonyAnalysis.sourceAssetId);
      if (!source || harmonyAnalysis.status !== "complete"
        || harmonyAnalysis.analysisEngine !== LOCAL_HARMONY_ANALYSIS_ENGINE
        || harmonyAnalysis.analysisEngineVersion !== LOCAL_HARMONY_ANALYSIS_ENGINE_VERSION
        || harmonyAnalysis.sourceChecksumSha256 !== source.checksumSha256) continue;
      if (!currentHarmonyBySource.has(source.id)) currentHarmonyBySource.set(source.id, harmonyAnalysis);
    }
    const harmonyAnalysisIds = [...currentHarmonyBySource.values()].map((analysis) => analysis.id);
    const harmonyRows = harmonyAnalysisIds.length
      ? await db.select({
        harmonyAnalysisId: harmonyEvents.harmonyAnalysisId,
        startMs: harmonyEvents.startMs,
        endMs: harmonyEvents.endMs,
        root: harmonyEvents.root,
        quality: harmonyEvents.quality,
        confidence: harmonyEvents.confidence,
      }).from(harmonyEvents).where(inArray(harmonyEvents.harmonyAnalysisId, harmonyAnalysisIds)).orderBy(asc(harmonyEvents.startMs))
      : [];
    const harmonyEventsByAnalysis = new Map<string, typeof harmonyRows>();
    for (const event of harmonyRows) {
      const existing = harmonyEventsByAnalysis.get(event.harmonyAnalysisId) ?? [];
      existing.push(event);
      harmonyEventsByAnalysis.set(event.harmonyAnalysisId, existing);
    }
    // Stem-scoped bed harmony: the chord timeline of the non-vocal stem a hybrid
    // actually keeps. The source-mix analysis above includes instruments that a
    // hybrid discards, so it cannot answer whether the placed vocal fits.
    const currentStemHarmonyByStemId = new Map<string, (typeof stemHarmonyAnalysisRows)[number]>();
    for (const analysis of [...stemHarmonyAnalysisRows].reverse()) {
      if (analysis.status !== "complete"
        || analysis.analysisEngine !== LOCAL_STEM_HARMONY_ANALYSIS_ENGINE
        || analysis.analysisEngineVersion !== LOCAL_STEM_HARMONY_ANALYSIS_ENGINE_VERSION) continue;
      if (!currentStemHarmonyByStemId.has(analysis.stemAssetId)) currentStemHarmonyByStemId.set(analysis.stemAssetId, analysis);
    }
    const stemHarmonyIds = [...currentStemHarmonyByStemId.values()].map((analysis) => analysis.id);
    const stemHarmonyRows = stemHarmonyIds.length
      ? await db.select({
        stemHarmonyAnalysisId: stemHarmonyEvents.stemHarmonyAnalysisId,
        startMs: stemHarmonyEvents.startMs,
        endMs: stemHarmonyEvents.endMs,
        root: stemHarmonyEvents.root,
        quality: stemHarmonyEvents.quality,
        confidence: stemHarmonyEvents.confidence,
      }).from(stemHarmonyEvents)
        .where(inArray(stemHarmonyEvents.stemHarmonyAnalysisId, stemHarmonyIds))
        .orderBy(asc(stemHarmonyEvents.startMs))
      : [];
    const stemHarmonyEventsByAnalysis = new Map<string, typeof stemHarmonyRows>();
    for (const event of stemHarmonyRows) {
      const existing = stemHarmonyEventsByAnalysis.get(event.stemHarmonyAnalysisId) ?? [];
      existing.push(event);
      stemHarmonyEventsByAnalysis.set(event.stemHarmonyAnalysisId, existing);
    }
    // Independent bass PITCH evidence for each source's isolated bass stem.
    // Only a complete analysis from the current engine version qualifies: 1.0.0
    // rows recorded attacks with no pitch and are genuinely stale, so they are
    // skipped rather than read as "the bass played nothing".
    const currentBassPitchByStemId = new Map<string, { analysis: (typeof bassAnalysisRows)[number]; segments: Array<{
      startMs: number; endMs: number; midiNote: number; frequencyHz: number; confidence: number;
    }> }>();
    for (const analysis of [...bassAnalysisRows].reverse()) {
      if (analysis.status !== "complete"
        || analysis.analysisEngine !== LOCAL_BASS_ANALYSIS_ENGINE
        || analysis.analysisEngineVersion !== LOCAL_BASS_ANALYSIS_ENGINE_VERSION) continue;
      if (!currentBassPitchByStemId.has(analysis.stemAssetId))
        currentBassPitchByStemId.set(analysis.stemAssetId, { analysis, segments: [] });
    }
    const bassAnalysisIds = [...currentBassPitchByStemId.values()].map(({ analysis }) => analysis.id);
    if (bassAnalysisIds.length) {
      const segmentRows = await db.select({
        bassAnalysisId: bassPitchSegments.bassAnalysisId,
        startMs: bassPitchSegments.startMs,
        endMs: bassPitchSegments.endMs,
        midiNote: bassPitchSegments.midiNote,
        frequencyHz: bassPitchSegments.frequencyHz,
        confidence: bassPitchSegments.confidence,
      }).from(bassPitchSegments).where(inArray(bassPitchSegments.bassAnalysisId, bassAnalysisIds))
        .orderBy(asc(bassPitchSegments.startMs));
      const segmentsByAnalysis = new Map<string, typeof segmentRows>();
      for (const segment of segmentRows) {
        const existing = segmentsByAnalysis.get(segment.bassAnalysisId) ?? [];
        existing.push(segment);
        segmentsByAnalysis.set(segment.bassAnalysisId, existing);
      }
      for (const [stemId, current] of currentBassPitchByStemId)
        currentBassPitchByStemId.set(stemId, {
          analysis: current.analysis,
          segments: segmentsByAnalysis.get(current.analysis.id) ?? [],
        });
    }
    const stemsBySource = new Map<string, typeof stems>();
    for (const stem of stems) {
      const existing = stemsBySource.get(stem.sourceAssetId) ?? [];
      existing.push(stem);
      stemsBySource.set(stem.sourceAssetId, existing);
    }

    const currentVocalBySource = new Map<string, {
      analysis: (typeof vocalAnalysisRows)[number];
      stem: (typeof stems)[number];
      phrases: Array<{ startMs: number; endMs: number; confidence: number }>;
      activityIntervals: Array<{ startMs: number; endMs: number; confidence: number }>;
      pitchFrames?: Array<{
        timestampMs: number; frequencyHz: number | null; midiFloat: number | null;
        nearestMidiNote: number | null; confidence: number; voiced: boolean;
      }>;
    }>();
    for (const vocalAnalysis of [...vocalAnalysisRows].reverse()) {
      if (vocalAnalysis.status !== "complete"
        || vocalAnalysis.analysisEngine !== LOCAL_VOCAL_ANALYSIS_ENGINE
        || vocalAnalysis.analysisEngineVersion !== LOCAL_VOCAL_ANALYSIS_ENGINE_VERSION) continue;
      const source = sourceById.get(vocalAnalysis.sourceAssetId);
      const stem = stemById.get(vocalAnalysis.stemAssetId);
      if (!source || !stem || stem.stemType !== "vocals") continue;
      if (vocalAnalysisProvenanceReason({
        sourceAssetId: vocalAnalysis.sourceAssetId,
        expectedSourceAssetId: source.id,
        stemAssetId: vocalAnalysis.stemAssetId,
        expectedStemAssetId: stem.id,
        sourceChecksumSha256: vocalAnalysis.sourceChecksumSha256,
        expectedSourceChecksumSha256: source.checksumSha256,
        stemChecksumSha256: vocalAnalysis.stemChecksumSha256,
        expectedStemChecksumSha256: stem.checksumSha256,
        analysisEngine: vocalAnalysis.analysisEngine,
        analysisEngineVersion: vocalAnalysis.analysisEngineVersion,
      }, { engine: LOCAL_VOCAL_ANALYSIS_ENGINE, version: LOCAL_VOCAL_ANALYSIS_ENGINE_VERSION })) continue;
      if (!currentVocalBySource.has(source.id))
        currentVocalBySource.set(source.id, { analysis: vocalAnalysis, stem, phrases: [], activityIntervals: [] });
    }
    const vocalAnalysisIds = [...new Set([...currentVocalBySource.values()].map(({ analysis }) => analysis.id))];
    if (vocalAnalysisIds.length) {
      const [persistedPhrases, persistedActivity] = await Promise.all([
        db.select({
          vocalAnalysisId: vocalPhrases.vocalAnalysisId,
          startMs: vocalPhrases.startMs,
          endMs: vocalPhrases.endMs,
          confidence: vocalPhrases.confidence,
        }).from(vocalPhrases).where(inArray(vocalPhrases.vocalAnalysisId, vocalAnalysisIds)),
        db.select({
          vocalAnalysisId: vocalActivityIntervals.vocalAnalysisId,
          startMs: vocalActivityIntervals.startMs,
          endMs: vocalActivityIntervals.endMs,
          confidence: vocalActivityIntervals.confidence,
        }).from(vocalActivityIntervals).where(inArray(vocalActivityIntervals.vocalAnalysisId, vocalAnalysisIds)),
      ]);
      const phrasesByAnalysis = new Map<string, typeof persistedPhrases>();
      for (const phrase of persistedPhrases) {
        const existing = phrasesByAnalysis.get(phrase.vocalAnalysisId) ?? [];
        existing.push(phrase);
        phrasesByAnalysis.set(phrase.vocalAnalysisId, existing);
      }
      const activityByAnalysis = new Map<string, typeof persistedActivity>();
      for (const interval of persistedActivity) {
        const existing = activityByAnalysis.get(interval.vocalAnalysisId) ?? [];
        existing.push(interval);
        activityByAnalysis.set(interval.vocalAnalysisId, existing);
      }
      for (const [sourceId, current] of currentVocalBySource)
        currentVocalBySource.set(sourceId, {
          ...current,
          phrases: phrasesByAnalysis.get(current.analysis.id) ?? [],
          activityIntervals: activityByAnalysis.get(current.analysis.id) ?? [],
        });
      // Isolated pitch frames are the melody a vocal hybrid carries. Without
      // them the retained-stem check has nothing to judge and must say so.
      const pitchFrameRows = await db.select({
        vocalAnalysisId: vocalPitchFrames.vocalAnalysisId,
        timestampMs: vocalPitchFrames.timestampMs,
        frequencyHz: vocalPitchFrames.frequencyHz,
        midiFloat: vocalPitchFrames.midiFloat,
        nearestMidiNote: vocalPitchFrames.nearestMidiNote,
        confidence: vocalPitchFrames.confidence,
        voiced: vocalPitchFrames.voiced,
      }).from(vocalPitchFrames).where(inArray(vocalPitchFrames.vocalAnalysisId, vocalAnalysisIds))
        .orderBy(asc(vocalPitchFrames.timestampMs));
      const framesByAnalysis = new Map<string, typeof pitchFrameRows>();
      for (const frame of pitchFrameRows) {
        const existing = framesByAnalysis.get(frame.vocalAnalysisId) ?? [];
        existing.push(frame);
        framesByAnalysis.set(frame.vocalAnalysisId, existing);
      }
      for (const [sourceId, current] of currentVocalBySource)
        currentVocalBySource.set(sourceId, { ...current, pitchFrames: framesByAnalysis.get(current.analysis.id) ?? [] });
    }
    const probeTimer = () => {};
    void probeTimer;
    const fingerprintUpdates: Array<{
      id: string;
      sourceAnalysisId: string;
      sourceSectionAnalysisId: string;
      sourceChecksumSha256: string;
      fingerprint: PassageFingerprint;
    }> = [];
    const fingerprintForSection = (sourceId: string, section: (typeof sections)[number], sourceChecksumSha256: string) => {
      const fingerprint = parsePassageFingerprint(section.passageFingerprint, {
        sourceChecksumSha256,
        startBeatIndex: section.startBeatIndex,
        endBeatIndex: section.endBeatIndex,
      });
      if (!fingerprint) return null;
      const vocal = currentVocalBySource.get(sourceId);
      if (!vocal) return fingerprint;
      const activityCoverage = vocalCoverage(vocal.activityIntervals, section.startMs, section.endMs);
      const pitchCoverage = vocalCoverage(vocal.phrases, section.startMs, section.endMs);
      const activityIntervals = vocal.activityIntervals
        .filter((interval) => interval.endMs > section.startMs && interval.startMs < section.endMs)
        .slice(0, 256)
        .map((interval) => ({
          startMs: Math.max(section.startMs, interval.startMs),
          endMs: Math.min(section.endMs, interval.endMs),
          confidence: interval.confidence,
        }));
      const pitchContinuityRuns = vocal.phrases
        .filter((phrase) => phrase.endMs > section.startMs && phrase.startMs < section.endMs)
        .slice(0, 256)
        .map((phrase) => ({
          startMs: Math.max(section.startMs, phrase.startMs),
          endMs: Math.min(section.endMs, phrase.endMs),
          confidence: phrase.confidence,
        }));
      const enriched: PassageFingerprint = {
        ...fingerprint,
        vocalActivity: {
          status: "measured",
          value: {
            activityCoverage: activityCoverage.voicedCoverage,
            meanActivityStrength: activityCoverage.meanConfidence,
            pitchCoverage: pitchCoverage.voicedCoverage,
            meanPitchConfidence: pitchCoverage.meanConfidence,
            analysisId: vocal.analysis.id,
            stemAssetId: vocal.stem.id,
            stemChecksumSha256: vocal.stem.checksumSha256,
            activityIntervals,
            pitchContinuityRuns,
          },
          method: "checksum-current separated-vocal activity confidence and pitch-continuity runs; neither is lyric transcription",
          confidence: Math.min(activityCoverage.meanConfidence, pitchCoverage.meanConfidence || activityCoverage.meanConfidence),
        },
      };
      fingerprintUpdates.push({
        id: section.id,
        sourceAnalysisId: section.sourceAnalysisId,
        sourceSectionAnalysisId: section.sourceSectionAnalysisId,
        sourceChecksumSha256: section.sourceChecksumSha256,
        fingerprint: enriched,
      });
      return enriched;
    };
    const plan = buildAutomaticRemixPlan(sources.map((source) => {
      const analysis = analysisBySource.get(source.id);
      const sectionAnalysis = sectionAnalysisBySource.get(source.id);
      const verifiedAnalysis = analysis?.status === "complete"
        && isCurrentDesktopAnalysis(analysis)
        && analysis.sourceChecksumSha256 === source.checksumSha256
        ? analysis
        : null;
      const verifiedSections = verifiedAnalysis && sectionAnalysis?.status === "complete"
        && isCurrentDesktopSectionAnalysis(sectionAnalysis)
        && sectionAnalysis.sourceAnalysisId === verifiedAnalysis.id
        && sectionAnalysis.sourceChecksumSha256 === source.checksumSha256
        ? (sectionsBySource.get(source.id) ?? []).filter((section) => section.sourceAnalysisId === verifiedAnalysis.id
          && section.sourceSectionAnalysisId === sectionAnalysis.id && section.sourceChecksumSha256 === source.checksumSha256)
        : [];
      return {
        id: source.id,
        originalFilename: source.originalFilename,
        checksumSha256: source.checksumSha256,
        durationMs: source.durationSeconds * 1000,
        analysis: verifiedAnalysis ? {
          id: verifiedAnalysis.id,
          status: verifiedAnalysis.status,
          sourceChecksumSha256: verifiedAnalysis.sourceChecksumSha256,
          bpm: verifiedAnalysis.bpm,
          bpmConfidence: currentBpmConfidence(verifiedAnalysis),
          musicalKey: verifiedAnalysis.musicalKey,
          keyConfidence: currentKeyConfidence(verifiedAnalysis),
          beatConfidence: currentBeatConfidence(verifiedAnalysis),
          beatGridMs: parseBeatGrid(verifiedAnalysis.beatGrid),
        } : null,
        sections: verifiedSections.map((section) => {
          return {
            id: section.id,
            sectionIndex: section.sectionIndex,
            startMs: section.startMs,
            endMs: section.endMs,
            startBeatIndex: section.startBeatIndex,
            endBeatIndex: section.endBeatIndex,
            label: section.label,
            labelConfidence: section.labelConfidence,
            structuralConfidence: section.structuralConfidence,
            passageFingerprint: fingerprintForSection(source.id, section, source.checksumSha256),
          };
        }),
        stems: stems.filter((stem) => stem.sourceAssetId === source.id).map((stem) => ({ id: stem.id, sourceAssetId: stem.sourceAssetId, stemType: stem.stemType, durationMs: stem.durationSeconds * 1000 })),
        ...(() => {
          const harmonyAnalysis = currentHarmonyBySource.get(source.id);
          if (!harmonyAnalysis) return {};
          const events = normaliseHarmonyEvents(harmonyEventsByAnalysis.get(harmonyAnalysis.id) ?? [], source.durationSeconds * 1000);
          return events ? { harmony: {
            analysisId: harmonyAnalysis.id,
            analysisEngine: harmonyAnalysis.analysisEngine,
            analysisEngineVersion: harmonyAnalysis.analysisEngineVersion,
            sourceChecksumSha256: harmonyAnalysis.sourceChecksumSha256,
            events,
          } } : {};
        })(),
        ...(() => {
          // The bed a hybrid keeps is this source's non-vocal stem, so the
          // retained-stem check must read that stem's own chord timeline.
          const sourceStems = stemsBySource.get(source.id) ?? [];
          const bedStem = chooseStemForHarmony(sourceStems);
          if (!bedStem) return {};
          const stemHarmony = currentStemHarmonyByStemId.get(bedStem.id);
          if (!stemHarmony) return {};
          if (stemHarmonyAnalysisProvenanceReason({
            sourceAssetId: stemHarmony.sourceAssetId,
            expectedSourceAssetId: source.id,
            stemAssetId: stemHarmony.stemAssetId,
            expectedStemAssetId: bedStem.id,
            stemType: bedStem.stemType,
            sourceChecksumSha256: stemHarmony.sourceChecksumSha256,
            expectedSourceChecksumSha256: source.checksumSha256,
            stemChecksumSha256: stemHarmony.stemChecksumSha256,
            expectedStemChecksumSha256: bedStem.checksumSha256,
            analysisEngine: stemHarmony.analysisEngine,
            analysisEngineVersion: stemHarmony.analysisEngineVersion,
          })) return {};
          const stemEvents = normaliseStemHarmonyEvents(
            stemHarmonyEventsByAnalysis.get(stemHarmony.id) ?? [],
            source.durationSeconds * 1000,
          );
          if (!stemEvents) return {};
          return { bedHarmony: {
            analysisEngine: stemHarmony.analysisEngine,
            analysisEngineVersion: stemHarmony.analysisEngineVersion,
            stemAssetId: bedStem.id,
            stemType: bedStem.stemType,
            stemChecksumSha256: stemHarmony.stemChecksumSha256,
            sourceChecksumSha256: stemHarmony.sourceChecksumSha256,
            events: stemEvents,
          } };
        })(),
        ...(() => {
          // The retained bed's own harmonic foundation. This is the evidence that
          // lets the planner decide whether a bed's chord labels agree with the
          // bass underneath them; without it the bass is reported unavailable and
          // never treated as support.
          const bassStem = (stemsBySource.get(source.id) ?? []).find((stem) => stem.stemType === "bass");
          if (!bassStem) return {};
          const evidence = currentBassPitchByStemId.get(bassStem.id);
          if (!evidence) return {};
          if (bassAnalysisProvenanceReason({
            sourceAssetId: evidence.analysis.sourceAssetId,
            expectedSourceAssetId: source.id,
            stemAssetId: evidence.analysis.stemAssetId,
            expectedStemAssetId: bassStem.id,
            sourceChecksumSha256: evidence.analysis.sourceChecksumSha256,
            expectedSourceChecksumSha256: source.checksumSha256,
            stemChecksumSha256: evidence.analysis.stemChecksumSha256,
            expectedStemChecksumSha256: bassStem.checksumSha256,
            analysisEngine: evidence.analysis.analysisEngine,
            analysisEngineVersion: evidence.analysis.analysisEngineVersion,
          })) return {};
          const segments = normaliseBassPitchSegments(
            evidence.segments,
            source.durationSeconds * 1000,
          );
          if (!segments?.length) return {};
          return { bassLine: segments };
        })(),
        ...(() => {
          // The melody a vocal hybrid carries, mapped into this source's own
          // timeline. Placement into the anchor happens inside the planner,
          // which knows the matched section pair and the authorized shift.
          const vocal = currentVocalBySource.get(source.id);
          if (!vocal?.pitchFrames?.length) return {};
          const frames = vocal.pitchFrames
            .filter((frame): frame is typeof frame & { nearestMidiNote: number } => frame.nearestMidiNote !== null)
            .map((frame) => ({
              timestampMs: frame.timestampMs,
              frequencyHz: frame.frequencyHz,
              midiFloat: frame.midiFloat,
              nearestMidiNote: frame.nearestMidiNote,
              confidence: frame.confidence,
              voiced: frame.voiced,
            }));
          const notes = placedVocalNotes({
            vocalFrames: frames,
            sourceStartMs: 0,
            sourceEndMs: source.durationSeconds * 1000,
            targetStartMs: 0,
            stretchRatio: 1,
            pitchShiftSemitones: 0,
          });
          return notes ? { vocalNotes: notes } : {};
        })(),
      };
    }), constraints);
    if (fingerprintUpdates.length) {
      await db.transaction(async (tx) => {
        for (const update of fingerprintUpdates) {
          const [persisted] = await tx.update(sourceSections).set({ passageFingerprint: update.fingerprint }).where(and(
            eq(sourceSections.id, update.id),
            eq(sourceSections.sourceAnalysisId, update.sourceAnalysisId),
            eq(sourceSections.sourceSectionAnalysisId, update.sourceSectionAnalysisId),
            eq(sourceSections.sourceChecksumSha256, update.sourceChecksumSha256),
          )).returning({ id: sourceSections.id });
          if (!persisted) throw new Error("Source sections changed while current vocal evidence was being attached.");
        }
      });
    }
    if (!plan.ok) {
      const error = plan.reason === "no_stems"
        ? "No usable stems remain for this automatic arrangement."
        : plan.reason === "hybrid_evidence_unavailable"
          ? "A hybrid needs current, confident tempo and beat analysis with usable structural sections. Choose Original for a faithful single-source arrangement."
          : plan.reason === "no_compatible_hybrid_source"
            ? "No donor passage passed Waveyard’s current tempo, rhythm, chroma, and beat-phase checks, so no hybrid was created. Analyze sources with current section fingerprints or choose Original."
        : plan.reason === "unsafe_hybrid_alignment"
          ? "Waveyard could not verify safe section-to-section alignment for this hybrid. Try different sources or choose the original arrangement."
          : "A completed source with real stems is required before Waveyard can build an arrangement.";
      return Response.json({ error, ...(plan.compatibility ? { compatibility: plan.compatibility } : {}) }, { status: 409 });
    }

    const result = await db.transaction(async (tx) => {
      const [remix] = await tx.insert(remixSessions).values({
        projectId,
        ownerId: user.id,
        name: plan.plan.name,
        masterVolume: 1,
        loopStartMs: 0,
        loopEndMs: null,
        tempoBpm: plan.plan.tempoBpm,
        timeSignatureNumerator: 4,
        timeSignatureDenominator: 4,
        gridDivision: "beat",
        snapEnabled: true,
        targetKey: plan.plan.targetKey,
      }).returning();
      const tracks = await tx.insert(remixTracks).values(plan.plan.tracks.map((track) => ({
        remixSessionId: remix.id,
        stemAssetId: track.stemAssetId,
        name: track.name,
        sortOrder: track.sortOrder,
        volume: track.volume,
        pan: track.pan,
      }))).returning();
      const trackByStemId = new Map(tracks.map((track) => [track.stemAssetId, track]));
      const clips = plan.plan.tracks.flatMap((track) => track.clips.map((clip) => ({
        remixTrackId: trackByStemId.get(track.stemAssetId)!.id,
        stemAssetId: clip.stemAssetId,
        timelineStartMs: clip.timelineStartMs,
        durationMs: clip.durationMs,
        sourceOffsetMs: clip.sourceOffsetMs,
        gain: clip.gain,
        fadeInMs: clip.fadeInMs,
        fadeOutMs: clip.fadeOutMs,
        tempoSyncEnabled: clip.tempoSyncEnabled,
        keySyncEnabled: clip.keySyncEnabled,
        beatSnapEnabled: clip.beatSnapEnabled,
      })));
      const insertedClips = clips.length ? await tx.insert(remixClips).values(clips).returning() : [];
      await tx.insert(automaticRemixGenerations).values({
        remixSessionId: remix.id,
        engine: plan.plan.provenance.engine,
        engineVersion: plan.plan.provenance.engineVersion,
        variant: plan.plan.provenance.variant,
        constraints: JSON.stringify(plan.plan.provenance.constraints),
        provenance: JSON.stringify(plan.plan.provenance),
      });
      const snapshot = {
        name: remix.name,
        masterVolume: remix.masterVolume,
        loopStartMs: remix.loopStartMs,
        loopEndMs: remix.loopEndMs,
        tempoBpm: remix.tempoBpm,
        timeSignatureNumerator: remix.timeSignatureNumerator,
        timeSignatureDenominator: remix.timeSignatureDenominator,
        gridDivision: remix.gridDivision,
        snapEnabled: remix.snapEnabled,
        targetKey: remix.targetKey,
        tracks: tracks.map((track) => ({ ...track, clips: insertedClips.filter((clip) => clip.remixTrackId === track.id) })),
        automation: [],
      };
      const [version] = await tx.insert(remixVersions).values({
        remixSessionId: remix.id,
        createdById: user.id,
        name: "Automatic starting point",
        snapshot: JSON.stringify(snapshot),
      }).returning({ id: remixVersions.id, name: remixVersions.name, createdAt: remixVersions.createdAt });
      return { remix, version };
    });
    return Response.json({ remix: result.remix, version: result.version, plan: { notices: plan.plan.notices, provenance: plan.plan.provenance, compatibility: plan.plan.compatibility ?? null } }, { status: 201 });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("automatic remix creation failed", error);
    return Response.json({ error: "Could not build an automatic arrangement." }, { status: 500 });
  }
}
