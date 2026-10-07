/**
 * Audio cleanup workflow — SCAN → PREVIEW → APPLY over real PCM.
 *
 * POST /api/waveyard/projects/[id]/cleanup
 *   { action: "scan" }                     → measured findings report
 *   { action: "preview", operations: [...] } → processed preview WAV +
 *                                              before/after measurements
 *   { action: "apply", operations: [...] }   → derived cleanup version
 *                                              (original untouched, undo = delete)
 *
 * Decoding: native 16-bit WAV (no dependency); compressed formats via
 * ffmpeg; if ffmpeg is absent the response is an honest 424
 * DEPENDENCY_MISSING naming the exact gap. Every apply records measured
 * before/after — the proof the repair did something real.
 */

import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { db } from "@/db";
import { cleanupVersions, sourceAssets } from "@/db/waveyardSchema";
import { requireProjectRole, requireUser } from "@/lib/waveyard/local-context";
import { getStorage } from "@/lib/waveyard/storage";
import { scanAudioForProblems, measureAudio, type CleanupReport } from "@/lib/waveyard/measure/cleanup";
import { recommendationsForFindings, type CleanupOperation } from "@/lib/waveyard/measure/recommend";
import type { AudioMeasurements } from "@/lib/waveyard/measure/cleanup";
import {
  validateInsertParams,
  processWithChain,
  type Insert,
  type InsertChain,
  type InsertProcessorId,
} from "@/lib/waveyard/mixer/inserts";
import { decodeSourceToStereoPcm, DependencyMissingError } from "@/lib/waveyard/measure/pcm";
import { encodeWav16 } from "@/lib/waveyard/mixer/synth";

export const dynamic = "force-dynamic";

