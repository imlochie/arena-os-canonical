/**
 * Chop pattern rendering — the chipmunk-soul beat maker (vision §V4).
 *
 * POST /api/waveyard/projects/[id]/vocal-chops/render
 *   body: { events: PianoNote[] }  — piano-roll notes whose ids are
 *   chop-stamped ("<chopId>:<suffix>", see vocal-chops.ts). Each note plays
 *   its chop resampled to the note's pitch: up = faster + brighter (the
 *   chipmunk effect), down = slower + darker. Drawn length cuts the chop;
 *   velocity scales it.
 *
 *   → audio/wav response (real PCM render, deterministic from the request —
 *   stateless by design; nothing is persisted, the client keeps the blob).
 *
 * Honest limits: ≤128 notes, ≤16 distinct chops, ≤300 s of audio.
 */

import { NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";

import { db } from "@/db";
import { vocalChops } from "@/db/waveyardSchema";
import { requireProjectRole, requireUser } from "@/lib/waveyard/local-context";
import { getStorage } from "@/lib/waveyard/storage";
import { decodeWav16, encodeWav16 } from "@/lib/waveyard/mixer/synth";
import {
  CHOP_RENDER_ENGINE,
  chopSampleFromDecoded,
  parseChopNoteId,
  renderChopPattern,
  type ChopPatternEvent,
  type ChopSample,
} from "@/lib/waveyard/studio/vocal-chops";
import { validatePianoNotes } from "@/lib/waveyard/studio/piano-roll";
import { isUuid } from "@/lib/api/ids";

export const dynamic = "force-dynamic";

const RENDER_SAMPLE_RATE = 44_100;
const MAX_EVENTS = 128;
const MAX_DISTINCT_CHOPS = 16;
const MAX_DURATION_SECONDS = 300;
const MAX_WAV_BYTES = 16 * 1024 * 1024;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id: projectId } = await params;
    if (!isUuid(projectId)) return NextResponse.json({ error: "Invalid id parameter." }, { status: 400 });
    await requireProjectRole(user.id, projectId, "editor");

    const body = (await request.json().catch(() => ({}))) as { events?: unknown };
    const notes = validatePianoNotes(body.events);
    if (notes === null) {
      return NextResponse.json({ error: "The pattern notes failed validation." }, { status: 400 });
    }
    if (notes.length === 0) return NextResponse.json({ error: "The pattern is empty — draw some notes first." }, { status: 400 });
    if (notes.length > MAX_EVENTS) {
      return NextResponse.json({ error: `Patterns are limited to ${MAX_EVENTS} notes.` }, { status: 413 });
    }

    // Every note must carry its chop in the id.
    const chopIds: string[] = [];
    for (const note of notes) {
      const chopId = parseChopNoteId(note.id);
      if (chopId === null) {
        return NextResponse.json(
          { error: "Every pattern note must be drawn with an armed vocal chop (the note ids carry the chop)." },
          { status: 400 },
        );
      }
      if (!chopIds.includes(chopId)) chopIds.push(chopId);
    }
    if (chopIds.length > MAX_DISTINCT_CHOPS) {
      return NextResponse.json({ error: `Patterns are limited to ${MAX_DISTINCT_CHOPS} different chops.` }, { status: 413 });
    }

    const lastEndMs = notes.reduce((latest, note) => Math.max(latest, note.startMs + note.durationMs), 0);
    const durationSeconds = Math.max(1, Math.ceil(lastEndMs / 1000) + 1);
    if (durationSeconds > MAX_DURATION_SECONDS) {
      return NextResponse.json({ error: `Pattern renders are limited to ${MAX_DURATION_SECONDS} seconds.` }, { status: 413 });
    }

    const rows = await db
      .select({ id: vocalChops.id, storageKey: vocalChops.storageKey, rootMidi: vocalChops.rootMidi })
      .from(vocalChops)
      .where(and(eq(vocalChops.projectId, projectId), inArray(vocalChops.id, chopIds)));
    if (rows.length !== chopIds.length) {
      return NextResponse.json({ error: "The pattern references a vocal chop that no longer exists — rescan and redraw." }, { status: 404 });
    }

    const storage = getStorage();
    const samples = new Map<string, ChopSample>();
    for (const row of rows) {
      const bytes = await storage.getBuffer(row.storageKey, MAX_WAV_BYTES);
      const decoded = decodeWav16(new Uint8Array(bytes));
      if (decoded === null) {
        return NextResponse.json({ error: "A stored vocal chop could not be decoded." }, { status: 500 });
      }
      samples.set(row.id, chopSampleFromDecoded(decoded, row.rootMidi));
    }

    // Map chop ids → dense indices, then render note-by-note.
    const indexById = new Map(chopIds.map((chopId, index) => [chopId, index]));
    const chops = chopIds.map((chopId) => samples.get(chopId)!);
    const events: ChopPatternEvent[] = notes.map((note) => ({
      startMs: note.startMs,
      durationMs: note.durationMs,
      midi: note.midi,
      velocity: note.velocity,
      chopIndex: indexById.get(parseChopNoteId(note.id)!)!,
    }));

    const pcm = renderChopPattern(events, chops, RENDER_SAMPLE_RATE, durationSeconds);
    const wav = encodeWav16(pcm, RENDER_SAMPLE_RATE);
    return new NextResponse(wav as unknown as BodyInit, {
      status: 200,
      headers: {
        "content-type": "audio/wav",
        "cache-control": "no-store",
        "x-renderer": CHOP_RENDER_ENGINE,
      },
    });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("chop pattern render failed", error);
    return NextResponse.json({ error: "The chop pattern could not be rendered." }, { status: 500 });
  }
}
