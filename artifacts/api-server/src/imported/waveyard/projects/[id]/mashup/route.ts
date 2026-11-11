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
 * Plan and render are read-only; the explicit save action persists the
 * arrangement into Waveyard remix tables. Source tracks and stems are never
 * modified by these actions.
 */


import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { db } from "@workspace/db";
import { processingJobs, remixAutomationPoints, remixClips, remixSessions, remixTracks, remixVersions, sourceAnalyses, sourceAssets, stemAssets } from "@workspace/db/waveyardSchema";
import { requireProjectRole, requireUser } from "@workspace/arena/lib/waveyard/local-context";
import { getStorage } from "@workspace/arena/lib/waveyard/storage";
import { decodeWav16, encodeWav16, type DecodedWav } from "@workspace/arena/lib/waveyard/mixer/synth";
import { decodeSourceToStereoPcm } from "@workspace/arena/lib/waveyard/measure/pcm";
import { loadSourceProfile } from "@workspace/arena/lib/waveyard/studio/mashup-sources";
import {
  INSTRUMENTAL_BED_STEM_TYPES,
  InstrumentalBedError,
  sumInstrumentalStems,
  type InstrumentalBedStem,
} from "@workspace/arena/lib/waveyard/studio/mashup-bed";
import { analyseStereoPcm, mashupDuckAutomationPoints, planMashup, planSongExtension, renderMashup, renderSongExtension } from "@workspace/arena/lib/waveyard/studio/mashup";
import { DESKTOP_ANALYSIS_ENGINE, DESKTOP_ANALYSIS_ENGINE_VERSION } from "@workspace/arena/lib/waveyard/types/analysis-provenance";
import { trustedAnalysisBpm, trustedAnalysisKey, trustedAnalysisBeatGrid } from "@workspace/arena/lib/waveyard/types";
import { isUuid } from "@workspace/arena/lib/api/ids";

export const dynamic = "force-dynamic";

const RENDER_SAMPLE_RATE = 44_100;
const MAX_STEM_BYTES = 128 * 1024 * 1024;
const MAX_RENDER_SECONDS = 900;

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
  stems: StemIntegrityAsset[];
};

type BedLoadResult =
  | { ok: true; pcm: Float32Array; frames: number; appliedGain: number; info: BedSourceInfo; stems: StemIntegrityAsset[] }
  | { ok: false; info: BedSourceInfo };

type StemIntegrityAsset = Pick<typeof stemAssets.$inferSelect,
  | "id"
  | "projectId"
  | "sourceAssetId"
  | "separationJobId"
  | "stemType"
  | "storageKey"
  | "checksumSha256"
  | "durationSeconds"
  | "sampleRate"
  | "channels"
  | "fileSizeBytes"
>;

type LoadedComplementaryStem = {
  asset: StemIntegrityAsset;
  decoded: DecodedWav;
};

/** Latest stem of a type backed by a completed separation run, or null. */
async function latestStem(projectId: string, sourceAssetId: string, stemType: string) {
  const [stem] = await db
    .select({
      id: stemAssets.id,
      projectId: stemAssets.projectId,
      sourceAssetId: stemAssets.sourceAssetId,
      separationJobId: stemAssets.separationJobId,
      stemType: stemAssets.stemType,
      storageKey: stemAssets.storageKey,
      checksumSha256: stemAssets.checksumSha256,
      durationSeconds: stemAssets.durationSeconds,
      sampleRate: stemAssets.sampleRate,
      channels: stemAssets.channels,
      fileSizeBytes: stemAssets.fileSizeBytes,
    })
    .from(stemAssets)
    .innerJoin(processingJobs, eq(stemAssets.separationJobId, processingJobs.id))
    .where(and(
      eq(stemAssets.projectId, projectId),
      eq(stemAssets.sourceAssetId, sourceAssetId),
      eq(stemAssets.stemType, stemType),
      eq(processingJobs.projectId, projectId),
      eq(processingJobs.sourceAssetId, sourceAssetId),
      eq(processingJobs.type, "separation"),
      eq(processingJobs.status, "complete"),
    ))
    .orderBy(
      desc(sql`coalesce(${processingJobs.completedAt}, ${processingJobs.createdAt})`),
      desc(stemAssets.createdAt),
      desc(stemAssets.id),
    )
    .limit(1);
  if (!stem) return null;
  return stem;
}

