import { getLatestMission, getMissionById, listSpaceMissions, runMission, cancelMission, reconcileMission, MissionBusyError, MissionInputError } from "@/lib/spaces/mission";
import { getSpace } from "@/lib/spaces";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const url = new URL(req.url);
    if (url.searchParams.get("history") === "1") return Response.json({ missions: await listSpaceMissions(id) });
    const missionId = url.searchParams.get("missionId");
    if (missionId) {
      const { isUuid } = await import("@/lib/api/ids");
      if (!isUuid(missionId)) return Response.json({ error: "Valid mission ID required." }, { status: 400 });
      const mission = await getMissionById(id, missionId); return mission ? Response.json({ mission }) : Response.json({ error: "Mission not found in this space." }, { status: 404 });
    }
    return Response.json({ mission: await getLatestMission(id) });
  }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Mission storage unavailable" }, { status: 503 }); }
}

// POST → start (or continue) a mission.
// Body: { goal, timeBudgetMinutes?, agentPlan?, githubToken?, keys?, localOnly? }
// A "checkpointed" or "awaiting_approval" mission resumes where it stopped
// (goal/plan from the row; approval decisions apply on the resumed run).
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    /* body optional for continue */
  }
  try {
    const space = await getSpace(id);
    if (!space) return Response.json({ error: "space not found" }, { status: 404 });

    if (body?.operation === "reconcile") {
      const mission = await reconcileMission(id, { missionId: String(body.missionId ?? ""), requestId: String(body.requestId ?? ""), resolution: body.resolution, evidence: String(body.evidence ?? "") });
      return Response.json({ mission });
    }
    const existing = await getLatestMission(id);
    if (body?.missionId && existing?.id !== body.missionId) return Response.json({ error: "The selected historical mission is not the active mission. Retrieve its outputs; it was not resumed as a different task." }, { status: 409 });
    const unfinished = existing && ["running", "checkpointed", "awaiting_approval", "needs_reconciliation"].includes(existing.status);
    if (unfinished && body?.goal && String(body.goal).trim() !== existing.goal) return Response.json({ error: "An unfinished mission exists. Resume, reconcile, or cancel it before starting another goal." }, { status: 409 });
    const continuing = unfinished && !body?.goal;
    if (!continuing && !String(body?.goal ?? "").trim()) {
      return Response.json({ error: "goal is required" }, { status: 400 });
    }

    const localOnly = body?.localOnly === true;
    const mission = await runMission(id, {
      goal: String(body?.goal ?? existing?.goal ?? "").trim(),
      timeBudgetMs: body?.timeBudgetMinutes ? Math.round(Number(body.timeBudgetMinutes) * 60_000) : undefined,
      agentPlan: Array.isArray(body?.agentPlan) ? body.agentPlan : undefined,
      keys: localOnly ? undefined : body?.keys,
      localOnly,
      githubToken: body?.githubToken || undefined,
      maxTurnsPerAgent: body?.maxTurnsPerAgent ? Math.round(Number(body.maxTurnsPerAgent)) : undefined,
      maxActionsPerTurn: body?.maxActionsPerTurn ? Math.round(Number(body.maxActionsPerTurn)) : undefined,
      isolation: body?.isolation === "container" || body?.isolation === "host" ? body.isolation : "auto",
      isolationImage: typeof body?.isolationImage === "string" && body.isolationImage.trim() ? body.isolationImage.trim().slice(0, 100) : undefined,
      isolationNetwork: body?.isolationNetwork === "bridge" ? "bridge" : "none",
      extraCommands: Array.isArray(body?.extraCommands)
        ? body.extraCommands.map((c: unknown) => String(c)).slice(0, 12)
        : undefined,
    });
    return Response.json({ mission });
  } catch (e) {
    const message = e instanceof Error ? e.message : "mission failed";
    return Response.json({ error: message }, { status: e instanceof MissionBusyError ? 409 : e instanceof MissionInputError || body?.operation === "reconcile" ? 400 : 500 });
  }
}


export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  if (typeof body.missionId !== "string") return Response.json({ error: "missionId is required" }, { status: 400 });
  try {
    const mission = await cancelMission(id, undefined, body.missionId);
    return Response.json({ mission });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Cancellation failed" }, { status: error instanceof MissionBusyError ? 409 : 500 }); }
}
