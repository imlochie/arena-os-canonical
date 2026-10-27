/**
 * Audio-to-MIDI export: serialises a stem's persisted analysis (vocal
 * pitch frames, drum events, or the source's harmony events) into a
 * Standard MIDI File for download. The analysis must already exist — this
 * route never fabricates notes or triggers analysis itself.
 */

import { isUuid } from "@/lib/api/ids";
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  drumAnalyses,
  drumEvents,
  harmonyAnalyses,
  harmonyEvents,
  stemAssets,
  vocalAnalyses,
  vocalPitchFrames,
} from "@/db/waveyardSchema";
import { requireProjectRole, requireUser } from "@/lib/waveyard/local-context";
import { buildStandardMidiFile } from "@/lib/waveyard/midi-file";
import {
  drumEventsToMidiNotes,
  harmonyEventsToMidiNotes,
  vocalFramesToMidiNotes,
  type DrumEvent,
  type HarmonyEvent,
  type MidiNoteEvent,
  type VocalPitchFrame,
} from "@/lib/waveyard/types";

export const dynamic = "force-dynamic";

const KINDS = ["vocal", "drums", "harmony"] as const;
type MidiExportKind = (typeof KINDS)[number];

function parseBpm(raw: string | null): number {
  const parsed = Number(raw);
  return raw !== null && Number.isFinite(parsed) && parsed >= 20 && parsed <= 300 ? parsed : 120;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; audioId: string }> },
) {
  try {
    const user = await requireUser();
    const { id: projectId, audioId } = await params;
    if (!isUuid(projectId) || !isUuid(audioId)) return NextResponse.json({ error: "Invalid id parameter" }, { status: 400 });
    await requireProjectRole(user.id, projectId, "viewer");

    const url = new URL(request.url);
    const kind = (url.searchParams.get("kind") ?? "vocal") as MidiExportKind;
    if (!(KINDS as readonly string[]).includes(kind)) {
      return NextResponse.json({ error: `kind must be one of ${KINDS.join(", ")}.` }, { status: 400 });
    }
    const bpm = parseBpm(url.searchParams.get("bpm"));

    const [stem] = await db
      .select()
      .from(stemAssets)
      .where(and(eq(stemAssets.id, audioId), eq(stemAssets.projectId, projectId)))
      .limit(1);
    if (!stem) return NextResponse.json({ error: "Stem not found." }, { status: 404 });

    let notes: MidiNoteEvent[];
    if (kind === "vocal") {
      const [analysis] = await db.select().from(vocalAnalyses).where(eq(vocalAnalyses.stemAssetId, stem.id)).limit(1);
      if (!analysis) return NextResponse.json({ error: "No vocal analysis for this stem yet. Run vocal analysis first." }, { status: 404 });
      const rows = await db
        .select()
        .from(vocalPitchFrames)
        .where(eq(vocalPitchFrames.vocalAnalysisId, analysis.id))
        .orderBy(vocalPitchFrames.frameIndex);
      const frames: VocalPitchFrame[] = rows.map((row) => ({
        timestampMs: row.timestampMs,
        frequencyHz: row.frequencyHz,
        midiFloat: row.midiFloat,
        nearestMidiNote: row.nearestMidiNote,
        confidence: row.confidence,
        voiced: row.voiced,
      }));
      notes = vocalFramesToMidiNotes(frames);
    } else if (kind === "drums") {
      const [analysis] = await db.select().from(drumAnalyses).where(eq(drumAnalyses.stemAssetId, stem.id)).limit(1);
      if (!analysis) return NextResponse.json({ error: "No drum analysis for this stem yet. Run drum analysis first." }, { status: 404 });
      const rows = await db
        .select()
        .from(drumEvents)
        .where(eq(drumEvents.drumAnalysisId, analysis.id))
        .orderBy(drumEvents.eventIndex);
      const events: DrumEvent[] = rows.map((row) => ({
        timestampMs: row.timestampMs,
        strength: row.strength,
        confidence: row.confidence,
        rhythmicClass: (row.rhythmicClass as DrumEvent["rhythmicClass"]) ?? null,
        nearestBeatIndex: row.nearestBeatIndex,
        beatOffsetMs: row.beatOffsetMs,
      }));
      notes = drumEventsToMidiNotes(events);
    } else {
      const [analysis] = await db
        .select()
        .from(harmonyAnalyses)
        .where(eq(harmonyAnalyses.sourceAssetId, stem.sourceAssetId))
        .limit(1);
      if (!analysis) return NextResponse.json({ error: "No harmony analysis for this source yet. Run harmony analysis first." }, { status: 404 });
      const rows = await db
        .select()
        .from(harmonyEvents)
        .where(eq(harmonyEvents.harmonyAnalysisId, analysis.id))
        .orderBy(harmonyEvents.eventIndex);
      const events: HarmonyEvent[] = rows.map((row) => ({
        startMs: row.startMs,
        endMs: row.endMs,
        root: row.root,
        quality: row.quality as HarmonyEvent["quality"],
        confidence: row.confidence,
      }));
      notes = harmonyEventsToMidiNotes(events);
    }

    const file = buildStandardMidiFile(notes, bpm);
    return new NextResponse(new Uint8Array(file), {
      status: 200,
      headers: {
        "content-type": "audio/midi",
        "content-disposition": `attachment; filename="${stem.stemType}-midi.mid"`,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: "Could not build MIDI export." }, { status: 500 });
  }
}
