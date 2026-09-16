// Collaboration Orchestrator — structured multi-participant AI collaboration.
//
// This automates the "human message bus" problem: instead of you ferrying
// prompts between Arena, ChatGPT, Grok, and Notion, a Collaboration Session
// holds a goal, shared context, and heterogeneous participants (arena models,
// external OpenAI-compatible AIs, and you — the human owner), connected by
// explicit Relays:
//
//   Relay = source → target, purpose, request, context refs, privacy
//   classification, response contract.
//
// Execution model (house pattern — no background workers): POST
// /api/orchestrator/[id]/advance performs ONE step: it dispatches the next
// pending relay to a model/external participant, or surfaces a pending
// human-targeted relay as a checkpoint (session → blocked) for the owner to
// answer. With autoRoute on, an idle session asks a conductor model for the
// next relay or a close decision — honestly declining to route when running
// offline.
//
// Privacy: every relay carries a classification. public → any participant;
// internal → internal-trust participants only; private → human participants
// only. The envelope sent to a participant contains only what the relay's
// classification permits — never the whole workspace.

import { db } from "@/db";
import { artifacts, collaborationParticipants, collaborationRelays, collaborations } from "@/db/schema";
import { asc, desc, eq, sql } from "drizzle-orm";
import { generate } from "@/lib/ai";
import { getModel } from "@/lib/models";
import { preferencesBriefFor } from "@/lib/preferences";
import { getTool } from "@/lib/assistantTools";

// ---------------- types ----------------

export type ParticipantKind = "model" | "human" | "external";
export type TrustLevel = "internal" | "external";
export type Classification = "public" | "internal" | "private";
export type RelayStatus = "pending" | "responded" | "cancelled" | "failed";
export type CollaborationStatus = "running" | "blocked" | "closed";

export interface OrchestratorKeys {
  openrouter?: string;
  groq?: string;
  gemini?: string;
  turboagent?: string;
  externalBearer?: string; // bearer token for kind=external adapters
}

export interface Participant {
  id: string;
  collaborationId: string;
  key: string;
  name: string;
  emoji: string;
  kind: ParticipantKind;
  modelId: string | null;
  adapterUrl: string | null;
  adapterModel: string | null;
  capabilities: string[];
  trust: TrustLevel;
}

export interface RelayToolStep {
  tool: string;
  ok: boolean;
  ms: number;
  summary: string;
}

export interface Relay {
  id: string;
  collaborationId: string;
  seq: number;
  sourceKey: string;
  targetKey: string;
  purpose: string;
  request: string;
  contextRefs: string[];
  classification: Classification;
  responseContract: string;
  status: RelayStatus;
  response: string | null;
  via: string;
  note: string;
  toolUse: boolean;
  steps: RelayToolStep[];
  createdAt: string;
}

export interface Collaboration {
  id: string;
  title: string;
  goal: string;
  context: string;
  status: CollaborationStatus;
  autoRoute: boolean;
  projectId: string | null;
  createdAt: string;
  updatedAt: string;
  participants: Participant[];
  relays: Relay[];
}

export interface ParticipantInput {
  key?: string;
  name: string;
  emoji?: string;
  kind?: string;
  modelId?: string;
  adapterUrl?: string;
  adapterModel?: string;
  capabilities?: string[];
  trust?: string;
}

export interface RelayInput {
  source?: string;
  target: string;
  purpose?: string;
  request: string;
  contextRefs?: string[];
  classification?: string;
  responseContract?: string;
  toolUse?: boolean;
}

export interface CreateCollaborationInput {
  title?: string;
  goal: string;
  context?: string;
  autoRoute?: boolean;
  projectId?: string | null;
  participants: ParticipantInput[];
  relay?: RelayInput | null;
}

export interface AdvanceResult {
  ran: "relay" | "checkpoint" | "blocked-relay" | "autoroute" | "close" | "idle" | "closed";
  note: string;
  collaboration: Collaboration;
}

const MAX_RELAYS = 24;
const ENVELOPE_CHAR_LIMIT = 9000;

// ---------------- storage (DB + memory fallback) ----------------

