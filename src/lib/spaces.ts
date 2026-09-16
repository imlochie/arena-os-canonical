// Spaces — server-side orchestration for the multi-window agent workbench.
//
// A space is one small repetitive task: prompt + model + interval + a
// persistent "briefcase" of carry-forward notes. Each run executes the task
// once via generate() (inheriting the full provider fan-out, Local Mode and
// no-train headers) and ends with an optional "### BRIEFCASE UPDATE:" section
// that becomes the space's new briefcase — so agents accumulate context run
// over run.
//
// Execution model (same house pattern as Congress): no background workers.
// POST /api/spaces/tick runs at most a few due spaces per request; the
// workbench page and each popped-out window poll it while visible.

import { db } from "@/db";
import { spaceRuns, spaces } from "@/db/schema";
import { asc, desc, eq, sql } from "drizzle-orm";
import { generate } from "@/lib/ai";
import { getModel } from "@/lib/models";

// ---------------- types ----------------

export interface SpaceGenOpts {
  keys?: { openrouter?: string; groq?: string; gemini?: string; turboagent?: string };
  localOnly?: boolean;
}

interface SpaceRowLike {
  id: string;
  title: string;
  emoji: string;
  prompt: string;
  modelId: string;
  intervalMinutes: number;
  status: string;
  briefcase: string;
  lastOutput: string | null;
  lastRunAt: string | null; // ISO
  nextRunAt: string | null; // ISO
  runCount: number;
  okCount: number;
  projectId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SpaceRun {
  id: string;
  status: string;
  output: string;
  via: string;
  ms: number;
  createdAt: string;
}

export interface SpaceState {
  id: string;
  title: string;
  emoji: string;
  prompt: string;
  modelId: string;
  intervalMinutes: number;
  status: "running" | "paused";
  briefcase: string;
  lastOutput: string | null;
  lastRunAt: string | null;
  nextRunAt: string | null;
  runCount: number;
  okCount: number;
  projectId: string | null;
  createdAt: string;
  updatedAt: string;
  due: boolean; // nextRunAt <= now
}

// ---------------- persistence (DB + memory fallback) ----------------

let tableReady = false;
let dbHealthy = true;
const memorySpaces = new Map<string, SpaceRowLike>();
const memoryRuns = new Map<string, SpaceRun[]>();
const inflight = new Set<string>();

async function ensureTables(): Promise<void> {
  if (tableReady) return;
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "spaces" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "title" text DEFAULT 'Untitled space' NOT NULL,
        "emoji" text DEFAULT '🤖' NOT NULL,
        "prompt" text NOT NULL,
        "model_id" text DEFAULT 'openai' NOT NULL,
        "interval_minutes" integer DEFAULT 60 NOT NULL,
        "status" text DEFAULT 'running' NOT NULL,
        "briefcase" text DEFAULT '' NOT NULL,
        "last_output" text,
        "last_run_at" timestamp,
        "next_run_at" timestamp,
        "run_count" integer DEFAULT 0 NOT NULL,
        "ok_count" integer DEFAULT 0 NOT NULL,
        "project_id" uuid,
        "created_at" timestamp DEFAULT now() NOT NULL,
        "updated_at" timestamp DEFAULT now() NOT NULL
      );
    `);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "space_runs" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "space_id" uuid NOT NULL,
        "status" text DEFAULT 'ok' NOT NULL,
        "output" text DEFAULT '' NOT NULL,
        "via" text DEFAULT '' NOT NULL,
        "ms" integer DEFAULT 0 NOT NULL,
        "created_at" timestamp DEFAULT now() NOT NULL
      );
    `);
    tableReady = true;
    dbHealthy = true;
  } catch {
    dbHealthy = false;
  }
}

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function rowFromDb(r: typeof spaces.$inferSelect): SpaceRowLike {
  return {
    id: r.id,
    title: r.title,
    emoji: r.emoji,
    prompt: r.prompt,
    modelId: r.modelId,
    intervalMinutes: r.intervalMinutes,
    status: r.status,
    briefcase: r.briefcase,
    lastOutput: r.lastOutput ?? null,
    lastRunAt: r.lastRunAt ? new Date(r.lastRunAt).toISOString() : null,
    nextRunAt: r.nextRunAt ? new Date(r.nextRunAt).toISOString() : null,
    runCount: r.runCount,
    okCount: r.okCount,
    projectId: r.projectId ?? null,
    createdAt: new Date(r.createdAt ?? new Date()).toISOString(),
    updatedAt: new Date(r.updatedAt ?? new Date()).toISOString(),
  };
}

async function loadSpace(id: string): Promise<SpaceRowLike | null> {
  try {
    await ensureTables();
    if (dbHealthy) {
      const rows = await db.select().from(spaces).where(eq(spaces.id, id)).limit(1);
      if (rows.length) return rowFromDb(rows[0]);
      return null;
    }
  } catch {
    dbHealthy = false;
  }
  return memorySpaces.get(id) ?? null;
}

