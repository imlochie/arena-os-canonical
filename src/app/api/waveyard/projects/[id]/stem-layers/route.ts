/**
 * Stem layers — RECURSIVE separation (vision: "separate layers of the
 * melody... a flute or extra noise I want to grab or remove" — which
 * stem.fm cannot do).
 *
 * POST /api/waveyard/projects/[id]/stem-layers
 *   body: { stemAssetId, target }
 *   → enqueues a second separation pass whose INPUT is that stem's audio;
 *   the child stems land as "<parent>/<child>" layers (e.g. "other/vocals"
 *   = backing vocals pulled out of the melody) and appear as new lanes in
 *   the stem player. One in-flight layer job per (stem, target) — a repeat
 *   request while queued is an honest 409.
 *
 * Honest capability note: the second pass extracts the registry's trained
 * categories (vocals/drums/bass) out of ANY stem — it is not a "flute
 * detector". Grabbing a specific pitched instrument is the chop scanner's
 * job (pitch-agnostic, works on any tonal layer).
 */

import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import { processingJobs, stemAssets } from "@/db/waveyardSchema";
import { requireProjectRole, requireUser } from "@/lib/waveyard/local-context";
import { enqueueSeparation } from "@/lib/waveyard/queue";
import { findMdxModel, findSeparationRecipe } from "@/lib/waveyard/separation/mdx";
import { isUuid } from "@/lib/api/ids";

export const dynamic = "force-dynamic";

/** What the UI offers as second-pass targets (label → registry id). */
const LAYER_TARGETS = [
  { id: "kim_vocal_2", label: "Backing vocals", blurb: "pull any vocal content out of this stem — backing vocals, ad-libs, buried harmonies" },
  { id: "kuielab_b_drums", label: "Drums residue", blurb: "pull percussion leakage out of this stem" },
  { id: "kuielab_b_bass", label: "Bass residue", blurb: "pull low-end leakage out of this stem" },
  { id: "stems_4", label: "4-way layers", blurb: "split this stem four ways: vocals, drums, bass, other" },
] as const;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id: projectId } = await params;
    if (!isUuid(projectId)) return NextResponse.json({ error: "Invalid id parameter." }, { status: 400 });
    await requireProjectRole(user.id, projectId, "editor");

    const body = (await request.json().catch(() => ({}))) as { stemAssetId?: unknown; target?: unknown };
    const stemAssetId = typeof body.stemAssetId === "string" ? body.stemAssetId : "";
    const target = typeof body.target === "string" ? body.target : "";
    if (!isUuid(stemAssetId)) return NextResponse.json({ error: "Pick a stem to separate into layers." }, { status: 400 });
    const known = LAYER_TARGETS.find((option) => option.id === target);
    if (known === undefined || (findMdxModel(target) === undefined && findSeparationRecipe(target) === undefined)) {
      return NextResponse.json({ error: "Unknown layer target." }, { status: 400 });
    }

    const [stem] = await db
      .select()
      .from(stemAssets)
      .where(and(eq(stemAssets.id, stemAssetId), eq(stemAssets.projectId, projectId)))
      .limit(1);
    if (!stem) return NextResponse.json({ error: "That stem is not in this project." }, { status: 404 });
    // Layering a layer ("other/vocals") is legal but rarely what anyone
    // wants by accident — refuse one level deep to keep names sane.
    if (stem.stemType.includes("/")) {
      return NextResponse.json(
        { error: "This stem is already a layer — separate the parent stem instead." },
        { status: 422 },
      );
    }

    const idempotencyKey = `separation-layer:${stemAssetId}:${target}`;
    const [job] = await db
      .insert(processingJobs)
      .values({
        projectId,
        sourceAssetId: stem.sourceAssetId,
        type: "separation",
        status: "queued",
        stage: "queued",
        idempotencyKey,
        model: target,
        requestedDevice: "auto",
        metadata: JSON.stringify({ kind: "stem-layer", parentStemAssetId: stem.id, parentStemType: stem.stemType, targetLabel: known.label }),
      })
      .onConflictDoNothing({ target: processingJobs.idempotencyKey })
      .returning();
    if (job === undefined) {
      return NextResponse.json({ error: "These layers are already separating — they will appear as new lanes when done." }, { status: 409 });
    }

    try {
      await enqueueSeparation({
        processingJobId: job.id,
        projectId,
        sourceAssetId: stem.sourceAssetId,
        model: target,
        requestedDevice: "auto",
        parentStemAssetId: stem.id,
      });
    } catch {
      // The durable job stays queued; the local worker's requeue sweep
      // picks it up (same contract as first-pass separation).
    }

    return NextResponse.json(
      { job: { id: job.id }, layering: { stemType: stem.stemType, target: known.label } },
      { status: 202 },
    );
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("stem layer request failed", error);
    return NextResponse.json({ error: "The layer separation could not be started." }, { status: 500 });
  }
}