const memoryCollabs = new Map<string, Collaboration>();
let dbHealthy = true;
let tableReady = false;

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `o${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "participant"
  );
}

async function ensureTables(): Promise<void> {
  if (tableReady) return;
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "collaborations" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "title" text DEFAULT 'Untitled collaboration' NOT NULL,
        "goal" text NOT NULL,
        "context" text DEFAULT '' NOT NULL,
        "status" text DEFAULT 'running' NOT NULL,
        "auto_route" integer DEFAULT 0 NOT NULL,
        "project_id" uuid,
        "created_at" timestamp DEFAULT now() NOT NULL,
        "updated_at" timestamp DEFAULT now() NOT NULL
      );
    `);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "collaboration_participants" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "collaboration_id" uuid NOT NULL,
        "key" text NOT NULL,
        "name" text NOT NULL,
        "emoji" text DEFAULT '🤖' NOT NULL,
        "kind" text DEFAULT 'model' NOT NULL,
        "model_id" text,
        "adapter_url" text,
        "adapter_model" text,
        "capabilities" text DEFAULT '' NOT NULL,
        "trust" text DEFAULT 'internal' NOT NULL,
        "created_at" timestamp DEFAULT now() NOT NULL
      );
    `);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "collaboration_relays" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "collaboration_id" uuid NOT NULL,
        "seq" integer DEFAULT 1 NOT NULL,
        "source_key" text DEFAULT 'owner' NOT NULL,
        "target_key" text NOT NULL,
        "purpose" text DEFAULT 'contribute' NOT NULL,
        "request" text NOT NULL,
        "context_refs" text DEFAULT '' NOT NULL,
        "classification" text DEFAULT 'internal' NOT NULL,
        "response_contract" text DEFAULT 'markdown text' NOT NULL,
        "status" text DEFAULT 'pending' NOT NULL,
        "response" text,
        "via" text DEFAULT '' NOT NULL,
        "note" text DEFAULT '' NOT NULL,
        "created_at" timestamp DEFAULT now() NOT NULL,
        "updated_at" timestamp DEFAULT now() NOT NULL
      );
    `);
    tableReady = true;
    dbHealthy = true;
  } catch {
    dbHealthy = false;
  }
}

// ---------------- normalization helpers ----------------

function validModel(id: string | null | undefined): string | null {
  if (!id) return null;
  try {
    const m = getModel(id);
    return m.kind === "text" ? m.id : null;
  } catch {
    return null;
  }
}

function normKind(kind: string | null | undefined): ParticipantKind {
  return kind === "human" || kind === "external" ? kind : "model";
}

function normTrust(trust: string | null | undefined): TrustLevel {
  return trust === "external" ? "external" : "internal";
}

function normClassification(c: string | null | undefined): Classification {
  return c === "public" || c === "private" ? c : "internal";
}

