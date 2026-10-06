// Congress — timed multi-seat deliberation with durable records.
//
// A congress "sits" for a set amount of wall-clock time: seats (role + model)
// speak in round-robin, each turn generated on demand (bounded work per
// request — the client polls /advance while the page is open). When the clock
// runs out (or the chamber closes early / hits the turn cap) the Clerk drafts
// the Act: a self-contained resolution document that is saved to the artifact
// library (and project memory when linked). Sessions can be adjourned and
// resumed, and reconvened as a new sitting seeded with the previous Act —
// results compound over time.
//
// Persistence follows the house pattern: Postgres best-effort with an
// in-memory fallback, so the chamber works even when the DB is down.

import { db } from "@/db";
import { artifacts, congressSessions, congressTurns, projectMemory } from "@/db/schema";
import { desc, eq, sql } from "drizzle-orm";
import { generate } from "@/lib/ai";
import { getModel, textModels } from "@/lib/models";

// ---------------- roles ----------------

export { CONGRESS_ROLES, getCongressRole, type CongressRole } from "./congressRoles";
import { getCongressRole as getRole } from "./congressRoles";

// ---------------- types ----------------

export interface CongressSeat {
  label?: string;
  role: string; // role id
  modelId: string;
  emoji?: string;
}

interface SessionRow {
  id: string;
  title: string;
  topic: string;
  projectId: string | null;
  status: string;
  seats: string; // JSON
  synthesisModel: string;
  durationMs: number;
  remainingMs: number | null;
  endsAt: string | null; // ISO
  turnCount: number;
  nextSeat: number;
  maxTurns: number;
  act: string | null;
  parentSessionId: string | null;
  sitting: number;
  createdAt: string;
  updatedAt: string;
}

export interface CongressTurn {
  id: string;
  seatIndex: number;
  role: string;
  label: string;
  modelId: string;
  content: string;
  kind: string;
  createdAt: string;
}

export interface CongressState {
  id: string;
  title: string;
  topic: string;
  projectId: string | null;
  status: "sitting" | "adjourned" | "closed";
  seats: CongressSeat[];
  synthesisModel: string;
  durationMs: number;
  remainingMs: number | null;
  endsAt: string | null;
  turnCount: number;
  maxTurns: number;
  act: string | null;
  parentSessionId: string | null;
  sitting: number;
  createdAt: string;
  updatedAt: string;
  turns: CongressTurn[];
  msRemaining: number; // live: >0 while sitting
}

export interface CongressGenOpts {
  keys?: { openrouter?: string; groq?: string; gemini?: string; turboagent?: string };
  localOnly?: boolean;
}

// ---------------- persistence (DB + memory fallback) ----------------

let tableReady = false;
let dbHealthy = true;

const memorySessions = new Map<string, SessionRow>();
const memoryTurns = new Map<string, CongressTurn[]>();
const inflight = new Set<string>();

