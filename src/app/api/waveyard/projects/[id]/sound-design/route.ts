/**
 * Sound design — real procedural renders, persisted with provenance.
 *
 * POST /api/waveyard/projects/[id]/sound-design { kind, params } → renders
 * the recipe through the real synth + insert engine, stores the WAV and
 * the recipe JSON. GET lists assets (with mute flags). PATCH toggles mute.
 * DELETE removes (asset + file). Nothing here is AI-generated or faked.
 */

import { NextResponse } from "next/server";
import { and, asc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { db } from "@/db";
import { soundDesignAssets } from "@/db/waveyardSchema";
import { requireProjectRole, requireUser } from "@/lib/waveyard/local-context";
import { getStorage } from "@/lib/waveyard/storage";
import {
  isSoundDesignKind,
  normaliseSoundDesignParams,
  renderRecipe,
  describeRecipe,
} from "@/lib/waveyard/design/sounddesign";

export const dynamic = "force-dynamic";

function rowToResponse(row: typeof soundDesignAssets.$inferSelect, projectId: string) {
  const recipe = JSON.parse(row.recipe);
  return {
    id: row.id,
    kind: row.kind,
    muted: row.muted,
    durationSeconds: row.durationSeconds,
    sampleRate: row.sampleRate,
    audioUrl: `/api/waveyard/projects/${projectId}/sound-design/${row.id}`,
    description: describeRecipe(recipe),
    recipe,
    createdAt: row.createdAt,
  };
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id: projectId } = await params;
    await requireProjectRole(user.id, projectId, "viewer");
    const rows = await db
      .select()
      .from(soundDesignAssets)
      .where(eq(soundDesignAssets.projectId, projectId))
      .orderBy(asc(soundDesignAssets.createdAt));
    return NextResponse.json({ assets: rows.map((row) => rowToResponse(row, projectId)) });
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: "Could not list sound-design assets." }, { status: 500 });
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  let tempRender: string | null = null;
  try {
    const user = await requireUser();
    const { id: projectId } = await params;
    await requireProjectRole(user.id, projectId, "editor");
    const body = await request.json().catch(() => ({}));
    if (!isSoundDesignKind(body.kind))
      return NextResponse.json({ error: "Unknown sound-design kind." }, { status: 400 });
    const normalised = normaliseSoundDesignParams(body.params);
    if (normalised === null)
      return NextResponse.json({ error: "Invalid parameters." }, { status: 400 });

    const rendered = renderRecipe({ kind: body.kind, ...normalised });
    const assetId = randomUUID();
    const storageKey = `projects/${projectId}/sound-design/${assetId}.wav`;
    tempRender = join(tmpdir(), `arena-sd-${assetId}.wav`);
    await writeFile(tempRender, rendered.wav);
    await getStorage().putFile(storageKey, tempRender);

    const [row] = await db
      .insert(soundDesignAssets)
      .values({
        id: assetId,
        projectId,
        kind: body.kind,
        recipe: JSON.stringify(rendered.recipe),
        storageKey,
        durationSeconds: rendered.durationSeconds,
        sampleRate: rendered.sampleRate,
      })
      .returning();
    return NextResponse.json({ asset: rowToResponse(row, projectId) }, { status: 201 });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("sound design failed", error);
    return NextResponse.json({ error: "Sound-design render failed." }, { status: 500 });
  } finally {
    if (tempRender !== null) await rm(tempRender, { force: true }).catch(() => undefined);
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id: projectId } = await params;
    await requireProjectRole(user.id, projectId, "editor");
    const body = await request.json().catch(() => ({}));
    if (typeof body.assetId !== "string" || typeof body.muted !== "boolean")
      return NextResponse.json({ error: "assetId and muted are required." }, { status: 400 });
    const updated = await db
      .update(soundDesignAssets)
      .set({ muted: body.muted })
      .where(and(eq(soundDesignAssets.id, body.assetId), eq(soundDesignAssets.projectId, projectId)))
      .returning();
    if (updated.length === 0)
      return NextResponse.json({ error: "Asset not found." }, { status: 404 });
    return NextResponse.json({ asset: rowToResponse(updated[0], projectId) });
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: "Could not update the asset." }, { status: 500 });
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id: projectId } = await params;
    await requireProjectRole(user.id, projectId, "editor");
    const assetId = new URL(request.url).searchParams.get("assetId") ?? "";
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(assetId))
      return NextResponse.json({ error: "Invalid asset id." }, { status: 400 });
    const deleted = await db
      .delete(soundDesignAssets)
      .where(and(eq(soundDesignAssets.id, assetId), eq(soundDesignAssets.projectId, projectId)))
      .returning({ id: soundDesignAssets.id, storageKey: soundDesignAssets.storageKey });
    if (deleted.length === 0)
      return NextResponse.json({ error: "Asset not found." }, { status: 404 });
    await getStorage().delete(deleted[0].storageKey).catch(() => undefined);
    return NextResponse.json({ deleted: deleted[0].id });
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: "Could not delete the asset." }, { status: 500 });
  }
}
