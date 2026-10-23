import { ArtifactObjectError, artifactObjectSummary, writeArtifactObject, verifyArtifactObject, MAX_ARTIFACT_OBJECT_BYTES } from "@/lib/artifact-objects";
import { createHash } from "node:crypto";
import { isUuid } from "@/lib/api/ids";
import { resolveArtifactInput, ArtifactInputError } from "@/lib/artifact-input";
import { readRetainedRelayResult, retainRelayResult, ReceiptIntegrityError, type ReceiptReference } from "@/lib/orchestrator-receipts";
import { assertUrlDestination } from "@/lib/security/outbound-url";
import { parseArtifactReference } from "@/lib/handoffs";
import { assertRevisionIntegrity, getArtifact, getArtifactRevision, insertArtifact } from "@/lib/arcadeStore";
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
import { LOCAL_OWNER_ID, artifactRevisions, collaborationParticipants, collaborationRelays, collaborations } from "@/db/schema";
import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import { generate } from "@/lib/ai";
import { getModel } from "@/lib/models";
import { preferencesBriefFor } from "@/lib/preferences";
import { getTool } from "@/lib/assistantTools";

// ---------------- types ----------------

export type ParticipantKind = "model" | "human" | "external";
export type TrustLevel = "internal" | "external";
export type Classification = "public" | "internal" | "private";
export type RelayStatus = "pending" | "dispatching" | "uncertain" | "responded" | "cancelled" | "failed";
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
  /** What actually executed the response (GenerateResult metadata). */
  runtime?: unknown;
  resultReceipt?: ReceiptReference;
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
  requestId?: string;
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
  requestId?: string;
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

// ---------------- durable storage ----------------

// Migrations own the schema. A failed query must never change storage mode.
export class OrchestratorInputError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}
export function orchestratorErrorResponse(error: unknown) {
  const status = error instanceof OrchestratorInputError || error instanceof CollaborationArchiveError || error instanceof ArtifactInputError || error instanceof ReceiptIntegrityError || error instanceof ArtifactObjectError ? error.status : error instanceof SyntaxError ? 400 : 503;
  return Response.json({ error: status === 503 ? "Persistent collaboration storage unavailable or acknowledgement uncertain. Work was not acknowledged; reload before retrying. " : error instanceof Error ? error.message : "Request rejected." }, { status });
}
type OrchestratorTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

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
    status: (["pending", "dispatching", "uncertain", "responded", "cancelled", "failed"].includes(r.status) ? r.status : "uncertain") as RelayStatus,
    resultReceipt: r.resultReceipt ?? undefined,
    response: r.response ?? null,
    via: r.via ?? "",
    note: r.note ?? "",
    toolUse: Boolean(r.toolUse),
    steps: parseSteps(r.steps),
    createdAt: new Date(r.createdAt ?? new Date()).toISOString(),
    runtime: (r as any).runtime ?? undefined,
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

