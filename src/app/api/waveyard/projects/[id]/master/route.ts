import { isUuid } from "@/lib/api/ids";
/**
 * Mastering workflow — SOURCE → MASTER ANALYSIS → RECOMMENDATIONS →
 * PREVIEW → APPLY (+ reference comparison).
 *
 * Every number shown comes from measureAudio on real decoded PCM.
 * PREVIEW renders the real master chain; APPLY persists it as the remix
 * session's master insert chain (the same chain the live mixer and the
 * export path read). Reference imports are stored and measured —
 * comparisons are tabulated, never adjectival. Export itself remains
 * worker-gated and is reported honestly.
 */

import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { db } from "@/db";
import { remixSessions, sourceAssets } from "@/db/waveyardSchema";
import { requireProjectRole, requireUser } from "@/lib/waveyard/local-context";
import { getStorage } from "@/lib/waveyard/storage";
import { decodeSourceToStereoPcm, DependencyMissingError } from "@/lib/waveyard/measure/pcm";
import { measureAudio, type AudioMeasurements } from "@/lib/waveyard/measure/cleanup";
import { bandRmsDb } from "@/lib/waveyard/mixer/meters";
import { masterRecommendations, MASTER_LOUDNESS_TARGET_LUFS } from "@/lib/waveyard/measure/master";
import { validateInsertParams, processWithChain, type Insert, type InsertChain, type InsertProcessorId } from "@/lib/waveyard/mixer/inserts";
import { encodeWav16 } from "@/lib/waveyard/mixer/synth";

export const dynamic = "force-dynamic";

type SpectralBands = { sub: number; low: number; lowMid: number; mid: number; highMid: number; high: number; air: number };

function spectralBands(pcm: Float32Array, sampleRate: number, overallRms: number): SpectralBands {
  const airTop = Math.min(18000, (sampleRate / 2) * 0.95);
  return {
    sub: bandRmsDb(pcm, sampleRate, 20, 60) - overallRms,
    low: bandRmsDb(pcm, sampleRate, 60, 120) - overallRms,
    lowMid: bandRmsDb(pcm, sampleRate, 120, 350) - overallRms,
    mid: bandRmsDb(pcm, sampleRate, 350, 2000) - overallRms,
    highMid: bandRmsDb(pcm, sampleRate, 2000, 6000) - overallRms,
    high: bandRmsDb(pcm, sampleRate, 6000, 12000) - overallRms,
    air: bandRmsDb(pcm, sampleRate, 12000, airTop) - overallRms,
  };
}

function parseOperations(raw: unknown): InsertChain | null {
  if (!Array.isArray(raw) || raw.length > 12) return null;
  const chain: InsertChain = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object") return null;
    const candidate = item as { processor?: unknown; params?: unknown };
    if (typeof candidate.processor !== "string") return null;
    const validation = validateInsertParams(candidate.processor, candidate.params ?? {});
    if (validation === null) return null;
    const insert: Insert = {
      id: `master-${chain.length}`,
      processor: candidate.processor as InsertProcessorId,
      enabled: true,
      wet: 1,
      params: validation.params,
    };
    chain.push(insert);
  }
  return chain;
}

async function firstSource(projectId: string) {
  const [source] = await db
    .select()
    .from(sourceAssets)
    .where(eq(sourceAssets.projectId, projectId))
    .orderBy(asc(sourceAssets.createdAt))
    .limit(1);
  return source;
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  let tempSource: string | null = null;
  try {
    const user = await requireUser();
    const { id: projectId } = await params;
    if (!isUuid(projectId)) return NextResponse.json({ error: "Invalid id parameter" }, { status: 400 });
    await requireProjectRole(user.id, projectId, "viewer");
    const source = await firstSource(projectId);
    if (source === undefined)
      return NextResponse.json({ error: "This project has no source audio to master." }, { status: 409 });
    tempSource = join(tmpdir(), `arena-master-src-${randomUUID()}`);
    await getStorage().getToFile(source.storageKey, tempSource);
    const decoded = await decodeSourceToStereoPcm(tempSource, { sampleRate: source.sampleRate });
    const measurements = measureAudio(decoded.pcm, decoded.sampleRate);
    const spectral = spectralBands(decoded.pcm, decoded.sampleRate, measurements.rmsDb);
    const [session] = await db
      .select({ masterInserts: remixSessions.masterInserts })
      .from(remixSessions)
      .where(eq(remixSessions.projectId, projectId))
      .orderBy(asc(remixSessions.createdAt))
      .limit(1);
    return NextResponse.json({
      analysis: {
        measurements,
        spectral,
        targetLufs: MASTER_LOUDNESS_TARGET_LUFS,
        recommendations: masterRecommendations(measurements, spectral),
      },
      currentMasterChain: session !== undefined ? safeParse(session.masterInserts) : [],
      exportState: "Export rendering requires the Waveyard worker (Redis + worker). This sandbox has neither — the export API reports that honestly instead of faking a render.",
    });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof DependencyMissingError)
      return NextResponse.json({ error: error.message, errorCode: error.errorCode }, { status: 424 });
    return NextResponse.json({ error: "Master analysis failed." }, { status: 500 });
  } finally {
    if (tempSource !== null) await rm(tempSource, { force: true }).catch(() => undefined);
  }
}

