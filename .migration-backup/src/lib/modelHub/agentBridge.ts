/**
 * Agent bridge — "back-wire an agent into the app."
 *
 * The app enqueues a prompt; an external agent — a human at a terminal, or
 * an AI agent session running scripts/agent-bridge.mjs — takes it, answers
 * it, and the answer flows back through the normal generate() contract with
 * backend "agent-bridge" and honest provenance (via: agent-bridge).
 *
 * Fast-fail honesty: if no bridge has polled recently, submissions return
 * null immediately — the caller falls back visibly instead of hanging.
 */

import { and, asc, eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { agentBridgeState, agentBridgeTasks } from "@/db/schema";
import type { ChatMsg } from "@/lib/ai";

const BRIDGE_SINGLTON_ID = "bridge";
const BRIDGE_STALE_MS = 15_000;
const POLL_INTERVAL_MS = 400;

export type AgentTaskView = {
  id: string;
  messages: ChatMsg[];
  createdAt: string;
};

/** Record a bridge poll (called by the API routes on every take/heartbeat). */
export async function touchBridge(name: string | null): Promise<void> {
  await db
    .insert(agentBridgeState)
    .values({ id: BRIDGE_SINGLTON_ID, name, lastPolledAt: new Date() })
    .onConflictDoUpdate({
      target: agentBridgeState.id,
      set: { name, lastPolledAt: new Date() },
    });
}

export async function bridgeStatus(): Promise<{ connected: boolean; name: string | null; lastPolledAt: string | null }> {
  const [state] = await db.select().from(agentBridgeState).where(eq(agentBridgeState.id, BRIDGE_SINGLTON_ID)).limit(1);
  const lastPolledAt = state?.lastPolledAt ?? null;
  return {
    connected: lastPolledAt !== null && Date.now() - new Date(lastPolledAt).getTime() < BRIDGE_STALE_MS,
    name: state?.name ?? null,
    lastPolledAt: lastPolledAt !== null ? new Date(lastPolledAt).toISOString() : null,
  };
}

/** Take the next queued task (marks it taken). Returns null when the queue is empty. */
export async function takeNextTask(): Promise<AgentTaskView | null> {
  const [next] = await db
    .select()
    .from(agentBridgeTasks)
    .where(eq(agentBridgeTasks.status, "queued"))
    .orderBy(asc(agentBridgeTasks.createdAt))
    .limit(1);
  if (!next) return null;
  const claimed = await db
    .update(agentBridgeTasks)
    .set({ status: "taken", takenAt: new Date() })
    .where(and(eq(agentBridgeTasks.id, next.id), eq(agentBridgeTasks.status, "queued")))
    .returning({ id: agentBridgeTasks.id });
  if (claimed.length === 0) return null; // someone else took it
  return {
    id: next.id,
    messages: JSON.parse(next.messagesJson) as ChatMsg[],
    createdAt: next.createdAt instanceof Date ? next.createdAt.toISOString() : String(next.createdAt),
  };
}

export async function completeTask(id: string, text: string, ok: boolean): Promise<boolean> {
  const rows = await db
    .update(agentBridgeTasks)
    .set({ status: ok ? "done" : "failed", resultText: text, completedAt: new Date() })
    .where(and(eq(agentBridgeTasks.id, id), eq(agentBridgeTasks.status, "taken")))
    .returning({ id: agentBridgeTasks.id });
  return rows.length > 0;
}

/**
 * Submit a prompt and wait for a bridge answer. Returns null when no bridge
 * is connected (fast) or the wait times out — the caller produces the honest
 * labelled fallback. On timeout the row is marked expired so a late bridge
 * answer is never silently dropped into nothing (it stays inspectable).
 */
export async function submitAgentTask(
  messages: ChatMsg[],
  requestedModelId: string,
  waitMs = 90_000,
): Promise<string | null> {
  const status = await bridgeStatus();
  if (!status.connected) return null;
  const [task] = await db
    .insert(agentBridgeTasks)
    .values({ messagesJson: JSON.stringify(messages), requestedModelId, status: "queued" })
    .returning({ id: agentBridgeTasks.id });
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    const [row] = await db.select().from(agentBridgeTasks).where(eq(agentBridgeTasks.id, task.id)).limit(1);
    if (!row) return null;
    if (row.status === "done" && row.resultText !== null) return row.resultText;
    if (row.status === "failed") return null;
  }
  await db
    .update(agentBridgeTasks)
    .set({ status: "expired", completedAt: new Date() })
    .where(and(eq(agentBridgeTasks.id, task.id), sql`${agentBridgeTasks.status} in ('queued','taken')`));
  return null;
}
