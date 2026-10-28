import { isUuid } from "@workspace/arena/lib/api/ids";
import { requireUser } from "@workspace/arena/lib/waveyard/local-context";
import { startSeparationForTrack } from "@workspace/arena/lib/waveyard/library/service";

export const runtime = "nodejs";

/** Start separation for a library track that has never had a job. */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    if (!isUuid(id)) {
      return Response.json({ error: "Invalid track id." }, { status: 400 });
    }

    const result = await startSeparationForTrack(user.id, id);
    if (result.outcome === "not-found") {
      return Response.json({ error: "Track not found." }, { status: 404 });
    }
    if (result.outcome === "already-separated") {
      return Response.json({ state: "separated", jobId: null, stemCount: result.stemCount, error: null });
    }
    if (result.outcome === "already-active") {
      return Response.json({ state: "processing", jobId: result.job?.id ?? null, stemCount: null, error: null });
    }
    if (result.outcome === "previous-attempt") {
      return Response.json({
        state: "previous-attempt",
        jobId: result.job.id,
        stemCount: null,
        error: "A separation attempt already exists. Refresh the library and use Retry separation.",
      }, { status: 409 });
    }
    if (result.outcome === "not-queued") {
      return Response.json({
        state: "failed",
        jobId: result.job.id,
        stemCount: null,
        error: `The separation worker did not accept this job: ${result.reason}`,
      }, { status: 503 });
    }
    return Response.json(
      { state: "queued", jobId: result.job.id, stemCount: null, error: null },
      { status: 202 },
    );
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
}
