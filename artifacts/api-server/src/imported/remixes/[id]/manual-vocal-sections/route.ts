import { isUuid } from "@workspace/arena/lib/api/ids";
import {
  manualVocalSectionSetInputSchema,
  manualVocalSectionSchema,
} from "@workspace/arena/lib/waveyard/types";
import { and, eq } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  manualVocalSectionSets,
  remixSessions,
  sourceAssets,
  stemAssets,
} from "@workspace/db/waveyardSchema";
import { requireProjectRole, requireUser } from "@workspace/arena/lib/waveyard/local-context";

async function getSession(userId: string, remixId: string, minimum: "viewer" | "editor") {
  const [remix] = await db.select().from(remixSessions).where(eq(remixSessions.id, remixId)).limit(1);
  if (!remix) throw new Response("Remix session not found.", { status: 404 });
  await requireProjectRole(userId, remix.projectId, minimum);
  return remix;
}

async function getVocalSource(projectId: string, sourceAssetId: string, stemAssetId: string) {
  const [[source], [stem]] = await Promise.all([
    db.select().from(sourceAssets)
      .where(and(eq(sourceAssets.id, sourceAssetId), eq(sourceAssets.projectId, projectId))).limit(1),
    db.select().from(stemAssets)
      .where(and(eq(stemAssets.id, stemAssetId), eq(stemAssets.projectId, projectId))).limit(1),
  ]);
  if (!source || !stem || stem.sourceAssetId !== source.id || stem.stemType !== "vocals")
    throw new Response("Manual sections require the current vocal stem for this source in the remix project.", { status: 422 });
  return { source, stem };
}

function storedSections(value: unknown) {
  if (!Array.isArray(value)) throw new Response("Saved vocal-section data is invalid; it was not changed.", { status: 500 });
  const parsed = value.map((section) => manualVocalSectionSchema.safeParse(section));
  if (parsed.some((section) => !section.success))
    throw new Response("Saved vocal-section data is invalid; it was not changed.", { status: 500 });
  return parsed.map((section) => section.data!);
}

function currentChecksums(row: typeof manualVocalSectionSets.$inferSelect, source: { checksumSha256: string }, stem: { checksumSha256: string | null }) {
  return row.sourceChecksumSha256 === source.checksumSha256
    && row.stemChecksumSha256 === (stem.checksumSha256 ?? "");
}

/** Read human-marked vocal regions stored with one private Studio session. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string; sourceAssetId: string; stemAssetId: string }> }) {
  try {
    const user = await requireUser();
    const { id, sourceAssetId, stemAssetId } = await params;
    if (!isUuid(id) || !isUuid(sourceAssetId) || !isUuid(stemAssetId)) return Response.json({ error: "Invalid id parameter." }, { status: 400 });
    const remix = await getSession(user.id, id, "viewer");
    const { source, stem } = await getVocalSource(remix.projectId, sourceAssetId, stemAssetId);
    const [row] = await db.select().from(manualVocalSectionSets).where(and(
      eq(manualVocalSectionSets.remixSessionId, remix.id),
      eq(manualVocalSectionSets.stemAssetId, stem.id),
    )).limit(1);
    if (!row) return Response.json({ revision: 0, sections: [], stale: false });
    const stale = row.sourceAssetId !== source.id || !currentChecksums(row, source, stem);
    return Response.json({
      revision: row.revision,
      sections: storedSections(row.sections),
      stale,
      sourceChecksumSha256: row.sourceChecksumSha256,
      stemChecksumSha256: row.stemChecksumSha256,
    });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("manual vocal-section read failed", error);
    return Response.json({ error: "Could not load the session's vocal sections." }, { status: 500 });
  }
}

/** Replace a session's annotations atomically; revision checks prevent lost edits across devices. */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string; sourceAssetId: string; stemAssetId: string }> }) {
  try {
    const user = await requireUser();
    const { id, sourceAssetId, stemAssetId } = await params;
    if (!isUuid(id) || !isUuid(sourceAssetId) || !isUuid(stemAssetId)) return Response.json({ error: "Invalid id parameter." }, { status: 400 });
    const remix = await getSession(user.id, id, "editor");
    const raw = await request.json().catch(() => null);
    const input = manualVocalSectionSetInputSchema.safeParse(raw);
    if (!input.success)
      return Response.json({ error: "Vocal sections must have unique IDs, valid labels, and increasing source times." }, { status: 400 });
    const { expectedRevision, confirmCurrentAudio, sections } = input.data;
    const { source, stem } = await getVocalSource(remix.projectId, sourceAssetId, stemAssetId);
    const durationMs = Math.round(stem.durationSeconds * 1_000);
    if (sections.some((section) => section.endMs > durationMs))
      return Response.json({ error: "A vocal section extends beyond the current stem audio." }, { status: 422 });
    const [existing] = await db.select().from(manualVocalSectionSets).where(and(
      eq(manualVocalSectionSets.remixSessionId, remix.id),
      eq(manualVocalSectionSets.stemAssetId, stem.id),
    )).limit(1);
    const currentRevision = existing?.revision ?? 0;
    if (expectedRevision !== currentRevision)
      return Response.json({ error: "These vocal markers changed on another device. Reload them before saving.", code: "VOCAL_SECTION_REVISION_CONFLICT" }, { status: 409 });
    if (existing && !currentChecksums(existing, source, stem) && sections.length > 0 && !confirmCurrentAudio)
      return Response.json({ error: "The source audio changed. Listen to this vocal stem and explicitly confirm or re-mark its boundaries before reusing them.", code: "VOCAL_SECTION_SOURCE_CHANGED" }, { status: 409 });

    const now = new Date();
    const values = {
      remixSessionId: remix.id,
      projectId: remix.projectId,
      sourceAssetId: source.id,
      stemAssetId: stem.id,
      sourceChecksumSha256: source.checksumSha256,
      stemChecksumSha256: stem.checksumSha256 ?? "",
      sections: [...sections].sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs),
      updatedAt: now,
    };
    let saved: typeof manualVocalSectionSets.$inferSelect | undefined;
    try {
      if (!existing) {
        [saved] = await db.insert(manualVocalSectionSets).values({ ...values, revision: 1 }).returning();
      } else {
        [saved] = await db.update(manualVocalSectionSets).set({
          ...values,
          revision: existing.revision + 1,
        }).where(and(
          eq(manualVocalSectionSets.id, existing.id),
          eq(manualVocalSectionSets.revision, expectedRevision),
        )).returning();
      }
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "23505")
        return Response.json({ error: "These vocal markers were created on another device. Reload them before saving.", code: "VOCAL_SECTION_REVISION_CONFLICT" }, { status: 409 });
      throw error;
    }
    if (!saved)
      return Response.json({ error: "These vocal markers changed on another device. Reload them before saving.", code: "VOCAL_SECTION_REVISION_CONFLICT" }, { status: 409 });
    return Response.json({ revision: saved.revision, sections: storedSections(saved.sections), stale: false });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("manual vocal-section save failed", error);
    return Response.json({ error: "Could not save these private vocal sections." }, { status: 500 });
  }
}