async function ensureTables(): Promise<void> {
  if (tableReady) return;
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "congress_sessions" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "title" text DEFAULT 'Untitled congress' NOT NULL,
        "topic" text NOT NULL,
        "project_id" uuid,
        "status" text DEFAULT 'sitting' NOT NULL,
        "seats" text DEFAULT '[]' NOT NULL,
        "synthesis_model" text DEFAULT 'openai' NOT NULL,
        "duration_ms" integer DEFAULT 600000 NOT NULL,
        "remaining_ms" integer,
        "ends_at" timestamp,
        "turn_count" integer DEFAULT 0 NOT NULL,
        "next_seat" integer DEFAULT 0 NOT NULL,
        "max_turns" integer DEFAULT 50 NOT NULL,
        "act" text,
        "parent_session_id" uuid,
        "sitting" integer DEFAULT 1 NOT NULL,
        "created_at" timestamp DEFAULT now() NOT NULL,
        "updated_at" timestamp DEFAULT now() NOT NULL
      );
    `);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "congress_turns" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "session_id" uuid NOT NULL,
        "seat_index" integer DEFAULT -1 NOT NULL,
        "role" text DEFAULT '' NOT NULL,
        "label" text DEFAULT '' NOT NULL,
        "model_id" text DEFAULT '' NOT NULL,
        "content" text NOT NULL,
        "kind" text DEFAULT 'speech' NOT NULL,
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
  return globalThis.crypto?.randomUUID?.() ?? `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function rowFromDb(r: typeof congressSessions.$inferSelect): SessionRow {
  return {
    id: r.id,
    title: r.title,
    topic: r.topic,
    projectId: r.projectId ?? null,
    status: r.status,
    seats: r.seats,
    synthesisModel: r.synthesisModel,
    durationMs: r.durationMs,
    remainingMs: r.remainingMs ?? null,
    endsAt: r.endsAt ? new Date(r.endsAt).toISOString() : null,
    turnCount: r.turnCount,
    nextSeat: r.nextSeat,
    maxTurns: r.maxTurns,
    act: r.act ?? null,
    parentSessionId: r.parentSessionId ?? null,
    sitting: r.sitting,
    createdAt: new Date(r.createdAt ?? new Date()).toISOString(),
    updatedAt: new Date(r.updatedAt ?? new Date()).toISOString(),
  };
}

async function loadSession(id: string): Promise<SessionRow | null> {
  try {
    await ensureTables();
    if (dbHealthy) {
      const rows = await db.select().from(congressSessions).where(eq(congressSessions.id, id)).limit(1);
      if (rows.length) return rowFromDb(rows[0]);
      return null;
    }
  } catch {
    dbHealthy = false;
  }
  return memorySessions.get(id) ?? null;
}

async function loadTurns(sessionId: string, limit = 400): Promise<CongressTurn[]> {
  try {
    await ensureTables();
    if (dbHealthy) {
      const rows = await db.select().from(congressTurns).where(eq(congressTurns.sessionId, sessionId)).limit(limit);
      return rows.map((t) => ({
        id: t.id,
        seatIndex: t.seatIndex,
        role: t.role,
        label: t.label,
        modelId: t.modelId,
        content: t.content,
        kind: t.kind,
        createdAt: new Date(t.createdAt ?? new Date()).toISOString(),
      }));
    }
  } catch {
    dbHealthy = false;
  }
  return memoryTurns.get(sessionId) ?? [];
}

async function saveSession(row: SessionRow): Promise<void> {
  row.updatedAt = new Date().toISOString();
  memorySessions.set(row.id, row);
  try {
    if (!dbHealthy) return;
    await db
      .update(congressSessions)
      .set({
        status: row.status,
        remainingMs: row.remainingMs,
        endsAt: row.endsAt ? new Date(row.endsAt) : null,
        turnCount: row.turnCount,
        nextSeat: row.nextSeat,
        act: row.act,
        updatedAt: new Date(),
      })
      .where(eq(congressSessions.id, row.id));
  } catch {
    dbHealthy = false;
  }
}

async function insertTurn(sessionId: string, turn: Omit<CongressTurn, "id" | "createdAt">): Promise<CongressTurn> {
  const full: CongressTurn = { ...turn, id: newId(), createdAt: new Date().toISOString() };
  const list = memoryTurns.get(sessionId) ?? [];
  list.push(full);
  memoryTurns.set(sessionId, list);
  try {
    if (!dbHealthy) return full;
    await db.insert(congressTurns).values({
      sessionId,
      seatIndex: full.seatIndex,
      role: full.role,
      label: full.label,
      modelId: full.modelId,
      content: full.content,
      kind: full.kind,
    });
  } catch {
    dbHealthy = false;
  }
  return full;
}

// ---------------- create / reconvene ----------------

export interface CreateCongressInput {
  title?: string;
  topic: string;
  seats: CongressSeat[];
  synthesisModel?: string;
  durationMinutes?: number;
  maxTurns?: number;
  projectId?: string | null;
  reconveneOf?: string;
}