/** Verify stored identity/metadata and decode a render-rate stereo stem WAV. */
async function decodeStemAsset(stem: StemIntegrityAsset): Promise<DecodedWav | null> {
  const storageKey = typeof stem.storageKey === "string" ? stem.storageKey.trim() : "";
  if (
    storageKey === ""
    || storageKey !== stem.storageKey
    || storageKey.startsWith("/")
    || storageKey.includes("\\")
    || storageKey.split("/").some((part) => part === "" || part === "." || part === "..")
    || !Number.isSafeInteger(stem.fileSizeBytes)
    || stem.fileSizeBytes < 44
    || !/^[a-f0-9]{64}$/i.test(stem.checksumSha256)
  ) return null;

  let bytes: Buffer;
  try {
    bytes = await getStorage().getBuffer(stem.storageKey, MAX_STEM_BYTES);
  } catch {
    return null;
  }
  if (bytes.byteLength !== stem.fileSizeBytes) return null;
  const checksum = createHash("sha256").update(bytes).digest("hex");
  if (checksum !== stem.checksumSha256.toLowerCase()) return null;

  let decoded: DecodedWav | null;
  try {
    decoded = decodeWav16(new Uint8Array(bytes));
  } catch {
    return null;
  }
  if (decoded === null) return null;
  if (
    decoded.sampleRate !== RENDER_SAMPLE_RATE
    || decoded.channels !== 2
    || decoded.frames < 1
    || stem.sampleRate !== decoded.sampleRate
    || stem.channels !== decoded.channels
    || !Number.isSafeInteger(stem.durationSeconds)
    || stem.durationSeconds < 0
    || Math.round(decoded.frames / decoded.sampleRate) !== stem.durationSeconds
  ) return null;
  return decoded;
}

/**
 * Load complementary donor instruments from the exact completed separation
 * run that supplied the selected lead vocal. Invalid optional stems are omitted
 * with a warning; they never replace or contaminate the lead vocal.
 */
async function loadComplementaryDonorStems(
  projectId: string,
  sourceAssetId: string,
  vocalsStem: StemIntegrityAsset,
  vocalFrames: number,
): Promise<{ stems: LoadedComplementaryStem[]; warnings: string[] }> {
  const rows: StemIntegrityAsset[] = await db
    .select({
      id: stemAssets.id,
      projectId: stemAssets.projectId,
      sourceAssetId: stemAssets.sourceAssetId,
      separationJobId: stemAssets.separationJobId,
      stemType: stemAssets.stemType,
      storageKey: stemAssets.storageKey,
      checksumSha256: stemAssets.checksumSha256,
      durationSeconds: stemAssets.durationSeconds,
      sampleRate: stemAssets.sampleRate,
      channels: stemAssets.channels,
      fileSizeBytes: stemAssets.fileSizeBytes,
    })
    .from(stemAssets)
    .innerJoin(processingJobs, eq(stemAssets.separationJobId, processingJobs.id))
    .where(and(
      eq(stemAssets.projectId, projectId),
      eq(stemAssets.sourceAssetId, sourceAssetId),
      eq(stemAssets.separationJobId, vocalsStem.separationJobId),
      eq(processingJobs.projectId, projectId),
      eq(processingJobs.sourceAssetId, sourceAssetId),
      eq(processingJobs.type, "separation"),
      eq(processingJobs.status, "complete"),
      inArray(stemAssets.stemType, [...INSTRUMENTAL_BED_STEM_TYPES]),
    ))
    .orderBy(asc(stemAssets.stemType), desc(stemAssets.createdAt), desc(stemAssets.id));

  const warnings: string[] = [];
  const rowsByType = new Map<string, StemIntegrityAsset[]>();
  for (const row of rows) {
    const group = rowsByType.get(row.stemType) ?? [];
    group.push(row);
    rowsByType.set(row.stemType, group);
  }
  if (rows.length === 0) {
    warnings.push("No complementary non-vocal donor stems are available from the selected completed separation run; the mashup uses its lead vocal and bed only.");
  }

  const stems: LoadedComplementaryStem[] = [];
  for (const [stemType, matchingRows] of rowsByType) {
    if (matchingRows.length !== 1) {
      warnings.push(`The donor ${stemType} layer was omitted because its completed separation run contains duplicate stem records.`);
      continue;
    }
    const asset = matchingRows[0]!;
    const decoded = await decodeStemAsset(asset);
    if (
      decoded === null
      || asset.projectId !== projectId
      || asset.sourceAssetId !== sourceAssetId
      || asset.separationJobId !== vocalsStem.separationJobId
      || decoded.frames !== vocalFrames
      || asset.durationSeconds !== vocalsStem.durationSeconds
    ) {
      warnings.push(`The donor ${stemType} layer was omitted because its stored audio failed integrity or alignment checks.`);
      continue;
    }
    stems.push({ asset, decoded });
  }
  return { stems, warnings };
}

