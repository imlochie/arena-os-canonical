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
 * Nothing is persisted and no source is touched — the plan is a proposal,
 * the render is stateless. The user's own arrangement stays theirs.
 */


import { and, desc, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { db } from "@workspace/db";
import { processingJobs, remixClips, remixSessions, remixTracks, remixVersions, sourceAnalyses, sourceAssets, stemAssets } from "@workspace/db/waveyardSchema";
import { requireProjectRole, requireUser } from "@workspace/arena/lib/waveyard/local-context";
import { getStorage } from "@workspace/arena/lib/waveyard/storage";
import { decodeWav16, encodeWav16 } from "@workspace/arena/lib/waveyard/mixer/synth";
import { decodeSourceToStereoPcm } from "@workspace/arena/lib/waveyard/measure/pcm";
import { loadSourceProfile } from "@workspace/arena/lib/waveyard/studio/mashup-sources";
import {
  INSTRUMENTAL_BED_STEM_TYPES,
  InstrumentalBedError,
  sumInstrumentalStems,
  type InstrumentalBedStem,
} from "@workspace/arena/lib/waveyard/studio/mashup-bed";
import { analyseStereoPcm, planMashup, planSongExtension, renderMashup, renderSongExtension } from "@workspace/arena/lib/waveyard/studio/mashup";
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
  stems: Array<typeof stemAssets.$inferSelect>;
};

type BedLoadResult =
  | { ok: true; pcm: Float32Array; info: BedSourceInfo }
  | { ok: false; info: BedSourceInfo };

/** Latest stem of a type backed by a completed separation run, or null. */
async function latestStem(projectId: string, sourceAssetId: string, stemType: string) {
  const [stem] = await db
    .select({ id: stemAssets.id, storageKey: stemAssets.storageKey, separationJobId: stemAssets.separationJobId })
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
        const bedSource = await findBedSource(projectId, bedId);
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

      // Load available complementary stems from the donor vocal track (e.g. guitar/keys/other)
      // to enrich breakdown/solo pockets without duplicating bed stems
      const complementaryDonorStems = new Map<string, Float32Array>();
      try {
        const donorStemRows = await db
          .select({ stemType: stemAssets.stemType, storageKey: stemAssets.storageKey })
          .from(stemAssets)
          .where(and(eq(stemAssets.projectId, projectId), eq(stemAssets.sourceAssetId, vocalsId)));

        for (const stemRow of donorStemRows) {
          if (stemRow.stemType !== "vocals") {
            const pcm = await stemPcm(stemRow.storageKey);
            if (pcm) complementaryDonorStems.set(`donor_${stemRow.stemType}`, pcm);
          }
        }
      } catch {
        // Fall back gracefully
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
