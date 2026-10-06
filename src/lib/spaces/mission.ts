/**
 * Space missions — bounded multi-agent build/automation runs.
 *
 * A mission gives a space's agents a REAL workspace and a protocol:
 *
 *   goal + time budget + ordered agent plan
 *     → each agent takes turns emitting JSON actions
 *       { actions: [{tool, args}], handoff, done }
 *     → the runner executes every action via the journaled tool surface,
 *       feeds the observations back, and advances through the plan
 *     → time budget hit  → checkpoint: status "checkpointed", the current
 *       agent's handoff is stored; POST {continue:true} resumes at the next
 *       agent exactly where it stopped
 *     → every step is persisted to the mission journal: what tool, what
 *       input, what actually happened, how long it took.
 *
 * Agents use the same honest model layer as everything else (Local Engine
 * offline, any configured model otherwise). A Local Engine agent plans
 * structurally but cannot write arbitrary code — missions say so in their
 * status detail rather than pretending.
 */

import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { spaceMissions } from "@/db/schema";
import { generate } from "@/lib/ai";
import type { GenerateResult } from "@/lib/runtime";
import { listAgents } from "@/lib/spaces";
import { executeTool, ensureWorkspace, toolListFiles, workspaceDir as wsDir, type ToolOutcome } from "./tools";

export interface MissionAgentSpec {
  name: string;
  role: string;
  modelId: string;
  systemPrompt?: string;
}

export interface MissionStep {
  agent: string;
  turn: number;
  actions: ToolOutcome[];
  handoff: string;
  done: boolean;
  thought: string;
  runtime?: { backend?: string; modelId?: string; fallback?: boolean };
  ms: number;
}

export interface MissionJournal {
  steps: MissionStep[];
}

export interface MissionSummary {
  id: string;
  spaceId: string;
  goal: string;
  status: string;
  statusDetail: string;
  timeBudgetMs: number;
  agentPlan: MissionAgentSpec[];
  journal: MissionStep[];
  artifacts: { path: string; bytes: number }[];
  handoff: string;
  startedAt: string;
  updatedAt: string;
  endedAt: string | null;
}

export interface MissionOpts {
  goal: string;
  timeBudgetMs?: number;
  agentPlan?: MissionAgentSpec[];
  keys?: { openrouter?: string; groq?: string; gemini?: string; turboagent?: string };
  localOnly?: boolean;
  githubToken?: string;
  maxTurnsPerAgent?: number;
}

export interface MissionDeps {
  generate?: typeof generate;
}

const TOOL_DOC = `Available tools (emit actions as JSON):
- write_file {path, content}        write a file in the workspace
- read_file {path}                  read a file back (8KB cap)
- list_files {}                     list the workspace tree
- delete_file {path}
- run_command {command}             allowlisted: node, npm, npx, git, python3, ls, cat (20s timeout)
- fetch_url {url}                   GET a URL (this is how you read feeds/pages)
- github_publish {repo, message, files:[{path,content}], branch?}  commit+push to GitHub (needs a connected token)

Respond with ONE JSON object only, no prose outside it:
{"thought":"one short sentence of your reasoning",
 "actions":[{"tool":"...","args":{...}}],
 "handoff":"context the NEXT agent needs if you're finishing or out of time",
 "done":true|false}
done=true means your role is complete. Use at most 4 actions per turn.`;

function defaultPlan(spaceModel: string): MissionAgentSpec[] {
  return [
    { name: "Planner", role: "plan the work into concrete file-level steps", modelId: spaceModel },
    { name: "Builder", role: "implement the files and commands", modelId: spaceModel },
    { name: "Reviewer", role: "verify the result with read/commands and finish or hand back", modelId: spaceModel },
  ];
}

/** Extract the first JSON object from a model response (fences tolerated). */
export function parseAgentJson(text: string): { thought?: string; actions?: { tool: string; args: Record<string, any> }[]; handoff?: string; done?: boolean } | null {
  if (!text) return null;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fence?.[1], text];
  for (const c of candidates) {
    if (!c) continue;
    const start = c.indexOf("{");
    const end = c.lastIndexOf("}");
    if (start < 0 || end <= start) continue;
    try {
      const obj = JSON.parse(c.slice(start, end + 1));
      if (obj && typeof obj === "object") return obj;
    } catch {
      /* try next */
    }
  }
  return null;
}

