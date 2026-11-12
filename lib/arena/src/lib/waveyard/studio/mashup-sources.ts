/**
 * Server-side source resolution for the mashup routes — authoritative
 * analysis + sections → MashupSourceProfile. Shared by plan and render so
 * both see exactly the same evidence.
 */

import { and, asc, desc, eq } from "drizzle-orm";

import { db } from "@workspace/db";
import {
  harmonyAnalyses,
  harmonyEvents,
  processingJobs,
  sourceAnalyses,
  sourceAssets,
  sourceSectionAnalyses,
  sourceSections,
  stemAssets,
  vocalAnalyses,
  vocalPitchFrames,
  vocalPhrases,
} from "@workspace/db/waveyardSchema";
import {
  LOCAL_VOCAL_ANALYSIS_ENGINE,
  LOCAL_VOCAL_ANALYSIS_ENGINE_VERSION,
  normaliseVocalPitchFrames,
  vocalAnalysisProvenanceReason,
  type VocalPitchFrame,
  type VocalPhrase,
} from "../types/vocal-analysis";
import {
  LOCAL_HARMONY_ANALYSIS_ENGINE,
  LOCAL_HARMONY_ANALYSIS_ENGINE_VERSION,
  normaliseHarmonyEvents,
} from "../types/harmony-analysis";
import { parsePassageFingerprint } from "../types/passage-compatibility";
import { usableBeatGrid } from "../types/beat-grid";
import {
  measuredEvidence,
  MUSICAL_EVIDENCE_PACKET_FORMAT,
  unavailableEvidence,
  type MusicalEvidencePacket,
  type MusicalEvidenceChord,
  type MusicalEvidenceProvenance,
} from "./musical-evidence";
import type { MashupSourceProfile } from "./mashup";

