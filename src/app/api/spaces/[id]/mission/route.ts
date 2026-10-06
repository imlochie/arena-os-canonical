import { getLatestMission, runMission } from "@/lib/spaces/mission";
import { getSpace } from "@/lib/spaces";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const mission = await getLatestMission(id);
  return Response.json({ mission });
}

// POST → start (or continue) a mission.
// Body: { goal, timeBudgetMinutes?, agentPlan?, githubToken?, keys?, localOnly? }
// A "checkpointed" mission resumes where it stopped (goal/plan from the row).
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

    const existing = await getLatestMission(id);
    const continuing = existing?.status === "checkpointed" && !body?.goal;
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
    });
    return Response.json({ mission });
  } catch (e) {
    const message = e instanceof Error ? e.message : "mission failed";
    return Response.json({ error: message }, { status: 500 });
  }
}
