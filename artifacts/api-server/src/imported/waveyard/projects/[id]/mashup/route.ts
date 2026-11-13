/**
 * Mashup plan + render — song × song (vision: "Waveyard's main goal will
 * always be making mashups").
 *
 * POST /api/waveyard/projects/[id]/mashup
 *   body: { action: "plan", vocalsSourceId, instrumentalSourceId }
 *         { action: "render", vocalsSourceId, instrumentalSourceId }
 *         { action: "extend", sourceAssetId, sectionLabel?, repeats? }
 *   → plan: the full explained decision (tempo master, stretch, key move,
 *     segment placement, rationale, warnings). render: the mashup as a real
 *     PCM WAV (vocals stretched/pitched over the instrumental bed, ducked,
 *     crossfaded). extend: the source with a section looped to lengthen it.
 *
 * Plan and render do not alter original sources. Missing source analysis may
 * be computed and persisted; the explicit save action persists an editable
 * remix into Studio. The user's existing arrangements remain untouched.
 */


import { and, desc, eq, inArray } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { db } from "@workspace/db";
import {
  bassAnalyses,
  bassEvents,
  drumAnalyses,
  drumEvents,
  processingJobs,
  remixClips,
  remixSessions,
  remixTracks,
  remixVersions,
  sourceAnalyses,
  sourceAssets,
  stemAssets,
} from "@workspace/db/waveyardSchema";
import { requireProjectRole, requireUser } from "@workspace/arena/lib/waveyard/local-context";
import { getStorage } from "@workspace/arena/lib/waveyard/storage";
import { ensureBassAnalysis } from "@workspace/arena/lib/waveyard/bass-analysis";
import { decodeWav16, encodeWav16 } from "@workspace/arena/lib/waveyard/mixer/synth";
import { decodeSourceToStereoPcm } from "@workspace/arena/lib/waveyard/measure/pcm";
import { loadSourceProfile } from "@workspace/arena/lib/waveyard/studio/mashup-sources";
import {
  INSTRUMENTAL_BED_STEM_TYPES,
  InstrumentalBedError,
  sumInstrumentalStems,
  type InstrumentalBedStem,
} from "@workspace/arena/lib/waveyard/studio/mashup-bed";
import { analyseStereoPcm, planMashup, planSongExtension, renderMashup, renderSongExtension, type MashupTransientEvent } from "@workspace/arena/lib/waveyard/studio/mashup";
import { detectBassAttacks, detectDrumTransients } from "@workspace/arena/lib/waveyard/worker-local/analysis-engine";
import {
  DESKTOP_ANALYSIS_ENGINE,
  DESKTOP_ANALYSIS_ENGINE_VERSION,
  DESKTOP_STEM_ANALYSIS_ENGINE,
  DESKTOP_STEM_ANALYSIS_ENGINE_VERSION,
} from "@workspace/arena/lib/waveyard/types/analysis-provenance";
import { DRUM_ANALYSIS_ENGINE, DRUM_ANALYSIS_ENGINE_VERSION } from "@workspace/arena/lib/waveyard/types/drum-analysis";
import {
  bassAnalysisProvenanceReason,
  LOCAL_BASS_ANALYSIS_ENGINE,
  LOCAL_BASS_ANALYSIS_ENGINE_VERSION,
} from "@workspace/arena/lib/waveyard/types/bass-analysis";
import {
  measuredEvidence,
  unavailableEvidence,
  type MusicalEvidenceProvenance,
  type MusicalEvidencePacket,
} from "@workspace/arena/lib/waveyard/studio/musical-evidence";
import { trustedAnalysisBpm, trustedAnalysisKey, trustedAnalysisBeatGrid } from "@workspace/arena/lib/waveyard/types";
import { isUuid } from "@workspace/arena/lib/api/ids";

export const dynamic = "force-dynamic";

const RENDER_SAMPLE_RATE = 44_100;
const MAX_STEM_BYTES = 128 * 1024 * 1024;
const MAX_RENDER_SECONDS = 900;
const GROOVE_EVIDENCE_CACHE_TTL_MS = 10 * 60_000;
const GROOVE_EVIDENCE_CACHE_MAX_ENTRIES = 8;
const GROOVE_EVIDENCE_VERSION = "waveyard-persisted-first-stem-transients-v3";
const STEM_TIMING_CACHE_MAX_ENTRIES = 8;
const separatedStemTimingCache = new Map<string, ReturnType<typeof analyseStereoPcm>>();

type MeasuredBedGrooveEvidence = {
  drumEvents: MashupTransientEvent[];
  bassEvents: MashupTransientEvent[];
  warnings: string[];
  drumProvenance: MusicalEvidenceProvenance | null;
  bassProvenance: MusicalEvidenceProvenance | null;
};
const measuredBedGrooveCache = new Map<string, { createdAt: number; evidence: MeasuredBedGrooveEvidence }>();

type MashupBody = {
  action?: unknown;
  vocalsSourceId?: unknown;
  instrumentalSourceId?: unknown;
  sourceAssetId?: unknown;
  sectionLabel?: unknown;
  repeats?: unknown;
};

type BedSourceInfo = {
  source: "separated" | "original-fallback";
  separationJobId?: string;
  includedStemTypes?: string[];
  warning: string;
};

type BedSource = {
  info: BedSourceInfo;
  stems: Array<typeof stemAssets.$inferSelect>;
};

type BedLoadResult =
  | { ok: true; pcm: Float32Array; info: BedSourceInfo }
  | { ok: false; info: BedSourceInfo };

/** Latest stem of a type for a source whose separation job completed, or null. */
async function latestStem(projectId: string, sourceAssetId: string, stemType: string) {
  const [stem] = await db
    .select({ id: stemAssets.id, storageKey: stemAssets.storageKey, separationJobId: stemAssets.separationJobId })
    .from(stemAssets)
    .where(
      and(
        eq(stemAssets.projectId, projectId),
        eq(stemAssets.sourceAssetId, sourceAssetId),
        eq(stemAssets.stemType, stemType),
      ),
    )
    .orderBy(desc(stemAssets.createdAt))
    .limit(1);
  if (!stem) return null;

  const [job] = await db
    .select({ status: processingJobs.status })
    .from(processingJobs)
    .where(eq(processingJobs.id, stem.separationJobId))
    .limit(1);
  // Missing separation job records or non-complete jobs fail closed
  if (!job || job.status !== "complete") return null;

  return stem;
}

/** Decode a stem WAV from storage at the render rate. */
async function stemPcm(storageKey: string): Promise<Float32Array | null> {
  const bytes = await getStorage().getBuffer(storageKey, MAX_STEM_BYTES);
  const decoded = decodeWav16(new Uint8Array(bytes));
  if (decoded === null) return null;
  // Stems are rendered at 44.1 kHz stereo. A foreign rate or channel layout
  // is NOT acceptable — refuse rather than degrade silently.
  if (decoded.sampleRate === RENDER_SAMPLE_RATE && decoded.channels === 2) {
    return decoded.samples;
  }
  return null;
}

