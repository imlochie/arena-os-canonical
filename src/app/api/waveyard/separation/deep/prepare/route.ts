/**
 * Deep-engine preparation — the self-service lifecycle surface.
 *
 *   GET            → the durable preparation status (cheap, pollable:
 *                    state, steps, progress, consent, environment,
 *                    result, error, sanitized log). No discovery here,
 *                    so polling never spawns interpreters.
 *   GET ?inspect=1 → status + a FRESH environment report and the
 *                    ordered plan (what will be installed/downloaded,
 *                    expected sizes, verified sources, licenses) —
 *                    the consent screen's data.
 *   POST           → start (or resume) preparation with the owner's
 *                    granted consents. Validates consent against the
 *                    plan, then returns immediately; the run continues
 *                    in the background and its state is on disk.
 *
 * Every action calls a real backend operation and returns an honest
 * result — there are no instruction-only buttons here.
 */

import { NextResponse } from "next/server";

import { requireUser } from "@/lib/waveyard/local-context";
import { deepEngineStatusForThisRuntime, inspectDeepRuntimeReadiness } from "@/lib/waveyard/separation/deep";
import type { PreparationStatus } from "@/lib/waveyard/separation/provision-store";
import { getPreparationManager } from "@/lib/waveyard/separation/provision-store";
import { resolveProcessingMode } from "@/lib/waveyard/worker-local/runtime-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await requireUser();
    const modelId = new URL(request.url).searchParams.get("model") ?? "deep_6s";
    const manager = getPreparationManager(modelId);
    const status: PreparationStatus = await manager.getStatus();
    const body: Record<string, unknown> = {
      status,
      // Honest about WHICH runtime this is: the deep pass executes
      // in-process, so preparation is meaningful where this machine
      // runs the engine.
      runtime: {
        processingMode: resolveProcessingMode(),
        engine: { ...deepEngineStatusForThisRuntime(undefined, modelId), ...(await inspectDeepRuntimeReadiness({ modelId })) },
      },
    };
    if (new URL(request.url).searchParams.get("inspect") === "1") {
      const { report, plan } = await manager.inspect();
      body.report = report;
      body.plan = plan;
    }
    return NextResponse.json(body);
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("deep preparation status failed", error);
    return NextResponse.json({ error: "The preparation status could not be read." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    await requireUser();
    const body = (await request.json().catch(() => ({}))) as { consent?: unknown; model?: string; retest?: boolean };
    const manager = getPreparationManager(body.model);
    const grants = Array.isArray(body.consent)
      ? body.consent.filter((value): value is string => typeof value === "string")
      : [];
    const outcome = await manager.start(grants, body.retest === true);
    if (outcome.outcome === "started") {
      return NextResponse.json({ outcome: "started", epoch: outcome.epoch }, { status: 202 });
    }
    if (outcome.outcome === "already-ready") {
      return NextResponse.json({ outcome: "already-ready" }, { status: 200 });
    }
    if (outcome.outcome === "already-running") {
      return NextResponse.json({ outcome: "already-running", state: outcome.state }, { status: 409 });
    }
    return NextResponse.json({ outcome: "consent-missing", missing: outcome.missing }, { status: 400 });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("deep preparation start failed", error);
    return NextResponse.json({ error: "Preparation could not be started." }, { status: 500 });
  }
}
