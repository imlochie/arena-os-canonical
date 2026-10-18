/**
 * Deep Agent — the bounded autonomous agent (the honest AutoGPT).
 *
 * Wave-3 mandate: "bounded autonomous agent (plan → act → verify, capped
 * steps, human approval for writes)". This is a *research-and-draft* agent:
 * it plans, executes, and self-verifies text work through the normal
 * generate() contract — with hard bounds:
 *
 *   - capped step count (2..8, default 4) and a wall-clock budget
 *   - every step is verified; a failed step retries ONCE with the feedback
 *   - the full transcript (plan, outputs, verdicts, attempts) is persisted
 *   - it performs NO writes outside its own run rows (file/system effects
 *     remain gated behind the existing tool-effect approval chain)
 *   - honest engine labels on every step — the Local Engine floor produces
 *     deterministic, clearly-labeled output, never fake "agent reasoning"
 */

import { asc, desc, eq } from "drizzle-orm";

import { db } from "@/db";
import { deepAgentRuns, deepAgentSteps } from "@/db/schema";
import { generate, type ChatMsg } from "@/lib/ai";

export type DeepAgentStepView = {
  idx: number;
  title: string;
  output: string;
  verdict: "pass" | "fail";
  verdictReason: string;
  attempts: number;
};

export type DeepAgentRunView = {
  id: string;
  goal: string;
  status: string;
  engine: string;
  via: string;
  createdAt: string;
  steps: DeepAgentStepView[];
};

export const MAX_STEPS = 8;
export const DEFAULT_STEPS = 4;
const TIME_BUDGET_MS = 110_000;

export function parseAgentPlan(reply: string, maxSteps: number): string[] {
  // Accept a JSON array, a numbered list, or markdown "- " lines.
  const json = reply.match(/\[[\s\S]*\]/);
  if (json) {
    try {
      const parsed = JSON.parse(json[0]) as unknown;
      if (Array.isArray(parsed)) {
        const titles = parsed.map((item) => (typeof item === "string" ? item : String((item as { title?: string })?.title ?? ""))).filter(Boolean);
        if (titles.length >= 2) return titles.slice(0, maxSteps).map((t) => t.slice(0, 160));
      }
    } catch {
      /* fall through */
    }
  }
  const lines = reply
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:\d+[.)]|[-*])\s*/, "").trim())
    .filter((line) => line.length > 8 && !/^(here|sure|plan|steps)/i.test(line));
  if (lines.length < 2) return []; // one prose sentence is not a plan
  return lines.slice(0, maxSteps).map((t) => t.slice(0, 160));
}

export function parseVerdict(reply: string): { verdict: "pass" | "fail"; reason: string } {
  // A review must explicitly lead with its verdict. Quoted instructions or
  // "could not verify" prose must never become a successful review.
  const match = reply.trim().match(/^(PASS|FAIL)\b/i);
  if (!match) return { verdict: "fail", reason: "No explicit review verdict was returned; output remains unverified." };
  const verdict = match[1].toUpperCase() === "PASS" ? "pass" : "fail";
  const reason = reply.trim().slice(match[0].length).replace(/^\s*[:—-]\s*/, "").trim().slice(0, 240);
  return { verdict, reason: reason || (verdict === "pass" ? "model reviewer accepted the draft (not execution evidence)" : "model reviewer rejected the draft") };
}

