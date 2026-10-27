import { NextResponse } from "next/server";

import { deleteRun, getRun, listRuns, runDeepAgent, saveRunAsArtifact } from "@/lib/deepAgent";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** GET → recent runs (or ?id= for one full run). */
export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (id) {
    const run = await getRun(id);
    if (!run) return NextResponse.json({ error: "run not found" }, { status: 404 });
    return NextResponse.json({ run });
  }
  return NextResponse.json({ runs: await listRuns() });
}

/** POST {goal, steps?, keys?, modelId?} → a bounded plan→act→verify run. */
export async function POST(req: Request) {
  let body: { goal?: string; steps?: number; keys?: Record<string, string>; modelId?: string } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const goal = (body.goal ?? "").slice(0, 2000);
  if (!goal.trim()) return NextResponse.json({ error: "goal is required" }, { status: 400 });
  const run = await runDeepAgent(goal, { steps: body.steps, keys: body.keys, modelId: body.modelId });
  return NextResponse.json({ run }, { status: 201 });
}

/** PUT {runId} → save a finished run into the artifact library. */
export async function PUT(req: Request) {
  let body: { runId?: string } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!body.runId) return NextResponse.json({ error: "runId is required" }, { status: 400 });
  const result = await saveRunAsArtifact(body.runId);
  if (!result.ok) return NextResponse.json({ error: result.note ?? "could not save" }, { status: 422 });
  return NextResponse.json({ ok: true, artifactId: result.artifactId });
}

/** DELETE ?id= → remove a run (and its transcript, cascade). */
export async function DELETE(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  return NextResponse.json({ removed: await deleteRun(id) });
}
