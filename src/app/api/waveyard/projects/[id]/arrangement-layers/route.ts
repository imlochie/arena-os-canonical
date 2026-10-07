import { isUuid } from "@/lib/api/ids";
/**
 * Arrangement layer generation + durable listing — prompt → real composed
 * and rendered audio, PERSISTED as project metadata.
 *
 * POST /api/waveyard/projects/[id]/arrangement-layers
 *   body: { prompt: string } | { instruction: ArrangementInstruction }
 *   → composes from authoritative analysis, renders real PCM, stores the
 *     WAV, and persists the full layer metadata (prompt, instruction,
 *     events, notes, provenance) in arrangement_layers. Temp files are
 *   removed on every path (finally). Layers survive reload/restart.
 *
 * GET  → durable layer list for the project (survives page reload,
 *   browser restart, server restart, project reopen).
 *
 * The source is never touched; layers are derived artifacts.
 */

import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { db } from "@/db";
import {
  arrangementLayers,
  sourceAnalyses,
  sourceAssets,
  sourceSections,
} from "@/db/waveyardSchema";
import { requireProjectRole, requireUser } from "@/lib/waveyard/local-context";
import { getStorage } from "@/lib/waveyard/storage";
import {
  composeArrangementLayer,
  validateArrangementInstruction,
  type ArrangementInstruction,
  type ComposerEvidence,
  type ComposerSection,
} from "@/lib/waveyard/arrangement/composer";
import { parsePromptToInstruction } from "@/lib/waveyard/arrangement/prompt";
import { renderNotes, encodeWav16 } from "@/lib/waveyard/mixer/synth";

export const dynamic = "force-dynamic";

const MAX_PROMPT_CHARS = 400;
const RENDER_SAMPLE_RATE = 44_100;

function parsedBeatGrid(value: string | null): number[] | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return null;
    const beats = parsed
      .filter((beat): beat is number => Number.isSafeInteger(beat) && beat >= 0)
      .sort((left: number, right: number) => left - right);
    return beats.length >= 4 ? beats : null;
  } catch {
    return null;
  }
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id: projectId } = await params;
    if (!isUuid(projectId)) return NextResponse.json({ error: "Invalid id parameter" }, { status: 400 });
    await requireProjectRole(user.id, projectId, "viewer");
    const rows = await db
      .select()
      .from(arrangementLayers)
      .where(eq(arrangementLayers.projectId, projectId))
      .orderBy(asc(arrangementLayers.createdAt));
    return NextResponse.json({ layers: rows.map(layerRowToResponse) }, { status: 200 });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("arrangement layer listing failed", error);
    return NextResponse.json({ error: "Could not list arrangement layers." }, { status: 500 });
  }
}