function rowToSummary(row: typeof spaceMissions.$inferSelect): MissionSummary {
  const journal = (row.journal as MissionJournal | null)?.steps ?? [];
  return {
    id: row.id,
    spaceId: row.spaceId,
    goal: row.goal,
    status: row.status,
    statusDetail: row.statusDetail,
    timeBudgetMs: row.timeBudgetMs,
    agentPlan: (row.agentPlan as MissionAgentSpec[] | null) ?? [],
    journal,
    artifacts: (row.artifacts as MissionSummary["artifacts"] | null) ?? [],
    handoff: row.handoff,
    startedAt: (row.startedAt ?? new Date()).toISOString(),
    updatedAt: (row.updatedAt ?? new Date()).toISOString(),
    endedAt: row.endedAt ? row.endedAt.toISOString() : null,
  };
}

// Memory fallback so missions still run when Postgres is unavailable —
// same philosophy as the spaces store. (DB-first whenever healthy.)
let missionDbHealthy = true;
const memoryMissions = new Map<string, any>();

export async function getLatestMission(spaceId: string): Promise<MissionSummary | null> {
  if (missionDbHealthy) {
    try {
      const rows = await db
        .select()
        .from(spaceMissions)
        .where(eq(spaceMissions.spaceId, spaceId))
        .orderBy(desc(spaceMissions.startedAt))
        .limit(1);
      if (rows.length) return rowToSummary(rows[0]);
      return memoryMissions.get(spaceId) ?? null;
    } catch {
      missionDbHealthy = false;
    }
  }
  return memoryMissions.get(spaceId) ?? null;
}

