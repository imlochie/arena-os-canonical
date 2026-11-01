import { ArcadeDevelopmentTools, type ArcadeDevelopmentSnapshot } from "@workspace/arena/lib/spaces/arcade-development";
import { getLatestMission, runMission, recordArcadeDevelopmentEvent } from "@workspace/arena/lib/spaces/mission";
import { createSpace, getSpace, listSpaces } from "@workspace/arena/lib/spaces";
import { decideApproval, getApproval, listApprovals } from "@workspace/arena/lib/spaces/governance";
import { getModel } from "@workspace/arena/lib/models";
import { ensureHubModelsLoaded } from "@workspace/arena/lib/modelHub/registry";
import { requireUser } from "@workspace/arena/lib/waveyard/local-context";
import { requireApiAccess } from "@workspace/arena/lib/security/api-access";

export const dynamic = "force-dynamic";
export const maxDuration = 240;
const running = new Set<string>();

/** Private source is request-scoped. The paused Space stores only owner/base
 * bindings; the existing mission journal redacts all source-bearing tool data. */
export async function POST(req: Request) {
  const denied = await requireApiAccess(req); if (denied) return denied;
  let lock = "";
  try {
    const owner = await requireUser();
    const text = await req.text();
    if (Buffer.byteLength(text) > 240_000) return Response.json({ error: "Development request exceeds 240 KB." }, { status: 413 });
    const body = JSON.parse(text);
    if (!["start", "resume", "approve", "deny", "check", "event"].includes(body.op)) throw new Error("Unsupported development operation.");
    if (body.authorized !== true) return Response.json({ error: "Confirm permission to inspect and modify this source." }, { status: 400 });
    if (body.op === "event") {
      const space = await getSpace(String(body.spaceId ?? ""));
      if (!space) throw new Error("Development workspace not found.");
      const binding = JSON.parse(space.briefcase);
      if (binding.ownerId !== owner.id || binding.developmentId !== body.developmentId) return Response.json({ error: "This development workspace belongs to a different owner." }, { status: 403 });
      const event = body.event;
      if (!event || !["installed", "launched", "stopped", "rolled-back", "owner-assessed-working", "owner-assessed-failed"].includes(event.type) ||
        !/^[a-f0-9]{64}$/.test(event.draftHash) || !/^[a-zA-Z0-9-]{1,100}$/.test(event.profileId))
        throw new Error("Invalid browser evidence.");
      if (running.has(space.id)) return Response.json({ error: "Wait for the current mission operation before recording evidence." }, { status: 409 });
      lock = space.id; running.add(lock);
      const mission = await recordArcadeDevelopmentEvent(space.id, binding, { type: event.type, draftHash: event.draftHash, profileId: event.profileId });
      return Response.json({ mission });
    }
    const tools = new ArcadeDevelopmentTools(body.snapshot as ArcadeDevelopmentSnapshot, owner.id);
    let spaceId = typeof body.spaceId === "string" ? body.spaceId : "";
    const binding = tools.binding;
    if (spaceId) {
      const space = await getSpace(spaceId);
      if (!space || space.briefcase !== JSON.stringify(binding)) return Response.json({ error: "This development workspace does not belong to this owner and immutable base." }, { status: 403 });
    }
    if (body.op === "check") {
      const build = await tools.execute({ tool: "arcade_build", args: {} });
      return Response.json({ snapshot: tools.current, metadata: tools.metadata(), build });
    }
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (!prompt || prompt.length > 1000) return Response.json({ error: "Describe one gameplay change in 1–1,000 characters." }, { status: 400 });
    let modelId = String(body.modelId ?? "");
    const decisionOnly = body.op === "approve" || body.op === "deny";
    if (!decisionOnly) {
      await ensureHubModelsLoaded(true);
      const model = getModel(modelId);
      if (model.kind !== "text" || !["local-server", "turboagent"].includes(model.backend ?? "")) {
        return Response.json({ error: "Select a registered local code model in Model Hub. This workflow does not send imported source to an unselected cloud service or use the deterministic Local Engine.", code: "MODEL_UNAVAILABLE" }, { status: 503 });
      }
      modelId = model.id;
    }
    if (!spaceId) {
      if (body.op && body.op !== "start") return Response.json({ error: "Start a new development mission first." }, { status: 400 });
      // Recover the same metadata workspace after a cancelled first request,
      // without persisting imported source or restarting any privileged action.
      const space = (await listSpaces()).find(space => space.briefcase === JSON.stringify(binding)) ?? await createSpace({ title: `Arcade development: ${body.snapshot.title}`, prompt: "Explicit browser-local Arcade development only; never run autonomously.",
        modelId, status: "paused", briefcase: JSON.stringify(binding) });
      spaceId = space.id;
    }
    if (running.has(spaceId)) return Response.json({ error: "This development mission is already running." }, { status: 409 });
    lock = spaceId;
    running.add(lock);
    const latest = await getLatestMission(spaceId);
    const resume = ["resume", "approve", "deny"].includes(body.op);
    if (resume && (!latest || latest.mode !== "arcade")) throw new Error("There is no resumable Arcade mission.");
    if (resume && latest!.agentPlan[0]?.modelId !== modelId) throw new Error("A resumed mission must use its originally selected model. Start a new mission to change models.");
    if (body.op === "approve" || body.op === "deny") {
      const approval = await getApproval(String(body.approvalId ?? ""));
      if (!approval || approval.spaceId !== spaceId || approval.missionId !== latest?.id ||
        !["arcade.install", "arcade.launch"].includes(approval.actionClass)) throw new Error("This approval does not belong to the current development mission.");
      // The current request must still contain the exact artifact shown for review.
      const payload = approval.payload as { draftHash?: string; baseHash?: string };
      if (payload.draftHash !== tools.hash || payload.baseHash !== binding.baseHash) throw new Error("The reviewed artifact changed. Start a fresh review; nothing was installed.");
      if (!await decideApproval(approval.id, body.op === "approve" ? "approve" : "deny", owner.id))
        throw new Error("This decision has already been made.");
    }
    const mission = await runMission(spaceId, { mode: "arcade", goal: prompt, resume,
      localOnly: true, isolation: "host", maxTurnsPerAgent: 6, maxActionsPerTurn: 4, timeBudgetMs: 180_000,
      agentPlan: [{ name: "Arcade developer", role: "inspect and modify authorized gameplay in a private development copy", modelId }],
    }, { arcade: tools, signal: req.signal });
    const approvals = (await listApprovals(spaceId)).filter(a => a.missionId === mission.id && a.status === "pending");
    return Response.json({ spaceId, mission, approvals, snapshot: tools.current, metadata: tools.metadata(), handoff: tools.handoff });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Development request failed. Original source and saves were not changed." }, { status: 422 });
  } finally {
    if (lock) running.delete(lock);
  }
}
