import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import {
  exportJobs,
  getDb,
  remixSessions,
  remixVersions,
} from "@waveyard/database";
import { enqueueExport } from "@waveyard/queue";
import { requireUser } from "@/lib/auth";
import { requireProjectRole } from "@/lib/permissions";

async function accessVersion(
  userId: string,
  versionId: string,
  minimum: "viewer" | "editor",
) {
  const db = getDb();
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
    const jobs = await getDb()
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
    if (format !== "wav")
      return NextResponse.json(
        { error: "Only WAV export is currently supported." },
        { status: 422 },
      );
    const { version, session } = await accessVersion(user.id, id, "editor");
    const db = getDb();
    const idempotencyKey = `export:${version.id}:wav:44100:2`;
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
        format: "wav",
        sampleRate: 44_100,
        channels: 2,
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
        format: "wav",
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