async function persistSpace(row: SpaceRowLike): Promise<void> {
  row.updatedAt = new Date().toISOString();
  memorySpaces.set(row.id, row);
  try {
    if (!dbHealthy) return;
    await db
      .update(spaces)
      .set({
        title: row.title,
        emoji: row.emoji,
        prompt: row.prompt,
        modelId: row.modelId,
        intervalMinutes: row.intervalMinutes,
        status: row.status,
        briefcase: row.briefcase,
        lastOutput: row.lastOutput,
        lastRunAt: row.lastRunAt ? new Date(row.lastRunAt) : null,
        nextRunAt: row.nextRunAt ? new Date(row.nextRunAt) : null,
        runCount: row.runCount,
        okCount: row.okCount,
        updatedAt: new Date(),
      })
      .where(eq(spaces.id, row.id));
  } catch {
    dbHealthy = false;
  }
}

async function insertRun(spaceId: string, run: Omit<SpaceRun, "id" | "createdAt">): Promise<void> {
  const full: SpaceRun = { ...run, id: newId(), createdAt: new Date().toISOString() };
  const list = memoryRuns.get(spaceId) ?? [];
  list.push(full);
  memoryRuns.set(spaceId, list.slice(-200));
  try {
    if (!dbHealthy) return;
    await db.insert(spaceRuns).values({
      spaceId,
      status: full.status,
      output: full.output.slice(0, 12000),
      via: full.via,
      ms: full.ms,
    });
  } catch {
    dbHealthy = false;
  }
}

// ---------------- public state ----------------

function publicSpace(row: SpaceRowLike): SpaceState {
  return {
    ...row,
    status: row.status === "paused" ? "paused" : "running",
    due: row.status === "running" && (!row.nextRunAt || new Date(row.nextRunAt).getTime() <= Date.now()),
  };
}