function validModel(id: string): string {
  try {
    const m = getModel(id);
    return m.kind === "text" ? m.id : "openai";
  } catch {
    return "openai";
  }
}

function sanitizeSeats(seats: CongressSeat[]): CongressSeat[] {
  return seats
    .slice(0, 8)
    .map((s, i) => ({
      label: String(s.label ?? "").slice(0, 60) || `${getRole(String(s.role)).label} ${i + 1}`,
      role: getRole(String(s.role)).id,
      modelId: validModel(String(s.modelId ?? "openai")),
      emoji: getRole(String(s.role)).emoji,
    }));
}

export async function createCongress(input: CreateCongressInput): Promise<CongressState> {
  const topic = input.topic.trim().slice(0, 4000);
  if (!topic) throw new Error("topic is required");
  const seats = sanitizeSeats(input.seats?.length ? input.seats : defaultSeats());
  if (seats.length < 2) throw new Error("a congress needs at least 2 seats");
  const durationMs = Math.max(30_000, Math.min(6 * 60 * 60_000, Math.round((input.durationMinutes ?? 10) * 60_000)));
  const maxTurns = Math.max(3, Math.min(400, input.maxTurns ?? Math.ceil(durationMs / 20_000) + 6));
  const synthesisModel = validModel(input.synthesisModel ?? "openai");
  const now = new Date().toISOString();

  let parent: SessionRow | null = null;
  let sitting = 1;
  let title = (input.title ?? "").trim().slice(0, 160) || `Congress on ${topic.slice(0, 60)}`;
  if (input.reconveneOf) {
    parent = await loadSession(input.reconveneOf);
    if (parent) {
      sitting = parent.sitting + 1;
      title = parent.title;
    }
  }

  const row: SessionRow = {
    id: newId(),
    title,
    topic: parent && !input.topic?.trim() ? parent.topic : topic,
    projectId: input.projectId ? String(input.projectId) : parent?.projectId ?? null,
    status: "sitting",
    seats: JSON.stringify(seats),
    synthesisModel,
    durationMs,
    remainingMs: null,
    endsAt: new Date(Date.now() + durationMs).toISOString(),
    turnCount: 0,
    nextSeat: 0,
    maxTurns,
    act: null,
    parentSessionId: parent?.id ?? null,
    sitting,
    createdAt: now,
    updatedAt: now,
  };
  memorySessions.set(row.id, row);
  memoryTurns.set(row.id, []);
  try {
    await ensureTables();
    if (dbHealthy) {
      await db.insert(congressSessions).values({
        id: row.id,
        title: row.title,
        topic: row.topic,
        projectId: row.projectId,
        status: row.status,
        seats: row.seats,
        synthesisModel: row.synthesisModel,
        durationMs: row.durationMs,
        endsAt: new Date(row.endsAt!),
        maxTurns: row.maxTurns,
        parentSessionId: row.parentSessionId,
        sitting: row.sitting,
      });
    }
  } catch {
    dbHealthy = false;
  }

  if (parent?.act) {
    await insertTurn(row.id, {
      seatIndex: -1,
      role: "clerk",
      label: "Clerk",
      modelId: "",
      kind: "system",
      content: `The ${ordinal(sitting)} sitting reconvenes. The Act of the previous sitting is before the chamber:\n\n${parent.act.slice(0, 6000)}`,
    });
  }
  return publicState(row, await loadTurns(row.id));
}