export async function runMission(
  spaceId: string,
  opts: MissionOpts,
  deps: MissionDeps = {}
): Promise<MissionSummary> {
  const gen = deps.generate ?? generate;
  const timeBudgetMs = Math.min(3_600_000, Math.max(30_000, opts.timeBudgetMs ?? 600_000));
  const maxTurns = Math.min(8, Math.max(1, opts.maxTurnsPerAgent ?? 3));

  // Plan: explicit > the space's fleet > default three-role pipeline.
  const fleet = await listAgents(spaceId).catch(() => []);
  const plan: MissionAgentSpec[] =
    opts.agentPlan?.length
      ? opts.agentPlan
      : fleet.length
        ? fleet.map((a: { name: string; role: string; modelId: string; systemPrompt: string }) => ({ name: a.name, role: a.role, modelId: a.modelId, systemPrompt: a.systemPrompt }))
        : defaultPlan("local-engine");

  await ensureWorkspace(spaceId);

  // Load or create the mission row (continue = resume a checkpoint).
  const existing = await getLatestMission(spaceId);
  const resuming = existing && existing.status === "checkpointed";
  let row: any;
  if (resuming) {
    if (missionDbHealthy) {
      try {
        [row] = await db.update(spaceMissions).set({ status: "running", statusDetail: "", updatedAt: new Date() }).where(eq(spaceMissions.id, existing.id)).returning();
      } catch {
        missionDbHealthy = false;
      }
    }
    if (!row) {
      row = { ...memoryMissions.get(spaceId), status: "running", statusDetail: "" };
      memoryMissions.set(spaceId, row);
    }
  } else {
    const fresh = {
      id: crypto.randomUUID(),
      spaceId,
      goal: opts.goal.slice(0, 2000),
      status: "running",
      statusDetail: "",
      timeBudgetMs,
      agentPlan: plan,
      journal: { steps: [] },
      artifacts: [],
      handoff: "",
      startedAt: new Date(),
      updatedAt: new Date(),
      endedAt: null,
    };
    if (missionDbHealthy) {
      try {
        const [inserted] = await db.insert(spaceMissions).values({
          spaceId: fresh.spaceId, goal: fresh.goal, timeBudgetMs, agentPlan: plan,
          journal: { steps: [] }, artifacts: [], handoff: "",
        }).returning();
        row = inserted;
      } catch {
        missionDbHealthy = false;
      }
    }
    if (!row) {
      row = fresh;
      memoryMissions.set(spaceId, fresh);
    }
  }

  let mission = rowToSummary(row);
  const steps: MissionStep[] = [...mission.journal];
  const started = Date.now();
  const deadline = started + timeBudgetMs;
  let handoff = resuming ? mission.handoff : "";
  let status = "done";
  let statusDetail = "";

  const save = async (patch: Partial<typeof spaceMissions.$inferInsert>) => {
    const apply = (r: any) => rowToSummary({ ...r, ...patch, journal: { steps }, updatedAt: new Date() });
    if (missionDbHealthy) {
      try {
        const [updated] = await db
          .update(spaceMissions)
          .set({ ...patch, journal: { steps }, updatedAt: new Date() })
          .where(eq(spaceMissions.id, mission.id))
          .returning();
        if (updated) {
          mission = rowToSummary(updated);
          memoryMissions.set(spaceId, updated);
          return mission;
        }
      } catch {
        missionDbHealthy = false;
      }
    }
    const mem = memoryMissions.get(spaceId) ?? row;
    const next = apply(mem);
    memoryMissions.set(spaceId, { ...mem, ...patch, journal: { steps } });
    mission = next;
    return mission;
  };

  agentLoop: for (let ai = 0; ai < plan.length; ai++) {
    const agent = plan[ai];
    for (let turn = 1; turn <= maxTurns; turn++) {
      if (Date.now() >= deadline) {
        status = "checkpointed";
        statusDetail = `time budget (${Math.round(timeBudgetMs / 1000)}s) reached before ${agent.name} could run — resume to continue`;
        break agentLoop;
      }

      const context =
        (handoff ? `Handoff from the previous agent:\n${handoff}\n\n` : "") +
        `Mission goal: ${mission.goal}\nYou are agent ${ai + 1}/${plan.length}: ${agent.name} (${agent.role}).` +
        (steps.length ? `\n\nRecent journal (most recent last):\n${steps.slice(-4).map((s) => `${s.agent}: ${s.thought} [${s.actions.map((a) => a.tool + (a.ok ? "✓" : "✗")).join(", ")}]`).join("\n")}` : "");

      let result: GenerateResult;
      const t0 = Date.now();
      try {
        result = await gen(
          {
            modelId: agent.modelId,
            messages: [{ role: "user", content: context }],
            system:
              (agent.systemPrompt ? agent.systemPrompt + "\n\n" : "") +
              `You are ${agent.name}, the ${agent.role} agent of a build mission with REAL tool execution. ` +
              "You draft actions; the runner executes them and shows you what actually happened. " +
              "Never claim an action you did not emit. " +
              TOOL_DOC,
            temperature: 0.3,
            keys: opts.localOnly ? undefined : opts.keys,
            localOnly: opts.localOnly,
          },
        );
      } catch (e) {
        steps.push({
          agent: agent.name, turn, actions: [], handoff: "", done: false,
          thought: `model call failed: ${e instanceof Error ? e.message : "error"}`,
          ms: Date.now() - t0,
        });
        status = "failed";
        statusDetail = `${agent.name}'s model call failed`;
        break agentLoop;
      }

      const parsed = parseAgentJson(result.text);
      const actions = Array.isArray(parsed?.actions) ? parsed!.actions!.slice(0, 4) : [];
      const outcomes: ToolOutcome[] = [];
      for (const a of actions) {
        if (Date.now() >= deadline) {
          status = "checkpointed";
          statusDetail = `time budget hit mid-turn while ${agent.name} was acting — resume to continue`;
          break;
        }
        outcomes.push(await executeTool(spaceId, a, { githubToken: opts.githubToken }));
      }

      const step: MissionStep = {
        agent: agent.name,
        turn,
        actions: outcomes,
        handoff: String(parsed?.handoff ?? "").slice(0, 2000),
        done: parsed?.done === true,
        thought: String(parsed?.thought ?? result.text.slice(0, 200)).slice(0, 500),
        runtime: { backend: result.backend, modelId: result.modelId, fallback: result.fallback },
        ms: Date.now() - t0,
      };
      steps.push(step);
      if (step.handoff) handoff = step.handoff;

      if (status === "checkpointed") break agentLoop;
      if (step.done) break; // next agent
    }
  }

  const totalActions = steps.reduce((n, s) => n + s.actions.length, 0);
  if (status === "done") {
    if (totalActions === 0) {
      status = "failed";
      statusDetail =
        "no agent emitted an executable action — the Local Engine plans but cannot act. " +
        "Connect a real model (free Groq/OpenRouter key in Settings, on-device WebLLM, or TurboAgent) for actionable missions.";
    } else {
      statusDetail = `${steps.length} step(s) across ${new Set(steps.map((s) => s.agent)).size} agent(s), ${totalActions} tool action(s) executed`;
    }
  }

  await save({
    status,
    statusDetail,
    handoff,
    artifacts: await listArtifacts(spaceId),
    endedAt: status === "running" ? null : new Date(),
  });
  return mission;
}

async function listArtifacts(spaceId: string): Promise<{ path: string; bytes: number }[]> {
  try {
    const listing = await toolListFiles(wsDir(spaceId));
    return listing
      .split("\n")
      .filter((l) => l && !l.startsWith("("))
      .map((l) => {
        const m = l.match(/^(.*) \((\d+)B\)$/);
        return m ? { path: m[1], bytes: Number(m[2]) } : null;
      })
      .filter((x): x is { path: string; bytes: number } => x !== null);
  } catch {
    return [];
  }
}