export async function listSpaces(): Promise<SpaceState[]> {
  try {
    await ensureTables();
    if (dbHealthy) {
      const rows = await db.select().from(spaces).orderBy(asc(spaces.createdAt));
      return rows.map((r) => publicSpace(rowFromDb(r)));
    }
  } catch {
    dbHealthy = false;
  }
  return [...memorySpaces.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(publicSpace);
}

export async function getSpace(id: string): Promise<SpaceState | null> {
  const row = await loadSpace(id);
  return row ? publicSpace(row) : null;
}

export async function getSpaceRuns(id: string, limit = 25): Promise<SpaceRun[]> {
  try {
    await ensureTables();
    if (dbHealthy) {
      const rows = await db
        .select()
        .from(spaceRuns)
        .where(eq(spaceRuns.spaceId, id))
        .orderBy(desc(spaceRuns.createdAt))
        .limit(limit);
      return rows.map((r) => ({
        id: r.id,
        status: r.status,
        output: r.output,
        via: r.via,
        ms: r.ms,
        createdAt: new Date(r.createdAt ?? new Date()).toISOString(),
      }));
    }
  } catch {
    dbHealthy = false;
  }
  return (memoryRuns.get(id) ?? []).slice(-limit).reverse();
}

// ---------------- create / update / delete ----------------

export interface CreateSpaceInput {
  title: string;
  emoji?: string;
  prompt: string;
  modelId?: string;
  intervalMinutes?: number;
  briefcase?: string;
  projectId?: string | null;
}

function validModel(id: string): string {
  try {
    const m = getModel(id);
    return m.kind === "text" ? m.id : "openai";
  } catch {
    return "openai";
  }
}

export async function createSpace(input: CreateSpaceInput): Promise<SpaceState> {
  const prompt = input.prompt.trim().slice(0, 8000);
  if (!prompt) throw new Error("prompt is required");
  const intervalMinutes = Math.max(5, Math.min(1440, Math.round(input.intervalMinutes ?? 60)));
  const now = new Date().toISOString();
  const row: SpaceRowLike = {
    id: newId(),
    title: (input.title || "Untitled space").trim().slice(0, 120),
    emoji: (input.emoji || "🤖").slice(0, 8),
    prompt,
    modelId: validModel(input.modelId ?? "openai"),
    intervalMinutes,
    status: "running",
    briefcase: (input.briefcase ?? "").slice(0, 8000),
    lastOutput: null,
    lastRunAt: null,
    nextRunAt: null, // due immediately — first run happens on the next tick
    runCount: 0,
    okCount: 0,
    projectId: input.projectId ? String(input.projectId) : null,
    createdAt: now,
    updatedAt: now,
  };
  memorySpaces.set(row.id, row);
  memoryRuns.set(row.id, []);
  try {
    await ensureTables();
    if (dbHealthy) {
      await db.insert(spaces).values({
        id: row.id,
        title: row.title,
        emoji: row.emoji,
        prompt: row.prompt,
        modelId: row.modelId,
        intervalMinutes: row.intervalMinutes,
        briefcase: row.briefcase,
        projectId: row.projectId,
      });
    }
  } catch {
    dbHealthy = false;
  }
  return publicSpace(row);
}

export interface UpdateSpaceInput {
  title?: string;
  emoji?: string;
  prompt?: string;
  modelId?: string;
  intervalMinutes?: number;
  status?: "running" | "paused";
  briefcase?: string;
}

export async function updateSpace(id: string, patch: UpdateSpaceInput): Promise<SpaceState | null> {
  const row = await loadSpace(id);
  if (!row) return null;
  if (patch.title !== undefined) row.title = patch.title.trim().slice(0, 120) || row.title;
  if (patch.emoji !== undefined) row.emoji = patch.emoji.slice(0, 8) || row.emoji;
  if (patch.prompt !== undefined && patch.prompt.trim()) row.prompt = patch.prompt.trim().slice(0, 8000);
  if (patch.modelId !== undefined) row.modelId = validModel(patch.modelId);
  if (patch.intervalMinutes !== undefined) {
    row.intervalMinutes = Math.max(5, Math.min(1440, Math.round(patch.intervalMinutes)));
  }
  if (patch.status !== undefined) row.status = patch.status === "paused" ? "paused" : "running";
  if (patch.briefcase !== undefined) row.briefcase = patch.briefcase.slice(0, 8000);
  await persistSpace(row);
  return publicSpace(row);
}

export async function deleteSpace(id: string): Promise<boolean> {
  const existed = memorySpaces.has(id) || (await loadSpace(id)) !== null;
  memorySpaces.delete(id);
  memoryRuns.delete(id);
  try {
    await ensureTables();
    if (dbHealthy) {
      await db.execute(sql`DELETE FROM "space_runs" WHERE "space_id" = ${id}`);
      await db.execute(sql`DELETE FROM "spaces" WHERE "id" = ${id}`);
    }
  } catch {
    dbHealthy = false;
  }
  return existed;
}

// ---------------- execution ----------------

const BRIEFCASE_MARKER = "### BRIEFCASE UPDATE:";

function runUserPrompt(row: SpaceRowLike): string {
  return (
    `TASK (runs on a repeating schedule, every ${row.intervalMinutes} minutes):\n${row.prompt}\n\n` +
    `BRIEFCASE (persistent notes carried between runs — the human can edit it):\n${row.briefcase || "(empty)"}\n\n` +
    (row.lastOutput
      ? `YOUR PREVIOUS OUTPUT (for continuity, don't repeat yourself):\n${row.lastOutput.slice(0, 1500)}\n\n`
      : "") +
    `Produce this run's output now — compact and immediately usable by the human. ` +
    `If the task benefits from carrying state forward, end with:\n${BRIEFCASE_MARKER}\n(consolidated notes that REPLACE the briefcase — keep under ~250 words)`
  );
}

export async function runSpace(id: string, opts: SpaceGenOpts): Promise<SpaceState | null> {
  const row = await loadSpace(id);
  if (!row) return null;
  const started = Date.now();
  try {
    const result = await generate({
      modelId: row.modelId,
      messages: [{ role: "user", content: runUserPrompt(row) }],
      system:
        "You are a diligent automation agent running one iteration of a small recurring task inside the human's workspace. " +
        "Produce output the human can use immediately. Never pretend to have taken actions (posting, sending, buying) — you draft, the human acts.",
      temperature: 0.6,
      keys: opts.localOnly ? undefined : opts.keys,
      localOnly: opts.localOnly,
    });
    const raw = result.text;
    let output = raw;
    let briefcase = row.briefcase;
    const idx = raw.indexOf(BRIEFCASE_MARKER);
    if (idx >= 0) {
      output = raw.slice(0, idx).trim();
      const next = raw.slice(idx + BRIEFCASE_MARKER.length).trim();
      if (next) briefcase = next.slice(0, 8000);
    }
    row.runCount += 1;
    row.okCount += 1;
    row.lastOutput = output.slice(0, 8000) || raw.slice(0, 8000);
    row.briefcase = briefcase;
    row.lastRunAt = new Date().toISOString();
    row.nextRunAt = new Date(Date.now() + row.intervalMinutes * 60_000).toISOString();
    await persistSpace(row);
    await insertRun(id, { status: "ok", output: row.lastOutput, via: result.via, ms: Date.now() - started });
  } catch (e) {
    row.runCount += 1;
    row.lastRunAt = new Date().toISOString();
    row.nextRunAt = new Date(Date.now() + row.intervalMinutes * 60_000).toISOString();
    await persistSpace(row);
    await insertRun(id, {
      status: "error",
      output: e instanceof Error ? e.message.slice(0, 500) : "run failed",
      via: "",
      ms: Date.now() - started,
    });
  }
  return publicSpace(row);
}

// Tick: run up to `limit` due spaces (bounded work per request).
export async function tickSpaces(
  limit: number,
  opts: SpaceGenOpts
): Promise<{ ran: string[]; spaces: SpaceState[] }> {
  const all = await listSpaces();
  const due = all.filter((s) => s.due && s.status === "running" && !inflight.has(s.id)).slice(0, limit);
  const ran: string[] = [];
  for (const s of due) {
    inflight.add(s.id);
    try {
      await runSpace(s.id, opts);
      ran.push(s.id);
    } finally {
      inflight.delete(s.id);
    }
  }
  return { ran, spaces: await listSpaces() };
}
