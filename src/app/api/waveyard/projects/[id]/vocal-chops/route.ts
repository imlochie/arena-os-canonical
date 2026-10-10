/**
 * Vocal chop scanning — the chipmunk-soul sampler's source side (vision §V4).
 *
 * POST /api/waveyard/projects/[id]/vocal-chops
 *   body: {} | { sourceAssetId?: string }
 *   → loads the project's separated VOCAL STEM (that's the Waveyard
 *     advantage: the scan reads a clean vocal, not a full mix), detects the
 *     best singable one-shot notes, stores each as a normalised WAV, and
 *     persists the ranked manifest. A rescan replaces the project's chop
 *     set (one active set; the latest scan wins). 0–12 chops come back.
 *
 * GET  → the project's persisted chop list (survives reload/restart).
 *
 * Honest failure modes: no separated vocal stem yet (409), a vocal stem
 * with no singable notes (422), unreadable stem audio (500).
 */

import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { db } from "@/db";
import { stemAssets, vocalChops } from "@/db/waveyardSchema";
import { requireProjectRole, requireUser } from "@/lib/waveyard/local-context";
import { getStorage, privateObjectKey } from "@/lib/waveyard/storage";
import { decodeWav16, encodeWav16 } from "@/lib/waveyard/mixer/synth";
import { CHOP_SCAN_ENGINE, scanVocalStemForChops } from "@/lib/waveyard/studio/vocal-chops";
import { isUuid } from "@/lib/api/ids";

export const dynamic = "force-dynamic";

const MAX_STEM_BYTES = 64 * 1024 * 1024;
const MAX_CHOPS = 12;
/** Stems the chop scanner accepts (the registry's stem vocabulary). */
const SCAN_STEM_TYPES = ["vocals", "drums", "bass", "other", "instrumental"] as const;

function chopRowToResponse(projectId: string, row: { id: string; startMs: number; durationMs: number; rootMidi: number; cents: number; confidence: number; sampleRate: number; createdAt: Date }) {
  return {
    id: row.id,
    startMs: row.startMs,
    durationMs: row.durationMs,
    rootMidi: row.rootMidi,
    cents: row.cents,
    confidence: row.confidence,
    sampleRate: row.sampleRate,
    createdAt: row.createdAt.toISOString(),
    audioUrl: `/api/waveyard/projects/${projectId}/vocal-chops/${row.id}`,
  };
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id: projectId } = await params;
    if (!isUuid(projectId)) return NextResponse.json({ error: "Invalid id parameter." }, { status: 400 });
    await requireProjectRole(user.id, projectId, "viewer");

    const rows = await db
      .select()
      .from(vocalChops)
      .where(eq(vocalChops.projectId, projectId))
      .orderBy(desc(vocalChops.confidence));
    return NextResponse.json({ chops: rows.map((row) => chopRowToResponse(projectId, row)) }, { status: 200 });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("vocal chop list failed", error);
    return NextResponse.json({ error: "Could not load vocal chops." }, { status: 500 });
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const temporaryDirectory = join(tmpdir(), `arena-chop-scan-${randomUUID()}`);
  try {
    const user = await requireUser();
    const { id: projectId } = await params;
    if (!isUuid(projectId)) return NextResponse.json({ error: "Invalid id parameter." }, { status: 400 });
    await requireProjectRole(user.id, projectId, "editor");

    const body = (await request.json().catch(() => ({}))) as { sourceAssetId?: unknown; stemType?: unknown };
    const stemType = typeof body.stemType === "string" && (SCAN_STEM_TYPES as readonly string[]).includes(body.stemType) ? body.stemType : "vocals";

    // The scan reads a separated stem — vocals by default, but it is
    // pitch-agnostic: it finds the NOTES in any tonal stem (a flute line
    // inside the melody, a bass figure, a lead synth).
    const stemConditions = [eq(stemAssets.projectId, projectId), eq(stemAssets.stemType, stemType)];
    if (typeof body.sourceAssetId === "string" && isUuid(body.sourceAssetId)) {
      stemConditions.push(eq(stemAssets.sourceAssetId, body.sourceAssetId));
    }
    const [stem] = await db
      .select()
      .from(stemAssets)
      .where(and(...stemConditions))
      .orderBy(desc(stemAssets.createdAt))
      .limit(1);
    if (!stem) {
      return NextResponse.json(
        {
          error: `No separated “${stemType}” stem in this project yet — separate a source first, then the scan reads that stem.`,
          errorCode: "STEM_MISSING",
        },
        { status: 409 },
      );
    }

    const stemBytes = await getStorage().getBuffer(stem.storageKey, MAX_STEM_BYTES);
    const decoded = decodeWav16(new Uint8Array(stemBytes));
    if (decoded === null) {
      return NextResponse.json({ error: "The vocal stem could not be decoded as WAV audio." }, { status: 500 });
    }

    const scanned = scanVocalStemForChops(
      { samples: decoded.samples, channels: decoded.channels, sampleRate: decoded.sampleRate },
      { maxChops: MAX_CHOPS },
    );
    if (scanned.length === 0) {
      return NextResponse.json(
        { error: "No singable vocal notes were found in this vocal stem." },
        { status: 422 },
      );
    }

    // One active chop set per project — a rescan replaces the previous set.
    const previous = await db.select({ id: vocalChops.id, storageKey: vocalChops.storageKey }).from(vocalChops).where(eq(vocalChops.projectId, projectId));
    for (const row of previous) await getStorage().delete(row.storageKey).catch(() => undefined);
    if (previous.length > 0) await db.delete(vocalChops).where(eq(vocalChops.projectId, projectId));

    const { mkdir } = await import("node:fs/promises");
    await mkdir(temporaryDirectory, { recursive: true });
    const inserted: Array<typeof vocalChops.$inferSelect> = [];
    for (const chop of scanned) {
      const chopId = randomUUID();
      // Stored as stereo-interleaved (identical channels) — encodeWav16's
      // buffer format, played back everywhere without conversion.
      const stereo = new Float32Array(chop.sample.length * 2);
      for (let i = 0; i < chop.sample.length; i += 1) {
        stereo[i * 2] = chop.sample[i];
        stereo[i * 2 + 1] = chop.sample[i];
      }
      const wav = encodeWav16(stereo, decoded.sampleRate);
      const chopPath = join(temporaryDirectory, `${chopId}.wav`);
      await writeFile(chopPath, wav);
      const storageKey = privateObjectKey(projectId, "chop", "wav");
      await getStorage().putFile(storageKey, chopPath, "audio/wav");

      const [row] = await db
        .insert(vocalChops)
        .values({
          id: chopId,
          projectId,
          sourceAssetId: stem.sourceAssetId,
          stemAssetId: stem.id,
          startMs: chop.detection.startMs,
          durationMs: chop.detection.durationMs,
          rootMidi: chop.detection.rootMidi,
          cents: chop.detection.cents,
          confidence: chop.detection.score,
          detection: JSON.stringify({ ...chop.detection, engine: CHOP_SCAN_ENGINE, stemAssetId: stem.id }),
          storageKey,
          sampleRate: decoded.sampleRate,
        })
        .returning();
      inserted.push(row);
    }

    return NextResponse.json(
      { chops: inserted.map((row) => chopRowToResponse(projectId, row)), scannedCount: inserted.length },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("vocal chop scan failed", error);
    return NextResponse.json({ error: "The vocal chop scan failed." }, { status: 500 });
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}
