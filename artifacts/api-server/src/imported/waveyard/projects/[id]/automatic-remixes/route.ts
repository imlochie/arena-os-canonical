import { isUuid } from "@workspace/arena/lib/api/ids";

import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  automaticRemixGenerations,
  remixClips,
  remixSessions,
  remixTracks,
  remixVersions,
  sourceAnalyses,
  sourceAssets,
  sourceSectionAnalyses,
  sourceSections,
  stemAssets,
  vocalAnalyses,
  vocalPhrases,
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
    
    const [sources, stems, analyses, sectionAnalyses, sections, vocalAnalysisRows] = await Promise.all([
      db.select().from(sourceAssets).where(eq(sourceAssets.projectId, projectId)).orderBy(asc(sourceAssets.createdAt)),
      db.select().from(stemAssets).where(eq(stemAssets.projectId, projectId)).orderBy(asc(stemAssets.createdAt)),
      db.select().from(sourceAnalyses).where(eq(sourceAnalyses.projectId, projectId)).orderBy(asc(sourceAnalyses.createdAt)),
      db.select().from(sourceSectionAnalyses).where(eq(sourceSectionAnalyses.projectId, projectId)).orderBy(asc(sourceSectionAnalyses.createdAt)),
      db.select().from(sourceSections).where(eq(sourceSections.projectId, projectId)).orderBy(asc(sourceSections.sourceAssetId), asc(sourceSections.sectionIndex)),
      db.select().from(vocalAnalyses).where(eq(vocalAnalyses.projectId, projectId)).orderBy(asc(vocalAnalyses.createdAt)),
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
    const currentVocalBySource = new Map<string, { analysis: (typeof vocalAnalysisRows)[number]; stem: (typeof stems)[number]; phrases: Array<{ startMs: number; endMs: number; confidence: number }> }>();
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
        currentVocalBySource.set(source.id, { analysis: vocalAnalysis, stem, phrases: [] });
    }
    const vocalAnalysisIds = [...new Set([...currentVocalBySource.values()].map(({ analysis }) => analysis.id))];
    if (vocalAnalysisIds.length) {
      const persistedPhrases = await db.select({
        vocalAnalysisId: vocalPhrases.vocalAnalysisId,
        startMs: vocalPhrases.startMs,
        endMs: vocalPhrases.endMs,
        confidence: vocalPhrases.confidence,
      }).from(vocalPhrases).where(inArray(vocalPhrases.vocalAnalysisId, vocalAnalysisIds));
      const phrasesByAnalysis = new Map<string, typeof persistedPhrases>();
      for (const phrase of persistedPhrases) {
        const existing = phrasesByAnalysis.get(phrase.vocalAnalysisId) ?? [];
        existing.push(phrase);
        phrasesByAnalysis.set(phrase.vocalAnalysisId, existing);
      }
      for (const [sourceId, current] of currentVocalBySource)
        currentVocalBySource.set(sourceId, { ...current, phrases: phrasesByAnalysis.get(current.analysis.id) ?? [] });
    }
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
      const coverage = vocalCoverage(vocal.phrases, section.startMs, section.endMs);
      const pitchContinuityRuns = vocal.phrases
        .filter((phrase) => phrase.endMs > section.startMs && phrase.startMs < section.endMs)
        .slice(0, 256)
        .map(({ startMs, endMs, confidence }) => ({ startMs, endMs, confidence }));
      const enriched: PassageFingerprint = {
        ...fingerprint,
        vocalActivity: {
          status: "measured",
          value: {
            ...coverage,
            analysisId: vocal.analysis.id,
            stemAssetId: vocal.stem.id,
            stemChecksumSha256: vocal.stem.checksumSha256,
            pitchContinuityRuns,
          },
          method: "checksum-current isolated-vocal pitch-continuity runs; not lyric transcription",
          confidence: coverage.meanConfidence,
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