/**
 * Find the authoritative bed source for a track.
 *
 * A future engine may provide a real "instrumental" stem; use it when its
 * separation run is complete. Otherwise use the LATEST completed separation
 * run and only its non-vocal stems. Never combine stems across runs.
 */
async function findBedSource(projectId: string, bedId: string): Promise<BedSource> {
  const [instrumental] = await db
    .select()
    .from(stemAssets)
    .where(
      and(
        eq(stemAssets.projectId, projectId),
        eq(stemAssets.sourceAssetId, bedId),
        eq(stemAssets.stemType, "instrumental"),
      ),
    )
    .orderBy(desc(stemAssets.createdAt))
    .limit(1);

  if (instrumental) {
    const [job] = await db
      .select({ status: processingJobs.status })
      .from(processingJobs)
      .where(eq(processingJobs.id, instrumental.separationJobId))
      .limit(1);
    if (job?.status === "complete") {
      return {
        info: {
          source: "separated",
          separationJobId: instrumental.separationJobId,
          includedStemTypes: ["instrumental"],
          warning:
            "The bed uses a separated instrumental stem. Separation is not perfect; residual leakage may remain.",
        },
        stems: [instrumental],
      };
    }
  }

  const [job] = await db
    .select()
    .from(processingJobs)
    .where(
      and(
        eq(processingJobs.projectId, projectId),
        eq(processingJobs.sourceAssetId, bedId),
        eq(processingJobs.type, "separation"),
        eq(processingJobs.status, "complete"),
      ),
    )
    .orderBy(desc(processingJobs.completedAt), desc(processingJobs.createdAt))
    .limit(1);

  if (!job) {
    return {
      info: {
        source: "original-fallback",
        warning:
          "No completed separation run is available for the bed. The original file is used and may contain the original vocal.",
      },
      stems: [],
    };
  }

  const stems = await db
    .select()
    .from(stemAssets)
    .where(
      and(
        eq(stemAssets.projectId, projectId),
        eq(stemAssets.sourceAssetId, bedId),
        eq(stemAssets.separationJobId, job.id),
      ),
    );
  const bedStemTypes = new Set<string>(INSTRUMENTAL_BED_STEM_TYPES);
  const usable = stems.filter((stem) => bedStemTypes.has(stem.stemType));
  if (usable.length === 0) {
    return {
      info: {
        source: "original-fallback",
        warning:
          "The completed separation run has no instrumental stems. The original file is used and may contain the original vocal.",
      },
      stems: [],
    };
  }

  return {
    info: {
      source: "separated",
      separationJobId: job.id,
      includedStemTypes: usable.map((stem) => stem.stemType),
      warning:
        "The bed is synthesized from separated stems. Separation is not perfect; residual vocal or instrument leakage may remain.",
    },
    stems: usable,
  };
}

/** Downmix and 2:1 decimate the validated 44.1 kHz stereo WAV for local DSP. */
function stemPcmToAnalysisMono(stereo: Float32Array): Float32Array {
  const sourceFrames = Math.floor(stereo.length / 2);
  const output = new Float32Array(Math.floor(sourceFrames / 2));
  for (let frame = 0; frame < output.length; frame += 1) {
    const first = frame * 4;
    output[frame] = (
      stereo[first]! + stereo[first + 1]! + stereo[first + 2]! + stereo[first + 3]!
    ) * 0.25;
  }
  return output;
}

function aggregateGrooveProvenance(
  feature: "drums" | "bass-attacks",
  sourceChecksumSha256: string,
  contributors: MusicalEvidenceProvenance[],
): MusicalEvidenceProvenance | null {
  if (contributors.length === 0) return null;
  if (contributors.length === 1) return contributors[0]!;
  return {
    analysisEngine: `waveyard-${feature}-evidence-aggregate`,
    analysisEngineVersion: GROOVE_EVIDENCE_VERSION,
    sourceChecksumSha256,
    persistence: contributors.every((item) => item.persistence === "database") ? "database" : "request",
    contributors,
  };
}

function summarizeEvidencePacket(packet: MusicalEvidencePacket) {
  return Object.fromEntries(Object.entries(packet.features).map(([name, evidence]) => [
    name,
    evidence.status === "measured"
      ? {
        status: evidence.status,
        analysisEngine: evidence.provenance.analysisEngine,
        analysisEngineVersion: evidence.provenance.analysisEngineVersion,
        persistence: evidence.provenance.persistence,
        subject: evidence.provenance.subject,
        stemAssetId: evidence.provenance.stemAssetId,
        stemType: evidence.provenance.stemType,
        stemChecksumSha256: evidence.provenance.stemChecksumSha256,
      }
      : { status: evidence.status, reason: evidence.reason },
  ]));
}

/**
 * Measure timing evidence from the exact latest completed bed separation.
 * Reuse checksum-current persisted drum events where available. Request-time
 * detection remains an explicit fallback until every separated stem has a
 * persisted event analysis; only timestamps and provenance are cached.
 */