export async function loadSourceProfile(
  projectId: string,
  sourceAssetId: string,
  role: "vocals" | "instrumental",
  database: any = db,
): Promise<MashupSourceProfile | null> {
  const [asset] = await database
    .select({
      id: sourceAssets.id,
      durationSeconds: sourceAssets.durationSeconds,
      checksumSha256: sourceAssets.checksumSha256,
    })
    .from(sourceAssets)
    .where(and(eq(sourceAssets.id, sourceAssetId), eq(sourceAssets.projectId, projectId)))
    .limit(1);
  if (!asset) return null;

  const [analysis] = await database
    .select({
      id: sourceAnalyses.id,
      bpm: sourceAnalyses.bpm,
      bpmConfidence: sourceAnalyses.bpmConfidence,
      musicalKey: sourceAnalyses.musicalKey,
      keyConfidence: sourceAnalyses.keyConfidence,
      beatGrid: sourceAnalyses.beatGrid,
      beatConfidence: sourceAnalyses.beatConfidence,
      sourceChecksumSha256: sourceAnalyses.sourceChecksumSha256,
      status: sourceAnalyses.status,
      analysisEngine: sourceAnalyses.analysisEngine,
      analysisEngineVersion: sourceAnalyses.analysisEngineVersion,
    })
    .from(sourceAnalyses)
    .where(
      and(
        eq(sourceAnalyses.sourceAssetId, sourceAssetId),
        eq(sourceAnalyses.projectId, projectId),
        eq(sourceAnalyses.sourceChecksumSha256, asset.checksumSha256),
        eq(sourceAnalyses.status, "complete"),
      ),
    )
    .orderBy(desc(sourceAnalyses.completedAt), desc(sourceAnalyses.createdAt), desc(sourceAnalyses.id))
    .limit(1);

  const [sectionAnalysis] = analysis
    ? await database
      .select({
        id: sourceSectionAnalyses.id,
        sourceAnalysisId: sourceSectionAnalyses.sourceAnalysisId,
        sourceChecksumSha256: sourceSectionAnalyses.sourceChecksumSha256,
        analysisEngine: sourceSectionAnalyses.analysisEngine,
        analysisEngineVersion: sourceSectionAnalyses.analysisEngineVersion,
        completedAt: sourceSectionAnalyses.completedAt,
      })
      .from(sourceSectionAnalyses)
      .where(and(
        eq(sourceSectionAnalyses.projectId, projectId),
        eq(sourceSectionAnalyses.sourceAssetId, sourceAssetId),
        eq(sourceSectionAnalyses.sourceAnalysisId, analysis.id),
        eq(sourceSectionAnalyses.sourceChecksumSha256, asset.checksumSha256),
        eq(sourceSectionAnalyses.status, "complete"),
      ))
      .orderBy(desc(sourceSectionAnalyses.completedAt), desc(sourceSectionAnalyses.createdAt), desc(sourceSectionAnalyses.id))
      .limit(1)
    : [];

  const sectionRows = sectionAnalysis
    ? await database
      .select({
        id: sourceSections.id,
        label: sourceSections.label,
        startMs: sourceSections.startMs,
        endMs: sourceSections.endMs,
        startBeatIndex: sourceSections.startBeatIndex,
        endBeatIndex: sourceSections.endBeatIndex,
        passageFingerprint: sourceSections.passageFingerprint,
        labelConfidence: sourceSections.labelConfidence,
        structuralConfidence: sourceSections.structuralConfidence,
        sourceAnalysisId: sourceSections.sourceAnalysisId,
        sourceSectionAnalysisId: sourceSections.sourceSectionAnalysisId,
        sourceChecksumSha256: sourceSections.sourceChecksumSha256,
        analysisEngine: sourceSections.analysisEngine,
        analysisEngineVersion: sourceSections.analysisEngineVersion,
      })
      .from(sourceSections)
      .where(and(
        eq(sourceSections.projectId, projectId),
        eq(sourceSections.sourceAssetId, sourceAssetId),
        eq(sourceSections.sourceAnalysisId, analysis.id),
        eq(sourceSections.sourceSectionAnalysisId, sectionAnalysis.id),
      ))
      .orderBy(asc(sourceSections.startMs))
    : [];
  const sections = sectionRows.filter((section: typeof sectionRows[number]) =>
    section.analysisEngine === sectionAnalysis?.analysisEngine
    && section.analysisEngineVersion === sectionAnalysis?.analysisEngineVersion
    && section.sourceChecksumSha256 === asset.checksumSha256
    && Number.isSafeInteger(section.startMs)
    && Number.isSafeInteger(section.endMs)
    && section.startMs >= 0
    && section.endMs > section.startMs
    && section.endMs <= Math.round(asset.durationSeconds * 1000)
    && typeof section.label === "string"
    && Number.isFinite(section.labelConfidence)
    && section.labelConfidence >= 0
    && section.labelConfidence <= 1
    && Number.isFinite(section.structuralConfidence)
    && section.structuralConfidence >= 0
    && section.structuralConfidence <= 1,
  ).map((section: typeof sectionRows[number]) => ({
    id: section.id,
    label: section.label,
    startMs: section.startMs,
    endMs: section.endMs,
    startBeatIndex: section.startBeatIndex,
    endBeatIndex: section.endBeatIndex,
    passageFingerprint: parsePassageFingerprint(section.passageFingerprint, {
      sourceChecksumSha256: asset.checksumSha256,
      startBeatIndex: section.startBeatIndex,
      endBeatIndex: section.endBeatIndex,
    }),
  }));

  const vocalEvidence = role === "vocals"
    ? await loadCurrentVocalEvidence(database, projectId, sourceAssetId, asset.checksumSha256, Math.round(asset.durationSeconds * 1000))
    : null;

  let parsedGrid: number[] | null = null;
  if (analysis?.beatGrid) {
    try {
      parsedGrid = usableBeatGrid(JSON.parse(analysis.beatGrid));
    } catch {
      parsedGrid = null;
    }
  }

  const sourceProvenance: MusicalEvidenceProvenance | null = analysis ? {
    analysisId: analysis.id,
    analysisEngine: analysis.analysisEngine,
    analysisEngineVersion: analysis.analysisEngineVersion,
    sourceChecksumSha256: analysis.sourceChecksumSha256,
    persistence: "database",
  } : null;
  const currentSections = sectionAnalysis && sectionRows.length === sections.length
      ? measuredEvidence(sections, {
        analysisId: sectionAnalysis.id,
        analysisEngine: sectionAnalysis.analysisEngine,
        analysisEngineVersion: sectionAnalysis.analysisEngineVersion,
        sourceChecksumSha256: sectionAnalysis.sourceChecksumSha256,
        persistence: "database",
      })
      : unavailableEvidence<typeof sections>("No complete section analysis matches the current source analysis and checksum.");

  const [harmonyAnalysis] = await database
    .select({
      id: harmonyAnalyses.id,
      analysisEngine: harmonyAnalyses.analysisEngine,
      analysisEngineVersion: harmonyAnalyses.analysisEngineVersion,
      sourceChecksumSha256: harmonyAnalyses.sourceChecksumSha256,
    })
    .from(harmonyAnalyses)
    .where(and(
      eq(harmonyAnalyses.projectId, projectId),
      eq(harmonyAnalyses.sourceAssetId, sourceAssetId),
      eq(harmonyAnalyses.sourceChecksumSha256, asset.checksumSha256),
      eq(harmonyAnalyses.status, "complete"),
      eq(harmonyAnalyses.analysisEngine, LOCAL_HARMONY_ANALYSIS_ENGINE),
      eq(harmonyAnalyses.analysisEngineVersion, LOCAL_HARMONY_ANALYSIS_ENGINE_VERSION),
    ))
    .orderBy(desc(harmonyAnalyses.completedAt), desc(harmonyAnalyses.createdAt), desc(harmonyAnalyses.id))
    .limit(1);
  const harmonyRows = harmonyAnalysis
    ? await database
      .select({
        startMs: harmonyEvents.startMs,
        endMs: harmonyEvents.endMs,
        root: harmonyEvents.root,
        quality: harmonyEvents.quality,
        confidence: harmonyEvents.confidence,
      })
      .from(harmonyEvents)
      .where(eq(harmonyEvents.harmonyAnalysisId, harmonyAnalysis.id))
      .orderBy(asc(harmonyEvents.startMs))
    : [];
  const persistedHarmony = normaliseHarmonyEvents(harmonyRows, Math.round(asset.durationSeconds * 1000));
  const harmony = harmonyAnalysis && persistedHarmony
    ? measuredEvidence(persistedHarmony, {
      analysisId: harmonyAnalysis.id,
      analysisEngine: harmonyAnalysis.analysisEngine,
      analysisEngineVersion: harmonyAnalysis.analysisEngineVersion,
      sourceChecksumSha256: harmonyAnalysis.sourceChecksumSha256,
      persistence: "database",
    })
    : unavailableEvidence<MusicalEvidenceChord[]>("No complete, valid harmony analysis matches the current source and engine version.");

  const evidence: MusicalEvidencePacket = {
    format: MUSICAL_EVIDENCE_PACKET_FORMAT,
    source: {
      assetId: asset.id,
      checksumSha256: asset.checksumSha256,
      durationMs: Math.round(asset.durationSeconds * 1000),
    },
    features: {
      tempo: analysis && analysis.bpm !== null && sourceProvenance
        ? measuredEvidence({ bpm: analysis.bpm, confidence: analysis.bpmConfidence }, sourceProvenance)
        : unavailableEvidence("No current measured tempo is available."),
      key: analysis && analysis.musicalKey !== null && sourceProvenance
        ? measuredEvidence({ key: analysis.musicalKey, confidence: analysis.keyConfidence }, sourceProvenance)
        : unavailableEvidence("No current measured key is available."),
      beatGrid: parsedGrid && sourceProvenance
        ? measuredEvidence({ beatsMs: parsedGrid, confidence: analysis?.beatConfidence ?? null }, sourceProvenance)
        : unavailableEvidence("No valid beat grid matches the current source checksum."),
      sections: currentSections,
      vocalPhrases: vocalEvidence
        ? measuredEvidence(vocalEvidence.phrases, vocalEvidence.provenance)
        : unavailableEvidence("No current isolated-vocal phrase analysis is available for this source."),
      vocalPitchFrames: vocalEvidence && vocalEvidence.pitchFrames !== null
        ? measuredEvidence(vocalEvidence.pitchFrames, vocalEvidence.provenance)
        : unavailableEvidence("No current isolated-vocal pitch frames are available for this source."),
      harmony,
      drumEvents: unavailableEvidence("No current isolated drum event evidence was loaded."),
      bassAttacks: unavailableEvidence("No persisted isolated bass attack analysis exists yet."),
    },
  };

  return {
    role,
    sourceAssetId: asset.id,
    sourceChecksumSha256: asset.checksumSha256,
    bpm: evidence.features.tempo.status === "measured" ? evidence.features.tempo.value.bpm : null,
    bpmConfidence: evidence.features.tempo.status === "measured" ? evidence.features.tempo.value.confidence : null,
    musicalKey: evidence.features.key.status === "measured" ? evidence.features.key.value.key : null,
    keyConfidence: evidence.features.key.status === "measured" ? evidence.features.key.value.confidence : null,
    beatGridMs: evidence.features.beatGrid.status === "measured" ? evidence.features.beatGrid.value.beatsMs : null,
    beatConfidence: evidence.features.beatGrid.status === "measured" ? evidence.features.beatGrid.value.confidence : null,
    durationMs: evidence.source.durationMs,
    sections,
    vocalPhrases: vocalEvidence?.phrases ?? [],
    ...(evidence.features.vocalPitchFrames.status === "measured"
      ? { vocalPitchFrames: evidence.features.vocalPitchFrames.value }
      : {}),
    ...(evidence.features.harmony.status === "measured"
      ? { harmonyEvents: evidence.features.harmony.value }
      : {}),
    evidence,
  };
}

