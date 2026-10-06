import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import {
  drumAnalyses,
  exportJobs,
  harmonyAnalyses,
  remixSessions,
  remixVersions,
  sourceAssets,
  stemAssets,
  vocalAnalyses,
} from "@/db/waveyardSchema";
import { enqueueExport } from "@/lib/waveyard/queue";
import { requireUser } from "@/lib/waveyard/local-context";
import { requireProjectRole } from "@/lib/waveyard/local-context";

async function accessVersion(
  userId: string,
  versionId: string,
  minimum: "viewer" | "editor",
) {
  
  const [version] = await db
    .select()
    .from(remixVersions)
    .where(eq(remixVersions.id, versionId))
    .limit(1);
  if (!version) throw new Response("Remix version not found.", { status: 404 });
  const [session] = await db
    .select()
    .from(remixSessions)
    .where(eq(remixSessions.id, version.remixSessionId))
    .limit(1);
  if (!session)
    throw new Response("Remix session not found.", { status: 404 });
  await requireProjectRole(userId, session.projectId, minimum);
  return { version, session };
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const { version } = await accessVersion(user.id, id, "viewer");
    const jobs = await db
      .select()
      .from(exportJobs)
      .where(eq(exportJobs.remixVersionId, version.id));
    return NextResponse.json({ exports: jobs });
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    const format = body.format ?? "wav";
    if (format !== "wav" && format !== "midi")
      return NextResponse.json({ error: "Export format is unsupported." }, { status: 422 });
    const { version, session } = await accessVersion(user.id, id, "editor");
    
    let midi: { kind: "vocal" | "drums" | "harmony"; sourceAssetId: string; stemAssetId: string | null; analysisId: string; sourceChecksumSha256: string; analysisEngine: string; analysisEngineVersion: string } | null = null;
    if (format === "midi") {
      const kind = body.midiKind;
      const sourceAssetId = body.sourceAssetId;
      const stemAssetId = body.stemAssetId;
      if ((kind !== "vocal" && kind !== "drums" && kind !== "harmony") || typeof sourceAssetId !== "string")
        return NextResponse.json({ error: "MIDI export requires a supported analysis target." }, { status: 422 });
      const [source] = await db.select().from(sourceAssets).where(eq(sourceAssets.id, sourceAssetId)).limit(1);
      if (!source || source.projectId !== session.projectId)
        return NextResponse.json({ error: "MIDI source is unavailable in this project." }, { status: 404 });
      if (kind === "harmony") {
        const [analysis] = await db.select().from(harmonyAnalyses).where(eq(harmonyAnalyses.sourceAssetId, source.id)).limit(1);
        if (!analysis || analysis.projectId !== session.projectId || analysis.status !== "complete")
          return NextResponse.json({ error: "Complete current harmony analysis is required for MIDI export." }, { status: 409 });
        midi = { kind, sourceAssetId, stemAssetId: null, analysisId: analysis.id, sourceChecksumSha256: source.checksumSha256, analysisEngine: analysis.analysisEngine, analysisEngineVersion: analysis.analysisEngineVersion };
      } else {
        if (typeof stemAssetId !== "string") return NextResponse.json({ error: "Stem MIDI export requires an isolated stem." }, { status: 422 });
        const [stem] = await db.select().from(stemAssets).where(eq(stemAssets.id, stemAssetId)).limit(1);
        if (!stem || stem.projectId !== session.projectId || stem.sourceAssetId !== source.id
          || (kind === "vocal" && stem.stemType !== "vocals")
          || (kind === "drums" && stem.stemType !== "drums" && stem.stemType !== "percussion"))
          return NextResponse.json({ error: "MIDI stem is unavailable or unsupported." }, { status: 422 });
        const [analysis] = kind === "vocal"
          ? await db.select().from(vocalAnalyses).where(eq(vocalAnalyses.stemAssetId, stem.id)).limit(1)
          : await db.select().from(drumAnalyses).where(eq(drumAnalyses.stemAssetId, stem.id)).limit(1);
        if (!analysis || analysis.projectId !== session.projectId || analysis.status !== "complete")
          return NextResponse.json({ error: "Complete current stem analysis is required for MIDI export." }, { status: 409 });
        midi = { kind, sourceAssetId, stemAssetId, analysisId: analysis.id, sourceChecksumSha256: source.checksumSha256, analysisEngine: analysis.analysisEngine, analysisEngineVersion: analysis.analysisEngineVersion };
      }
    }
    const idempotencyKey = midi
      ? `export:${version.id}:midi:${midi.kind}:${midi.sourceAssetId}:${midi.stemAssetId ?? "source"}:${midi.analysisId}:480`
      : `export:${version.id}:wav:44100:2`;
    const [created] = await db
      .insert(exportJobs)
      .values({
        projectId: session.projectId,
        remixSessionId: session.id,
        remixVersionId: version.id,
        requestedById: user.id,
        status: "queued",
        stage: "queued",
        idempotencyKey,
        format,
        midiKind: midi?.kind ?? null,
        midiSourceAssetId: midi?.sourceAssetId ?? null,
        midiStemAssetId: midi?.stemAssetId ?? null,
        midiPpq: midi ? 480 : null,
        midiAnalysisId: midi?.analysisId ?? null,
        midiSourceChecksumSha256: midi?.sourceChecksumSha256 ?? null,
        midiAnalysisEngine: midi?.analysisEngine ?? null,
        midiAnalysisEngineVersion: midi?.analysisEngineVersion ?? null,
        sampleRate: midi ? 0 : 44_100,
        channels: midi ? 0 : 2,
      })
      .onConflictDoNothing({ target: exportJobs.idempotencyKey })
      .returning();
    const [job] = created
      ? [created]
      : await db
          .select()
          .from(exportJobs)
          .where(eq(exportJobs.idempotencyKey, idempotencyKey))
          .limit(1);
    if (!job) throw new Error("Export job idempotency lookup failed.");
    if (!created) return NextResponse.json({ job, reused: true });

    try {
      await enqueueExport({
        exportJobId: job.id,
        projectId: job.projectId,
        remixSessionId: job.remixSessionId,
        remixVersionId: job.remixVersionId,
        format: job.format as "wav" | "midi",
      });
    } catch (queueError) {
      await db
        .update(exportJobs)
        .set({
          status: "failed",
          stage: "queue-unavailable",
          errorCode: "queue_unavailable",
          errorMessage:
            queueError instanceof Error
              ? queueError.message.slice(0, 1000)
              : "Queue unavailable.",
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(exportJobs.id, job.id));
      return NextResponse.json(
        { error: "Export request was saved, but processing could not be queued." },
        { status: 503 },
      );
    }
    return NextResponse.json({ job, reused: false }, { status: 201 });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("export request failed", error);
    return NextResponse.json(
      { error: "Export could not be requested." },
      { status: 500 },
    );
  }
}