/**
 * Find the authoritative bed source for a track.
 *
 * A future engine may provide a real "instrumental" stem; use it when its
 * separation run is complete. Otherwise use the LATEST completed separation
 * run and only its non-vocal stems. Never combine stems across runs.
 */
async function findBedSource(projectId: string, bedId: string): Promise<BedSource> {
  const [job] = await db
    .select({ id: processingJobs.id })
    .from(processingJobs)
    .where(and(
      eq(processingJobs.projectId, projectId),
      eq(processingJobs.sourceAssetId, bedId),
      eq(processingJobs.type, "separation"),
      eq(processingJobs.status, "complete"),
    ))
    .orderBy(
      desc(sql`coalesce(${processingJobs.completedAt}, ${processingJobs.createdAt})`),
      desc(processingJobs.createdAt),
      desc(processingJobs.id),
    )
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

  const stems: StemIntegrityAsset[] = await db
    .select({
      id: stemAssets.id,
      projectId: stemAssets.projectId,
      sourceAssetId: stemAssets.sourceAssetId,
      separationJobId: stemAssets.separationJobId,
      stemType: stemAssets.stemType,
      storageKey: stemAssets.storageKey,
      checksumSha256: stemAssets.checksumSha256,
      durationSeconds: stemAssets.durationSeconds,
      sampleRate: stemAssets.sampleRate,
      channels: stemAssets.channels,
      fileSizeBytes: stemAssets.fileSizeBytes,
    })
    .from(stemAssets)
    .where(
      and(
        eq(stemAssets.projectId, projectId),
        eq(stemAssets.sourceAssetId, bedId),
        eq(stemAssets.separationJobId, job.id),
      ),
    );

  // The latest completed run is authoritative. Never select an instrumental
  // output from an older run just because the current run emitted split stems.
  const instrumentalStems = stems.filter((stem) => stem.stemType === "instrumental");
  if (instrumentalStems.length > 1) {
    throw new InstrumentalBedError(
      "invalid-provenance",
      "The latest completed separation run contains duplicate instrumental stems. Re-run separation for the instrumental track.",
    );
  }
  if (instrumentalStems.length === 1) {
    return {
      info: {
        source: "separated",
        separationJobId: job.id,
        includedStemTypes: ["instrumental"],
        warning:
          "The bed uses a separated instrumental stem. Separation is not perfect; residual leakage may remain.",
      },
      stems: instrumentalStems,
    };
  }

  const bedStemTypes = new Set<string>(INSTRUMENTAL_BED_STEM_TYPES);
  const usable = stems.filter((stem) => bedStemTypes.has(stem.stemType));
  const stemTypeCounts = new Map<string, number>();
  for (const stem of usable) stemTypeCounts.set(stem.stemType, (stemTypeCounts.get(stem.stemType) ?? 0) + 1);
  const duplicateType = [...stemTypeCounts].find(([, count]) => count > 1)?.[0];
  if (duplicateType) {
    throw new InstrumentalBedError(
      "invalid-provenance",
      `The completed separation run contains duplicate ${duplicateType} stems. Re-run separation for the instrumental track.`,
    );
  }
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

/**
 * Decode and sum the bed's separated non-vocal stems.
 *
 * Returns ok:false only when no usable separation exists, so the original-file
 * fallback applies. Throws InstrumentalBedError when stems exist but are
 * undecodable, or their provenance or exact alignment cannot be established —
 * those must not be silently replaced with the original file.
 */
async function loadInstrumentalBed(projectId: string, bedId: string): Promise<BedLoadResult> {
  const { info, stems } = await findBedSource(projectId, bedId);
  if (info.source === "original-fallback" || stems.length === 0) {
    return { ok: false, info };
  }

  if (stems.length === 1 && stems[0]!.stemType === "instrumental") {
    const decoded = await decodeStemAsset(stems[0]!);
    if (decoded === null) {
      throw new InstrumentalBedError(
        "invalid-stem",
        "The separated instrumental stem failed its stored-file integrity or PCM checks. Re-run separation for the instrumental track.",
      );
    }
    return { ok: true, pcm: decoded.samples, frames: decoded.frames, appliedGain: 1, info, stems };
  }

  const decodedStems: InstrumentalBedStem[] = [];
  for (const stem of stems) {
    const decoded = await decodeStemAsset(stem);
    if (decoded === null) {
      throw new InstrumentalBedError(
        "invalid-stem",
        `The separated ${stem.stemType} stem failed its stored-file integrity or PCM checks. Re-run separation for the instrumental track.`,
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
  return { ok: true, pcm: bed.pcm, frames: bed.frames, appliedGain: bed.appliedGain, info, stems };
}

async function inspectBed(projectId: string, bedId: string): Promise<BedSourceInfo> {
  const { info } = await findBedSource(projectId, bedId);
  return info;
}

/** Decode a source's ORIGINAL file (any codec) via the pcm pipeline. */
async function sourcePcm(projectId: string, sourceAssetId: string, tempDir: string): Promise<{ pcm: Float32Array } | null> {
  const [asset] = await db
    .select({ storageKey: sourceAssets.storageKey })
    .from(sourceAssets)
    .where(and(eq(sourceAssets.id, sourceAssetId), eq(sourceAssets.projectId, projectId)))
    .limit(1);
  if (!asset) return null;
  const filePath = join(tempDir, `source-${randomUUID()}`);
  await getStorage().getToFile(asset.storageKey, filePath);
  const decoded = await decodeSourceToStereoPcm(filePath, {}, {}, { requireSampleRate: RENDER_SAMPLE_RATE });
  return { pcm: decoded.pcm };
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

      const [vocals, bed] = await Promise.all([
        loadSourceProfile(projectId, vocalsId, "vocals"),
        loadSourceProfile(projectId, bedId, "instrumental"),
      ]);
      if (vocals === null || bed === null) {
        return Response.json({ error: "One of the tracks is not in this project." }, { status: 404 });
      }

      // If either profile lacks BPM or key analysis, decode real PCM, analyse on the fly, and persist
      if (vocals.bpm === null || vocals.musicalKey === null) {
        await mkdir(tempDir, { recursive: true });
        const vPcm = await sourcePcm(projectId, vocalsId, tempDir);
        if (vPcm?.pcm) {
          const analysis = analyseStereoPcm(vPcm.pcm);
          if (vocals.bpm === null && analysis.bpm) vocals.bpm = analysis.bpm;
          if (vocals.bpmConfidence === null || vocals.bpmConfidence === undefined) vocals.bpmConfidence = analysis.bpmConfidence;
          if (vocals.musicalKey === null && analysis.musicalKey) vocals.musicalKey = analysis.musicalKey;
          if (vocals.keyConfidence === null || vocals.keyConfidence === undefined) vocals.keyConfidence = analysis.keyConfidence;
          if (!vocals.beatGridMs && analysis.beatGridMs) vocals.beatGridMs = analysis.beatGridMs;
          if (vocals.beatConfidence === null || vocals.beatConfidence === undefined) vocals.beatConfidence = analysis.beatConfidence;

          // Persist analysis so subsequent runs reuse the analysis result
          try {
            const [asset] = await db.select({ checksumSha256: sourceAssets.checksumSha256 }).from(sourceAssets).where(eq(sourceAssets.id, vocalsId)).limit(1);
            if (asset) {
              await db.insert(sourceAnalyses).values({
                projectId,
                sourceAssetId: vocalsId,
                status: "complete",
                stage: "complete",
                idempotencyKey: `mashup-onthefly-${vocalsId}`,
                analysisEngine: DESKTOP_ANALYSIS_ENGINE,
                analysisEngineVersion: DESKTOP_ANALYSIS_ENGINE_VERSION,
                sourceChecksumSha256: asset.checksumSha256,
                bpm: analysis.bpm,
                bpmConfidence: analysis.bpmConfidence,
                musicalKey: analysis.musicalKey,
                keyConfidence: analysis.keyConfidence,
                beatGrid: analysis.beatGridMs ? JSON.stringify(analysis.beatGridMs) : null,
                beatConfidence: analysis.beatConfidence,
                completedAt: new Date(),
              }).onConflictDoNothing();
            }
          } catch {
            // Non-blocking if concurrent or read-only
          }
        }
      }
      if (bed.bpm === null || bed.musicalKey === null) {
        await mkdir(tempDir, { recursive: true });
        const bPcm = await sourcePcm(projectId, bedId, tempDir);
        if (bPcm?.pcm) {
          const analysis = analyseStereoPcm(bPcm.pcm);
          if (bed.bpm === null && analysis.bpm) bed.bpm = analysis.bpm;
          if (bed.bpmConfidence === null || bed.bpmConfidence === undefined) bed.bpmConfidence = analysis.bpmConfidence;
          if (bed.musicalKey === null && analysis.musicalKey) bed.musicalKey = analysis.musicalKey;
          if (bed.keyConfidence === null || bed.keyConfidence === undefined) bed.keyConfidence = analysis.keyConfidence;
          if (!bed.beatGridMs && analysis.beatGridMs) bed.beatGridMs = analysis.beatGridMs;
          if (bed.beatConfidence === null || bed.beatConfidence === undefined) bed.beatConfidence = analysis.beatConfidence;

          // Persist analysis so subsequent runs reuse the analysis result
          try {
            const [asset] = await db.select({ checksumSha256: sourceAssets.checksumSha256 }).from(sourceAssets).where(eq(sourceAssets.id, bedId)).limit(1);
            if (asset) {
              await db.insert(sourceAnalyses).values({
                projectId,
                sourceAssetId: bedId,
                status: "complete",
                stage: "complete",
                idempotencyKey: `mashup-onthefly-${bedId}`,
                analysisEngine: DESKTOP_ANALYSIS_ENGINE,
                analysisEngineVersion: DESKTOP_ANALYSIS_ENGINE_VERSION,
                sourceChecksumSha256: asset.checksumSha256,
                bpm: analysis.bpm,
                bpmConfidence: analysis.bpmConfidence,
                musicalKey: analysis.musicalKey,
                keyConfidence: analysis.keyConfidence,
                beatGrid: analysis.beatGridMs ? JSON.stringify(analysis.beatGridMs) : null,
                beatConfidence: analysis.beatConfidence,
                completedAt: new Date(),
              }).onConflictDoNothing();
            }
          } catch {
            // Non-blocking if concurrent or read-only
          }
        }
      }

      const planned = planMashup(vocals, bed);
      if (!planned.ok) {
        return Response.json({ error: planned.reason }, { status: 422 });
      }
      if (action === "plan") {
        const bedInfo = await inspectBed(projectId, bedId);
        return Response.json({ plan: planned.plan, bed: bedInfo }, { status: 200 });
      }

      if (action === "save") {
        const vocalsStem = await latestStem(projectId, vocalsId, "vocals");
        const decodedVocals = vocalsStem ? await decodeStemAsset(vocalsStem) : null;
        const bedLoad = await loadInstrumentalBed(projectId, bedId);

        if (!vocalsStem || decodedVocals === null || !bedLoad.ok || bedLoad.stems.length === 0) {
          return Response.json(
            { error: "A valid completed separated vocal stem and an integrity-checked separated instrumental bed are required to save an editable Studio remix." },
            { status: 422 },
          );
        }
        const bedStems = bedLoad.stems;
        const complementary = await loadComplementaryDonorStems(projectId, vocalsId, vocalsStem, decodedVocals.frames);

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

          tracksToInsert.push({
            remixSessionId: remix.id,
            stemAssetId: vocalsStem.id,
            name: "Lead Vocals (Donor)",
            sortOrder: 0,
            volume: 1,
            pan: 0,
          });

          let sortOrder = 1;
          for (const bStem of bedStems) {
            tracksToInsert.push({
              remixSessionId: remix.id,
              stemAssetId: bStem.id,
              name: `${bStem.stemType[0].toUpperCase()}${bStem.stemType.slice(1)} (Bed)`,
              sortOrder: sortOrder++,
              volume: 1,
              pan: 0,
            });
          }
          for (const donorStem of complementary.stems) {
            tracksToInsert.push({
              remixSessionId: remix.id,
              stemAssetId: donorStem.asset.id,
              name: `${donorStem.asset.stemType[0]!.toUpperCase()}${donorStem.asset.stemType.slice(1)} (Donor)`,
              sortOrder: sortOrder++,
              volume: 1,
              pan: 0,
            });
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
                gain: 1,
                fadeInMs: seg.crossfadeMs,
                fadeOutMs: seg.crossfadeMs,
                tempoSyncEnabled: vocalTempoTrusted,
                keySyncEnabled: vocalKeyTrusted,
                beatSnapEnabled: vocalGridTrusted,
              });
            }
          }

          // Persist the same bed PCM gain and end boundary used by the render.
          for (const bStem of bedStems) {
            if (trackByStemId.has(bStem.id)) {
              clipsToInsert.push({
                remixTrackId: trackByStemId.get(bStem.id)!.id,
                stemAssetId: bStem.id,
                timelineStartMs: 0,
                durationMs: Math.min(
                  planned.plan.durationMs,
                  Math.floor((bedLoad.frames * 1000) / RENDER_SAMPLE_RATE),
                ),
                sourceOffsetMs: 0,
                gain: bedLoad.appliedGain,
                fadeInMs: 0,
                fadeOutMs: 0,
                tempoSyncEnabled: false,
                keySyncEnabled: false,
                beatSnapEnabled: bedGridTrusted,
              });
            }
          }

          // Complementary donor instruments are persisted from the same run
          // that supplied the lead vocal, with no vocal stretch/key flags.
          for (const donorStem of complementary.stems) {
            const track = trackByStemId.get(donorStem.asset.id);
            if (!track) continue;
            clipsToInsert.push({
              remixTrackId: track.id,
              stemAssetId: donorStem.asset.id,
              timelineStartMs: 0,
              durationMs: Math.min(
                planned.plan.durationMs,
                Math.floor((donorStem.decoded.frames * 1000) / donorStem.decoded.sampleRate),
              ),
              sourceOffsetMs: 0,
              gain: 0.6,
              fadeInMs: 0,
              fadeOutMs: 0,
              tempoSyncEnabled: false,
              keySyncEnabled: false,
              beatSnapEnabled: false,
            });
          }

          const insertedClips = clipsToInsert.length ? await tx.insert(remixClips).values(clipsToInsert).returning() : [];
          const duckedStemIds = new Set([
            ...bedStems.map((stem) => stem.id),
            ...complementary.stems.map((stem) => stem.asset.id),
          ]);
          const automationPoints = mashupDuckAutomationPoints(planned.plan);
          const automationLanes = insertedTracks
            .filter((track) => duckedStemIds.has(track.stemAssetId))
            .map((track) => ({
              remixTrackId: track.id,
              parameter: "volume" as const,
              points: automationPoints,
            }));
          const automationRows = automationLanes.flatMap((lane) => lane.points.map((point) => ({
            remixSessionId: remix.id,
            remixTrackId: lane.remixTrackId,
            parameter: lane.parameter,
            timelineMs: point.timelineMs,
            value: point.value,
          })));
          if (automationRows.length) await tx.insert(remixAutomationPoints).values(automationRows);

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
            tracks: insertedTracks.map((track) => ({
              ...track,
              clips: insertedClips.filter((clip) => clip.remixTrackId === track.id),
            })),
            automation: automationLanes,
          };

          const [version] = await tx.insert(remixVersions).values({
            remixSessionId: remix.id,
            createdById: user.id,
            name: "Initial mashup arrangement",
            snapshot: JSON.stringify(snapshot),
          }).returning();

          return { remix, version };
        });

        return Response.json({
          ok: true,
          remix: result.remix,
          version: result.version,
          warnings: complementary.warnings,
        }, { status: 201 });
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
      const warnings: string[] = [];
      let vocalsPcm: Float32Array;
      const decodedVocalWav = vocalsStem !== null ? await decodeStemAsset(vocalsStem) : null;
      if (decodedVocalWav !== null) {
        vocalsPcm = decodedVocalWav.samples;
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

      const bedResult = await loadInstrumentalBed(projectId, bedId);
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

      // Load only valid non-vocal complements from the selected lead vocal's
      // exact completed separation run. Missing/corrupt optional layers are
      // safely omitted and disclosed instead of silently mixed or overwritten.
      const complementaryDonorStems = new Map<string, Float32Array>();
      if (vocalsStem !== null && decodedVocalWav !== null) {
        const complementary = await loadComplementaryDonorStems(
          projectId,
          vocalsId,
          vocalsStem,
          decodedVocalWav.frames,
        );
        warnings.push(...complementary.warnings);
        for (const donorStem of complementary.stems) {
          complementaryDonorStems.set(`donor_${donorStem.asset.stemType}`, donorStem.decoded.samples);
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
