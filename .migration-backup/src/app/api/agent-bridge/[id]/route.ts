/**
 * Agent bridge — post an answer for a taken task.
 *
 * POST /api/agent-bridge/{id} { text, ok? }
 *   → completes the task; generate() (backend "agent-bridge") unblocks with
 *     the text as the model output, honestly labeled via "agent-bridge".
 */

import { NextResponse } from "next/server";

import { completeTask } from "@/lib/modelHub/agentBridge";

export const dynamic = "force-dynamic";

function authorized(request: Request): boolean {
  const expected = process.env.ARENA_INTERNAL_API_KEY?.trim();
  if (expected === undefined || expected === "") return true;
  return request.headers.get("x-arena-internal-key") === expected;
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Bridge key required." }, { status: 401 });
  }
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as { text?: unknown; ok?: unknown };
  const text = typeof body.text === "string" ? body.text : "";
  const ok = body.ok !== false;
  if (text === "" && ok) {
    return NextResponse.json({ error: "An answer requires text (or ok:false to fail the task)." }, { status: 400 });
  }
  const completed = await completeTask(id, text.slice(0, 100_000), ok);
  if (!completed) return NextResponse.json({ error: "Task not found or not taken." }, { status: 404 });
  return NextResponse.json({ completed: true });
}
