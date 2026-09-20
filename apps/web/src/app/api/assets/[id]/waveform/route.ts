import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { validateWaveform } from "@waveyard/audio";
import { getDb, sourceAssets, stemAssets, waveformAssets } from "@waveyard/database";
import type { WaveformDocument } from "@waveyard/types";
import { getStorage } from "@waveyard/storage";
import { requireUser } from "@/lib/auth";
import { requireProjectRole } from "@/lib/permissions";

export const runtime = "nodejs";
const MAX_WAVEFORM_BYTES = 2_000_000;

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const db = getDb();
    const [stem] = await db.select().from(stemAssets).where(eq(stemAssets.id, id)).limit(1);
    const [source] = stem ? [undefined] : await db.select().from(sourceAssets).where(eq(sourceAssets.id, id)).limit(1);
    const asset = stem ?? source;
    if (!asset) return NextResponse.json({ error: "Audio asset not found." }, { status: 404 });
    await requireProjectRole(user.id, asset.projectId, "viewer");
    const [waveform] = stem
      ? await db.select().from(waveformAssets).where(eq(waveformAssets.stemAssetId, stem.id)).limit(1)
      : await db.select().from(waveformAssets).where(eq(waveformAssets.sourceAssetId, source!.id)).limit(1);
    if (!waveform) return NextResponse.json({ error: "Waveform is not available for this asset yet." }, { status: 404 });
    const document = JSON.parse((await getStorage().getBuffer(waveform.storageKey, MAX_WAVEFORM_BYTES)).toString("utf8")) as WaveformDocument;
    validateWaveform(document);
    return NextResponse.json({ waveform: document, format: waveform.format, checksumSha256: waveform.checksumSha256 }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("waveform delivery failed", error);
    return NextResponse.json({ error: "Waveform data could not be read." }, { status: 500 });
  }
}
