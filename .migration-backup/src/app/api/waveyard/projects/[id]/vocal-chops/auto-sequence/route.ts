/**
 * Auto-sequence the project's vocal chops — the soul chef (vision: "the
 * samples are automatically chopped and screwed and sequenced").
 *
 * POST /api/waveyard/projects/[id]/vocal-chops/auto-sequence
 *   body: { seed?, bars?, style? }
 *   → a deterministic, grid-locked, in-key chop pattern (chop-stamped note
 *     ids — directly renderable) + a per-bar rationale. Nothing is
 *     persisted: the pattern is a PROPOSAL the user can resequence, clean
 *     up, render, or throw away. Their ears are the authority.
 */

import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";

import { db } from "@/db";
import { sourceAnalyses, vocalChops } from "@/db/waveyardSchema";
import { requireProjectRole, requireUser } from "@/lib/waveyard/local-context";
import { sequenceChopPattern, SOUL_CHEF_ENGINE, type SoulChefStyle } from "@/lib/waveyard/studio/soul-chef";
import { isUuid } from "@/lib/api/ids";

export const dynamic = "force-dynamic";

const STYLES: SoulChefStyle[] = ["chipmunk", "screwed", "chopped"];

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id: projectId } = await params;
    if (!isUuid(projectId)) return NextResponse.json({ error: "Invalid id parameter." }, { status: 400 });
    await requireProjectRole(user.id, projectId, "editor");

    const body = (await request.json().catch(() => ({}))) as { seed?: unknown; bars?: unknown; style?: unknown };
    const chops = await db
      .select({ id: vocalChops.id, rootMidi: vocalChops.rootMidi, sourceAssetId: vocalChops.sourceAssetId })
      .from(vocalChops)
      .where(eq(vocalChops.projectId, projectId))
      .orderBy(desc(vocalChops.confidence));
    if (chops.length === 0) {
      return NextResponse.json(
        { error: "No vocal chops in this project yet — scan the vocal stem first." },
        { status: 409 },
      );
    }

    // The chops' own source carries the tempo/key the pattern must obey.
    const [analysis] = await db
      .select({ bpm: sourceAnalyses.bpm, musicalKey: sourceAnalyses.musicalKey })
      .from(sourceAnalyses)
      .where(eq(sourceAnalyses.sourceAssetId, chops[0].sourceAssetId))
      .limit(1);
    if (analysis?.bpm == null || analysis.bpm <= 0) {
      return NextResponse.json(
        { error: "The vocal source's tempo analysis is not complete — the chef needs the real grid." },
        { status: 422 },
      );
    }

    const seed = typeof body.seed === "number" && Number.isFinite(body.seed) ? Math.abs(Math.round(body.seed)) % 2_147_483_647 : 1;
    const bars = typeof body.bars === "number" && Number.isFinite(body.bars) ? Math.round(body.bars) : 4;
    const style = typeof body.style === "string" && (STYLES as string[]).includes(body.style) ? (body.style as SoulChefStyle) : "chopped";

    const { notes, rationale } = sequenceChopPattern(
      chops.map((chop) => ({ id: chop.id, rootMidi: chop.rootMidi })),
      { bpm: analysis.bpm, musicalKey: analysis.musicalKey ?? null },
      { seed, bars, style },
    );

    return NextResponse.json(
      {
        notes,
        rationale,
        engine: SOUL_CHEF_ENGINE,
        context: { bpm: analysis.bpm, musicalKey: analysis.musicalKey ?? null, style, seed, bars },
      },
      { status: 200 },
    );
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("chop auto-sequence failed", error);
    return NextResponse.json({ error: "The pattern could not be sequenced." }, { status: 500 });
  }
}