function splitList(value: string | null | undefined): string[] {
  return String(value ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function participantFromRow(r: typeof collaborationParticipants.$inferSelect): Participant {
  return {
    id: r.id,
    collaborationId: r.collaborationId,
    key: r.key,
    name: r.name,
    emoji: r.emoji,
    kind: normKind(r.kind),
    modelId: r.modelId ?? null,
    adapterUrl: r.adapterUrl ?? null,
    adapterModel: r.adapterModel ?? null,
    capabilities: splitList(r.capabilities),
    trust: normTrust(r.trust),
  };
}

function relayFromRow(r: typeof collaborationRelays.$inferSelect): Relay {
  return {
    id: r.id,
    collaborationId: r.collaborationId,
    seq: r.seq,
    sourceKey: r.sourceKey,
    targetKey: r.targetKey,
    purpose: r.purpose,
    request: r.request,
    contextRefs: splitList(r.contextRefs),
    classification: normClassification(r.classification),
    responseContract: r.responseContract,
    status: (["pending", "responded", "cancelled", "failed"].includes(r.status) ? r.status : "pending") as RelayStatus,
    response: r.response ?? null,
    via: r.via ?? "",
    note: r.note ?? "",
    toolUse: Boolean(r.toolUse),
    steps: parseSteps(r.steps),
    createdAt: new Date(r.createdAt ?? new Date()).toISOString(),
  };
}

function parseSteps(raw: string | null | undefined): RelayToolStep[] {
  try {
    const parsed = JSON.parse(String(raw ?? "[]"));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((e): e is Record<string, unknown> => Boolean(e) && typeof e === "object")
      .slice(0, 8)
      .map((e) => ({
        tool: String(e.tool ?? "unknown"),
        ok: Boolean(e.ok),
        ms: Number(e.ms ?? 0),
        summary: String(e.summary ?? "").slice(0, 400),
      }));
  } catch {
    return [];
  }
}

// ---------------- read ----------------

export async function getCollaboration(id: string): Promise<Collaboration | null> {
  const memory = memoryCollabs.get(id);
  try {
    await ensureTables();
    if (dbHealthy) {
      const [row] = await db.select().from(collaborations).where(eq(collaborations.id, id)).limit(1);
      if (!row) return null;
      const pRows = await db
        .select()
        .from(collaborationParticipants)
        .where(eq(collaborationParticipants.collaborationId, id))
        .orderBy(asc(collaborationParticipants.createdAt));
      const rRows = await db
        .select()
        .from(collaborationRelays)
        .where(eq(collaborationRelays.collaborationId, id))
        .orderBy(asc(collaborationRelays.seq));
      return {
        id: row.id,
        title: row.title,
        goal: row.goal,
        context: row.context,
        status: (["running", "blocked", "closed"].includes(row.status) ? row.status : "running") as CollaborationStatus,
        autoRoute: Boolean(row.autoRoute),
        projectId: row.projectId ?? null,
        createdAt: new Date(row.createdAt ?? new Date()).toISOString(),
        updatedAt: new Date(row.updatedAt ?? new Date()).toISOString(),
        participants: pRows.map(participantFromRow),
        relays: rRows.map(relayFromRow),
      };
    }
  } catch {
    dbHealthy = false;
  }
  return memory ?? null;
}

export async function listCollaborations(limit = 30): Promise<Collaboration[]> {
  try {
    await ensureTables();
    if (dbHealthy) {
      const rows = await db.select().from(collaborations).orderBy(desc(collaborations.updatedAt)).limit(Math.min(limit, 100));
      const result: Collaboration[] = [];
      for (const row of rows) {
        const full = await getCollaboration(row.id);
        if (full) result.push(full);
      }
      return result;
    }
  } catch {
    dbHealthy = false;
  }
  return [...memoryCollabs.values()]
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .slice(0, limit);
}

// ---------------- create ----------------

export async function createCollaboration(input: CreateCollaborationInput): Promise<Collaboration> {
  const goal = String(input.goal ?? "").trim().slice(0, 6000);
  if (!goal) throw new Error("a collaboration needs a goal");

  const rawParticipants = (input.participants ?? []).slice(0, 8);
  const cleaned: Participant[] = [];
  const usedKeys = new Set<string>();
  for (const raw of rawParticipants) {
    const name = String(raw.name ?? "").trim().slice(0, 80);
    if (!name) continue;
    const kind = normKind(raw.kind);
    let key = slug(raw.key || name);
    while (usedKeys.has(key)) key = `${key}-2`;
    usedKeys.add(key);
    const trust = normTrust(raw.trust);
    cleaned.push({
      id: newId(),
      collaborationId: "",
      key,
      name,
      emoji: (raw.emoji || (kind === "human" ? "🧑" : kind === "external" ? "🛰️" : "🤖")).slice(0, 8),
      kind,
      modelId: kind === "model" ? validModel(raw.modelId) ?? "openai" : null,
      adapterUrl: kind === "external" ? String(raw.adapterUrl ?? "").trim().slice(0, 300) || null : null,
      adapterModel: kind === "external" ? String(raw.adapterModel ?? "").trim().slice(0, 120) || null : null,
      capabilities: (raw.capabilities ?? []).map((c) => String(c).trim().slice(0, 40)).filter(Boolean).slice(0, 8),
      trust,
    });
  }
  if (!cleaned.length) throw new Error("a collaboration needs at least one participant");

  const collab: Collaboration = {
    id: newId(),
    title: String(input.title ?? "").trim().slice(0, 140) || `Collaboration — ${goal.slice(0, 60)}`,
    goal,
    context: String(input.context ?? "").trim().slice(0, 8000),
    status: "running",
    autoRoute: Boolean(input.autoRoute),
    projectId: input.projectId ?? null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    participants: cleaned,
    relays: [],
  };

  try {
    await ensureTables();
    if (dbHealthy) {
      const [row] = await db
        .insert(collaborations)
        .values({
          title: collab.title, goal: collab.goal, context: collab.context, status: collab.status,
          autoRoute: collab.autoRoute ? 1 : 0, projectId: collab.projectId,
        })
        .returning();
      if (row) collab.id = row.id;
      for (const p of cleaned) {
        const [pRow] = await db
          .insert(collaborationParticipants)
          .values({
            collaborationId: collab.id, key: p.key, name: p.name, emoji: p.emoji, kind: p.kind,
            modelId: p.modelId, adapterUrl: p.adapterUrl, adapterModel: p.adapterModel,
            capabilities: p.capabilities.join(","), trust: p.trust,
          })
          .returning();
        if (pRow) p.id = pRow.id;
        p.collaborationId = collab.id;
      }
    }
  } catch {
    dbHealthy = false;
  }
  memoryCollabs.set(collab.id, collab);

  if (input.relay && String(input.relay.request ?? "").trim()) {
    await addRelay(collab.id, input.relay);
  }
  return (await getCollaboration(collab.id)) ?? collab;
}

// ---------------- relays ----------------

export async function addRelay(collaborationId: string, input: RelayInput): Promise<Relay> {
  const collab = await getCollaboration(collaborationId);
  if (!collab) throw new Error("collaboration not found");
  if (collab.status === "closed") throw new Error("this collaboration is closed");
  if (collab.relays.length >= MAX_RELAYS) throw new Error(`relay limit reached (${MAX_RELAYS})`);

  const request = String(input.request ?? "").trim().slice(0, 8000);
  if (!request) throw new Error("a relay needs a request");
  const target = collab.participants.find((p) => p.key === input.target);
  if (!target) throw new Error(`unknown target participant "${input.target}"`);
  const source = input.source && input.source !== "owner"
    ? collab.participants.find((p) => p.key === input.source)?.key ?? "owner"
    : "owner";
  const classification = normClassification(input.classification);

  // egress policy is enforced at creation AND dispatch — fail early, honestly
  assertEgress(classification, target);

  // tool-capable relays are bounded: internal-trust model participants that
  // explicitly declared the tool_use capability, read/report tools only
  if (input.toolUse) {
    if (target.kind !== "model" || target.trust !== "internal" || !target.capabilities.includes("tool_use")) {
      throw new Error(
        `tool-capable relays require an internal-trust model participant with the "tool_use" capability (target "${target.key}" is ${target.kind}/${target.trust})`
      );
    }
  }

  const seq = collab.relays.reduce((max, r) => Math.max(max, r.seq), 0) + 1;
  const relay: Relay = {
    id: newId(),
    collaborationId,
    seq,
    sourceKey: source,
    targetKey: target.key,
    purpose: String(input.purpose ?? "contribute").trim().slice(0, 80) || "contribute",
    request,
    contextRefs: (input.contextRefs ?? []).map((r) => String(r).trim()).filter(Boolean).slice(0, 8),
    classification,
    responseContract: String(input.responseContract ?? "markdown text").trim().slice(0, 200) || "markdown text",
    status: "pending",
    response: null,
    via: "",
    note: "",
    toolUse: Boolean(input.toolUse),
    steps: [],
    createdAt: new Date().toISOString(),
  };

  try {
    await ensureTables();
    if (dbHealthy) {
      const [row] = await db
        .insert(collaborationRelays)
        .values({
          collaborationId, seq, sourceKey: relay.sourceKey, targetKey: relay.targetKey, purpose: relay.purpose,
          request: relay.request, contextRefs: relay.contextRefs.join(","), classification: relay.classification,
          responseContract: relay.responseContract, status: "pending",
          toolUse: relay.toolUse ? 1 : 0, steps: "[]",
        })
        .returning();
      if (row) relay.id = row.id;
    }
  } catch {
    dbHealthy = false;
  }
  if (!dbHealthy) {
    const memory = memoryCollabs.get(collaborationId);
    if (memory) {
      memory.relays.push(relay);
      memory.status = "running";
      memory.updatedAt = new Date().toISOString();
    }
  }
  await touch(collaborationId, "running");
  return relay;
}

function assertEgress(classification: Classification, target: Participant): void {
  if (classification === "private" && target.kind !== "human") {
    throw new Error(
      `egress policy: private context may only be relayed to human participants (target "${target.key}" is ${target.kind})`
    );
  }
  if (classification === "internal" && target.trust !== "internal") {
    throw new Error(
      `egress policy: internal context may not be relayed to external-trust participants (target "${target.key}")`
    );
  }
}

async function touch(id: string, status?: CollaborationStatus): Promise<void> {
  const now = new Date();
  try {
    await ensureTables();
    if (dbHealthy) {
      await db
        .update(collaborations)
        .set(status ? { status, updatedAt: now } : { updatedAt: now })
        .where(eq(collaborations.id, id));
    }
  } catch {
    dbHealthy = false;
  }
  const memory = memoryCollabs.get(id);
  if (memory) {
    if (status) memory.status = status;
    memory.updatedAt = now.toISOString();
  }
}

async function updateRelay(relayId: string, patch: Partial<Relay>): Promise<void> {
  try {
    await ensureTables();
    if (dbHealthy) {
      await db
        .update(collaborationRelays)
        .set({
          ...(patch.status !== undefined ? { status: patch.status } : {}),
          ...(patch.response !== undefined ? { response: patch.response } : {}),
          ...(patch.via !== undefined ? { via: patch.via } : {}),
          ...(patch.note !== undefined ? { note: patch.note } : {}),
          ...(patch.steps !== undefined ? { steps: JSON.stringify(patch.steps) } : {}),
          updatedAt: new Date(),
        })
        .where(eq(collaborationRelays.id, relayId));
    }
  } catch {
    dbHealthy = false;
  }
  for (const memory of memoryCollabs.values()) {
    const relay = memory.relays.find((r) => r.id === relayId);
    if (relay) Object.assign(relay, patch);
  }
}

// ---------------- the context envelope ----------------

async function fetchArtifactBodies(refs: string[]): Promise<string> {
  if (!refs.length) return "";
  try {
    const rows = await db.select().from(artifacts).limit(500);
    const parts: string[] = [];
    for (const ref of refs) {
      const row = rows.find((r) => r.id === ref);
      if (row) {
        parts.push(`--- ARTIFACT: ${row.title} (${row.kind}) ---\n${String(row.body ?? "").slice(0, 2500)}`);
      }
    }
    return parts.join("\n\n").slice(0, 6000);
  } catch {
    return "";
  }
}

async function buildEnvelope(collab: Collaboration, relay: Relay, target: Participant): Promise<string> {
  const sections: string[] = [];
  sections.push(`COLLABORATION: ${collab.title}\nGOAL: ${collab.goal}`);
  if (collab.context) sections.push(`SHARED CONTEXT:\n${collab.context.slice(0, 3000)}`);
  const artifactBodies = await fetchArtifactBodies(relay.contextRefs);
  if (artifactBodies) sections.push(`REFERENCED ARTIFACTS:\n${artifactBodies}`);
  const transcript = collab.relays
    .filter((r) => r.status === "responded" && r.id !== relay.id)
    .slice(-6)
    .map(
      (r) =>
        `#${r.seq} ${r.sourceKey} → ${r.targetKey} (${r.purpose})\n  REQUEST: ${r.request.slice(0, 500)}\n  RESPONSE: ${String(r.response ?? "").slice(0, 800)}`
    )
    .join("\n");
  if (transcript) sections.push(`TRANSCRIPT SO FAR:\n${transcript}`);
  const prefs = await preferencesBriefFor(target);
  if (prefs) {
    sections.push(
      `OWNER PREFERENCES & BOUNDARIES (standing guidance from the owner — honor these; boundaries are hard limits, never overstep them):\n${prefs}`
    );
  }
  sections.push(
    `YOU ARE: ${target.name} (${target.key})${target.capabilities.length ? ` — capabilities: ${target.capabilities.join(", ")}` : ""}`
  );
  sections.push(`PURPOSE OF THIS RELAY: ${relay.purpose}\n\nREQUEST:\n${relay.request}`);
  sections.push(`RESPONSE CONTRACT: ${relay.responseContract}`);
  return sections.join("\n\n").slice(0, ENVELOPE_CHAR_LIMIT);
}

// ---------------- external adapter (OpenAI-compatible) ----------------

async function callExternalAdapter(
  url: string,
  model: string | null,
  bearer: string | undefined,
  system: string,
  user: string
): Promise<{ text: string; via: string }> {
  const base = url.replace(/\/+$/, "");
  const endpoint = base.endsWith("/v1") ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify({
        model: model || undefined,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0.5,
        stream: false,
        max_tokens: 2048,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`adapter HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
    const text = data.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.trim()) throw new Error("adapter returned an empty response");
    return { text, via: `external:${new URL(endpoint).origin}` };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------- dispatch prompts + bounded tool loop ----------------

function dispatchSystemPrompt(target: Participant): string {
  return (
    "You are one participant in a structured multi-participant collaboration that always serves the OWNER's best interest. " +
    `Assume your assigned perspective (${target.name}) and deliberate toward the most optimal result for the owner — weigh trade-offs honestly, ` +
    "state your recommendation clearly, and disagree with other participants when the evidence warrants it. " +
    "Honor the owner's preferences and boundaries included in the envelope; boundaries are hard limits — never overstep them. " +
    "Be concise and useful in markdown. " +
    "Never claim to have taken real-world actions (posting, sending, buying, deploying) — you produce work product, the owner acts."
  );
}

// Read/report tools only — collaboration participants may inspect the
// workspace, never mutate it. That is the "without overstepping boundaries"
// rule made concrete.
const ORCHESTRATOR_TOOLS = [
  "list_modules",
  "list_projects",
  "list_artifacts",
  "list_spaces",
  "list_congress_sessions",
  "archive_search",
  "archive_item",
  "archive_stats",
];

function orchestratorToolManifest(): string {
  return ORCHESTRATOR_TOOLS.map((name) => {
    const tool = getTool(name);
    if (!tool) return "";
    const params = Object.entries(tool.parameters)
      .map(([k, v]) => `${k}${v.required ? "*" : ""}:${v.type}`)
      .join(", ");
    return `- ${name}(${params}): ${tool.description}`;
  })
    .filter(Boolean)
    .join("\n");
}

function parseRelayToolCall(text: string): { tool: string; args: Record<string, unknown> } | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates: string[] = [];
  if (fenced) candidates.push(fenced[1].trim());
  if (text.trim().startsWith("{")) candidates.push(text.trim());
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as { tool?: unknown; args?: unknown };
      if (parsed && typeof parsed.tool === "string") {
        const args =
          parsed.args && typeof parsed.args === "object" && !Array.isArray(parsed.args)
            ? (parsed.args as Record<string, unknown>)
            : {};
        return { tool: parsed.tool, args };
      }
    } catch {
      /* not JSON */
    }
  }
  return null;
}

async function dispatchWithTools(
  target: Participant,
  envelope: string,
  opts: { keys?: OrchestratorKeys; localOnly?: boolean }
): Promise<{ text: string; via: string; steps: RelayToolStep[] }> {
  const system =
    dispatchSystemPrompt(target) +
    "\n\nTOOL PROTOCOL — you may inspect the workspace through read-only tools. To call one, reply with ONLY a fenced JSON block:\n" +
    '```json\n{"tool": "<name>", "args": { … }}\n```\n' +
    "After each call you receive a TOOL RESULT message; keep calling tools (max 3) until you can answer, then reply with plain text as your final response.\n\n" +
    `AVAILABLE TOOLS:\n${orchestratorToolManifest()}`;
  const convo: { role: "user" | "assistant"; content: string }[] = [{ role: "user", content: envelope }];
  const steps: RelayToolStep[] = [];
  let via = "";
  for (let i = 0; i < 5; i++) {
    const gen = await generate({
      modelId: target.modelId ?? "openai",
      messages: convo,
      system,
      temperature: 0.4,
      keys: opts.localOnly ? undefined : opts.keys,
      localOnly: opts.localOnly,
    });
    via = gen.via;
    const text = gen.text.trim();
    const call = parseRelayToolCall(text);
    if (!call) return { text, via, steps };
    if (isOfflineVia(via)) return { text, via, steps };
    if (steps.length >= 3) {
      convo.push({ role: "assistant", content: text });
      convo.push({ role: "user", content: "Tool budget exhausted — answer now with what you have (plain text, no JSON)." });
      continue;
    }
    const tool = ORCHESTRATOR_TOOLS.includes(call.tool) ? getTool(call.tool) : undefined;
    if (!tool) {
      convo.push({ role: "assistant", content: text });
      convo.push({
        role: "user",
        content: `TOOL RESULT ${call.tool}: error — unknown or disallowed tool. Allowed: ${ORCHESTRATOR_TOOLS.join(", ")}`,
      });
      continue;
    }
    const started = Date.now();
    let ok = true;
    let result: unknown;
    try {
      result = await tool.run(call.args, {});
    } catch (error) {
      ok = false;
      result = { error: error instanceof Error ? error.message : "tool failed" };
    }
    const summary = (() => {
      try {
        const json = JSON.stringify(result) ?? "null";
        return json.length <= 600 ? json : `${json.slice(0, 600)}…`;
      } catch {
        return "(unserializable tool result)";
      }
    })();
    steps.push({ tool: tool.name, ok, ms: Date.now() - started, summary });
    convo.push({ role: "assistant", content: text });
    convo.push({ role: "user", content: `TOOL RESULT ${tool.name}:\n${summary}` });
  }
  return { text: "The tool loop exceeded its step budget.", via, steps };
}

// ---------------- deliberation rounds ----------------

/**
 * Queue one deliberation round: a perspective relay to every non-human
 * participant, then a synthesis relay (executes last — relays run in seq
 * order) that weighs them all toward the owner's best interest.
 */
export async function startDeliberationRound(id: string): Promise<Collaboration> {
  const collab = await getCollaboration(id);
  if (!collab) throw new Error("collaboration not found");
  if (collab.status === "closed") throw new Error("this collaboration is closed");
  const thinkers = collab.participants.filter((p) => p.kind !== "human");
  if (!thinkers.length) throw new Error("a deliberation round needs at least one non-human participant");
  for (const p of thinkers) {
    await addRelay(id, {
      source: "conductor",
      target: p.key,
      purpose: "perspective",
      request:
        `From your perspective as ${p.name}, weigh in on the goal${collab.relays.length ? " and the transcript so far" : ""}. ` +
        "State your strongest recommendation for the owner and your single biggest concern.",
      classification: p.trust === "external" ? "public" : "internal",
    });
  }
  const synthesist =
    collab.participants.find((p) => p.capabilities.includes("synthesis")) ??
    collab.participants.find((p) => p.kind === "model" && p.trust === "internal") ??
    thinkers[0];
  await addRelay(id, {
    source: "conductor",
    target: synthesist.key,
    purpose: "synthesis",
    request:
      "Weigh every perspective above and produce the single most optimal recommendation for the owner: " +
      "the decision, the trade-offs accepted, and the next step. Flag anything that would overstep the owner's boundaries.",
    classification: synthesist.trust === "external" ? "public" : "internal",
  });
  return (await getCollaboration(id))!;
}

// ---------------- advance (one step per request) ----------------

function isOfflineVia(via: string): boolean {
  return (
    via === "offline-fallback" ||
    via === "offline" ||
    via === "local:text" ||
    via.startsWith("turboagent:unreachable") ||
    via.startsWith("turboagent:not-configured")
  );
}

export async function advanceCollaboration(
  id: string,
  opts: { keys?: OrchestratorKeys; localOnly?: boolean } = {}
): Promise<AdvanceResult | null> {
  const collab = await getCollaboration(id);
  if (!collab) return null;

  if (collab.status === "closed") {
    return { ran: "closed", note: "This collaboration is closed.", collaboration: collab };
  }

  const pending = collab.relays.filter((r) => r.status === "pending").sort((a, b) => a.seq - b.seq)[0];

  if (!pending) {
    if (collab.autoRoute) {
      const routed = await conductorRoute(collab, opts);
      if (routed.collaboration !== collab) return routed; // relay created or closed
      return { ran: "idle", note: routed.note, collaboration: collab };
    }
    return {
      ran: "idle",
      note: "No pending relays. Add a relay, or close the collaboration to file its record.",
      collaboration: collab,
    };
  }

  const target = collab.participants.find((p) => p.key === pending.targetKey);
  if (!target) {
    await updateRelay(pending.id, { status: "failed", note: `unknown target participant "${pending.targetKey}"` });
    const refreshed = (await getCollaboration(id))!;
    return { ran: "blocked-relay", note: `Relay #${pending.seq} failed: unknown target.`, collaboration: refreshed };
  }

  // defense in depth: egress check again at dispatch
  try {
    assertEgress(pending.classification, target);
  } catch (error) {
    const note = error instanceof Error ? error.message : "egress policy blocked this relay";
    await updateRelay(pending.id, { status: "failed", note });
    const refreshed = (await getCollaboration(id))!;
    return { ran: "blocked-relay", note, collaboration: refreshed };
  }

  // human participant → checkpoint, not dispatch
  if (target.kind === "human") {
    await touch(id, "blocked");
    const refreshed = (await getCollaboration(id))!;
    return {
      ran: "checkpoint",
      note: `Relay #${pending.seq} is waiting for ${target.name} — approve, reject, or answer it.`,
      collaboration: refreshed,
    };
  }

  const system = dispatchSystemPrompt(target);
  const envelope = await buildEnvelope(collab, pending, target);

  try {
    let result: { text: string; via: string };
    let steps: RelayToolStep[] = [];
    if (target.kind === "external") {
      if (!target.adapterUrl) throw new Error("external participant has no adapter URL configured");
      result = await callExternalAdapter(
        target.adapterUrl,
        target.adapterModel,
        opts.localOnly ? undefined : opts.keys?.externalBearer,
        system,
        envelope
      );
    } else if (pending.toolUse) {
      const loop = await dispatchWithTools(target, envelope, opts);
      result = { text: loop.text, via: loop.via };
      steps = loop.steps;
    } else {
      const gen = await generate({
        modelId: target.modelId ?? "openai",
        messages: [{ role: "user", content: envelope }],
        system,
        temperature: 0.5,
        keys: opts.localOnly ? undefined : opts.keys,
        localOnly: opts.localOnly,
      });
      result = { text: gen.text, via: gen.via };
    }
    await updateRelay(pending.id, {
      status: "responded",
      response: result.text.slice(0, 12000),
      via: result.via,
      ...(steps.length ? { steps } : {}),
    });
    await touch(id, "running");
    const refreshed = (await getCollaboration(id))!;
    return {
      ran: "relay",
      note: `Relay #${pending.seq} → ${target.name} responded (via ${result.via}${steps.length ? `, ${steps.length} tool call${steps.length === 1 ? "" : "s"}` : ""}).`,
      collaboration: refreshed,
    };
  } catch (error) {
    const note = error instanceof Error ? error.message : "dispatch failed";
    await updateRelay(pending.id, { status: "failed", note });
    const refreshed = (await getCollaboration(id))!;
    return { ran: "blocked-relay", note: `Relay #${pending.seq} failed: ${note}`, collaboration: refreshed };
  }
}

// ---------------- human checkpoint response ----------------

export async function respondToRelay(
  relayId: string,
  input: { response?: string; rejected?: boolean }
): Promise<Relay | null> {
  for (const collab of await listCollaborations(100)) {
    const relay = collab.relays.find((r) => r.id === relayId);
    if (!relay) continue;
    if (relay.status !== "pending") return relay;
    if (input.rejected) {
      await updateRelay(relayId, {
        status: "cancelled",
        response: String(input.response ?? "").slice(0, 4000) || null,
        via: "human",
        note: "Rejected by the owner.",
      });
    } else {
      await updateRelay(relayId, {
        status: "responded",
        response: String(input.response ?? "").slice(0, 12000) || "(approved by the owner)",
        via: "human",
      });
    }
    await touch(collab.id, "running");
    return (await getCollaboration(collab.id))?.relays.find((r) => r.id === relayId) ?? relay;
  }
  return null;
}

// ---------------- auto-routing conductor ----------------

function parseConductorJson(text: string): Record<string, unknown> | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : text).trim();
  const start = candidate.search(/[[{]/);
  if (start < 0) return null;
  const slice = candidate.slice(start);
  for (const endToken of ["}", "]"]) {
    const end = slice.lastIndexOf(endToken);
    if (end > 0) {
      try {
        return JSON.parse(slice.slice(0, end + 1)) as Record<string, unknown>;
      } catch {
        /* keep trying */
      }
    }
  }
  return null;
}

async function conductorRoute(
  collab: Collaboration,
  opts: { keys?: OrchestratorKeys; localOnly?: boolean }
): Promise<AdvanceResult> {
  if (collab.relays.length >= MAX_RELAYS) {
    return { ran: "idle", note: `Relay limit reached (${MAX_RELAYS}); close the collaboration.`, collaboration: collab };
  }
  const transcript = collab.relays
    .slice(-8)
    .map((r) => `#${r.seq} ${r.sourceKey} → ${r.targetKey} (${r.purpose}, ${r.status})\n  REQUEST: ${r.request.slice(0, 300)}\n  RESPONSE: ${String(r.response ?? r.note).slice(0, 500)}`)
    .join("\n");
  const roster = collab.participants
    .map((p) => `- ${p.key}: ${p.name} [${p.kind}${p.trust === "external" ? ", external-trust" : ""}]${p.capabilities.length ? ` — ${p.capabilities.join(", ")}` : ""}`)
    .join("\n");
  const system =
    "You are the conductor of a structured AI collaboration. Given the goal, the participant roster, and the " +
    "transcript so far, decide the single next move. Reply ONLY with fenced JSON, one of:\n" +
    '```json\n{"action":"relay","target":"<participant key>","purpose":"<short>","request":"<bounded prompt>","responseContract":"<expected output>","classification":"public|internal|private"}\n```\n' +
    '```json\n{"action":"close","summary":"<what was achieved>"}\n```\n' +
    "Rules: route in the owner's best interest, respecting their boundaries; use the participant best suited for what is still missing; use classification \"public\" for " +
    "external-trust participants; close when the goal is met or stalled. Never invent participant keys."
  const user = `GOAL: ${collab.goal}\n\nPARTICIPANTS:\n${roster}\n\nTRANSCRIPT:\n${transcript || "(nothing yet)"}`;

  let via = "";
  let text = "";
  try {
    const gen = await generate({
      modelId: "openai",
      messages: [{ role: "user", content: user }],
      system,
      temperature: 0.3,
      keys: opts.localOnly ? undefined : opts.keys,
      localOnly: opts.localOnly,
    });
    via = gen.via;
    text = gen.text;
  } catch {
    return { ran: "idle", note: "The conductor could not be reached; route manually.", collaboration: collab };
  }

  if (isOfflineVia(via)) {
    return {
      ran: "idle",
      note: "Conductor auto-routing needs a working model (offline mode) — add the next relay manually.",
      collaboration: collab,
    };
  }

  const decision = parseConductorJson(text);
  if (!decision || decision.action !== "relay" && decision.action !== "close") {
    return { ran: "idle", note: "The conductor did not return a valid decision; route manually.", collaboration: collab };
  }

  if (decision.action === "close") {
    const closed = await closeCollaboration(collab.id, String(decision.summary ?? "Closed by the conductor."));
    return { ran: "close", note: "The conductor closed the collaboration and filed its record.", collaboration: closed };
  }

  const targetKey = String(decision.target ?? "");
  const target = collab.participants.find((p) => p.key === targetKey);
  if (!target) {
    return { ran: "idle", note: `The conductor named unknown participant "${targetKey}"; route manually.`, collaboration: collab };
  }
  // conductor relays to external-trust participants are always public
  const classification =
    target.trust === "external"
      ? "public"
      : normClassification(String(decision.classification ?? "internal"));
  try {
    await addRelay(collab.id, {
      source: "conductor",
      target: target.key,
      purpose: String(decision.purpose ?? "continue"),
      request: String(decision.request ?? "").slice(0, 8000),
      classification,
      responseContract: String(decision.responseContract ?? "markdown text"),
    });
  } catch (error) {
    return {
      ran: "idle",
      note: `The conductor's relay was rejected: ${error instanceof Error ? error.message : "unknown error"}`,
      collaboration: collab,
    };
  }
  const refreshed = (await getCollaboration(collab.id))!;
  return { ran: "autoroute", note: `The conductor routed the next relay to ${target.name}.`, collaboration: refreshed };
}

// ---------------- close ----------------

export async function closeCollaboration(id: string, summary?: string): Promise<Collaboration> {
  const collab = await getCollaboration(id);
  if (!collab) throw new Error("collaboration not found");
  await touch(id, "closed");
  const record = (await getCollaboration(id))!;

  const transcript = record.relays
    .map(
      (r) =>
        `### #${r.seq} ${r.sourceKey} → ${r.targetKey} · ${r.purpose} · ${r.status}\n` +
        `**Request:** ${r.request.slice(0, 800)}\n\n${r.response ? `**Response (via ${r.via}):**\n${r.response.slice(0, 2000)}` : `**Note:** ${r.note || "(no response)"}`}`
    )
    .join("\n\n");
  try {
    await db.insert(artifacts).values({
      projectId: record.projectId,
      kind: "decision",
      title: `🎼 Collaboration record — ${record.title.slice(0, 120)}`,
      body:
        `**Goal:** ${record.goal.slice(0, 2000)}\n\n${summary ? `**Summary:** ${String(summary).slice(0, 2000)}\n\n` : ""}` +
        `**Participants:** ${record.participants.map((p) => `${p.emoji} ${p.name} (${p.kind})`).join(", ")}\n\n---\n\n${transcript}`.slice(0, 30000),
      sourceType: "orchestrator",
      sourceId: record.id,
    });
  } catch {
    /* artifact filing is best-effort */
  }
  return record;
}

// ---------------- delete ----------------

export async function deleteCollaboration(id: string): Promise<boolean> {
  const collab = await getCollaboration(id);
  if (!collab) return false;
  try {
    await ensureTables();
    if (dbHealthy) {
      await db.delete(collaborationRelays).where(eq(collaborationRelays.collaborationId, id));
      await db.delete(collaborationParticipants).where(eq(collaborationParticipants.collaborationId, id));
      await db.delete(collaborations).where(eq(collaborations.id, id));
    }
  } catch {
    dbHealthy = false;
  }
  memoryCollabs.delete(id);
  return true;
}
