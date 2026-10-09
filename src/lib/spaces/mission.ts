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

import { readFile } from "node:fs/promises";
import path from "node:path";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { spaceMissions } from "@/db/schema";
import { generate } from "@/lib/ai";
import type { GenerateResult } from "@/lib/runtime";
import { listAgents } from "@/lib/spaces";
import { executeTool, ensureWorkspace, toolListFiles, workspaceDir as wsDir, type ToolOutcome } from "./tools";
import { actionSignature, classifyToolAction, approvalRequired, claimExecution, completeExecution, findLatestBySignature, requestApproval } from "./governance";

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
  maxActionsPerTurn?: number;
  /** Extra command binaries this mission opts into (beyond the base allowlist). */
  extraCommands?: string[];
}

export interface MissionDeps {
  generate?: typeof generate;
}

const AGENT_KNOWLEDGE = `WORK DISCIPLINE (how strong coding agents operate):
- PLAN before acting: your first turn should map the approach (and for multi-file work, write PLAN.md).
- SURGICAL EDITS: use edit_file with a unique old_text snippet for changes to existing files; write_file only for new files or full rewrites. Never rewrite a large file to change a few lines.
- VERIFY EVERY CHANGE: after writing or editing code, run it (run_command) or test it (run_tests). Never claim something works unverified.
- SELF-CORRECT, don't retry: when something fails, read the OBSERVATIONS, form a hypothesis about WHY, then apply a targeted fix. Blind repetition of a failed action is a bug.
- SMALL STEPS: one concern per turn; land it, verify, move on.
- At the end, append 1-3 concise lessons to AGENT_NOTES.md ("## <goal in 6 words>\n- lesson") — future missions in this space read them.`;