async function loadMeasuredBedGrooveEvidence(projectId: string, bedId: string): Promise<MeasuredBedGrooveEvidence> {
  const bedSource = await findBedSource(projectId, bedId);
  if (bedSource.info.source !== "separated" || !bedSource.info.separationJobId) {
    return {
      drumEvents: [],
      bassEvents: [],
      warnings: ["No completed separated drum/bass stems are available; entry timing uses the beat grid only."],
      drumProvenance: null,
      bassProvenance: null,
    };
  }

  const relevantStems = bedSource.stems
    .filter((stem) => stem.stemType === "drums" || stem.stemType === "percussion" || stem.stemType === "bass")
    .sort((left, right) => left.stemType.localeCompare(right.stemType) || left.id.localeCompare(right.id));
  const [source] = await db
    .select({
      id: sourceAssets.id,
      projectId: sourceAssets.projectId,
      checksumSha256: sourceAssets.checksumSha256,
      durationSeconds: sourceAssets.durationSeconds,
    })
    .from(sourceAssets)
    .where(and(eq(sourceAssets.id, bedId), eq(sourceAssets.projectId, projectId)))
    .limit(1);
  if (!source) {
    return {
      drumEvents: [],
      bassEvents: [],
      warnings: ["The source record is missing; stem timing evidence was excluded."],
      drumProvenance: null,
      bassProvenance: null,
    };
  }
  const drumStemIds = relevantStems
    .filter((stem) => stem.stemType === "drums" || stem.stemType === "percussion")
    .map((stem) => stem.id);
  const persistedDrumAnalyses = drumStemIds.length
    ? await db.select().from(drumAnalyses).where(inArray(drumAnalyses.stemAssetId, drumStemIds))
    : [];
  const drumAnalysisByStem = new Map(persistedDrumAnalyses.map((analysis) => [analysis.stemAssetId, analysis]));
  const bassStemIds = relevantStems.filter((stem) => stem.stemType === "bass").map((stem) => stem.id);
  const persistedBassAnalyses = bassStemIds.length
    ? await db.select().from(bassAnalyses).where(inArray(bassAnalyses.stemAssetId, bassStemIds))
    : [];
  const bassAnalysisByStem = new Map(persistedBassAnalyses.map((analysis) => [analysis.stemAssetId, analysis]));
  const cacheKey = [
    bedId,
    source.checksumSha256,
    bedSource.info.separationJobId,
    GROOVE_EVIDENCE_VERSION,
    ...relevantStems.map((stem) => `${stem.id}:${stem.checksumSha256}`),
    ...persistedDrumAnalyses.map((analysis) =>
      `${analysis.id}:${analysis.status}:${analysis.sourceChecksumSha256}:${analysis.stemChecksumSha256}:${analysis.analysisEngine}:${analysis.analysisEngineVersion}:${analysis.updatedAt?.getTime() ?? 0}`),
    ...persistedBassAnalyses.map((analysis) =>
      `${analysis.id}:${analysis.status}:${analysis.sourceChecksumSha256}:${analysis.stemChecksumSha256}:${analysis.analysisEngine}:${analysis.analysisEngineVersion}:${analysis.updatedAt?.getTime() ?? 0}`),
  ].join("|");
  const now = Date.now();
  const cached = measuredBedGrooveCache.get(cacheKey);
  if (cached && now - cached.createdAt < GROOVE_EVIDENCE_CACHE_TTL_MS) return cached.evidence;
  if (cached) measuredBedGrooveCache.delete(cacheKey);

  const evidence: MeasuredBedGrooveEvidence = {
    drumEvents: [],
    bassEvents: [],
    warnings: [],
    drumProvenance: null,
    bassProvenance: null,
  };
  const drumContributors: MusicalEvidenceProvenance[] = [];
  const bassContributors: MusicalEvidenceProvenance[] = [];
  if (!relevantStems.some((stem) => stem.stemType === "drums" || stem.stemType === "percussion")) {
    evidence.warnings.push("The selected separation has no separate drum/percussion stem; drum-transient matching is unavailable.");
  }
  if (!relevantStems.some((stem) => stem.stemType === "bass")) {
    evidence.warnings.push("The selected separation has no separate bass stem; low-band attack matching is unavailable.");
  }

  for (const stem of relevantStems) {
    try {
      if (stem.stemType === "bass") {
        const analysis = bassAnalysisByStem.get(stem.id);
        const currentAnalysis = analysis
          && analysis.status === "complete"
          && !bassAnalysisProvenanceReason({
            sourceAssetId: analysis.sourceAssetId,
            expectedSourceAssetId: source.id,
            stemAssetId: analysis.stemAssetId,
            expectedStemAssetId: stem.id,
            sourceChecksumSha256: analysis.sourceChecksumSha256,
            expectedSourceChecksumSha256: source.checksumSha256,
            stemChecksumSha256: analysis.stemChecksumSha256,
            expectedStemChecksumSha256: stem.checksumSha256,
            analysisEngine: analysis.analysisEngine,
            analysisEngineVersion: analysis.analysisEngineVersion,
          });
        if (currentAnalysis) {
          const persisted = await db.select({
            timestampMs: bassEvents.timestampMs,
            strength: bassEvents.strength,
            confidence: bassEvents.confidence,
          }).from(bassEvents)
            .where(eq(bassEvents.bassAnalysisId, analysis.id))
            .orderBy(bassEvents.timestampMs, bassEvents.eventIndex);
          evidence.bassEvents.push(...persisted
            .filter((event) => Number.isSafeInteger(event.timestampMs)
              && event.timestampMs >= 0
              && event.timestampMs <= Math.round(source.durationSeconds * 1000)
              && Number.isFinite(event.strength)
              && event.strength >= 0
              && event.strength <= 1
              && Number.isFinite(event.confidence)
              && event.confidence > 0
              && event.confidence <= 1)
            .map(({ timestampMs, strength, confidence }) => ({ timestampMs, strength, confidence })));
          bassContributors.push({
            analysisId: analysis.id,
            analysisEngine: analysis.analysisEngine,
            analysisEngineVersion: analysis.analysisEngineVersion,
            sourceChecksumSha256: source.checksumSha256,
            stemAssetId: stem.id,
            stemChecksumSha256: stem.checksumSha256,
            persistence: "database",
          });
          continue;
        }
        try {
          const ensured = await ensureBassAnalysis(db, source, stem);
          if (ensured.workerUnavailable) {
            evidence.warnings.push("No local bass-analysis worker is active; bass attacks are measured for this request only.");
          } else if (ensured.stale) {
            evidence.warnings.push("A saved bass analysis has stale source, stem, or engine provenance; fresh request-time measurement is used instead.");
          } else if (ensured.queued || ensured.analysis?.status === "queued" || ensured.analysis?.status === "processing" || ensured.analysis?.status === "preparing") {
            evidence.warnings.push("Durable bass attack analysis is queued or running; this plan uses checksum-verified request-time measurements until it completes.");
          } else if (ensured.analysis?.status === "failed") {
            evidence.warnings.push("Durable bass attack analysis failed; this plan uses checksum-verified request-time measurements.");
          }
        } catch {
          evidence.warnings.push("Durable bass analysis could not be queued; checksum-verified request-time measurements are used.");
        }
      }

      const bytes = await getStorage().getBuffer(stem.storageKey, MAX_STEM_BYTES);
      const actualChecksum = createHash("sha256").update(bytes).digest("hex");
      if (actualChecksum !== stem.checksumSha256) {
        evidence.warnings.push(`The ${stem.stemType} stem checksum does not match its saved record; its timing evidence was excluded.`);
        continue;
      }

      if (stem.stemType === "drums" || stem.stemType === "percussion") {
        const analysis = drumAnalysisByStem.get(stem.id);
        const supportedEngine = analysis && (
          (analysis.analysisEngine === DRUM_ANALYSIS_ENGINE && analysis.analysisEngineVersion === DRUM_ANALYSIS_ENGINE_VERSION)
          || (analysis.analysisEngine === DESKTOP_STEM_ANALYSIS_ENGINE && analysis.analysisEngineVersion === DESKTOP_STEM_ANALYSIS_ENGINE_VERSION)
        );
        if (analysis?.status === "complete"
          && supportedEngine
          && analysis.projectId === projectId
          && analysis.sourceAssetId === bedId
          && analysis.sourceChecksumSha256 === source.checksumSha256
          && analysis.stemChecksumSha256 === actualChecksum) {
          const persisted = await db
            .select({
              timestampMs: drumEvents.timestampMs,
              strength: drumEvents.strength,
              confidence: drumEvents.confidence,
            })
            .from(drumEvents)
            .where(eq(drumEvents.drumAnalysisId, analysis.id))
            .orderBy(drumEvents.timestampMs, drumEvents.eventIndex);
          evidence.drumEvents.push(...persisted
            .filter((event) => Number.isSafeInteger(event.timestampMs)
              && event.timestampMs >= 0
              && event.timestampMs <= Math.round(source.durationSeconds * 1000)
              && Number.isFinite(event.strength)
              && event.strength >= 0
              && event.strength <= 1
              && Number.isFinite(event.confidence)
              && event.confidence > 0
              && event.confidence <= 1)
            .map(({ timestampMs, strength, confidence }) => ({ timestampMs, strength, confidence })));
          drumContributors.push({
            analysisId: analysis.id,
            analysisEngine: analysis.analysisEngine,
            analysisEngineVersion: analysis.analysisEngineVersion,
            sourceChecksumSha256: source.checksumSha256,
            stemAssetId: stem.id,
            stemChecksumSha256: actualChecksum,
            persistence: "database",
          });
          continue;
        }
        evidence.warnings.push(`No current persisted drum analysis matches the ${stem.stemType} stem; checksum-verified request-time detection was used.`);
      }

      const decoded = decodeWav16(new Uint8Array(bytes));
      if (!decoded || decoded.sampleRate !== RENDER_SAMPLE_RATE || decoded.channels !== 2) {
        evidence.warnings.push(`The ${stem.stemType} stem is not a validated 44.1 kHz stereo WAV; its timing evidence was excluded.`);
        continue;
      }
      const mono = stemPcmToAnalysisMono(decoded.samples);
      const events = stem.stemType === "bass" ? detectBassAttacks(mono) : detectDrumTransients(mono);
      const mapped = events.map(({ timestampMs, strength, confidence }) => ({ timestampMs, strength, confidence }));
      const runtimeProvenance: MusicalEvidenceProvenance = {
        analysisEngine: stem.stemType === "bass" ? "arena-js-dsp-bass-lowband" : DESKTOP_STEM_ANALYSIS_ENGINE,
        analysisEngineVersion: DESKTOP_STEM_ANALYSIS_ENGINE_VERSION,
        sourceChecksumSha256: source.checksumSha256,
        stemAssetId: stem.id,
        stemChecksumSha256: actualChecksum,
        persistence: "request",
      };
      if (stem.stemType === "bass") {
        evidence.bassEvents.push(...mapped);
        bassContributors.push(runtimeProvenance);
      } else {
        evidence.drumEvents.push(...mapped);
        drumContributors.push(runtimeProvenance);
      }
    } catch {
      evidence.warnings.push(`The ${stem.stemType} stem could not be read; its timing evidence was excluded.`);
    }
  }

  evidence.drumEvents.sort((left, right) => left.timestampMs - right.timestampMs);
  evidence.bassEvents.sort((left, right) => left.timestampMs - right.timestampMs);
  evidence.drumProvenance = aggregateGrooveProvenance("drums", source.checksumSha256, drumContributors);
  evidence.bassProvenance = aggregateGrooveProvenance("bass-attacks", source.checksumSha256, bassContributors);
  while (measuredBedGrooveCache.size >= GROOVE_EVIDENCE_CACHE_MAX_ENTRIES) {
    const oldestKey = measuredBedGrooveCache.keys().next().value;
    if (oldestKey === undefined) break;
    measuredBedGrooveCache.delete(oldestKey);
  }
  measuredBedGrooveCache.set(cacheKey, { createdAt: now, evidence });
  return evidence;
}