export async function runDeepAgent(
  goal: string,
  opts: { steps?: number; keys?: Record<string, string>; modelId?: string; timeBudgetMs?: number } = {},
  deps: { generate?: typeof generate; database?: typeof db } = {},
): Promise<DeepAgentRunView> {
  const database = deps.database ?? db;
  const generateDraft = deps.generate ?? generate;
  const maxSteps = Math.max(2, Math.min(opts.steps ?? DEFAULT_STEPS, MAX_STEPS));
  const deadline = Date.now() + Math.min(opts.timeBudgetMs ?? TIME_BUDGET_MS, TIME_BUDGET_MS);
  const gen = (messages: ChatMsg[], temperature = 0.5) =>
    generateDraft({ modelId: opts.modelId ?? "local-engine", messages, keys: opts.keys as never, temperature, maxTokens: 2000 });

  const [run] = await database.insert(deepAgentRuns).values({ goal, status: "running" }).returning();
  const finish = async (status: string): Promise<DeepAgentRunView> => {
    await database.update(deepAgentRuns).set({ status }).where(eq(deepAgentRuns.id, run.id));
    return getRun(run.id, database) as Promise<DeepAgentRunView>;
  };

  try {
    // ---- plan ----
    const planReply = await gen([
      {
        role: "user",
        content:
          `Goal: ${goal}\n\nBreak this into exactly ${maxSteps} concrete steps. Reply with ONLY a JSON array of ${maxSteps} short step titles (strings), no prose.`,
      },
    ]);
    const plan = parseAgentPlan(planReply.text, maxSteps);
    if (plan.length === 0) {
      await database.insert(deepAgentSteps).values({ runId: run.id, idx: 0, title: "plan", output: planReply.text.slice(0, 2000), verdict: "fail", verdictReason: "could not extract a plan", attempts: 1 });
      return finish("failed");
    }
    let engine = planReply.backend;
    let via = planReply.via ?? planReply.backend;

    // ---- act + verify, step by step ----
    const outputs: string[] = [];
    for (const [idx, title] of plan.entries()) {
      if (Date.now() > deadline) {
        await database.insert(deepAgentSteps).values({ runId: run.id, idx, title, output: "", verdict: "fail", verdictReason: "time budget exhausted — run stopped honestly", attempts: 0 });
        return finish("incomplete");
      }
      const context =
        outputs.length === 0
          ? ""
          : `\n\nWork already completed in previous steps:\n${outputs.map((o, i) => `— step ${i + 1}: ${o.slice(0, 400)}`).join("\n")}`;
      const actMessages: ChatMsg[] = [
        {
          role: "user",
          content: `Overall goal: ${goal}\n\nThis step: ${title}${context}\n\nDo the step. Reply with the step's actual output only (the research/draft/answer itself, no meta-commentary).`,
        },
      ];
      let act = await gen(actMessages, 0.6);
      let attempts = 1;

      const verify = async (output: string) => {
        const reply = await gen(
          [
            {
              role: "user",
              content:
                `Goal: ${goal}\nStep: ${title}\nProposed step output:\n"""\n${output.slice(0, 3000)}\n"""\n\n` +
                `Does this output genuinely accomplish this step (useful, on-topic, not empty or evasive)? Reply with one word first — PASS or FAIL — then one sentence why.`,
            },
          ],
          0.2,
        );
        if (reply.fallback || reply.backend === "arena-local-engine") {
          return { verdict: "fail" as const, reason: "A capable review model is unavailable; this draft remains unverified. Configure a model and retry." };
        }
        return parseVerdict(reply.text);
      };

      let verdict = await verify(act.text);
      if (verdict.verdict === "fail" && Date.now() < deadline) {
        // one honest retry with the feedback
        const retry = await gen([...actMessages, { role: "user", content: `Your previous attempt failed review: ${verdict.reason}. Try again, better.` }], 0.6);
        const retryVerdict = await verify(retry.text);
        attempts = 2;
        if (retryVerdict.verdict === "pass" || retry.text.trim().length > act.text.trim().length) {
          act = retry;
          verdict = retryVerdict;
        }
      }
      engine = act.backend;
      via = act.via ?? act.backend;
      await database.update(deepAgentRuns).set({ engine, via }).where(eq(deepAgentRuns.id, run.id));
      await database.insert(deepAgentSteps).values({
        runId: run.id,
        idx,
        title,
        output: act.text.slice(0, 20_000),
        verdict: verdict.verdict,
        verdictReason: verdict.reason,
        attempts,
      });
      // Failed work is retained for inspection, never fed to downstream steps
      // as "work already completed" or marked done because the loop finished.
      if (verdict.verdict === "fail") return finish("failed");
      outputs.push(act.text);
    }
    await database.update(deepAgentRuns).set({ status: "done", engine, via }).where(eq(deepAgentRuns.id, run.id));
    return (await getRun(run.id, database)) as DeepAgentRunView;
  } catch (cause) {
    // Provider exceptions must not leave a durable, permanently running job.
    await database.update(deepAgentRuns).set({ status: "failed" }).where(eq(deepAgentRuns.id, run.id));
    throw cause;
  }
}

