/**
 * Arrangement layer generation — prompt → real composed + rendered audio.
 *
 * POST /api/waveyard/projects/[id]/arrangement-layers
 *   body: { prompt: string } | { instruction: ArrangementInstruction }
 *
 * Uses ONLY authoritative analysis evidence (key, tempo, beat grid,
 * sections) for the project's primary source. Composes deterministically,
 * renders real PCM through the synth engine, stores the WAV under the
 * project's storage namespace, and returns note events + interpretation +
 * provenance. The layer is a derived artifact: the source is never
 * touched, and every response says exactly what was placed and why.
 */

import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { db } from "@/db";
import {
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

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id: projectId } = await params;
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

    const storage = getStorage();
    // putBuffer takes string data; WAV bytes go through putFile via a temp
    // write to keep binary exact.
    const { writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tempPath = join(tmpdir(), `arena-layer-${layerId}.wav`);
    await writeFile(tempPath, wav);
    await storage.putFile(storageKey, tempPath);

    return NextResponse.json(
      {
        layer: {
          id: layerId,
          instrument: layer.instrument,
          events: layer.events,
          realizationNotes: layer.realizationNotes,
          interpretation,
          storageKey,
          format: layer.format,
        },
        provenance: {
          kind: "generated-arrangement-layer",
          sourceAssetId: source.asset.id,
          sourceChecksumSha256: source.asset.checksumSha256,
          engine: "waveyard-composer-v1",
          renderer: "waveyard-synth-v1",
          sampleRate: RENDER_SAMPLE_RATE,
          createdAt: new Date().toISOString(),
          requestedBy: user.id,
        },
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("arrangement layer generation failed", error);
    return NextResponse.json({ error: "Could not generate the arrangement layer." }, { status: 500 });
  }
}