/**
 * Decode and sum the bed's separated non-vocal stems.
 *
 * Returns ok:false only when no usable separation exists, so the original-file
 * fallback applies. Throws InstrumentalBedError when stems exist but are
 * undecodable, or their provenance or exact alignment cannot be established —
 * those must not be silently replaced with the original file.
 */
async function loadInstrumentalBed(projectId: string, bedId: string, resolvedSource?: BedSource): Promise<BedLoadResult> {
  const { info, stems } = resolvedSource ?? await findBedSource(projectId, bedId);
  if (info.source === "original-fallback" || stems.length === 0) {
    return { ok: false, info };
  }

  if (stems.length === 1 && stems[0]!.stemType === "instrumental") {
    const pcm = await stemPcm(stems[0]!.storageKey);
    if (pcm === null) {
      throw new InstrumentalBedError(
        "invalid-stem",
        "The separated instrumental stem is not a valid 44.1 kHz stereo WAV. Re-run separation for the instrumental track.",
      );
    }
    return { ok: true, pcm, info };
  }

  const decodedStems: InstrumentalBedStem[] = [];
  for (const stem of stems) {
    const bytes = await getStorage().getBuffer(stem.storageKey, MAX_STEM_BYTES);
    const decoded = decodeWav16(new Uint8Array(bytes));
    if (decoded === null || decoded.sampleRate !== RENDER_SAMPLE_RATE) {
      throw new InstrumentalBedError(
        "invalid-stem",
        `The separated ${stem.stemType} stem is not a valid 44.1 kHz WAV. Re-run separation for the instrumental track.`,
      );
    }
    decodedStems.push({
      stemType: stem.stemType,
      sourceAssetId: stem.sourceAssetId,
      separationJobId: stem.separationJobId,
      startMs: 0,
      sampleRate: decoded.sampleRate,
      channels: decoded.channels,
      frames: decoded.frames,
      samples: decoded.samples,
    });
  }

  const bed = sumInstrumentalStems(decodedStems);
  return { ok: true, pcm: bed.pcm, info };
}

async function inspectBed(projectId: string, bedId: string): Promise<BedSourceInfo> {
  const { info } = await findBedSource(projectId, bedId);
  return info;
}

/** Decode a source's ORIGINAL file (any codec) via the pcm pipeline. */
async function sourcePcm(projectId: string, sourceAssetId: string, tempDir: string): Promise<{ pcm: Float32Array; checksumSha256: string } | null> {
  const [asset] = await db
    .select({ storageKey: sourceAssets.storageKey, checksumSha256: sourceAssets.checksumSha256 })
    .from(sourceAssets)
    .where(and(eq(sourceAssets.id, sourceAssetId), eq(sourceAssets.projectId, projectId)))
    .limit(1);
  if (!asset) return null;
  const filePath = join(tempDir, `source-${randomUUID()}`);
  await getStorage().getToFile(asset.storageKey, filePath);
  const decoded = await decodeSourceToStereoPcm(filePath, {}, {}, { requireSampleRate: RENDER_SAMPLE_RATE });
  return { pcm: decoded.pcm, checksumSha256: asset.checksumSha256 };
}

