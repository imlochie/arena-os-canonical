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

import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { db } from "@/db";
import { sourceAssets, stemAssets } from "@/db/waveyardSchema";
import { requireProjectRole, requireUser } from "@/lib/waveyard/local-context";
import { getStorage } from "@/lib/waveyard/storage";
import { decodeWav16, encodeWav16 } from "@/lib/waveyard/mixer/synth";
import { decodeSourceToStereoPcm } from "@/lib/waveyard/measure/pcm";
import { loadSourceProfile } from "@/lib/waveyard/studio/mashup-sources";
import { planMashup, planSongExtension, renderMashup, renderSongExtension } from "@/lib/waveyard/studio/mashup";
import { isUuid } from "@/lib/api/ids";

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

/** Latest stem of a type for a source, or null. */
async function latestStem(projectId: string, sourceAssetId: string, stemType: string) {
  const [stem] = await db
    .select({ storageKey: stemAssets.storageKey })
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
  return stem ?? null;
}

/** Decode a stem WAV from storage at the render rate. */
async function stemPcm(storageKey: string): Promise<Float32Array | null> {
  const bytes = await getStorage().getBuffer(storageKey, MAX_STEM_BYTES);
  const decoded = decodeWav16(new Uint8Array(bytes));
  if (decoded === null) return null;
  if (decoded.sampleRate === RENDER_SAMPLE_RATE) return decoded.samples;
  // Stems are rendered at 44.1 kHz; a foreign rate is resampled naively is
  // NOT acceptable — refuse rather than degrade silently.
  return null;
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
    if (!isUuid(projectId)) return NextResponse.json({ error: "Invalid id parameter." }, { status: 400 });
    await requireProjectRole(user.id, projectId, "editor");

    const body = (await request.json().catch(() => ({}))) as MashupBody;
    const action = typeof body.action === "string" ? body.action : "plan";

    if (action === "plan" || action === "render") {
      const vocalsId = typeof body.vocalsSourceId === "string" ? body.vocalsSourceId : "";
      const bedId = typeof body.instrumentalSourceId === "string" ? body.instrumentalSourceId : "";
      if (!isUuid(vocalsId) || !isUuid(bedId)) {
        return NextResponse.json({ error: "Pick both a vocal track and an instrumental track." }, { status: 400 });
      }
      if (vocalsId === bedId) {
        return NextResponse.json({ error: "Pick two different tracks — the mashup needs a vocal source and an instrumental source." }, { status: 400 });
      }

      const [vocals, bed] = await Promise.all([
        loadSourceProfile(projectId, vocalsId, "vocals"),
        loadSourceProfile(projectId, bedId, "instrumental"),
      ]);
      if (vocals === null || bed === null) {
        return NextResponse.json({ error: "One of the tracks is not in this project." }, { status: 404 });
      }

      const planned = planMashup(vocals, bed);
      if (!planned.ok) {
        return NextResponse.json({ error: planned.reason }, { status: 422 });
      }
      if (action === "plan") {
        return NextResponse.json({ plan: planned.plan }, { status: 200 });
      }

      // Render: vocals stem over the bed's instrumental stem (or its original).
      if (planned.plan.durationMs / 1000 > MAX_RENDER_SECONDS) {
        return NextResponse.json({ error: `Renders are limited to ${MAX_RENDER_SECONDS / 60} minutes.` }, { status: 413 });
      }
      await mkdir(tempDir, { recursive: true });
      const vocalsStem = await latestStem(projectId, vocalsId, "vocals");
      const bedStem = await latestStem(projectId, bedId, "instrumental");
      const vocalsPcm = vocalsStem !== null ? await stemPcm(vocalsStem.storageKey) : null;
      const bedPcm = bedStem !== null ? await stemPcm(bedStem.storageKey) : null;
      if (vocalsPcm === null || bedPcm === null) {
        // Fall back to the original files (any codec) through the pcm pipeline.
        const [vocalsFile, bedFile] = await Promise.all([
          vocalsPcm === null ? sourcePcm(projectId, vocalsId, tempDir) : Promise.resolve(null),
          bedPcm === null ? sourcePcm(projectId, bedId, tempDir) : Promise.resolve(null),
        ]);
        if (vocalsPcm === null && vocalsFile === null) {
          return NextResponse.json({ error: "The vocal track's audio could not be decoded." }, { status: 500 });
        }
        if (bedPcm === null && bedFile === null) {
          return NextResponse.json({ error: "The instrumental's audio could not be decoded." }, { status: 500 });
        }
        const mixed = renderMashup(planned.plan, {
          vocals: (vocalsPcm ?? vocalsFile!.pcm) as Float32Array,
          bed: (bedPcm ?? bedFile!.pcm) as Float32Array,
          sampleRate: RENDER_SAMPLE_RATE,
        });
        const wav = encodeWav16(mixed, RENDER_SAMPLE_RATE);
        return wavResponse(wav, "mashup");
      }
      const mixed = renderMashup(planned.plan, { vocals: vocalsPcm, bed: bedPcm, sampleRate: RENDER_SAMPLE_RATE });
      return wavResponse(encodeWav16(mixed, RENDER_SAMPLE_RATE), "mashup");
    }

    if (action === "extend") {
      const sourceAssetId = typeof body.sourceAssetId === "string" ? body.sourceAssetId : "";
      if (!isUuid(sourceAssetId)) {
        return NextResponse.json({ error: "Pick the track to extend." }, { status: 400 });
      }
      const profile = await loadSourceProfile(projectId, sourceAssetId, "instrumental");
      if (profile === null) return NextResponse.json({ error: "That track is not in this project." }, { status: 404 });

      const sectionLabel = typeof body.sectionLabel === "string" && body.sectionLabel.trim().length > 0 ? body.sectionLabel.trim() : undefined;
      const repeats = typeof body.repeats === "number" && Number.isFinite(body.repeats) ? Math.round(body.repeats) : 2;
      const plan = planSongExtension(profile, { sectionLabel, repeats });
      if (plan === null) {
        return NextResponse.json({ error: "This track has no analyzed sections to loop — run analysis first." }, { status: 422 });
      }
      if (plan.durationMs / 1000 > MAX_RENDER_SECONDS) {
        return NextResponse.json({ error: `Renders are limited to ${MAX_RENDER_SECONDS / 60} minutes.` }, { status: 413 });
      }

      await mkdir(tempDir, { recursive: true });
      const decoded = await sourcePcm(projectId, sourceAssetId, tempDir);
      if (decoded === null) return NextResponse.json({ error: "The track's audio could not be decoded." }, { status: 500 });
      const extended = renderSongExtension(plan, decoded.pcm, RENDER_SAMPLE_RATE);
      return wavResponse(encodeWav16(extended, RENDER_SAMPLE_RATE), "extended");
    }

    return NextResponse.json({ error: "Unknown action — use plan, render, or extend." }, { status: 400 });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("mashup route failed", error);
    return NextResponse.json({ error: "The mashup could not be produced." }, { status: 500 });
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function wavResponse(wav: Uint8Array, kind: string): NextResponse {
  return new NextResponse(wav as unknown as BodyInit, {
    status: 200,
    headers: {
      "content-type": "audio/wav",
      "cache-control": "no-store",
      "content-disposition": `attachment; filename="waveyard-${kind}.wav"`,
    },
  });
}
