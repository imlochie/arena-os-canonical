/**
 * Space action approvals — the human side of the check-in environment
 * (docs/spaces-autonomy.md Phase A).
 *
 *   GET  /api/spaces/approvals?spaceId=&status=&pending=1
 *        → the approval ledger (newest first, bounded)
 *   POST /api/spaces/approvals { id, decision: "approve"|"deny" }
 *        → record a human decision on a pending approval
 *
 * Deciding an approval does NOT execute anything by itself: the mission
 * (resumed by the workbench or the spaces daemon) claims and executes
 * approved actions exactly once. Denials are terminal.
 */

import { decideApproval, listApprovals, type ApprovalStatus } from "@/lib/spaces/governance";

export const dynamic = "force-dynamic";

const STATUSES: ApprovalStatus[] = ["pending", "approved", "denied", "executing", "executed", "failed"];

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const spaceId = url.searchParams.get("spaceId") ?? undefined;
    const statusParam = url.searchParams.get("status");
    const status = STATUSES.includes(statusParam as ApprovalStatus) ? (statusParam as ApprovalStatus) : undefined;
    const approvals = await listApprovals(spaceId, status);
    return Response.json({ approvals });
  } catch (e) {
    const message = e instanceof Error ? e.message : "approval list failed";
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const id = String(body?.id ?? "");
    const decision = body?.decision;
    if (!id) return Response.json({ error: "id is required" }, { status: 400 });
    if (decision !== "approve" && decision !== "deny") {
      return Response.json({ error: 'decision must be "approve" or "deny"' }, { status: 400 });
    }
    const decidedBy = String(body?.decidedBy ?? "owner").slice(0, 100);
    const approval = await decideApproval(id, decision, decidedBy);
    if (!approval) {
      return Response.json({ error: "approval not found or already decided" }, { status: 409 });
    }
    return Response.json({ approval });
  } catch (e) {
    const message = e instanceof Error ? e.message : "decision failed";
    return Response.json({ error: message }, { status: 500 });
  }
}