const TOOL_DOC = `Available tools (emit actions as JSON):
- write_file {path, content}        create/overwrite a file (new files, or full rewrites of small files)
- edit_file {path, old_text, new_text}  SURGICAL edit of an existing file (Aider-style): old_text must match EXACTLY ONE location — copy it from read_file output; verified + syntax-checked
- read_file {path, startLine?, endLine?}  numbered, windowed view (default first 100 lines)
- list_files {}                     list the workspace tree
- delete_file {path}
- run_command {command}             allowlisted: node, npm, npx, git, python3, ls, cat (20s timeout)
- search_code {pattern, glob?}      regex search across the workspace — file:line results (use this to explore existing code)
- run_tests {command?}              run the workspace's tests (auto-detects npm test / node --test); 60s budget — use it to verify your work
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
  const maxTurns = Math.min(16, Math.max(1, opts.maxTurnsPerAgent ?? 3));
  const maxActions = Math.min(12, Math.max(1, opts.maxActionsPerTurn ?? 4));
  const extraAllow = (opts.extraCommands ?? [])
    .map((c) => String(c).trim().split(/\s+/)[0])
    .filter((c) => /^[a-z0-9_.@-]+$/i.test(c) && c.length <= 30)
    .slice(0, 12);

  // Load or create the mission row (continue = resume a checkpoint or an
  // approval wait). Loaded FIRST so a resumed mission reuses its stored plan.
  const existing = await getLatestMission(spaceId);
  const resuming = existing && (existing.status === "checkpointed" || existing.status === "awaiting_approval");
  const resumingPlan = resuming && existing!.agentPlan.length ? existing!.agentPlan : undefined;

  // Plan: explicit > the space's fleet > default three-role pipeline.
  const fleet = await listAgents(spaceId).catch(() => []);
  const plan: MissionAgentSpec[] =
    resumingPlan?.length
      ? resumingPlan
      : opts.agentPlan?.length
        ? opts.agentPlan
        : fleet.length
        ? fleet.map((a: { name: string; role: string; modelId: string; systemPrompt: string }) => ({ name: a.name, role: a.role, modelId: a.modelId, systemPrompt: a.systemPrompt }))
        : defaultPlan("openai"); // any text alias: routes via Groq/OpenRouter key when sent, else keyless pollinations, else honest local fallback

  await ensureWorkspace(spaceId);
  let row: any;
  if (resuming) {
    if (missionDbHealthy) {
      try {
        [row] = await db.update(spaceMissions).set({ status: "running", statusDetail: "resumed", updatedAt: new Date() }).where(eq(spaceMissions.id, existing.id)).returning();
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

      // Observations: what the tools ACTUALLY returned recently — this is
      // how agents see test failures and command output and fix their work.
      const observations = steps
        .slice(-2)
        .flatMap((s) =>
          s.actions.map((a) => `${s.agent} → ${a.tool}: ${a.output.slice(0, 1200)}`),
        )
        .slice(-6)
        .join("\n---\n");
      // Workspace map (Aider-style repo map): cheap, high-signal orientation.
      let map = "";
      try {
        map = (await toolListFiles(wsDir(spaceId))).slice(0, 1500);
      } catch {
        /* empty workspace */
      }
      // Reflection memory (Reflexion): lessons from previous missions in
      // this space persist in AGENT_NOTES.md and are injected here.
      let memory = "";
      try {
        const notes = await readFile(path.join(wsDir(spaceId), "AGENT_NOTES.md"), "utf8").catch(() => "");
        if (notes.trim()) memory = notes.slice(0, 1500);
      } catch {
        /* no memory yet */
      }
      const context =
        (handoff ? `Handoff from the previous agent:\n${handoff}\n\n` : "") +
        (memory ? `MEMORY — lessons from previous missions in this space:\n${memory}\n\n` : "") +
        (map && map !== "(workspace is empty)" ? `WORKSPACE MAP (current files):\n${map}\n\n` : "") +
        `Mission goal: ${mission.goal}\nYou are agent ${ai + 1}/${plan.length}: ${agent.name} (${agent.role}).` +
        (steps.length ? `\n\nRecent journal (most recent last):\n${steps.slice(-4).map((s) => `${s.agent}: ${s.thought} [${s.actions.map((a) => a.tool + (a.ok ? "✓" : "✗")).join(", ")}]`).join("\n")}` : "") +
        (observations ? `\n\nOBSERVATIONS — actual tool outputs from your recent turns (read them; fix what failed):\n${observations}` : "");

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
              AGENT_KNOWLEDGE + "\n\n" +
              TOOL_DOC,
            temperature: 0.3,
            maxTokens: 8_000,
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
      const actions = Array.isArray(parsed?.actions) ? parsed!.actions!.slice(0, maxActions) : [];
      const outcomes: ToolOutcome[] = [];
      for (const a of actions) {
        if (Date.now() >= deadline) {
          status = "checkpointed";
          statusDetail = `time budget hit mid-turn while ${agent.name} was acting — resume to continue`;
          break;
        }
        // GOVERNANCE GATE (docs/spaces-autonomy.md Phase A): approval-required
        // action classes never execute without a recorded human decision. The
        // mission checkpoints itself awaiting_approval; on resume the same
        // action signature is matched to its decision — approved executes
        // (single-claim), pending keeps waiting, denied is refused honestly.
        const actionClass = classifyToolAction(a.tool);
        if (approvalRequired(actionClass)) {
          const sig = actionSignature(mission.id, a.tool, a.args);
          // The LATEST approval for this exact action instance binds: pending →
          // wait for the human; denied → refused, terminal; executed/failed →
          // never repeated; approved → single-claim execution.
          let approval = await findLatestBySignature(sig);
          if (!approval) {
            approval = await requestApproval({
              spaceId,
              missionId: mission.id,
              signature: sig,
              actionClass,
              summary: `${a.tool}: ${JSON.stringify(a.args).slice(0, 300)}`,
              payload: a.args,
            });
          }
          if (approval.status === "pending") {
            outcomes.push({
              tool: a.tool,
              input: a.args ?? {},
              output: `⏸ awaiting human approval (class ${actionClass}, request ${approval.id.slice(0, 8)}) — the mission is checkpointed. Approve or deny it in the Spaces workbench (Approvals panel) or via the API; the daemon/workbench resumes automatically once decided.`,
              ok: false,
              ms: 0,
            });
            status = "awaiting_approval";
            statusDetail = `action ${a.tool} requires human approval (request ${approval.id.slice(0, 8)}) — decide in the Spaces workbench`;
            break;
          }
          if (approval.status === "denied") {
            outcomes.push({
              tool: a.tool,
              input: a.args ?? {},
              output: `refused: the human denied this action (request ${approval.id.slice(0, 8)}). Do not retry the same action; adjust the approach.`,
              ok: false,
              ms: 0,
            });
            continue;
          }
          if (approval.status === "executing") {
            outcomes.push({
              tool: a.tool,
              input: a.args ?? {},
              output: `execution of request ${approval.id.slice(0, 8)} is already in progress elsewhere — not repeated here`,
              ok: false,
              ms: 0,
            });
            continue;
          }
          if (approval.status === "executed" || approval.status === "failed") {
            outcomes.push({
              tool: a.tool,
              input: a.args ?? {},
              output: `already executed earlier (request ${approval.id.slice(0, 8)}, ${approval.status}) — not repeated`,
              ok: approval.status === "executed",
              ms: 0,
            });
            continue;
          }
          // approved → single-claim execution (exactly one caller wins)
          const claimed = await claimExecution(approval.id);
          if (!claimed) {
            outcomes.push({
              tool: a.tool,
              input: a.args ?? {},
              output: `lost the execution claim for request ${approval.id.slice(0, 8)} — another runner is executing it`,
              ok: false,
              ms: 0,
            });
            continue;
          }
          const tExec = Date.now();
          const gated = await executeTool(spaceId, a, { githubToken: opts.githubToken, extraAllow });
          await completeExecution(approval.id, gated.ok, { tool: gated.tool, output: gated.output.slice(0, 2000) }, gated.ok ? undefined : gated.output.slice(0, 500));
          outcomes.push({ ...gated, ms: Date.now() - tExec });
          continue;
        }
        outcomes.push(await executeTool(spaceId, a, { githubToken: opts.githubToken, extraAllow }));
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
    endedAt: status === "running" || status === "awaiting_approval" ? null : new Date(),
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