function recordRuntimeSourceAnalysis(
  profile: NonNullable<Awaited<ReturnType<typeof loadSourceProfile>>>,
  sourceChecksumSha256: string,
  analysis: ReturnType<typeof analyseStereoPcm>,
) {
  if (!profile.evidence || profile.evidence.source.checksumSha256 !== sourceChecksumSha256) return;
  const provenance: MusicalEvidenceProvenance = {
    analysisEngine: DESKTOP_ANALYSIS_ENGINE,
    analysisEngineVersion: DESKTOP_ANALYSIS_ENGINE_VERSION,
    sourceChecksumSha256,
    persistence: "request",
  };
  if (analysis.bpm !== null) {
    profile.evidence.features.tempo = measuredEvidence({
      bpm: analysis.bpm,
      confidence: analysis.bpmConfidence,
    }, provenance);
  }
  if (analysis.musicalKey !== null) {
    profile.evidence.features.key = measuredEvidence({
      key: analysis.musicalKey,
      confidence: analysis.keyConfidence,
    }, provenance);
  }
  if (analysis.beatGridMs !== null) {
    profile.evidence.features.beatGrid = measuredEvidence({
      beatsMs: analysis.beatGridMs,
      confidence: analysis.beatConfidence,
    }, provenance);
  }
}

/**
 * A separated drum stem often exposes a much clearer pulse than the complete
 * mix. Use it only when it belongs to the same completed separation as this
 * source, its bytes match the saved checksum, and its tempo/beat grid clear the
 * same confidence gates used everywhere else. This is request-time evidence;
 * it is deliberately not written into source_analyses as if it came from the
 * original mix.
 */