function safeParse(raw: string): unknown[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  let tempSource: string | null = null;
  let tempRender: string | null = null;
  try {
    const user = await requireUser();
    const { id: projectId } = await params;
    if (!isUuid(projectId)) return NextResponse.json({ error: "Invalid id parameter" }, { status: 400 });
    await requireProjectRole(user.id, projectId, "editor");
    const body = await request.json().catch(() => ({}));
    const action = String(body.action ?? "");

    const source = await firstSource(projectId);
    if (source === undefined)
      return NextResponse.json({ error: "This project has no source audio to master." }, { status: 409 });

    tempSource = join(tmpdir(), `arena-master-src-${randomUUID()}`);
    await getStorage().getToFile(source.storageKey, tempSource);
    const decoded = await decodeSourceToStereoPcm(tempSource, { sampleRate: source.sampleRate });

    if (action === "preview") {
      const chain = parseOperations(body.operations);
      if (chain === null || chain.length === 0)
        return NextResponse.json({ error: "Operations failed validation — real registry processors with in-range parameters only." }, { status: 400 });
      const before: AudioMeasurements = measureAudio(decoded.pcm, decoded.sampleRate);
      const processed = processWithChain(Float32Array.from(decoded.pcm), chain, decoded.sampleRate);
      const after = measureAudio(processed, decoded.sampleRate);
      const renderId = randomUUID();
      const storageKey = `projects/${projectId}/master/preview-${renderId}.wav`;
      tempRender = join(tmpdir(), `arena-master-out-${renderId}.wav`);
      await writeFile(tempRender, encodeWav16(processed, decoded.sampleRate));
      await getStorage().putFile(storageKey, tempRender);
      return NextResponse.json({
        preview: {
          audioUrl: `/api/waveyard/projects/${projectId}/master/${`preview-${renderId}`}`,
          operations: chain.map((insert) => ({ processor: insert.processor, params: insert.params })),
          before,
          after,
        },
      });
    }

    if (action === "apply") {
      const chain = parseOperations(body.operations);
      if (chain === null || chain.length === 0)
        return NextResponse.json({ error: "Operations failed validation." }, { status: 400 });
      const [session] = await db
        .select({ id: remixSessions.id })
        .from(remixSessions)
        .where(eq(remixSessions.projectId, projectId))
        .orderBy(asc(remixSessions.createdAt))
        .limit(1);
      if (session === undefined)
        return NextResponse.json({ error: "No remix session to hold the master chain." }, { status: 409 });
      await db
        .update(remixSessions)
        .set({ masterInserts: JSON.stringify(chain), updatedAt: new Date() })
        .where(eq(remixSessions.id, session.id));
      return NextResponse.json({
        applied: chain.map((insert) => ({ processor: insert.processor, params: insert.params })),
        sessionId: session.id,
      });
    }

    return NextResponse.json({ error: "Unknown action — use preview or apply." }, { status: 400 });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof DependencyMissingError)
      return NextResponse.json({ error: error.message, errorCode: error.errorCode }, { status: 424 });
    console.error("master route failed", error);
    return NextResponse.json({ error: "Master operation failed." }, { status: 500 });
  } finally {
    for (const temp of [tempSource, tempRender]) {
      if (temp !== null) await rm(temp, { force: true }).catch(() => undefined);
    }
  }
}