function defaultSeats(): CongressSeat[] {
  const pool = textModels().filter((m) => m.id !== "offline-sage");
  const pick = (i: number) => pool[i % pool.length]?.id ?? "openai";
  return [
    { role: "chair", modelId: "openai" },
    { role: "proposer", modelId: pick(1) },
    { role: "skeptic", modelId: pick(2) },
  ];
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// ---------------- state ----------------

function publicState(row: SessionRow, turns: CongressTurn[]): CongressState {
  const seats = safeParseSeats(row.seats);
  const msRemaining =
    row.status === "sitting" && row.endsAt ? Math.max(0, new Date(row.endsAt).getTime() - Date.now()) : row.remainingMs ?? 0;
  return {
    id: row.id,
    title: row.title,
    topic: row.topic,
    projectId: row.projectId,
    status: row.status as CongressState["status"],
    seats,
    synthesisModel: row.synthesisModel,
    durationMs: row.durationMs,
    remainingMs: row.remainingMs,
    endsAt: row.endsAt,
    turnCount: row.turnCount,
    maxTurns: row.maxTurns,
    act: row.act,
    parentSessionId: row.parentSessionId,
    sitting: row.sitting,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    turns,
    msRemaining,
  };
}

function safeParseSeats(s: string): CongressSeat[] {
  try {
    const parsed = JSON.parse(s || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function getCongress(id: string): Promise<CongressState | null> {
  const row = await loadSession(id);
  if (!row) return null;
  return publicState(row, await loadTurns(id));
}

export async function listCongresses(limit = 30): Promise<CongressState[]> {
  try {
    await ensureTables();
    if (dbHealthy) {
      const rows = await db.select().from(congressSessions).orderBy(desc(congressSessions.createdAt)).limit(limit);
      const out: CongressState[] = [];
      for (const r of rows) {
        const row = rowFromDb(r);
        out.push(publicState(row, []));
      }
      return out;
    }
  } catch {
    dbHealthy = false;
  }
  return [...memorySessions.values()]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit)
    .map((r) => publicState(r, []));
}

// ---------------- prompt building ----------------

function seatSystemPrompt(seat: CongressSeat, topic: string): string {
  const role = getRole(seat.role);
  return (
    `You are the ${role.label} (${role.emoji}) of a congress sitting on the topic:\n"${topic.slice(0, 1500)}"\n\n` +
    `${role.instruction}\n\n` +
    `Floor rules: speak in 2-6 sentences, plain text (no headings, no markdown lists unless essential). ` +
    `Address colleagues by role. Build on what was said — no repetition. Aim for outcomes that will still make sense when read months from now.`
  );
}

function floorContext(row: SessionRow, seats: CongressSeat[], turns: CongressTurn[], seatIndex: number): string {
  const role = getRole(seats[seatIndex]?.role ?? "proposer");
  const remainingMin = row.endsAt ? Math.max(0, (new Date(row.endsAt).getTime() - Date.now()) / 60_000) : 0;
  const seatList = seats.map((s, i) => `${getRole(s.role).emoji} ${getRole(s.role).label} (seat ${i + 1}, model ${s.modelId})`).join("; ");
  const recent = turns
    .filter((t) => t.kind === "speech" || t.kind === "system")
    .slice(-10)
    .map((t) => {
      const who = t.kind === "system" ? "CLERK" : `${t.label || t.role} (seat ${t.seatIndex + 1})`;
      return `${who}: ${t.content.slice(0, 1400)}`;
    })
    .join("\n\n");
  const isFirst = turns.filter((t) => t.kind === "speech").length === 0;
  return (
    `Congress record — sitting ${row.sitting}, turn ${row.turnCount + 1} of at most ${row.maxTurns}. ` +
    `About ${remainingMin < 1 ? "less than a minute" : `${Math.round(remainingMin)} minute(s)`} remain on the clock.\n\n` +
    `Seats present: ${seatList}\n\n` +
    `Topic: ${row.topic.slice(0, 1500)}\n\n` +
    `Proceedings so far:\n${recent || "(the floor has not yet been opened)"}\n\n` +
    (isFirst
      ? `You open the sitting as the ${role.label}. Frame the topic and state what this sitting should settle.`
      : `It is your turn to speak as the ${role.label}. Advance the deliberation — do not merely agree.`)
  );
}

function actPrompt(row: SessionRow, seats: CongressSeat[], turns: CongressTurn[]): string {
  const record = turns
    .slice(-24)
    .map((t) => `${t.kind === "system" ? "CLERK" : `${t.label || t.role} (seat ${t.seatIndex + 1})`}: ${t.content.slice(0, 1600)}`)
    .join("\n\n");
  return (
    `Compile the final Act of the congress from these proceedings.\n\n` +
    `Title: ${row.title} (sitting ${row.sitting})\nTopic: ${row.topic.slice(0, 2000)}\n\n` +
    `Proceedings:\n${record}\n\n` +
    `Write the Act for a reader who was not present. Structure it exactly as:\n` +
    `## Resolutions\n(numbered, self-contained, durable statements of what this congress settled)\n` +
    `## Decisions\n(specific choices made, with rationale in one line each)\n` +
    `## Open Questions\n(what remains unsettled — feed these to the next sitting)\n` +
    `## Next Steps\n(concrete, assignable actions)\n\n` +
    `No preamble, no filler. If the chamber was thin on substance, say so in Open Questions rather than inventing content.`
  );
}

// ---------------- the step engine ----------------

export type AdvanceResult =
  | { done: false; state: CongressState }
  | { done: true; closed: true; state: CongressState };

// One bounded step: a single seat speaks, or (when time/turns are exhausted)
// the Clerk drafts the Act and the session closes. Safe to call repeatedly.
export async function advanceCongress(id: string, opts: CongressGenOpts): Promise<AdvanceResult | null> {
  if (inflight.has(id)) {
    const row = await loadSession(id);
    return row ? { done: false, state: publicState(row, await loadTurns(id)) } : null;
  }
  inflight.add(id);
  try {
    const row = await loadSession(id);
    if (!row) return null;
    if (row.status === "closed") {
      return { done: true, closed: true, state: publicState(row, await loadTurns(id)) };
    }
    if (row.status === "adjourned") {
      return { done: false, state: publicState(row, await loadTurns(id)) };
    }

    const seats = safeParseSeats(row.seats);
    if (!seats.length) {
      row.status = "closed";
      row.act = "The chamber could not be seated.";
      await saveSession(row);
      return { done: true, closed: true, state: publicState(row, await loadTurns(id)) };
    }

    const timeUp = !row.endsAt || new Date(row.endsAt).getTime() - Date.now() <= 0;
    const turnsUsed = row.turnCount >= row.maxTurns;

    if (timeUp || turnsUsed) {
      await closeWithAct(row, seats, opts);
      return { done: true, closed: true, state: publicState(row, await loadTurns(id)) };
    }

    // ---- next seat speaks ----
    const seatIndex = ((row.nextSeat % seats.length) + seats.length) % seats.length;
    const seat = seats[seatIndex];
    const turns = await loadTurns(id);
    const result = await generate({
      modelId: seat.modelId,
      messages: [{ role: "user", content: floorContext(row, seats, turns, seatIndex) }],
      system: seatSystemPrompt(seat, row.topic),
      temperature: 0.75,
      keys: opts.localOnly ? undefined : opts.keys,
      localOnly: opts.localOnly,
    });
    await insertTurn(id, {
      seatIndex,
      role: seat.role,
      label: seat.label || getRole(seat.role).label,
      modelId: seat.modelId,
      content: result.text.slice(0, 6000),
      kind: "speech",
    });
    row.turnCount += 1;
    row.nextSeat = (seatIndex + 1) % seats.length;
    await saveSession(row);
    return { done: false, state: publicState(row, await loadTurns(id)) };
  } finally {
    inflight.delete(id);
  }
}

async function closeWithAct(row: SessionRow, seats: CongressSeat[], opts: CongressGenOpts): Promise<void> {
  const turns = await loadTurns(row.id);
  const result = await generate({
    modelId: row.synthesisModel,
    messages: [{ role: "user", content: actPrompt(row, seats, turns) }],
    system:
      "You are the Clerk of the Congress. You compile precise, durable Acts from deliberation records. You never invent agreements that were not reached.",
    temperature: 0.4,
    keys: opts.localOnly ? undefined : opts.keys,
    localOnly: opts.localOnly,
  });
  const act = result.text.slice(0, 20000);
  row.status = "closed";
  row.act = act;
  row.remainingMs = 0;
  await saveSession(row);
  await insertTurn(row.id, {
    seatIndex: -1,
    role: "clerk",
    label: "Clerk",
    modelId: row.synthesisModel,
    content: act,
    kind: "act",
  });

  // Durable results: artifact + project memory (best-effort; never fatal).
  try {
    await db.insert(artifacts).values({
      projectId: row.projectId,
      kind: "decision",
      title: `🏛️ Act — ${row.title.slice(0, 120)}`,
      body: `**Topic:** ${row.topic.slice(0, 2000)}\n\n${act}`.slice(0, 20000),
      sourceType: "congress",
      sourceId: row.id,
    });
  } catch {
    /* DB down — memory fallback already holds the record */
  }
  if (row.projectId) {
    try {
      await db.insert(projectMemory).values({
        projectId: row.projectId,
        kind: "decision",
        content: `🏛️ ${row.title} (sitting ${row.sitting}): ${act.slice(0, 400)}`,
      });
    } catch {
      /* best-effort */
    }
  }
}

// ---------------- lifecycle ----------------

export async function adjournCongress(id: string): Promise<CongressState | null> {
  const row = await loadSession(id);
  if (!row || row.status !== "sitting") return row ? publicState(row, await loadTurns(id)) : null;
  row.remainingMs = row.endsAt ? Math.max(0, new Date(row.endsAt).getTime() - Date.now()) : 0;
  row.status = "adjourned";
  await saveSession(row);
  await insertTurn(id, {
    seatIndex: -1,
    role: "clerk",
    label: "Clerk",
    modelId: "",
    kind: "system",
    content: "The sitting is adjourned. The clock is paused — resume to continue deliberation.",
  });
  return publicState(row, await loadTurns(id));
}

export async function resumeCongress(id: string): Promise<CongressState | null> {
  const row = await loadSession(id);
  if (!row || row.status !== "adjourned") return row ? publicState(row, await loadTurns(id)) : null;
  const remaining = row.remainingMs ?? 0;
  row.endsAt = new Date(Date.now() + Math.max(remaining, 30_000)).toISOString();
  row.remainingMs = null;
  row.status = "sitting";
  await saveSession(row);
  await insertTurn(id, {
    seatIndex: -1,
    role: "clerk",
    label: "Clerk",
    modelId: "",
    kind: "system",
    content: `The sitting resumes with ${Math.round(remaining / 60_000)} minute(s) remaining on the clock.`,
  });
  return publicState(row, await loadTurns(id));
}

export async function closeCongress(id: string, opts: CongressGenOpts): Promise<CongressState | null> {
  const row = await loadSession(id);
  if (!row) return null;
  if (row.status === "closed") return publicState(row, await loadTurns(id));
  const seats = safeParseSeats(row.seats);
  await closeWithAct(row, seats.length ? seats : defaultSeats(), opts);
  return publicState(row, await loadTurns(row.id));
}

export async function deleteCongress(id: string): Promise<boolean> {
  const existed = memorySessions.has(id) || (await loadSession(id)) !== null;
  memorySessions.delete(id);
  memoryTurns.delete(id);
  try {
    await ensureTables();
    if (dbHealthy) {
      await db.execute(sql`DELETE FROM "congress_turns" WHERE "session_id" = ${id}`);
      await db.execute(sql`DELETE FROM "congress_sessions" WHERE "id" = ${id}`);
    }
  } catch {
    dbHealthy = false;
  }
  return existed;
}