export async function getRun(id: string, database: typeof db = db): Promise<DeepAgentRunView | null> {
  const [run] = await database.select().from(deepAgentRuns).where(eq(deepAgentRuns.id, id)).limit(1);
  if (!run) return null;
  const steps = await database.select().from(deepAgentSteps).where(eq(deepAgentSteps.runId, id)).orderBy(asc(deepAgentSteps.idx));
  return {
    id: run.id,
    goal: run.goal,
    status: run.status,
    engine: run.engine,
    via: run.via,
    createdAt: run.createdAt.toISOString(),
    steps: steps.map((step) => ({
      idx: step.idx,
      title: step.title,
      output: step.output,
      verdict: step.verdict as "pass" | "fail",
      verdictReason: step.verdictReason,
      attempts: step.attempts,
    })),
  };
}

/**
 * Save a finished run as an artifact — the agent's one sanctioned "write":
 * it goes through the normal artifact library (visible, deletable,
 * provenance-labeled), not the filesystem.
 */
export async function saveRunAsArtifact(id: string): Promise<{ ok: boolean; artifactId?: string; note?: string }> {
  const run = await getRun(id);
  if (!run) return { ok: false, note: "run not found" };
  if (run.steps.length === 0) return { ok: false, note: "run has no steps to save" };
  const body =
    `# Deep Agent run — ${run.goal}

` +
    `_engine: ${run.engine} · via: ${run.via} · status: ${run.status} · ${run.steps.length} step(s)_

` +
    run.steps
      .map(
        (step) =>
          `## Step ${step.idx + 1}: ${step.title}
_verdict: ${step.verdict}${step.attempts > 1 ? ` (${step.attempts} attempts)` : ""} — ${step.verdictReason}_

${step.output}`,
      )
      .join("\n\n---\n\n");
  try {
    const { db } = await import("@/db");
    const { artifacts } = await import("@/db/schema");
    const [row] = await db
      .insert(artifacts)
      .values({
        title: `Deep Agent: ${run.goal.slice(0, 120)}`,
        body: body.slice(0, 60_000),
        kind: "deep-agent",
        sourceType: "assistant",
      })
      .returning();
    return { ok: true, artifactId: row?.id };
  } catch {
    return { ok: false, note: "artifact library unavailable" };
  }
}

export async function listRuns(limit = 20): Promise<{ id: string; goal: string; status: string; via: string; createdAt: string; stepCount: number }[]> {
  const runs = await db.select().from(deepAgentRuns).orderBy(desc(deepAgentRuns.createdAt)).limit(limit);
  const result = [];
  for (const run of runs) {
    const steps = await db.select({ id: deepAgentSteps.id }).from(deepAgentSteps).where(eq(deepAgentSteps.runId, run.id));
    result.push({
      id: run.id,
      goal: run.goal,
      status: run.status,
      via: run.via,
      createdAt: run.createdAt.toISOString(),
      stepCount: steps.length,
    });
  }
  return result;
}

export async function deleteRun(id: string): Promise<boolean> {
  const removed = await db.delete(deepAgentRuns).where(eq(deepAgentRuns.id, id)).returning({ id: deepAgentRuns.id });
  return removed.length > 0;
}