/**
 * Mashup planning may use only phrase intervals from the latest vocal stem
 * when both its separation run and checksum-bound local analysis completed.
 * Older or mismatched analysis is treated as unavailable, never reused.
 */
async function loadCurrentVocalEvidence(
  database: any,
  projectId: string,
  sourceAssetId: string,
  sourceChecksumSha256: string,
  durationMs: number,
): Promise<{
  phrases: VocalPhrase[];
  pitchFrames: VocalPitchFrame[] | null;
  provenance: MusicalEvidenceProvenance;
} | null> {
  const [stem] = await database
    .select({
      id: stemAssets.id,
      checksumSha256: stemAssets.checksumSha256,
      separationJobId: stemAssets.separationJobId,
    })
    .from(stemAssets)
    .where(and(
      eq(stemAssets.projectId, projectId),
      eq(stemAssets.sourceAssetId, sourceAssetId),
      eq(stemAssets.stemType, "vocals"),
    ))
    .orderBy(desc(stemAssets.createdAt), desc(stemAssets.id))
    .limit(1);
  if (!stem) return null;

  const [separation] = await database
    .select({ status: processingJobs.status })
    .from(processingJobs)
    .where(eq(processingJobs.id, stem.separationJobId))
    .limit(1);
  if (separation?.status !== "complete") return null;

  const [analysis] = await database
    .select({
      id: vocalAnalyses.id,
      sourceAssetId: vocalAnalyses.sourceAssetId,
      stemAssetId: vocalAnalyses.stemAssetId,
      sourceChecksumSha256: vocalAnalyses.sourceChecksumSha256,
      stemChecksumSha256: vocalAnalyses.stemChecksumSha256,
      analysisEngine: vocalAnalyses.analysisEngine,
      analysisEngineVersion: vocalAnalyses.analysisEngineVersion,
    })
    .from(vocalAnalyses)
    .where(and(
      eq(vocalAnalyses.projectId, projectId),
      eq(vocalAnalyses.sourceAssetId, sourceAssetId),
      eq(vocalAnalyses.stemAssetId, stem.id),
      eq(vocalAnalyses.status, "complete"),
      eq(vocalAnalyses.analysisEngine, LOCAL_VOCAL_ANALYSIS_ENGINE),
      eq(vocalAnalyses.analysisEngineVersion, LOCAL_VOCAL_ANALYSIS_ENGINE_VERSION),
      eq(vocalAnalyses.sourceChecksumSha256, sourceChecksumSha256),
      eq(vocalAnalyses.stemChecksumSha256, stem.checksumSha256),
    ))
    .orderBy(desc(vocalAnalyses.completedAt), desc(vocalAnalyses.id))
    .limit(1);
  if (!analysis || vocalAnalysisProvenanceReason({
    sourceAssetId: analysis.sourceAssetId,
    expectedSourceAssetId: sourceAssetId,
    stemAssetId: analysis.stemAssetId,
    expectedStemAssetId: stem.id,
    sourceChecksumSha256: analysis.sourceChecksumSha256,
    expectedSourceChecksumSha256: sourceChecksumSha256,
    stemChecksumSha256: analysis.stemChecksumSha256,
    expectedStemChecksumSha256: stem.checksumSha256,
    analysisEngine: analysis.analysisEngine,
    analysisEngineVersion: analysis.analysisEngineVersion,
  }, { engine: LOCAL_VOCAL_ANALYSIS_ENGINE, version: LOCAL_VOCAL_ANALYSIS_ENGINE_VERSION })) return null;

  const rows = await database
    .select({ startMs: vocalPhrases.startMs, endMs: vocalPhrases.endMs, confidence: vocalPhrases.confidence })
    .from(vocalPhrases)
    .where(eq(vocalPhrases.vocalAnalysisId, analysis.id))
    .orderBy(asc(vocalPhrases.startMs));

  const phrases = rows.filter((phrase: VocalPhrase) =>
    Number.isSafeInteger(phrase.startMs)
    && Number.isSafeInteger(phrase.endMs)
    && phrase.startMs >= 0
    && phrase.endMs > phrase.startMs
    && phrase.endMs <= durationMs
    && Number.isFinite(phrase.confidence)
    && phrase.confidence >= 0
    && phrase.confidence <= 1,
  );
  const pitchFrameRows = await database
    .select({
      timestampMs: vocalPitchFrames.timestampMs,
      frequencyHz: vocalPitchFrames.frequencyHz,
      midiFloat: vocalPitchFrames.midiFloat,
      nearestMidiNote: vocalPitchFrames.nearestMidiNote,
      confidence: vocalPitchFrames.confidence,
      voiced: vocalPitchFrames.voiced,
    })
    .from(vocalPitchFrames)
    .where(eq(vocalPitchFrames.vocalAnalysisId, analysis.id))
    .orderBy(asc(vocalPitchFrames.timestampMs));
  const pitchFrames = normaliseVocalPitchFrames(pitchFrameRows, durationMs);
  return {
    phrases,
    pitchFrames,
    provenance: {
      analysisId: analysis.id,
      analysisEngine: analysis.analysisEngine,
      analysisEngineVersion: analysis.analysisEngineVersion,
      sourceChecksumSha256,
      stemAssetId: stem.id,
      stemChecksumSha256: stem.checksumSha256,
      persistence: "database",
    },
  };
}