async function applySeparatedDrumTiming(
  projectId: string,
  profile: NonNullable<Awaited<ReturnType<typeof loadSourceProfile>>>,
  separatedSource: BedSource,
): Promise<void> {
  const separationJobId = separatedSource.info.separationJobId;
  if (!separationJobId || !profile.sourceAssetId || !profile.sourceChecksumSha256) return;
  const [job] = await db.select({ metadata: processingJobs.metadata }).from(processingJobs).where(and(
    eq(processingJobs.id, separationJobId),
    eq(processingJobs.projectId, projectId),
    eq(processingJobs.sourceAssetId, profile.sourceAssetId),
    eq(processingJobs.type, "separation"),
    eq(processingJobs.status, "complete"),
  )).limit(1);
  let jobSourceChecksum: string | null = null;
  try {
    const metadata = JSON.parse(job?.metadata ?? "{}") as Record<string, unknown>;
    jobSourceChecksum = typeof metadata.sourceChecksumSha256 === "string"
      ? metadata.sourceChecksumSha256
      : null;
  } catch {
    // A malformed or absent separation manifest cannot prove which source
    // version generated its stems.
  }
  if (jobSourceChecksum !== profile.sourceChecksumSha256) {
    profile.grooveWarnings = [
      ...(profile.grooveWarnings ?? []),
      "The completed separation is not bound to the current source checksum; its drum timing evidence was excluded.",
    ];
    return;
  }
  const stem = separatedSource.stems.find((candidate) =>
    (candidate.stemType === "drums" || candidate.stemType === "percussion")
    && candidate.projectId === projectId
    && candidate.sourceAssetId === profile.sourceAssetId
    && candidate.separationJobId === separationJobId);
  if (!stem) return;

  let bytes: Buffer;
  try {
    bytes = await getStorage().getBuffer(stem.storageKey, MAX_STEM_BYTES);
  } catch {
    profile.grooveWarnings = [...(profile.grooveWarnings ?? []), "The separated drum stem for this track could not be read; other timing evidence remains in use."];
    return;
  }
  const actualChecksum = createHash("sha256").update(bytes).digest("hex");
  if (actualChecksum !== stem.checksumSha256) {
    profile.grooveWarnings = [...(profile.grooveWarnings ?? []), "The separated drum stem checksum does not match its recorded value; its tempo and beat grid were excluded."];
    return;
  }
  const decoded = decodeWav16(new Uint8Array(bytes));
  if (!decoded || decoded.sampleRate !== RENDER_SAMPLE_RATE || decoded.channels !== 2
    || Math.abs(decoded.frames / RENDER_SAMPLE_RATE * 1000 - profile.durationMs) > 1_100) {
    profile.grooveWarnings = [...(profile.grooveWarnings ?? []), "The separated drum stem is not a full-length 44.1 kHz stereo WAV; its timing evidence was excluded."];
    return;
  }

  const cacheKey = `${stem.id}:${stem.checksumSha256}:${DESKTOP_ANALYSIS_ENGINE_VERSION}`;
  let analysis = separatedStemTimingCache.get(cacheKey);
  if (!analysis) {
    analysis = analyseStereoPcm(decoded.samples);
    while (separatedStemTimingCache.size >= STEM_TIMING_CACHE_MAX_ENTRIES) {
      const oldestKey = separatedStemTimingCache.keys().next().value;
      if (oldestKey === undefined) break;
      separatedStemTimingCache.delete(oldestKey);
    }
    separatedStemTimingCache.set(cacheKey, analysis);
  }
  const stemBpm = trustedAnalysisBpm(analysis.bpm, analysis.bpmConfidence);
  const stemBeatGrid = trustedAnalysisBeatGrid(analysis.beatGridMs, analysis.bpmConfidence, analysis.beatConfidence);
  if (stemBpm === null && stemBeatGrid === null) return;

  const provenance: MusicalEvidenceProvenance = {
    analysisEngine: DESKTOP_ANALYSIS_ENGINE,
    analysisEngineVersion: DESKTOP_ANALYSIS_ENGINE_VERSION,
    sourceChecksumSha256: profile.sourceChecksumSha256,
    subject: "separated-stem",
    stemAssetId: stem.id,
    stemType: stem.stemType,
    stemChecksumSha256: actualChecksum,
    persistence: "request",
  };
  const currentBpmConfidence = profile.bpmConfidence ?? 0;
  if (stemBpm !== null && (trustedAnalysisBpm(profile.bpm, profile.bpmConfidence) === null
    || (analysis.bpmConfidence ?? 0) > currentBpmConfidence)) {
    profile.bpm = stemBpm;
    profile.bpmConfidence = analysis.bpmConfidence;
    if (profile.evidence) {
      profile.evidence.features.tempo = measuredEvidence({
        bpm: stemBpm,
        confidence: analysis.bpmConfidence,
      }, provenance);
    }
  }
  const currentBeatGrid = trustedAnalysisBeatGrid(profile.beatGridMs, profile.bpmConfidence, profile.beatConfidence);
  if (stemBeatGrid !== null && (currentBeatGrid === null
    || (analysis.beatConfidence ?? 0) > (profile.beatConfidence ?? 0))) {
    profile.beatGridMs = stemBeatGrid;
    profile.beatConfidence = analysis.beatConfidence;
    if (profile.evidence) {
      profile.evidence.features.beatGrid = measuredEvidence({
        beatsMs: stemBeatGrid,
        confidence: analysis.beatConfidence,
      }, provenance);
    }
  }
  profile.grooveWarnings = [
    ...(profile.grooveWarnings ?? []),
    `Tempo/beat evidence was measured from the checksum-verified ${stem.stemType} stem of this source's completed separation (request-time, not saved as full-mix analysis).`,
  ];
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const tempDir = join(tmpdir(), `arena-mashup-${randomUUID()}`);
  try {
    const user = await requireUser();
    const { id: projectId } = await params;
    if (!isUuid(projectId)) return Response.json({ error: "Invalid id parameter." }, { status: 400 });
    await requireProjectRole(user.id, projectId, "editor");

    const body = (await request.json().catch(() => ({}))) as MashupBody;
    const action = typeof body.action === "string" ? body.action : "plan";

    if (action === "plan" || action === "render" || action === "save") {
      const vocalsId = typeof body.vocalsSourceId === "string" ? body.vocalsSourceId : "";
      const bedId = typeof body.instrumentalSourceId === "string" ? body.instrumentalSourceId : "";
      if (!isUuid(vocalsId) || !isUuid(bedId)) {
        return Response.json({ error: "Pick both a vocal track and an instrumental track." }, { status: 400 });
      }
      if (vocalsId === bedId) {
        return Response.json({ error: "Pick two different tracks — the mashup needs a vocal source and an instrumental source." }, { status: 400 });
      }

      const [resolvedVocalSource, resolvedBedSource] = await Promise.all([
        findBedSource(projectId, vocalsId),
        findBedSource(projectId, bedId),
      ]);
      const [vocals, bed] = await Promise.all([
        loadSourceProfile(projectId, vocalsId, "vocals", db, {
          separationJobId: resolvedVocalSource.info.separationJobId,
        }),
        loadSourceProfile(projectId, bedId, "instrumental", db, {
          separationJobId: resolvedBedSource.info.separationJobId,
        }),
      ]);
      if (vocals === null || bed === null) {
        return Response.json({ error: "One of the tracks is not in this project." }, { status: 404 });
      }
      await Promise.all([
        applySeparatedDrumTiming(projectId, vocals, resolvedVocalSource),
        applySeparatedDrumTiming(projectId, bed, resolvedBedSource),
      ]);

      // If either profile lacks BPM or key analysis, decode real PCM, analyse on the fly, and persist
      if (vocals.bpm === null || vocals.musicalKey === null) {
        await mkdir(tempDir, { recursive: true });
        const vPcm = await sourcePcm(projectId, vocalsId, tempDir);
        if (vPcm?.pcm && vPcm.checksumSha256 === vocals.sourceChecksumSha256) {
          const analysis = analyseStereoPcm(vPcm.pcm);
          if (vocals.bpm === null && analysis.bpm) vocals.bpm = analysis.bpm;
          if (vocals.bpmConfidence === null || vocals.bpmConfidence === undefined) vocals.bpmConfidence = analysis.bpmConfidence;
          if (vocals.musicalKey === null && analysis.musicalKey) vocals.musicalKey = analysis.musicalKey;
          if (vocals.keyConfidence === null || vocals.keyConfidence === undefined) vocals.keyConfidence = analysis.keyConfidence;
          if (!vocals.beatGridMs && analysis.beatGridMs) vocals.beatGridMs = analysis.beatGridMs;
          if (vocals.beatConfidence === null || vocals.beatConfidence === undefined) vocals.beatConfidence = analysis.beatConfidence;
          recordRuntimeSourceAnalysis(vocals, vPcm.checksumSha256, analysis);

          // Persist analysis so subsequent runs reuse the analysis result
          try {
            await db.insert(sourceAnalyses).values({
                projectId,
                sourceAssetId: vocalsId,
                status: "complete",
                stage: "complete",
                idempotencyKey: `mashup-onthefly-${vocalsId}`,
                analysisEngine: DESKTOP_ANALYSIS_ENGINE,
                analysisEngineVersion: DESKTOP_ANALYSIS_ENGINE_VERSION,
                sourceChecksumSha256: vPcm.checksumSha256,
                bpm: analysis.bpm,
                bpmConfidence: analysis.bpmConfidence,
                musicalKey: analysis.musicalKey,
                keyConfidence: analysis.keyConfidence,
                beatGrid: analysis.beatGridMs ? JSON.stringify(analysis.beatGridMs) : null,
                beatConfidence: analysis.beatConfidence,
                completedAt: new Date(),
              }).onConflictDoNothing();
          } catch {
            // Non-blocking if concurrent or read-only
          }
        }
      }
      if (bed.bpm === null || bed.musicalKey === null) {
        await mkdir(tempDir, { recursive: true });
        const bPcm = await sourcePcm(projectId, bedId, tempDir);
        if (bPcm?.pcm && bPcm.checksumSha256 === bed.sourceChecksumSha256) {
          const analysis = analyseStereoPcm(bPcm.pcm);
          if (bed.bpm === null && analysis.bpm) bed.bpm = analysis.bpm;
          if (bed.bpmConfidence === null || bed.bpmConfidence === undefined) bed.bpmConfidence = analysis.bpmConfidence;
          if (bed.musicalKey === null && analysis.musicalKey) bed.musicalKey = analysis.musicalKey;
          if (bed.keyConfidence === null || bed.keyConfidence === undefined) bed.keyConfidence = analysis.keyConfidence;
          if (!bed.beatGridMs && analysis.beatGridMs) bed.beatGridMs = analysis.beatGridMs;
          if (bed.beatConfidence === null || bed.beatConfidence === undefined) bed.beatConfidence = analysis.beatConfidence;
          recordRuntimeSourceAnalysis(bed, bPcm.checksumSha256, analysis);

          // Persist analysis so subsequent runs reuse the analysis result
          try {
            await db.insert(sourceAnalyses).values({
                projectId,
                sourceAssetId: bedId,
                status: "complete",
                stage: "complete",
                idempotencyKey: `mashup-onthefly-${bedId}`,
                analysisEngine: DESKTOP_ANALYSIS_ENGINE,
                analysisEngineVersion: DESKTOP_ANALYSIS_ENGINE_VERSION,
                sourceChecksumSha256: bPcm.checksumSha256,
                bpm: analysis.bpm,
                bpmConfidence: analysis.bpmConfidence,
                musicalKey: analysis.musicalKey,
                keyConfidence: analysis.keyConfidence,
                beatGrid: analysis.beatGridMs ? JSON.stringify(analysis.beatGridMs) : null,
                beatConfidence: analysis.beatConfidence,
                completedAt: new Date(),
              }).onConflictDoNothing();
          } catch {
            // Non-blocking if concurrent or read-only
          }
        }
      }

      const grooveEvidence = await loadMeasuredBedGrooveEvidence(projectId, bedId);
      bed.drumEvents = grooveEvidence.drumEvents;
      bed.bassEvents = grooveEvidence.bassEvents;
      bed.grooveWarnings = grooveEvidence.warnings;
      if (bed.evidence) {
        bed.evidence.features.drumEvents = grooveEvidence.drumProvenance
          ? measuredEvidence(grooveEvidence.drumEvents, grooveEvidence.drumProvenance)
          : unavailableEvidence("No checksum-current drum event evidence is available.");
        bed.evidence.features.bassAttacks = grooveEvidence.bassProvenance
          ? measuredEvidence(grooveEvidence.bassEvents, grooveEvidence.bassProvenance)
          : unavailableEvidence("No checksum-current low-band bass attack evidence is available.");
      }

      const planned = planMashup(vocals, bed);
      if (!planned.ok) {
        return Response.json({ error: planned.reason }, { status: 422 });
      }
      if (action === "plan") {
        const bedInfo = await inspectBed(projectId, bedId);
        return Response.json({
          plan: planned.plan,
          bed: bedInfo,
          evidence: {
            vocals: vocals.evidence ? summarizeEvidencePacket(vocals.evidence) : null,
            bed: bed.evidence ? summarizeEvidencePacket(bed.evidence) : null,
          },
        }, { status: 200 });
      }

      if (action === "save") {
        const vocalsStem = await latestStem(projectId, vocalsId, "vocals");
        const bedSource = resolvedBedSource;
        const bedStems = bedSource.stems;

        if (!vocalsStem || bedStems.length === 0) {
          return Response.json(
            { error: "Both a completed separated vocal stem and an instrumental bed are required to save an editable Studio remix." },
            { status: 422 },
          );
        }

        // Verify genuine analysis confidence before enabling transform and snap flags
        const vocalTempoTrusted = trustedAnalysisBpm(vocals.bpm, vocals.bpmConfidence) !== null;
        const vocalKeyTrusted = trustedAnalysisKey(vocals.musicalKey, vocals.keyConfidence) !== null;
        const vocalGridTrusted = trustedAnalysisBeatGrid(vocals.beatGridMs, vocals.bpmConfidence, vocals.beatConfidence) !== null;
        const bedGridTrusted = trustedAnalysisBeatGrid(bed.beatGridMs, bed.bpmConfidence, bed.beatConfidence) !== null;
        const sessionSnapEnabled = vocalGridTrusted && bedGridTrusted;

        const result = await db.transaction(async (tx) => {
          const [remix] = await tx.insert(remixSessions).values({
            projectId,
            ownerId: user.id,
            name: `Mashup: ${vocals.role} × ${bed.role}`,
            masterVolume: 1,
            loopStartMs: 0,
            loopEndMs: null,
            tempoBpm: planned.plan.masterBpm,
            timeSignatureNumerator: 4,
            timeSignatureDenominator: 4,
            gridDivision: "beat",
            snapEnabled: sessionSnapEnabled,
            targetKey: bed.musicalKey,
          }).returning();

          const tracksToInsert: Array<{
            remixSessionId: string;
            stemAssetId: string;
            name: string;
            sortOrder: number;
            volume: number;
            pan: number;
          }> = [];

          if (vocalsStem) {
            tracksToInsert.push({
              remixSessionId: remix.id,
              stemAssetId: vocalsStem.id,
              name: "Lead Vocals (Donor)",
              sortOrder: 0,
              volume: 1,
              pan: 0,
            });
          }

          let sortOrder = 1;
          for (const bStem of bedStems) {
            if (bStem.stemType !== "vocals") {
              tracksToInsert.push({
                remixSessionId: remix.id,
                stemAssetId: bStem.id,
                name: `${bStem.stemType[0].toUpperCase()}${bStem.stemType.slice(1)} (Bed)`,
                sortOrder: sortOrder++,
                volume: 0.8,
                pan: 0,
              });
            }
          }

          const insertedTracks = tracksToInsert.length ? await tx.insert(remixTracks).values(tracksToInsert).returning() : [];
          const trackByStemId = new Map(insertedTracks.map((t) => [t.stemAssetId, t]));

          const clipsToInsert: Array<{
            remixTrackId: string;
            stemAssetId: string;
            timelineStartMs: number;
            durationMs: number;
            sourceOffsetMs: number;
            gain: number;
            fadeInMs: number;
            fadeOutMs: number;
            tempoSyncEnabled: boolean;
            keySyncEnabled: boolean;
            beatSnapEnabled: boolean;
          }> = [];

          // Vocal clips from planned segments
          if (vocalsStem && trackByStemId.has(vocalsStem.id)) {
            const vocalTrackId = trackByStemId.get(vocalsStem.id)!.id;
            for (const seg of planned.plan.segments) {
              clipsToInsert.push({
                remixTrackId: vocalTrackId,
                stemAssetId: vocalsStem.id,
                timelineStartMs: seg.mashupStartMs,
                durationMs: seg.mashupEndMs - seg.mashupStartMs,
                sourceOffsetMs: seg.vocalsFromMs,
                gain: 0.85,
                fadeInMs: seg.crossfadeMs,
                fadeOutMs: seg.crossfadeMs,
                tempoSyncEnabled: vocalTempoTrusted,
                keySyncEnabled: vocalKeyTrusted,
                beatSnapEnabled: vocalGridTrusted,
              });
            }
          }

          // Bed clips spanning full duration
          for (const bStem of bedStems) {
            if (bStem.stemType !== "vocals" && trackByStemId.has(bStem.id)) {
              clipsToInsert.push({
                remixTrackId: trackByStemId.get(bStem.id)!.id,
                stemAssetId: bStem.id,
                timelineStartMs: 0,
                durationMs: planned.plan.durationMs,
                sourceOffsetMs: 0,
                gain: 0.8,
                fadeInMs: 50,
                fadeOutMs: 150,
                tempoSyncEnabled: false,
                keySyncEnabled: false,
                beatSnapEnabled: bedGridTrusted,
              });
            }
          }

          const insertedClips = clipsToInsert.length ? await tx.insert(remixClips).values(clipsToInsert).returning() : [];

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
            mashupPlan: {
              engine: planned.plan.engine,
              masterBpm: planned.plan.masterBpm,
              vocalsStretchRatio: planned.plan.vocalsStretchRatio,
              vocalsPitchSemitones: planned.plan.vocalsPitchSemitones,
              keyRelationship: planned.plan.keyRelationship,
              durationMs: planned.plan.durationMs,
              segments: planned.plan.segments,
              passageSearch: planned.plan.passageSearch ?? null,
              arrangement: planned.plan.arrangement ?? null,
              rationale: planned.plan.rationale,
              warnings: planned.plan.warnings,
            },
            tracks: insertedTracks.map((track) => ({
              ...track,
              clips: insertedClips.filter((clip) => clip.remixTrackId === track.id),
            })),
            automation: [],
          };

          const [version] = await tx.insert(remixVersions).values({
            remixSessionId: remix.id,
            createdById: user.id,
            name: "Initial mashup arrangement",
            snapshot: JSON.stringify(snapshot),
          }).returning();

          return { remix, version };
        });

        return Response.json({ ok: true, remix: result.remix, version: result.version }, { status: 201 });
      }

      // Render: donor vocal over a clean instrumental bed. The bed is built
      // from the separated non-vocal stems of ONE completed separation run.
      // With no completed separation, fall back to the original file and say
      // so. Existing stems that fail validation fail the render (422).
      if (planned.plan.durationMs / 1000 > MAX_RENDER_SECONDS) {
        return Response.json({ error: `Renders are limited to ${MAX_RENDER_SECONDS / 60} minutes.` }, { status: 413 });
      }
      await mkdir(tempDir, { recursive: true });

      const vocalsStem = await latestStem(projectId, vocalsId, "vocals");
      const decodedVocals = vocalsStem !== null ? await stemPcm(vocalsStem.storageKey) : null;
      const warnings: string[] = [];
      let vocalsPcm: Float32Array;
      if (decodedVocals !== null) {
        vocalsPcm = decodedVocals;
      } else {
        const vocalsFile = await sourcePcm(projectId, vocalsId, tempDir);
        if (vocalsFile === null) {
          return Response.json({ error: "The vocal track's audio could not be decoded." }, { status: 500 });
        }
        vocalsPcm = vocalsFile.pcm;
        warnings.push(
          "The donor vocal uses the original file because no separated vocal stem is available; it may contain instrumental bleed.",
        );
      }

      const bedResult = await loadInstrumentalBed(projectId, bedId, resolvedBedSource);
      let bedPcm: Float32Array;
      let bedInfo: BedSourceInfo;
      if (bedResult.ok) {
        bedPcm = bedResult.pcm;
        bedInfo = bedResult.info;
      } else {
        const bedFile = await sourcePcm(projectId, bedId, tempDir);
        if (bedFile === null) {
          return Response.json({ error: "The instrumental's audio could not be decoded." }, { status: 500 });
        }
        bedPcm = bedFile.pcm;
        bedInfo = bedResult.info;
      }

      // Load available complementary stems from the donor vocal track (e.g. guitar/keys/other)
      // strictly from the single authoritative completed separation run of the vocal stem.
      // Exclude pending, failed, cancelled, or superseded runs, and reject duplicate stem types.
      const complementaryDonorStems = new Map<string, Float32Array>();
      if (vocalsStem?.separationJobId) {
        try {
          const donorStemRows = await db
            .select({
              stemType: stemAssets.stemType,
              storageKey: stemAssets.storageKey,
              separationJobId: stemAssets.separationJobId,
            })
            .from(stemAssets)
            .where(
              and(
                eq(stemAssets.projectId, projectId),
                eq(stemAssets.sourceAssetId, vocalsId),
                eq(stemAssets.separationJobId, vocalsStem.separationJobId),
              ),
            );

          const seenTypes = new Set<string>();
          for (const stemRow of donorStemRows) {
            if (stemRow.stemType !== "vocals") {
              if (seenTypes.has(stemRow.stemType)) {
                // Reject duplicate stem types rather than silently overwriting
                continue;
              }
              seenTypes.add(stemRow.stemType);
              const pcm = await stemPcm(stemRow.storageKey);
              if (pcm && pcm.length > 0) {
                complementaryDonorStems.set(`donor_${stemRow.stemType}`, pcm);
              }
            }
          }
        } catch {
          // Fall back gracefully
        }
      }

      const mixed = renderMashup(planned.plan, {
        vocals: vocalsPcm,
        bed: bedPcm,
        stems: complementaryDonorStems.size > 0 ? complementaryDonorStems : undefined,
        sampleRate: RENDER_SAMPLE_RATE,
      });
      return wavResponse(encodeWav16(mixed, RENDER_SAMPLE_RATE), "mashup", bedInfo, warnings);
    }

    if (action === "extend") {
      const sourceAssetId = typeof body.sourceAssetId === "string" ? body.sourceAssetId : "";
      if (!isUuid(sourceAssetId)) {
        return Response.json({ error: "Pick the track to extend." }, { status: 400 });
      }
      const profile = await loadSourceProfile(projectId, sourceAssetId, "instrumental");
      if (profile === null) return Response.json({ error: "That track is not in this project." }, { status: 404 });

      const sectionLabel = typeof body.sectionLabel === "string" && body.sectionLabel.trim().length > 0 ? body.sectionLabel.trim() : undefined;
      const repeats = typeof body.repeats === "number" && Number.isFinite(body.repeats) ? Math.round(body.repeats) : 2;
      const plan = planSongExtension(profile, { sectionLabel, repeats });
      if (plan === null) {
        return Response.json({ error: "This track has no analyzed sections to loop — run analysis first." }, { status: 422 });
      }
      if (plan.durationMs / 1000 > MAX_RENDER_SECONDS) {
        return Response.json({ error: `Renders are limited to ${MAX_RENDER_SECONDS / 60} minutes.` }, { status: 413 });
      }

      await mkdir(tempDir, { recursive: true });
      const decoded = await sourcePcm(projectId, sourceAssetId, tempDir);
      if (decoded === null) return Response.json({ error: "The track's audio could not be decoded." }, { status: 500 });
      const extended = renderSongExtension(plan, decoded.pcm, RENDER_SAMPLE_RATE);
      return wavResponse(encodeWav16(extended, RENDER_SAMPLE_RATE), "extended");
    }

    return Response.json({ error: "Unknown action — use plan, render, or extend." }, { status: 400 });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof InstrumentalBedError) {
      return Response.json({ error: error.message }, { status: 422 });
    }
    console.error("mashup route failed", error);
    return Response.json({ error: "The mashup could not be produced." }, { status: 500 });
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function wavResponse(
  wav: Uint8Array,
  kind: string,
  bed?: BedSourceInfo,
  warnings: string[] = [],
): Response {
  const headers = new Headers({
    "content-type": "audio/wav",
    "cache-control": "no-store",
    "content-disposition": `attachment; filename="waveyard-${kind}.wav"`,
  });
  if (bed) {
    headers.set("x-waveyard-bed-source", bed.source);
    headers.set("x-waveyard-bed-warning", encodeURIComponent(bed.warning));
    if (bed.separationJobId) headers.set("x-waveyard-bed-job", bed.separationJobId);
    if (bed.includedStemTypes?.length) {
      headers.set("x-waveyard-bed-stems", bed.includedStemTypes.join(","));
    }
  }
  for (const warning of warnings) {
    headers.append("x-waveyard-warning", encodeURIComponent(warning));
  }
  return new Response(wav as unknown as BodyInit, { status: 200, headers });
}
