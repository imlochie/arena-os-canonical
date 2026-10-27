/**
 * Space mission governance — the strict check-in environment (Phase A of the
 * Spaces autonomy roadmap; see docs/spaces-autonomy.md).
 *
 * Missions act on the real machine through the journaled tool surface. This
 * module decides WHICH of those actions a human must explicitly approve
 * before they run, and is the durable ledger of every request, decision, and
 * execution — the audit trail that makes autonomy accountable:
 *
 *   pending → approved | denied        (a human decides)
 *   approved → executing → executed | failed   (single-claim execution)
 *
 * NOTHING approval-gated ever executes without a decision recorded here, and
 * a decision can never be replayed into a second execution (atomic claim).
 *
 * Storage follows the spaces house pattern: Postgres when available, an
 * in-memory fallback otherwise (the desktop app always has Postgres; a bare
 * `next dev` without a database still gets full governance semantics).
 */

import { createHash } from "node:crypto";
import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { db } from "@/db";
import { spaceActionApprovals } from "@/db/schema";

// ---------------- action classification ----------------

export type ActionClass =
  | "filesystem.read"
  | "filesystem.write"
  | "command.run"
  | "network.fetch"
  | "github.publish"
  | "browser.view"
  | "browser.interact"
  | "external.call"
  | "external.sms"
  | "payment.link";

/** Action classes that ALWAYS require an explicit human approval before
 * execution. Everything else is journaled but auto-executed (bounded by the
 * tool surface itself: allowlist, cwd jail, timeouts, size caps). */
export const APPROVAL_REQUIRED: readonly ActionClass[] = [
  "github.publish",
  "browser.interact",
  "external.call",
  "external.sms",
  "payment.link",
];

export function approvalRequired(actionClass: ActionClass): boolean {
  return APPROVAL_REQUIRED.includes(actionClass);
}

/** Map a mission tool name to its action class. */
export function classifyToolAction(tool: string): ActionClass {
  switch (tool) {
    case "write_file":
    case "edit_file":
    case "delete_file":
      return "filesystem.write";
    case "run_command":
    case "run_tests":
      return "command.run";
    case "fetch_url":
      return "network.fetch";
    case "github_publish":
      return "github.publish";
    case "browser_navigate":
    case "browser_extract":
    case "browser_screenshot":
      return "browser.view";
    case "browser_click":
    case "browser_fill":
      return "browser.interact";
    case "external_call":
      return "external.call";
    case "external_sms":
      return "external.sms";
    case "payment_link":
      return "payment.link";
    default:
      return "filesystem.read"; // read_file, list_files, search_code
  }
}

/** Stable signature of a proposed action instance — the same action emitted
 * twice by a mission (e.g. before and after an approval checkpoint) maps to
 * the same approval, never a duplicate. */
export function actionSignature(missionId: string, tool: string, args: unknown): string {
  const canonical = JSON.stringify({ missionId, tool, args }, Object.keys(sortedKeys(args)).length ? sortedReplacer : undefined);
  return createHash("sha256").update(canonical).digest("hex");
}

function sortedKeys(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
function sortedReplacer(_k: string, v: unknown): unknown {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return Object.keys(v as Record<string, unknown>).sort().reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = (v as Record<string, unknown>)[key];
      return acc;
    }, {});
  }
  return v;
}

// ---------------- approval ledger ----------------

export type ApprovalStatus = "pending" | "approved" | "denied" | "executing" | "executed" | "failed";

export interface ActionApproval {
  id: string;
  spaceId: string;
  missionId: string | null;
  signature: string;
  actionClass: ActionClass;
  summary: string;
  payload: unknown; // REDACTED — never contains secrets
  status: ApprovalStatus;
  requestedAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  executedAt: string | null;
  result: unknown; // REDACTED
  failureReason: string | null;
}

const ACTIVE: ApprovalStatus[] = ["pending", "approved", "executing"];

// Memory fallback (same philosophy as the spaces/mission stores).
let ledgerDbHealthy = true;
const memoryApprovals = new Map<string, ActionApproval>();