function collaborationFromRows(row: typeof collaborations.$inferSelect, pRows: (typeof collaborationParticipants.$inferSelect)[], rRows: (typeof collaborationRelays.$inferSelect)[]): Collaboration {
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

// ---------------- read ----------------

async function readCollaboration(tx: OrchestratorTransaction, id: string): Promise<Collaboration | null> {
  const [row] = await tx.select().from(collaborations).where(eq(collaborations.id, id)).for("share");
  if (!row) return null;
  const pRows = await tx.select().from(collaborationParticipants).where(eq(collaborationParticipants.collaborationId, id)).orderBy(asc(collaborationParticipants.createdAt));
  const rRows = await tx.select().from(collaborationRelays).where(eq(collaborationRelays.collaborationId, id)).orderBy(asc(collaborationRelays.seq));
  return collaborationFromRows(row, pRows, rRows);
}
export async function getCollaboration(id: string): Promise<Collaboration | null> {
  return db.transaction(tx => readCollaboration(tx, id));
}
export async function listCollaborations(limit = 30): Promise<Collaboration[]> {
  const rows = await db.select({ id: collaborations.id }).from(collaborations).orderBy(desc(collaborations.updatedAt)).limit(Math.max(1, Math.min(limit, 100)));
  const result: Collaboration[] = [];
  for (const row of rows) { const full = await getCollaboration(row.id); if (full) result.push(full); }
  return result;
}

// ---------------- create ----------------

function normalizeContextReferences(refs: string[] = []): string[] {
  const contextRefs = refs.map((reference) => String(reference).trim()).filter(Boolean);
  if (contextRefs.length > 8) throw new OrchestratorInputError("A relay supports at most 8 pinned Artifact references; split the request explicitly.");
  if (contextRefs.some((reference) => !parseArtifactReference(reference))) throw new OrchestratorInputError("Artifact context requires a pinned immutable revision: artifact:<id>@<revisionId>. Bare current references are refused.");
  return contextRefs;
}

export async function createCollaboration(input: CreateCollaborationInput): Promise<Collaboration> {
  const goal = String(input.goal ?? "").trim();
  if (goal.length > 6000 || String(input.context ?? "").length > 8000) throw new OrchestratorInputError("Goal/context exceeds the supported limit. Nothing was saved; shorten it explicitly.", 413);
  if (!goal) throw new OrchestratorInputError("a collaboration needs a goal");
  if (input.relay) normalizeContextReferences(input.relay.contextRefs);

  if ((input.participants ?? []).length > 8) throw new OrchestratorInputError("At most8 participants are supported; none were silently discarded.", 413);
  const rawParticipants = input.participants ?? [];
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
  if (!cleaned.length) throw new OrchestratorInputError("a collaboration needs at least one participant");

  const collab: Collaboration = {
    id: input.requestId ?? newId(),
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

  if (input.requestId !== undefined && !isUuid(input.requestId)) throw new OrchestratorInputError("A valid UUID requestId is required.");
  const requestHash = createHash("sha256").update(JSON.stringify({ title: collab.title, goal, context: collab.context, autoRoute: collab.autoRoute, projectId: collab.projectId, participants: cleaned.map(({ id: _id, collaborationId: _parent, ...participant }) => participant), relay: input.relay ?? null })).digest("hex");
  const initial = input.relay && String(input.relay.request ?? "").trim() ? prepareRelay(collab, input.relay) : null;
  return db.transaction(async tx => {
    const [row] = await tx.insert(collaborations).values({ id: collab.id, requestHash, title: collab.title, goal: collab.goal, context: collab.context, status: "running", autoRoute: collab.autoRoute ? 1 : 0, projectId: collab.projectId }).onConflictDoNothing({ target: collaborations.id }).returning();
    if (!row) {
      const [existing] = await tx.select().from(collaborations).where(eq(collaborations.id, collab.id)).for("update");
      if (!existing || existing.requestHash !== requestHash) throw new OrchestratorInputError("Creation key already belongs to different work. Reload the existing session; nothing was overwritten.", 409);
      return (await readCollaboration(tx, collab.id))!;
    }
    const pRows = [];
    for (const p of cleaned) {
      const [stored] = await tx.insert(collaborationParticipants).values({ id: p.id, collaborationId: row.id, key: p.key, name: p.name, emoji: p.emoji, kind: p.kind, modelId: p.modelId, adapterUrl: p.adapterUrl, adapterModel: p.adapterModel, capabilities: p.capabilities.join(","), trust: p.trust }).returning(); pRows.push(stored);
    }
    const relays = initial ? [await insertRelay(tx, initial)] : [];
    return collaborationFromRows(row, pRows, relays);
  });
}

// ---------------- relays ----------------

function prepareRelay(collab: Collaboration, input: RelayInput): Relay {
  if (input.requestId !== undefined && !isUuid(input.requestId)) throw new OrchestratorInputError("A valid UUID relay requestId is required.");
  const collaborationId = collab.id;
  if (collab.status === "closed") throw new OrchestratorInputError("this collaboration is closed");
  if (collab.relays.length >= MAX_RELAYS) throw new OrchestratorInputError(`relay limit reached (${MAX_RELAYS})`);

  const request = String(input.request ?? "").trim();
  if (request.length > 8000) throw new OrchestratorInputError("Relay request exceeds8,000 characters. Nothing was queued; shorten it explicitly.", 413);
  if (!request) throw new OrchestratorInputError("a relay needs a request");
  const target = collab.participants.find((p) => p.key === input.target);
  if (!target) throw new OrchestratorInputError(`unknown target participant "${input.target}"`);
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
      throw new OrchestratorInputError(
        `tool-capable relays require an internal-trust model participant with the "tool_use" capability (target "${target.key}" is ${target.kind}/${target.trust})`
      );
    }
  }

  const contextRefs = normalizeContextReferences(input.contextRefs);

  const seq = collab.relays.reduce((max, r) => Math.max(max, r.seq), 0) + 1;
  const relay: Relay = {
    id: input.requestId ?? newId(),
    collaborationId,
    seq,
    sourceKey: source,
    targetKey: target.key,
    purpose: String(input.purpose ?? "contribute").trim().slice(0, 80) || "contribute",
    request,
    contextRefs,
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

  return relay;
}
async function insertRelay(tx: OrchestratorTransaction, relay: Relay) {
  const [row] = await tx.insert(collaborationRelays).values({ id: relay.id, collaborationId: relay.collaborationId, seq: relay.seq, sourceKey: relay.sourceKey, targetKey: relay.targetKey, purpose: relay.purpose, request: relay.request, contextRefs: relay.contextRefs.join(","), classification: relay.classification, responseContract: relay.responseContract, status: "pending", toolUse: relay.toolUse ? 1 : 0, steps: "[]" }).returning();
  return row;
}
export async function addRelay(collaborationId: string, input: RelayInput): Promise<Relay> {
  return db.transaction(async tx => {
    const [parent] = await tx.select().from(collaborations).where(eq(collaborations.id, collaborationId)).for("update");
    if (!parent) throw new OrchestratorInputError("Collaboration unavailable; relay was not queued.", 404);
    const collab = (await readCollaboration(tx, collaborationId))!;
    if (input.requestId) {
      const candidate = prepareRelay({ ...collab, status: "running", relays: [] }, input);
      const [existing] = await tx.select().from(collaborationRelays).where(eq(collaborationRelays.id, input.requestId));
      if (existing) {
        const relay = relayFromRow(existing);
        const fields = ["sourceKey", "targetKey", "purpose", "request", "contextRefs", "classification", "responseContract", "toolUse"] as const;
        if (relay.collaborationId !== collaborationId || JSON.stringify(fields.map(key => relay[key])) !== JSON.stringify(fields.map(key => candidate[key]))) throw new OrchestratorInputError("Relay creation key already belongs to different work. Reload before explicitly starting a separate request.", 409);
        return relay;
      }
    }
    if (parent.status === "closed") throw new OrchestratorInputError("Collaboration is closed; relay was not queued.", 409);
    const relay = prepareRelay(collab, input); const row = await insertRelay(tx, relay);
    await tx.update(collaborations).set({ status: "running", updatedAt: new Date() }).where(eq(collaborations.id, collaborationId));
    return relayFromRow(row);
  });
}

function assertEgress(classification: Classification, target: Participant): void {
  if (classification === "private" && target.kind !== "human") {
    throw new OrchestratorInputError(
      `egress policy: private context may only be relayed to human participants (target "${target.key}" is ${target.kind})`
    );
  }
  if (classification === "internal" && target.trust !== "internal") {
    throw new OrchestratorInputError(
      `egress policy: internal context may not be relayed to external-trust participants (target "${target.key}")`
    );
  }
}

async function touch(id: string, status?: CollaborationStatus): Promise<void> {
  const [row] = await db.update(collaborations).set({ ...(status ? { status } : {}), updatedAt: new Date() }).where(and(eq(collaborations.id, id), ne(collaborations.status, "closed"))).returning({ id: collaborations.id });
  if (!row) throw new OrchestratorInputError("Collaboration was removed; no update was acknowledged.", 409);
}
async function updateRelay(relayId: string, patch: Partial<Relay>, expected: RelayStatus[] = ["pending"]): Promise<void> {
  await db.transaction(async tx => {
    const [stored] = await tx.select().from(collaborationRelays).where(eq(collaborationRelays.id, relayId));
    if (!stored) throw new OrchestratorInputError("Relay was removed; no response was acknowledged.", 409);
    const [parent] = await tx.select().from(collaborations).where(eq(collaborations.id, stored.collaborationId)).for("update");
    if (!parent || parent.status === "closed") throw new OrchestratorInputError("Collaboration is absent or closed; no response was acknowledged.", 409);
    const [current] = await tx.select().from(collaborationRelays).where(eq(collaborationRelays.id, relayId)).for("update");
    if (!current || !expected.includes(current.status as RelayStatus)) return;
    await tx.update(collaborationRelays).set({ ...(patch.status !== undefined ? { status: patch.status } : {}), ...(patch.response !== undefined ? { response: patch.response } : {}), ...(patch.via !== undefined ? { via: patch.via } : {}), ...(patch.note !== undefined ? { note: patch.note } : {}), ...(patch.steps !== undefined ? { steps: JSON.stringify(patch.steps) } : {}), ...(patch.runtime !== undefined ? { runtime: patch.runtime as any } : {}), updatedAt: new Date() }).where(eq(collaborationRelays.id, relayId));
    await tx.update(collaborations).set({ updatedAt: new Date() }).where(eq(collaborations.id, stored.collaborationId));
  });
}

// ---------------- the context envelope ----------------

async function fetchArtifactBodies(refs: string[]): Promise<string> {
  const parts: string[] = [];
  for (const reference of refs) {
    const resolved = await resolveArtifactInput(reference, "");
    parts.push(`--- VERIFIED ARTIFACT ${reference}, excerpt ${Math.min(2500, resolved.text.length)}/${resolved.text.length} characters ---\n${resolved.text.slice(0, 2500)}`);
  }
  const content = parts.join("\n\n");
  return content.length > 6000 ? `${content.slice(0, 6000)}\n[Artifact excerpts truncated at 6000 characters; use read_artifact with the pinned IDs for the complete content.]` : content;
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
  const envelope = sections.join("\n\n");
  if (Buffer.byteLength(envelope, "utf8") > 128000) throw new OrchestratorInputError("Relay envelope exceeds128,000 UTF-8 bytes. Explicitly reduce its context; no request excerpt was dispatched.", 413);
  return envelope;
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
    const body = await boundedAdapterResponse(res);
    if (!res.ok) {
      throw new OrchestratorInputError(`adapter HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
    }
    const data = JSON.parse(body) as { choices?: Array<{ message?: { content?: unknown } }> };
    const text = data.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.trim()) throw new OrchestratorInputError("adapter returned an empty response");
    return { text, via: `external:${new URL(endpoint).origin}` };
  } finally {
    clearTimeout(timer);
  }
}

async function boundedAdapterResponse(response: Response) {
  if (!response.body) throw new OrchestratorInputError("Adapter returned no response body.");
  const reader = response.body.getReader(); const decoder = new TextDecoder();
  let size = 0; let text = "";
  try { for (;;) { const { value, done } = await reader.read(); if (done) return text + decoder.decode(); size += value.byteLength; if (size > 16 * 1024 * 1024) { await reader.cancel(); throw new OrchestratorInputError("Adapter response exceeds16MiB; outcome requires explicit owner review, not automatic replay."); } text += decoder.decode(value, { stream: true }); } } finally { reader.releaseLock(); }
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
  "read_artifact",
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
): Promise<{ text: string; via: string; steps: RelayToolStep[]; runtime?: unknown }> {
  const system =
    dispatchSystemPrompt(target) +
    "\n\nTOOL PROTOCOL — you may inspect the workspace through read-only tools. To call one, reply with ONLY a fenced JSON block:\n" +
    '```json\n{"tool": "<name>", "args": { … }}\n```\n' +
    "After each call you receive a TOOL RESULT message; keep calling tools (max 3) until you can answer, then reply with plain text as your final response.\n\n" +
    `AVAILABLE TOOLS:\n${orchestratorToolManifest()}`;
  const convo: { role: "user" | "assistant"; content: string }[] = [{ role: "user", content: envelope }];
  const steps: RelayToolStep[] = [];
  let via = "";
  let lastRuntime: unknown;
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
    lastRuntime = gen;
    const text = gen.text.trim();
    const call = parseRelayToolCall(text);
    if (!call) return { text, via, steps, runtime: lastRuntime };
    if (isOfflineVia(via)) return { text, via, steps, runtime: lastRuntime };
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
  return db.transaction(async tx => {
  const [parent] = await tx.select().from(collaborations).where(eq(collaborations.id, id)).for("update");
  if (!parent) throw new OrchestratorInputError("collaboration not found", 404);
  const collab = await readCollaboration(tx, id);
  if (!collab) throw new OrchestratorInputError("collaboration not found");
  if (collab.status === "closed") throw new OrchestratorInputError("this collaboration is closed");
  const thinkers = collab.participants.filter((p) => p.kind !== "human");
  if (!thinkers.length) throw new OrchestratorInputError("a deliberation round needs at least one non-human participant");
  for (const p of thinkers) {
    const relay = prepareRelay(collab, {
      source: "conductor",
      target: p.key,
      purpose: "perspective",
      request:
        `From your perspective as ${p.name}, weigh in on the goal${collab.relays.length ? " and the transcript so far" : ""}. ` +
        "State your strongest recommendation for the owner and your single biggest concern.",
      classification: p.trust === "external" ? "public" : "internal",
    });
    await insertRelay(tx, relay); collab.relays.push(relay);
  }
  const synthesist =
    collab.participants.find((p) => p.capabilities.includes("synthesis")) ??
    collab.participants.find((p) => p.kind === "model" && p.trust === "internal") ??
    thinkers[0];
  const synthesis = prepareRelay(collab, {
    source: "conductor",
    target: synthesist.key,
    purpose: "synthesis",
    request:
      "Weigh every perspective above and produce the single most optimal recommendation for the owner: " +
      "the decision, the trade-offs accepted, and the next step. Flag anything that would overstep the owner's boundaries.",
    classification: synthesist.trust === "external" ? "public" : "internal",
  });
  await insertRelay(tx, synthesis);
  await tx.update(collaborations).set({ status: "running", updatedAt: new Date() }).where(eq(collaborations.id, id));
  return (await readCollaboration(tx, id))!;
  });
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

  const outstanding = collab.relays.find(relay => relay.status === "dispatching" || relay.status === "uncertain");
  if (outstanding) {
    const retained = await readRetainedRelayResult(outstanding);
    if (retained) {
      await publishRetainedResult(id, outstanding.id);
      return { ran: "relay", note: `Relay #${outstanding.seq} result recovered from private storage without replaying its executor.`, collaboration: (await getCollaboration(id))! };
    }
    return { ran: "blocked-relay", note: `Relay #${outstanding.seq} was claimed but has no retained result. Execution or external effects may have occurred. It will NOT be automatically replayed. Reload/inspect the executor, or explicitly cancel this uncertain relay before queuing replacement work.`, collaboration: collab };
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

  if (target.kind === "external") {
    if (!target.adapterUrl) return { ran: "blocked-relay", note: "External participant has no adapter URL; nothing was dispatched.", collaboration: collab };
    if (opts.localOnly) { try { assertUrlDestination(new URL(target.adapterUrl), "loopback"); } catch { return { ran: "blocked-relay", note: "Local-only dispatch permits only loopback adapters; nothing was sent.", collaboration: collab }; } }
  }
  const system = dispatchSystemPrompt(target);
  let envelope;
  try { envelope = await buildEnvelope(collab, pending, target); }
  catch (error) {
    if (!(error instanceof ArtifactInputError) || error.status === 503) throw error;
    const note = `unbound/unavailable or corrupt Artifact context: ${error.message}`;
    await updateRelay(pending.id, { status: "failed", note });
    return { ran: "blocked-relay", note, collaboration: (await getCollaboration(id))! };
  }
  // Persist the claim before any executor can observe the request. All writes
  // take the parent lock, so concurrent Advance calls cannot dispatch twice.
  const claimed = await db.transaction(async tx => {
    const [parent] = await tx.select().from(collaborations).where(eq(collaborations.id, id)).for("update");
    if (!parent || parent.status === "closed") throw new OrchestratorInputError("Collaboration is absent or closed; nothing was dispatched.", 409);
    const [current] = await tx.select().from(collaborationRelays).where(eq(collaborationRelays.id, pending.id)).for("update");
    const blockers = await tx.select({ id: collaborationRelays.id }).from(collaborationRelays).where(and(eq(collaborationRelays.collaborationId, id), sql`${collaborationRelays.status} IN ('dispatching', 'uncertain')`));
    if (!current || current.status !== "pending" || blockers.length) return false;
    await tx.update(collaborationRelays).set({ status: "dispatching", note: "Execution claimed. An unacknowledged outcome is never automatically replayed.", updatedAt: new Date() }).where(eq(collaborationRelays.id, pending.id));
    return true;
  });
  if (!claimed) return { ran: "blocked-relay", note: "Another request already claimed or resolved this relay. Reload to inspect its durable outcome; no duplicate was dispatched.", collaboration: (await getCollaboration(id))! };
  try {
    let result: { text: string; via: string; runtime?: unknown };
    let steps: RelayToolStep[] = [];
    if (target.kind === "external") {
      if (!target.adapterUrl) throw new OrchestratorInputError("external participant has no adapter URL configured");
      if (opts.localOnly) {
        try { assertUrlDestination(new URL(target.adapterUrl), "loopback"); }
        catch { throw new OrchestratorInputError("Local-only dispatch permits only loopback external adapters; nothing was sent."); }
      }
      result = await callExternalAdapter(
        target.adapterUrl,
        target.adapterModel,
        opts.localOnly ? undefined : opts.keys?.externalBearer,
        system,
        envelope
      );
    } else if (pending.toolUse) {
      const loop = await dispatchWithTools(target, envelope, opts);
      result = { text: loop.text, via: loop.via, runtime: loop.runtime };
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
      result = { text: gen.text, via: gen.via, runtime: gen };
    }
    await retainRelayResult(pending, result, steps);
  } catch (error) {
    const note = `Execution outcome uncertain: ${error instanceof Error ? error.message : "executor/result storage failed"}. No automatic replay; inspect before explicitly cancelling.`;
    await updateRelay(pending.id, { status: "uncertain", note }, ["dispatching"]);
    return { ran: "blocked-relay", note, collaboration: (await getCollaboration(id))! };
  }
  await publishRetainedResult(id, pending.id);
  return { ran: "relay", note: `Relay #${pending.seq} → ${target.name} completed; its full response is retained for download.`, collaboration: (await getCollaboration(id))! };
}

async function publishRetainedResult(collaborationId: string, relayId: string) {
  await db.transaction(async tx => {
    const [parent] = await tx.select().from(collaborations).where(eq(collaborations.id, collaborationId)).for("update");
    if (!parent || parent.status === "closed") throw new OrchestratorInputError("Collaboration was closed/removed. Retained result was not overwritten or replayed.", 409);
    const [current] = await tx.select().from(collaborationRelays).where(and(eq(collaborationRelays.id, relayId), eq(collaborationRelays.collaborationId, collaborationId))).for("update");
    if (!current) throw new OrchestratorInputError("Relay was removed; its retained receipt was not deleted.", 409);
    const relay = relayFromRow(current);
    const retained = await readRetainedRelayResult(relay);
    if (!retained) throw new OrchestratorInputError("Claimed relay has no retained result. Inspect the executor; it will not be automatically replayed.", 409);
    if (current.status === "responded" && current.resultReceipt) return;
    if (current.status !== "dispatching" && current.status !== "uncertain") throw new OrchestratorInputError("Relay was explicitly cancelled/resolved. Retained result was not allowed to overwrite that decision.", 409);
    const { receipt, reference } = retained;
    await tx.update(collaborationRelays).set({ status: "responded", response: receipt.text.slice(0, 12000), via: receipt.via, steps: JSON.stringify(receipt.steps), runtime: receipt.runtime ?? null, resultReceipt: reference, note: receipt.text.length > 12000 ? "Preview only. Download the complete retained response; it was not truncated in private storage." : "", updatedAt: new Date() }).where(eq(collaborationRelays.id, relayId));
    await tx.update(collaborations).set({ status: "running", updatedAt: new Date() }).where(eq(collaborations.id, collaborationId));
  });
}
export async function getRelayResult(relayId: string) {
  const [row] = await db.select().from(collaborationRelays).where(eq(collaborationRelays.id, relayId));
  if (!row || !await getCollaboration(row.collaborationId)) return null;
  return readRetainedRelayResult(relayFromRow(row));
}

// ---------------- human checkpoint response ----------------

export async function respondToRelay(relayId: string, input: { response?: string; rejected?: boolean }): Promise<Relay | null> {
  const response = String(input.response ?? "");
  if (response.length > (input.rejected ? 4000 : 12000)) throw new OrchestratorInputError("Checkpoint response exceeds the supported limit; shorten it explicitly. Nothing was changed.", 413);
  return db.transaction(async tx => {
    const [located] = await tx.select().from(collaborationRelays).where(eq(collaborationRelays.id, relayId));
    if (!located) return null;
    const [parent] = await tx.select().from(collaborations).where(eq(collaborations.id, located.collaborationId)).for("update");
    if (!parent || parent.status === "closed") throw new OrchestratorInputError("Collaboration is absent or closed; the checkpoint was not changed.", 409);
    const [current] = await tx.select().from(collaborationRelays).where(eq(collaborationRelays.id, relayId)).for("update");
    if (!current) return null;
    const status = input.rejected ? "cancelled" : "responded";
    const answer = input.rejected ? response || null : response || "(approved by the owner)";
    const uncertain = current.status === "dispatching" || current.status === "uncertain";
    if (current.status !== "pending" && !(uncertain && input.rejected)) {
      if (current.status === status && current.response === answer) return relayFromRow(current);
      throw new OrchestratorInputError("Checkpoint already resolved. Reload the acknowledged answer; it was not overwritten.", 409);
    }
    const [participant] = await tx.select().from(collaborationParticipants).where(and(eq(collaborationParticipants.collaborationId, parent.id), eq(collaborationParticipants.key, current.targetKey)));
    if ((!participant || participant.kind !== "human") && !(uncertain && input.rejected)) throw new OrchestratorInputError("Only a human checkpoint can be answered by the owner.", 409);
    const [updated] = await tx.update(collaborationRelays).set({ status, response: answer, via: "human", note: input.rejected ? uncertain ? "Explicitly cancelled by owner; external effects were not undone. A later retained result remains inspectable." : "Rejected by the owner." : "", updatedAt: new Date() }).where(eq(collaborationRelays.id, relayId)).returning();
    await tx.update(collaborations).set({ status: "running", updatedAt: new Date() }).where(eq(collaborations.id, parent.id));
    return relayFromRow(updated);
  });
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

export class CollaborationArchiveError extends Error {
  readonly status: number;
  constructor(message: string, status = 503) { super(message); this.status = status; }
}
export async function fullCollaborationRecord(collab: Collaboration) {
  const record = { ...collab, relays: collab.relays.map(relay => ({ ...relay })) };
  let budget = Buffer.byteLength(JSON.stringify(record), "utf8");
  for (const relay of record.relays) {
    if (!relay.resultReceipt) continue;
    if (budget + relay.resultReceipt.bytes > MAX_ARTIFACT_OBJECT_BYTES) throw new CollaborationArchiveError("Complete record exceeds32MiB. Individual full relay responses remain downloadable; no clipped archive was filed.", 413);
    const retained = await readRetainedRelayResult(relay);
    if (!retained) throw new CollaborationArchiveError("A completed relay's retained response is missing. Restore its private storage before filing; its preview was not substituted.", 410);
    budget += Buffer.byteLength(retained.receipt.text, "utf8") - Buffer.byteLength(relay.response ?? "", "utf8");
    relay.response = retained.receipt.text;
  }
  return record;
}
export async function closeCollaboration(id: string, summary?: string): Promise<Collaboration & { archive: { artifactId: string; revisionId: string } }> {
  const result = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(collaborations).where(eq(collaborations.id, id)).for("update");
    if (!row) throw new CollaborationArchiveError("collaboration not found", 404);
    const pRows = await tx.select().from(collaborationParticipants).where(eq(collaborationParticipants.collaborationId, id)).orderBy(asc(collaborationParticipants.createdAt));
    const rRows = await tx.select().from(collaborationRelays).where(eq(collaborationRelays.collaborationId, id)).orderBy(asc(collaborationRelays.seq));
    if (rRows.some(relay => ["pending", "dispatching", "uncertain"].includes(relay.status))) throw new CollaborationArchiveError("Resolve pending/uncertain relays before filing. Their work is retained and no executor will be automatically replayed.", 409);
    const now = new Date();
    const record = collaborationFromRows({ ...row, status: "closed", updatedAt: now }, pRows, rRows);
    let artifact = await getArtifact(tx, id, LOCAL_OWNER_ID, true);
    if (!artifact) {
      // The immutable record uses the last work-update timestamp; filing time
      // is Artifact revision.createdAt. A DB rollback/retry therefore hashes
      // identical work to the SAME object, rather than leaking timed copies.
      const complete = await fullCollaborationRecord(collaborationFromRows({ ...row, status: "closed" }, pRows, rRows));
      const body = `${summary ? `Summary: ${String(summary)}\n\n` : ""}Retained collaboration record (JSON):\n\n${JSON.stringify(complete, null, 2)}`;
      if (Buffer.byteLength(body, "utf8") > MAX_ARTIFACT_OBJECT_BYTES) throw new CollaborationArchiveError("Complete record exceeds32MiB. Download individual retained responses; no clipped archive was filed.", 413);
      const contentObject = body.length > 20000 ? await writeArtifactObject(LOCAL_OWNER_ID, body) : undefined;
      artifact = await insertArtifact(tx, { id, projectId: record.projectId, kind: "decision", title: `Collaboration record — ${record.title}`, body: contentObject ? artifactObjectSummary(contentObject) : body, contentObject, sourceType: "orchestrator", sourceId: id, ownerId: LOCAL_OWNER_ID });
    }
    if (artifact.sourceType !== "orchestrator" || artifact.sourceId !== id) throw new CollaborationArchiveError("Archive identity collision; no session changes were committed.", 409);
    if (artifact.deletedAt) throw new CollaborationArchiveError("Archived Artifact is in trash. Recover it in the Library before retrying.", 409);
    const [original] = await tx.select().from(artifactRevisions).where(and(eq(artifactRevisions.artifactId, id), eq(artifactRevisions.revision, 1))).limit(1);
    if (!original) throw new CollaborationArchiveError("Original immutable archive unavailable; filing was not confirmed.");
    assertRevisionIntegrity(original, LOCAL_OWNER_ID);
    if (original.snapshot.contentObject) await verifyArtifactObject(LOCAL_OWNER_ID, original.snapshot.contentObject);
    await tx.update(collaborations).set({ status: "closed", updatedAt: now }).where(eq(collaborations.id, id));
    return { record, revisionId: original.id };
  });
  return { ...result.record, archive: { artifactId: id, revisionId: result.revisionId } };
}

// ---------------- delete ----------------

export async function deleteCollaboration(id: string): Promise<boolean> {
  return db.transaction(async tx => {
    const [parent] = await tx.select().from(collaborations).where(eq(collaborations.id, id)).for("update");
    if (!parent) return false;
    const outstanding = await tx.select({ status: collaborationRelays.status }).from(collaborationRelays).where(eq(collaborationRelays.collaborationId, id));
    if (outstanding.some(relay => relay.status === "dispatching" || relay.status === "uncertain")) throw new OrchestratorInputError("Inspect or explicitly cancel uncertain dispatches before deleting; external effects may have occurred.", 409);
    await tx.delete(collaborationRelays).where(eq(collaborationRelays.collaborationId, id));
    await tx.delete(collaborationParticipants).where(eq(collaborationParticipants.collaborationId, id));
    await tx.delete(collaborations).where(eq(collaborations.id, id));
    return true;
  });
}
