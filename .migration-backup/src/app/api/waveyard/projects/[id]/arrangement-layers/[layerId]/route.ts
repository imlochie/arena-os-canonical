/**
 * Arrangement layer editing — the piano roll's save path (vision §V4).
 *
 * PATCH /api/waveyard/projects/[id]/arrangement-layers/[layerId]
 *   body: { events: PianoNote[] }
 *   → validates the edited notes strictly (piano-roll.ts), re-renders the
 *     layer's REAL audio with the same instrument + renderer (waveyard-synth-v1),
 *     overwrites the stored WAV, and persists the new events. The layer keeps
 *     its identity, its provenance gains an "edited-in-piano-roll" entry, and
 *     the duration grows if the edit extends past the old end.
 *
 * The rendered audio is the authority: saving always re-renders, so what you
 * hear is exactly what the notes say — no stale WAV can survive an edit.
 */

import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { db } from "@/db";
import { arrangementLayers } from "@/db/waveyardSchema";
import { requireProjectRole, requireUser } from "@/lib/waveyard/local-context";
import { getStorage } from "@/lib/waveyard/storage";
import { encodeWav16, renderNotes, SYNTH_INSTRUMENTS, type SynthInstrument } from "@/lib/waveyard/mixer/synth";
import { planLayerEdit } from "@/lib/waveyard/studio/layer-edit";
import { isUuid } from "@/lib/api/ids";

export const dynamic = "force-dynamic";

const MAX_WAV_BYTES = 64 * 1024 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Serve a generated arrangement layer WAV from project storage. The key is
 *  reconstructed (never taken from the request) so containment is guaranteed
 *  by construction. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; layerId: string }> },
) {
  try {
    const user = await requireUser();
    const { id: projectId, layerId } = await params;
    if (!isUuid(projectId) || !isUuid(layerId)) return NextResponse.json({ error: "Invalid id parameter" }, { status: 400 });
    await requireProjectRole(user.id, projectId, "viewer");
    if (!UUID_RE.test(layerId))
      return NextResponse.json({ error: "Invalid layer id." }, { status: 400 });

    const storageKey = `projects/${projectId}/generated/${layerId}.wav`;
    const storage = getStorage();
    try {
      const buffer = await storage.getBuffer(storageKey, MAX_WAV_BYTES);
      return new NextResponse(new Uint8Array(buffer), {
        status: 200,
        headers: {
          "content-type": "audio/wav",
          "cache-control": "private, max-age=60",
        },
      });
    } catch {
      return NextResponse.json({ error: "Layer not found." }, { status: 404 });
    }
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: "Could not load the layer." }, { status: 500 });
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string; layerId: string }> }) {
  let tempPath: string | null = null;
  try {
    const user = await requireUser();
    const { id: projectId, layerId } = await params;
    if (!isUuid(projectId) || !isUuid(layerId)) return NextResponse.json({ error: "Invalid id parameter." }, { status: 400 });
    await requireProjectRole(user.id, projectId, "editor");

    const body = (await request.json().catch(() => ({}))) as { events?: unknown };
    const [layer] = await db
      .select()
      .from(arrangementLayers)
      .where(and(eq(arrangementLayers.id, layerId), eq(arrangementLayers.projectId, projectId)))
      .limit(1);
    if (!layer) return NextResponse.json({ error: "Arrangement layer not found." }, { status: 404 });

    const plan = planLayerEdit({ durationSeconds: layer.durationSeconds }, body.events);
    if (plan === null) {
      return NextResponse.json(
        { error: "The edited notes failed validation — every note needs a valid time, pitch, and velocity.", errorCode: "INPUT_INVALID" },
        { status: 400 },
      );
    }

    // Re-render: the stored audio always matches the persisted notes.
    if (!(SYNTH_INSTRUMENTS as readonly string[]).includes(layer.instrument)) {
      return NextResponse.json({ error: `This layer's instrument "${layer.instrument}" is not renderable on this machine.` }, { status: 422 });
    }
    const pcm = renderNotes(plan.synthEvents, layer.instrument as SynthInstrument, layer.sampleRate, plan.durationSeconds);
    const wav = encodeWav16(pcm, layer.sampleRate);
    tempPath = join(tmpdir(), `arena-layer-edit-${randomUUID()}.wav`);
    await writeFile(tempPath, wav);
    await getStorage().putFile(layer.storageKey, tempPath, "audio/wav");

    const provenance = JSON.parse(layer.provenance) as Record<string, unknown>;
    const [updated] = await db
      .update(arrangementLayers)
      .set({
        events: JSON.stringify(plan.synthEvents),
        durationSeconds: plan.durationSeconds,
        provenance: JSON.stringify({ ...provenance, editedWith: "piano-roll", editedNoteCount: plan.notes.length }),
      })
      .where(eq(arrangementLayers.id, layer.id))
      .returning();

    return NextResponse.json({
      layer: {
        id: updated.id,
        instrument: updated.instrument,
        events: JSON.parse(updated.events),
        durationSeconds: updated.durationSeconds,
        editedWith: "piano-roll",
      },
    });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("arrangement layer edit failed", error);
    return NextResponse.json({ error: "The layer edit could not be saved." }, { status: 500 });
  } finally {
    if (tempPath !== null) await rm(tempPath, { force: true }).catch(() => undefined);
  }
}