function rowToApproval(row: typeof spaceActionApprovals.$inferSelect): ActionApproval {
  return {
    id: row.id,
    spaceId: row.spaceId,
    missionId: row.missionId ?? null,
    signature: row.signature,
    actionClass: row.actionClass as ActionClass,
    summary: row.summary,
    payload: row.payload ?? null,
    status: row.status as ApprovalStatus,
    requestedAt: (row.requestedAt ?? new Date()).toISOString(),
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    decidedBy: row.decidedBy ?? null,
    executedAt: row.executedAt ? row.executedAt.toISOString() : null,
    result: row.result ?? null,
    failureReason: row.failureReason ?? null,
  };
}

/** Request (or return the existing) approval for an action instance. Idempotent
 * per signature while an approval is still active — a mission that re-emits
 * the same gated action after a checkpoint reuses its pending approval. */
export async function requestApproval(input: {
  spaceId: string;
  missionId: string | null;
  signature: string;
  actionClass: ActionClass;
  summary: string;
  payload?: unknown;
}): Promise<ActionApproval> {
  if (ledgerDbHealthy) {
    try {
      const existing = await db
        .select()
        .from(spaceActionApprovals)
        .where(and(eq(spaceActionApprovals.signature, input.signature), inArray(spaceActionApprovals.status, ACTIVE)))
        .limit(1);
      if (existing.length) return rowToApproval(existing[0]);
      const [row] = await db
        .insert(spaceActionApprovals)
        .values({
          spaceId: input.spaceId,
          missionId: input.missionId,
          signature: input.signature,
          actionClass: input.actionClass,
          summary: input.summary.slice(0, 500),
          payload: (input.payload ?? null) as never,
          status: "pending",
        })
        .returning();
      return rowToApproval(row);
    } catch {
      ledgerDbHealthy = false;
    }
  }
  for (const a of memoryApprovals.values()) {
    if (a.signature === input.signature && ACTIVE.includes(a.status)) return a;
  }
  const approval: ActionApproval = {
    id: crypto.randomUUID(),
    spaceId: input.spaceId,
    missionId: input.missionId,
    signature: input.signature,
    actionClass: input.actionClass,
    summary: input.summary.slice(0, 500),
    payload: input.payload ?? null,
    status: "pending",
    requestedAt: new Date().toISOString(),
    decidedAt: null,
    decidedBy: null,
    executedAt: null,
    result: null,
    failureReason: null,
  };
  memoryApprovals.set(approval.id, approval);
  return approval;
}

export async function getApproval(id: string): Promise<ActionApproval | null> {
  if (ledgerDbHealthy) {
    try {
      const rows = await db.select().from(spaceActionApprovals).where(eq(spaceActionApprovals.id, id)).limit(1);
      if (rows.length) return rowToApproval(rows[0]);
      return null;
    } catch {
      ledgerDbHealthy = false;
    }
  }
  return memoryApprovals.get(id) ?? null;
}

export async function findActiveBySignature(signature: string): Promise<ActionApproval | null> {
  if (ledgerDbHealthy) {
    try {
      const rows = await db
        .select()
        .from(spaceActionApprovals)
        .where(and(eq(spaceActionApprovals.signature, signature), inArray(spaceActionApprovals.status, ACTIVE)))
        .limit(1);
      if (rows.length) return rowToApproval(rows[0]);
      return null;
    } catch {
      ledgerDbHealthy = false;
    }
  }
  for (const a of memoryApprovals.values()) {
    if (a.signature === signature && ACTIVE.includes(a.status)) return a;
  }
  return null;
}

/** The latest approval for a signature, in ANY status — the gate uses this
 * so that terminal decisions (denied, executed) stay binding on re-emission:
 * a denied action is refused without a fresh request; an executed one is
 * never run again. */
export async function findLatestBySignature(signature: string): Promise<ActionApproval | null> {
  if (ledgerDbHealthy) {
    try {
      const rows = await db
        .select()
        .from(spaceActionApprovals)
        .where(eq(spaceActionApprovals.signature, signature))
        .orderBy(desc(spaceActionApprovals.requestedAt))
        .limit(1);
      if (rows.length) return rowToApproval(rows[0]);
      return null;
    } catch {
      ledgerDbHealthy = false;
    }
  }
  let latest: ActionApproval | null = null;
  for (const a of memoryApprovals.values()) {
    if (a.signature === signature && (!latest || a.requestedAt > latest.requestedAt)) latest = a;
  }
  return latest;
}

