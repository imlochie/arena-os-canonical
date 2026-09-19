import { computeCollegeState, snapshotCollegeState } from "@/lib/college/state";

export const dynamic = "force-dynamic";

// GET → the full College State: the institution's current understanding of
// itself, recomputed from persistent state (never from model memory).
// ?snapshot=1 also persists an auditable snapshot.
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const state = await computeCollegeState();
    let snapshotId: string | null = null;
    if (url.searchParams.get("snapshot") === "1") {
      snapshotId = await snapshotCollegeState("api_request", state);
    }
    return Response.json({ state, snapshotId });
  } catch (e) {
    console.error("college state error", e);
    return Response.json(
      { error: "state computation failed", detail: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