/** Pure row → API shape (unit-tested). */
export function layerRowToResponse(row: typeof arrangementLayers.$inferSelect) {
  return {
    id: row.id,
    instrument: row.instrument,
    mood: row.mood,
    density: row.density,
    register: row.registerKind,
    targetSections: JSON.parse(row.targetSections) as "all" | number[],
    level: row.level,
    seed: row.seed,
    originalPrompt: row.originalPrompt,
    events: JSON.parse(row.events),
    notes: JSON.parse(row.notes),
    storageKey: row.storageKey,
    renderer: row.renderer,
    sampleRate: row.sampleRate,
    durationSeconds: row.durationSeconds,
    provenance: JSON.parse(row.provenance),
    createdAt: row.createdAt,
    audioUrl: `/api/waveyard/projects/${row.projectId}/arrangement-layers/${row.id}`,
  };
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  let tempPath: string | null = null;
  try {
    const user = await requireUser();
    const { id: projectId } = await params;
    if (!isUuid(projectId)) return NextResponse.json({ error: "Invalid id parameter" }, { status: 400 });
    await requireProjectRole(user.id, projectId, "editor");

    const body = await request.json().catch(() => ({}));

    // --- Gather authoritative evidence ------------------------------------
    const [source] = await db
      .select({ asset: sourceAssets, analysis: sourceAnalyses })
      .from(sourceAssets)
      .leftJoin(sourceAnalyses, eq(sourceAnalyses.sourceAssetId, sourceAssets.id))
      .where(eq(sourceAssets.projectId, projectId))
      .orderBy(asc(sourceAssets.createdAt))
      .limit(1);

    if (source === undefined)
      return NextResponse.json(
        { error: "This project has no source audio to arrange against." },
        { status: 409 },
      );
    if (source.analysis?.status !== "complete" || !source.analysis.bpm || !source.analysis.musicalKey)
      return NextResponse.json(
        {
          error:
            "Source analysis (tempo + key) is not complete yet — the composer only writes against real analysis. Try again once analysis finishes.",
          errorCode: "ANALYSIS_MISSING",
        },
        { status: 409 },
      );

    const beatGridMs = parsedBeatGrid(source.analysis.beatGrid);
    if (beatGridMs === null)
      return NextResponse.json(
        { error: "No usable beat grid in the analysis — placement cannot be quantized honestly.", errorCode: "ANALYSIS_MISSING" },
        { status: 409 },
      );

    const sectionRows = await db
      .select()
      .from(sourceSections)
      .where(eq(sourceSections.sourceAssetId, source.asset.id))
      .orderBy(asc(sourceSections.startMs));
    if (sectionRows.length === 0)
      return NextResponse.json(
        { error: "No section analysis available — placement cannot be scoped honestly.", errorCode: "ANALYSIS_MISSING" },
        { status: 409 },
      );

    const sections: ComposerSection[] = sectionRows.map((row) => ({
      sectionIndex: row.sectionIndex,
      startMs: row.startMs,
      endMs: row.endMs,
      startBeatIndex: row.startBeatIndex,
      endBeatIndex: row.endBeatIndex,
    }));

    const evidence: ComposerEvidence = {
      musicalKey: source.analysis.musicalKey,
      bpm: source.analysis.bpm,
      beatGridMs,
      sections,
    };

    // --- Instruction: explicit or from prompt ------------------------------
    let instruction: ArrangementInstruction | null = null;
    let interpretation: string[] = [];
    let originalPrompt = "";
    if (body.instruction !== undefined) {
      instruction = validateArrangementInstruction(body.instruction);
      if (instruction === null)
        return NextResponse.json(
          { error: "Instruction failed contract validation.", errorCode: "INPUT_INVALID" },
          { status: 400 },
        );
      interpretation = ["Instruction provided directly (validated against the contract)."];
    } else {
      const prompt = typeof body.prompt === "string" ? body.prompt.trim().slice(0, MAX_PROMPT_CHARS) : "";
      if (prompt.length === 0)
        return NextResponse.json(
          { error: "Provide a prompt or an instruction.", errorCode: "INPUT_INVALID" },
          { status: 400 },
        );
      originalPrompt = prompt;
      const parsed = parsePromptToInstruction(prompt, { sectionCount: sections.length });
      instruction = parsed.instruction;
      interpretation = parsed.interpretation;
    }

    // --- Compose + render ---------------------------------------------------
    let layer;
    try {
      layer = composeArrangementLayer(instruction, evidence);
    } catch (error) {
      return NextResponse.json(
        {
          error: error instanceof Error ? error.message : "Composition failed.",
          errorCode: "ANALYSIS_INCOMPATIBLE",
        },
        { status: 422 },
      );
    }

    const durationSeconds = Math.max(1, (sections[sections.length - 1].endMs ?? 0) / 1000 + 1);
    const pcm = renderNotes(layer.events, layer.instrument, RENDER_SAMPLE_RATE, durationSeconds);
    const wav = encodeWav16(pcm, RENDER_SAMPLE_RATE);
    const layerId = randomUUID();
    const storageKey = `projects/${projectId}/generated/${layerId}.wav`;

    // Temp file is always removed in the finally block below — success,
    // storage failure, render failure, or any thrown exception.
    tempPath = join(tmpdir(), `arena-layer-${layerId}.wav`);
    await writeFile(tempPath, wav);
    await getStorage().putFile(storageKey, tempPath);

    // --- Persist durable metadata -------------------------------------------
    const [row] = await db
      .insert(arrangementLayers)
      .values({
        id: layerId,
        projectId,
        sourceAssetId: source.asset.id,
        sourceChecksumSha256: source.asset.checksumSha256,
        originalPrompt,
        instruction: JSON.stringify(instruction),
        instrument: layer.instrument,
        mood: instruction.mood,
        density: instruction.density,
        registerKind: instruction.register,
        targetSections: JSON.stringify(instruction.targetSections),
        level: instruction.level,
        seed: instruction.seed,
        events: JSON.stringify(layer.events),
        notes: JSON.stringify({ realization: layer.realizationNotes, interpretation }),
        storageKey,
        renderer: "waveyard-synth-v1",
        sampleRate: RENDER_SAMPLE_RATE,
        durationSeconds,
        provenance: JSON.stringify({
          kind: "generated-arrangement-layer",
          sourceAssetId: source.asset.id,
          sourceChecksumSha256: source.asset.checksumSha256,
          engine: "waveyard-composer-v1",
          renderer: "waveyard-synth-v1",
          requestedBy: user.id,
        }),
      })
      .returning();

    return NextResponse.json({ layer: layerRowToResponse(row) }, { status: 201 });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("arrangement layer generation failed", error);
    return NextResponse.json({ error: "Could not generate the arrangement layer." }, { status: 500 });
  } finally {
    if (tempPath !== null) {
      await rm(tempPath, { force: true }).catch(() => undefined);
    }
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id: projectId } = await params;
    if (!isUuid(projectId)) return NextResponse.json({ error: "Invalid id parameter" }, { status: 400 });
    await requireProjectRole(user.id, projectId, "editor");
    const url = new URL(request.url);
    const layerId = url.searchParams.get("layerId") ?? "";
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(layerId))
      return NextResponse.json({ error: "Invalid layer id." }, { status: 400 });
    const deleted = await db
      .delete(arrangementLayers)
      .where(eq(arrangementLayers.id, layerId))
      .returning({ id: arrangementLayers.id, storageKey: arrangementLayers.storageKey });
    if (deleted.length === 0)
      return NextResponse.json({ error: "Layer not found." }, { status: 404 });
    // Remove the derived WAV too; the source asset is never touched.
    await getStorage().delete(deleted[0].storageKey).catch(() => undefined);
    return NextResponse.json({ deleted: deleted[0].id }, { status: 200 });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("arrangement layer deletion failed", error);
    return NextResponse.json({ error: "Could not delete the layer." }, { status: 500 });
  }
}