export async function listApprovals(spaceId?: string, status?: ApprovalStatus): Promise<ActionApproval[]> {
  if (ledgerDbHealthy) {
    try {
      const conditions = [];
      if (spaceId) conditions.push(eq(spaceActionApprovals.spaceId, spaceId));
      if (status) conditions.push(eq(spaceActionApprovals.status, status));
      const rows = await db
        .select()
        .from(spaceActionApprovals)
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(desc(spaceActionApprovals.requestedAt))
        .limit(200);
      return rows.map(rowToApproval);
    } catch {
      ledgerDbHealthy = false;
    }
  }
  return [...memoryApprovals.values()]
    .filter((a) => (!spaceId || a.spaceId === spaceId) && (!status || a.status === status))
    .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
}

/** A human decides a pending approval. Terminal: denied stays denied. */
export async function decideApproval(
  id: string,
  decision: "approve" | "deny",
  decidedBy: string,
): Promise<ActionApproval | null> {
  if (ledgerDbHealthy) {
    try {
      const [row] = await db
        .update(spaceActionApprovals)
        .set({
          status: decision === "approve" ? "approved" : "denied",
          decidedAt: new Date(),
          decidedBy: decidedBy.slice(0, 100),
        })
        .where(and(eq(spaceActionApprovals.id, id), eq(spaceActionApprovals.status, "pending")))
        .returning();
      return row ? rowToApproval(row) : null;
    } catch {
      ledgerDbHealthy = false;
    }
  }
  const a = memoryApprovals.get(id);
  if (!a || a.status !== "pending") return null;
  a.status = decision === "approve" ? "approved" : "denied";
  a.decidedAt = new Date().toISOString();
  a.decidedBy = decidedBy.slice(0, 100);
  return a;
}

/** Single-claim execution: exactly one caller may transition approved →
 * executing. A second claim (double-click, daemon race, replay) loses. */
export async function claimExecution(id: string): Promise<boolean> {
  if (ledgerDbHealthy) {
    try {
      const rows = await db
        .update(spaceActionApprovals)
        .set({ status: "executing" })
        .where(and(eq(spaceActionApprovals.id, id), eq(spaceActionApprovals.status, "approved")))
        .returning();
      return rows.length > 0;
    } catch {
      ledgerDbHealthy = false;
    }
  }
  const a = memoryApprovals.get(id);
  if (!a || a.status !== "approved") return false;
  a.status = "executing";
  return true;
}

export async function completeExecution(id: string, ok: boolean, result: unknown, failureReason?: string): Promise<void> {
  if (ledgerDbHealthy) {
    try {
      await db
        .update(spaceActionApprovals)
        .set({
          status: ok ? "executed" : "failed",
          executedAt: new Date(),
          result: (ok ? result : null) as never,
          failureReason: ok ? null : String(failureReason ?? "execution failed").slice(0, 1000),
        })
        .where(eq(spaceActionApprovals.id, id));
      return;
    } catch {
      ledgerDbHealthy = false;
    }
  }
  const a = memoryApprovals.get(id);
  if (!a) return;
  a.status = ok ? "executed" : "failed";
  a.executedAt = new Date().toISOString();
  a.result = ok ? result : null;
  a.failureReason = ok ? null : String(failureReason ?? "execution failed").slice(0, 1000);
}

/** Expire approvals nobody decided. Free of side effects on decided rows. */
export async function expireApprovals(olderThanMs: number): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs);
  if (ledgerDbHealthy) {
    try {
      const rows = await db
        .update(spaceActionApprovals)
        .set({ status: "denied", decidedAt: new Date(), decidedBy: "expired" })
        .where(and(eq(spaceActionApprovals.status, "pending"), lt(spaceActionApprovals.requestedAt, cutoff)))
        .returning();
      return rows.length;
    } catch {
      ledgerDbHealthy = false;
    }
  }
  let n = 0;
  for (const a of memoryApprovals.values()) {
    if (a.status === "pending" && new Date(a.requestedAt).getTime() < cutoff.getTime()) {
      a.status = "denied";
      a.decidedAt = new Date().toISOString();
      a.decidedBy = "expired";
      n++;
    }
  }
  return n;
}
