/**
 * MIDI interchange for an arrangement layer — the piano roll's bridge to
 * FL Studio and every other DAW (vision §V4: "FL Studio opens our SMF
 * natively, and we open FL's exported MIDI").
 *
 * GET  → the layer's notes as a Standard MIDI File (format 0, PPQ 480) at
 *        the project's analysed tempo — FL opens it directly.
 * POST → body is a raw .mid file; parsed server-side with the app's own
 *        SMF reader and returned as editable piano-roll notes. Nothing is
 *        persisted here — the editor adopts the notes and saving goes
 *        through the layer PATCH (one authority for writes).
 */

import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import { arrangementLayers, sourceAnalyses } from "@/db/waveyardSchema";
import { requireProjectRole, requireUser } from "@/lib/waveyard/local-context";
import { buildStandardMidiFile, parseStandardMidiFile } from "@/lib/waveyard/midi-file";
import { fromSynthEvents, newNoteId, toMidiNoteEvents, MIDI_HIGH, MIDI_LOW, VELOCITY_MAX, VELOCITY_MIN, type PianoNote } from "@/lib/waveyard/studio/piano-roll";
import { isUuid } from "@/lib/api/ids";

export const dynamic = "force-dynamic";

const MAX_MIDI_UPLOAD_BYTES = 4 * 1024 * 1024;

async function loadLayer(projectId: string, layerId: string) {
  const [layer] = await db
    .select()
    .from(arrangementLayers)
    .where(and(eq(arrangementLayers.id, layerId), eq(arrangementLayers.projectId, projectId)))
    .limit(1);
  return layer ?? null;
}

/** The project's analysed tempo (layers are composed on this grid). */
async function projectBpm(sourceAssetId: string): Promise<number | null> {
  const [analysis] = await db
    .select({ bpm: sourceAnalyses.bpm })
    .from(sourceAnalyses)
    .where(eq(sourceAnalyses.sourceAssetId, sourceAssetId))
    .limit(1);
  return analysis?.bpm ?? null;
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string; layerId: string }> }) {
  try {
    const user = await requireUser();
    const { id: projectId, layerId } = await params;
    if (!isUuid(projectId) || !isUuid(layerId)) return NextResponse.json({ error: "Invalid id parameter." }, { status: 400 });
    await requireProjectRole(user.id, projectId, "viewer");

    const layer = await loadLayer(projectId, layerId);
    if (!layer) return NextResponse.json({ error: "Arrangement layer not found." }, { status: 404 });

    const bpm = (await projectBpm(layer.sourceAssetId)) ?? 120;
    const notes = fromSynthEvents(JSON.parse(layer.events));
    const bytes = buildStandardMidiFile(toMidiNoteEvents(notes), bpm);
    const filename = `${layer.instrument.replace(/[^a-zA-Z0-9_-]+/g, "-").toLowerCase()}-layer.mid`;
    return new NextResponse(bytes as unknown as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": "audio/midi",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("layer midi export failed", error);
    return NextResponse.json({ error: "The MIDI file could not be exported." }, { status: 500 });
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string; layerId: string }> }) {
  try {
    const user = await requireUser();
    const { id: projectId, layerId } = await params;
    if (!isUuid(projectId) || !isUuid(layerId)) return NextResponse.json({ error: "Invalid id parameter." }, { status: 400 });
    await requireProjectRole(user.id, projectId, "editor");

    const layer = await loadLayer(projectId, layerId);
    if (!layer) return NextResponse.json({ error: "Arrangement layer not found." }, { status: 404 });

    const buffer = await request.arrayBuffer();
    if (buffer.byteLength === 0 || buffer.byteLength > MAX_MIDI_UPLOAD_BYTES) {
      return NextResponse.json({ error: "Attach a .mid file between 1 byte and 4 MB." }, { status: 413 });
    }
    const parsed = parseStandardMidiFile(new Uint8Array(buffer));
    if (parsed === null) {
      return NextResponse.json(
        { error: "This file is not a readable Standard MIDI File (format 0 or 1 with PPQ timing)." },
        { status: 422 },
      );
    }
    if (parsed.notes.length === 0) {
      return NextResponse.json({ error: "This MIDI file contains no notes to import." }, { status: 422 });
    }

    // SMF events (velocity 1–127) become editable piano-roll notes.
    const notes: PianoNote[] = parsed.notes.map((event) => ({
      id: newNoteId(),
      startMs: event.startMs,
      durationMs: event.durationMs,
      midi: Math.max(MIDI_LOW, Math.min(MIDI_HIGH, event.midiNote)),
      velocity: Math.max(VELOCITY_MIN, Math.min(VELOCITY_MAX, event.velocity)),
    }));
    return NextResponse.json({
      notes,
      fileBpm: parsed.tempoChanges[0]?.bpm ?? 120,
      fileTempoChanges: parsed.tempoChanges,
      durationMs: parsed.durationMs,
    });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("layer midi import failed", error);
    return NextResponse.json({ error: "The MIDI file could not be imported." }, { status: 500 });
  }
}
