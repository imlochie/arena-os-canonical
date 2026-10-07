/**
 * AI assist route — REQUEST → ANALYSIS → PROPOSAL → REVIEW → APPLY.
 *
 * POST /api/waveyard/projects/[id]/ai
 *   { action: "request", workflowId, providerId? } → analysis text and/or a
 *     VALIDATED proposal (validator is the authority; clamps recorded).
 *   { action: "apply", workflowId, proposal }     → re-validates against
 *     fresh state, then persists inserts/strip changes to the remix
 *     session (undoable via normal remix history + PUT).
 *
 * GET → provider statuses (honest availability + reasons), the 16
 * workflows, and the channel menu. Unavailable providers return 503 with
 * the exact reason — there is no canned fallback. Non-AI features are
 * untouched.
 */

import { NextResponse } from "next/server";
import { asc, desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { db } from "@/db";
import { remixSessions, remixTracks, sourceAssets, stemAssets } from "@/db/waveyardSchema";
import { requireProjectRole, requireUser } from "@/lib/waveyard/local-context";
import { getStorage } from "@/lib/waveyard/storage";
import { decodeSourceToStereoPcm, DependencyMissingError } from "@/lib/waveyard/measure/pcm";
import { buildAnalysisPacket } from "@/lib/waveyard/ai/packet";
import { capabilityLabel, describeCapability } from "@/lib/waveyard/ai/capability";
import { AI_WORKFLOWS, findWorkflow } from "@/lib/waveyard/ai/workflows";
import {
  defaultProviderId,
  extractJsonObject,
  listProviders,
  requestFromProvider,
  type ProviderId,
} from "@/lib/waveyard/ai/providers";
import { applyProposal } from "@/lib/waveyard/ai/proposal";
import { mixerStateFromRemix, remixUpdateFromMixerState, type RemixSessionView } from "@/lib/waveyard/ai/remix-bridge";
// The remix PUT path persists bare-array insert JSON; the AI apply path
// writes the identical canonical form so GET/PUT consumers see one format.
const chainToJson = (chain: ReadonlyArray<unknown>) => JSON.stringify(chain);

export const dynamic = "force-dynamic";

async function loadSessionView(projectId: string): Promise<{ sessionId: string; view: RemixSessionView } | null> {
  const [session] = await db
    .select()
    .from(remixSessions)
    .where(eq(remixSessions.projectId, projectId))
    .orderBy(desc(remixSessions.createdAt))
    .limit(1);
  if (session === undefined) return null;
  const tracks = await db
    .select()
    .from(remixTracks)
    .where(eq(remixTracks.remixSessionId, session.id))
    .orderBy(asc(remixTracks.sortOrder));
  return {
    sessionId: session.id,
    view: {
      masterVolume: session.masterVolume,
      masterInsertsRaw: session.masterInserts,
      tracks: tracks.map((track) => ({
        id: track.id,
        stemAssetId: track.stemAssetId,
        name: track.name,
        volume: track.volume,
        pan: track.pan,
        muted: track.muted,
        solo: track.solo,
        insertsRaw: track.inserts,
      })),
    },
  };
}

async function loadPacketInputs(projectId: string) {
  const [source] = await db
    .select()
    .from(sourceAssets)
    .where(eq(sourceAssets.projectId, projectId))
    .orderBy(asc(sourceAssets.createdAt))
    .limit(1);
  const stems = await db
    .select({ id: stemAssets.id, stemType: stemAssets.stemType })
    .from(stemAssets)
    .where(eq(stemAssets.projectId, projectId));
  return { source, stems };
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id: projectId } = await params;
    await requireProjectRole(user.id, projectId, "viewer");
    const session = await loadSessionView(projectId);
    const channelMenu = session === null
      ? []
      : [
          ...session.view.tracks.map((track) => ({ id: `stem:${track.stemAssetId}`, name: track.name })),
          { id: "master", name: "Master" },
        ];
    return NextResponse.json({
      providers: listProviders(),
      defaultProviderId: defaultProviderId(),
      workflows: AI_WORKFLOWS,
      channels: channelMenu,
      capabilityLabels: {
        "audio-model": capabilityLabel("audio-model"),
        "audio-derived": capabilityLabel("audio-derived"),
        "text-only": capabilityLabel("text-only"),
      },
    });
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: "Could not load AI studio state." }, { status: 500 });
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  let tempSource: string | null = null;
  try {
    const user = await requireUser();
    const { id: projectId } = await params;
    await requireProjectRole(user.id, projectId, "editor");
    const body = await request.json().catch(() => ({}));
    const action = String(body.action ?? "");

    if (action === "request") {
      const workflow = findWorkflow(String(body.workflowId ?? ""));
      if (workflow === null)
        return NextResponse.json({ error: "Unknown workflow." }, { status: 400 });
      const providerId = (String(body.providerId ?? defaultProviderId()) as ProviderId);
      if (providerId !== "openai" && providerId !== "anthropic")
        return NextResponse.json({ error: "Unknown provider." }, { status: 400 });

      const session = await loadSessionView(projectId);
      if (session === null)
        return NextResponse.json({ error: "This project has no remix session yet." }, { status: 409 });
      const { source, stems } = await loadPacketInputs(projectId);
      if (source === undefined)
        return NextResponse.json({ error: "This project has no source audio to analyze." }, { status: 409 });

      // Real PCM → real measured packet. The model never receives audio.
      tempSource = join(tmpdir(), `arena-ai-src-${randomUUID()}`);
      await getStorage().getToFile(source.storageKey, tempSource);
      const decoded = await decodeSourceToStereoPcm(tempSource, { sampleRate: source.sampleRate });
      const packet = buildAnalysisPacket({
        target: { kind: "mix", name: session.view.tracks[0]?.name ?? "Mix" },
        pcm: decoded.pcm,
        sampleRate: decoded.sampleRate,
        stems: stems.map((stem) => ({ id: stem.id, type: stem.stemType })),
      });

      const channelMenu = [
        ...session.view.tracks.map((track) => ({ id: `stem:${track.stemAssetId}`, name: track.name })),
        { id: "master", name: "Master" },
      ];
      const result = await requestFromProvider({ providerId, workflow, packet, channelMenu });
      if (!result.ok) {
        return NextResponse.json(
          { error: result.reason, errorCode: "PROVIDER_UNAVAILABLE" },
          { status: 503 },
        );
      }

      const state = mixerStateFromRemix(session.view);
      if (workflow.expectation === "proposal") {
        const candidate = extractJsonObject(result.raw);
        const application = applyProposal(state, candidate);
        if (application.status === "rejected") {
          // The model's output failed the contract — reported honestly with
          // the exact errors. Nothing was applied.
          return NextResponse.json(
            {
              capability: result.capability,
              model: result.model,
              workflowId: workflow.id,
              rawModelOutput: result.raw.slice(0, 4000),
              rejected: application.errors,
            },
            { status: 422 },
          );
        }
        return NextResponse.json({
          capability: result.capability,
          model: result.model,
          workflowId: workflow.id,
          proposal: {
            rationale: (candidate as { rationale?: string }).rationale ?? "",
            applied: application.applied,
            clamped: application.clamped,
          },
        });
      }
      return NextResponse.json({
        capability: result.capability,
        model: result.model,
        workflowId: workflow.id,
        analysis: result.raw,
        capabilityDetail: describeCapability(result.capability),
      });
    }

    if (action === "apply") {
      const workflow = findWorkflow(String(body.workflowId ?? ""));
      if (workflow === null)
        return NextResponse.json({ error: "Unknown workflow." }, { status: 400 });
      const session = await loadSessionView(projectId);
      if (session === null)
        return NextResponse.json({ error: "No remix session." }, { status: 409 });
      const state = mixerStateFromRemix(session.view);
      const application = applyProposal(state, body.proposal);
      if (application.status === "rejected" || application.next === undefined) {
        return NextResponse.json(
          { error: "Proposal rejected by the validator.", errors: application.errors },
          { status: 422 },
        );
      }
      const update = remixUpdateFromMixerState(session.view, application.next);
      await db.transaction(async (tx) => {
        for (const track of update.tracks) {
          await tx
            .update(remixTracks)
            .set({
              volume: track.volume,
              pan: track.pan,
              muted: track.muted,
              solo: track.solo,
              inserts: chainToJson(track.inserts),
              updatedAt: new Date(),
            })
            .where(eq(remixTracks.id, track.id));
        }
        await tx
          .update(remixSessions)
          .set({
            masterVolume: update.masterVolume,
            masterInserts: chainToJson(update.masterInserts),
            updatedAt: new Date(),
          })
          .where(eq(remixSessions.id, session.sessionId));
      });
      return NextResponse.json({
        applied: application.applied,
        clamped: application.clamped,
        sessionId: session.sessionId,
      });
    }

    return NextResponse.json({ error: "Unknown action — use request or apply." }, { status: 400 });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof DependencyMissingError)
      return NextResponse.json({ error: error.message, errorCode: error.errorCode }, { status: 424 });
    console.error("ai route failed", error);
    return NextResponse.json({ error: "AI assist failed." }, { status: 500 });
  } finally {
    if (tempSource !== null) await rm(tempSource, { force: true }).catch(() => undefined);
  }
}