function parseOperations(raw: unknown): CleanupOperation[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > 24) return null;
  const ops: CleanupOperation[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object") return null;
    const candidate = item as { processor?: unknown; params?: unknown };
    if (typeof candidate.processor !== "string") return null;
    const validation = validateInsertParams(candidate.processor, candidate.params ?? {});
    if (validation === null) return null;
    ops.push({
      processor: candidate.processor,
      params: validation.params,
      addresses: "user-selected",
      reason: typeof (item as { reason?: unknown }).reason === "string" ? String((item as { reason: string }).reason) : "",
    });
  }
  return ops;
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id: projectId } = await params;
    await requireProjectRole(user.id, projectId, "viewer");
    const rows = await db
      .select()
      .from(cleanupVersions)
      .where(eq(cleanupVersions.projectId, projectId))
      .orderBy(asc(cleanupVersions.createdAt));
    return NextResponse.json({
      versions: rows.map((row) => ({
        id: row.id,
        operations: JSON.parse(row.operations),
        audioUrl: `/api/waveyard/projects/${projectId}/cleanup/${row.id}`,
        measurementsBefore: JSON.parse(row.measurementsBefore),
        measurementsAfter: JSON.parse(row.measurementsAfter),
        createdAt: row.createdAt,
      })),
    });
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: "Could not list cleanup versions." }, { status: 500 });
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  let tempSource: string | null = null;
  let tempRender: string | null = null;
  try {
    const user = await requireUser();
    const { id: projectId } = await params;
    await requireProjectRole(user.id, projectId, "editor");
    const body = await request.json().catch(() => ({}));
    const action = String(body.action ?? "");

    const [source] = await db
      .select()
      .from(sourceAssets)
      .where(eq(sourceAssets.projectId, projectId))
      .orderBy(asc(sourceAssets.createdAt))
      .limit(1);
    if (source === undefined)
      return NextResponse.json({ error: "This project has no source audio to clean." }, { status: 409 });

    tempSource = join(tmpdir(), `arena-cleanup-src-${randomUUID()}`);
    await getStorage().getToFile(source.storageKey, tempSource);
    const decoded = await decodeSourceToStereoPcm(tempSource, { sampleRate: source.sampleRate });

    if (action === "scan") {
      const report: CleanupReport = scanAudioForProblems(decoded.pcm, decoded.sampleRate);
      return NextResponse.json({
        report,
        recommendations: recommendationsForFindings(report),
        sourceAssetId: source.id,
      });
    }

    if (action === "preview" || action === "apply") {
      const operations = parseOperations(body.operations);
      if (operations === null)
        return NextResponse.json(
          { error: "Operations failed validation — only real registry processors with in-range parameters are accepted.", errorCode: "INPUT_INVALID" },
          { status: 400 },
        );
      if (operations.length === 0)
        return NextResponse.json({ error: "No operations selected." }, { status: 400 });

      const before: AudioMeasurements = measureAudio(decoded.pcm, decoded.sampleRate);
      const chain: InsertChain = operations.map((operation, index) => {
        const insert: Insert = {
          id: `cleanup-${index}`,
          processor: operation.processor as InsertProcessorId,
          enabled: true,
          wet: 1,
          params: operation.params,
        };
        return insert;
      });
      const processed = processWithChain(Float32Array.from(decoded.pcm), chain, decoded.sampleRate);
      const after: AudioMeasurements = measureAudio(processed, decoded.sampleRate);
      const wav = encodeWav16(processed, decoded.sampleRate);

      const versionId = randomUUID();
      const storageKey = `projects/${projectId}/cleanup/${action === "apply" ? versionId : `preview-${versionId}`}.wav`;
      tempRender = join(tmpdir(), `arena-cleanup-out-${versionId}.wav`);
      await writeFile(tempRender, wav);
      await getStorage().putFile(storageKey, tempRender);

      if (action === "preview") {
        return NextResponse.json({
          preview: {
            audioUrl: `/api/waveyard/projects/${projectId}/cleanup/preview-${versionId}`,
            operations,
            before,
            after,
          },
        });
      }

      const [row] = await db
        .insert(cleanupVersions)
        .values({
          id: versionId,
          projectId,
          sourceAssetId: source.id,
          operations: JSON.stringify(operations),
          storageKey,
          measurementsBefore: JSON.stringify(before),
          measurementsAfter: JSON.stringify(after),
        })
        .returning();
      return NextResponse.json(
        {
          version: {
            id: row.id,
            operations,
            audioUrl: `/api/waveyard/projects/${projectId}/cleanup/${row.id}`,
            measurementsBefore: before,
            measurementsAfter: after,
            createdAt: row.createdAt,
          },
        },
        { status: 201 },
      );
    }

    return NextResponse.json({ error: "Unknown action — use scan, preview, or apply." }, { status: 400 });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof DependencyMissingError)
      return NextResponse.json(
        { error: error.message, errorCode: error.errorCode },
        { status: 424 },
      );
    console.error("cleanup failed", error);
    return NextResponse.json({ error: "Cleanup failed." }, { status: 500 });
  } finally {
    for (const temp of [tempSource, tempRender]) {
      if (temp !== null) await rm(temp, { force: true }).catch(() => undefined);
    }
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id: projectId } = await params;
    await requireProjectRole(user.id, projectId, "editor");
    const versionId = new URL(request.url).searchParams.get("versionId") ?? "";
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(versionId))
      return NextResponse.json({ error: "Invalid version id." }, { status: 400 });
    const deleted = await db
      .delete(cleanupVersions)
      .where(eq(cleanupVersions.id, versionId))
      .returning({ id: cleanupVersions.id, storageKey: cleanupVersions.storageKey });
    if (deleted.length === 0)
      return NextResponse.json({ error: "Version not found." }, { status: 404 });
    await getStorage().delete(deleted[0].storageKey).catch(() => undefined);
    return NextResponse.json({ deleted: deleted[0].id }, { status: 200 });
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: "Could not revert the cleanup version." }, { status: 500 });
  }
}
