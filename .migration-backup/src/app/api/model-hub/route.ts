/**
 * Model Hub API — the self-contained way to download and connect AI models
 * to the entire app.
 *
 * GET  /api/model-hub  → saved connections (re-probed live), default-port
 *                        scan results, the pull catalog, registered hub
 *                        models, and the agent-bridge state.
 * POST /api/model-hub  → actions:
 *   { action: "scan", baseUrl? }            probe one URL (or the defaults)
 *   { action: "connect", kind, baseUrl, label }  save a connection
 *   { action: "disconnect", connectionId }  remove it (and its models)
 *   { action: "register", connectionId, remoteModel } make it app-selectable
 *   { action: "unregister", modelId }       remove one registered model
 *
 * Every baseUrl is loopback-gated (lib/modelHub/runtimes.ts) — the server
 * process never becomes an SSRF proxy.
 */

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { modelHubBindings, modelHubConnections, models as modelsTable } from "@/db/schema";
import { requireUser } from "@/lib/waveyard/local-context";
import {
  DEFAULT_SCAN_PORTS,
  PULL_CATALOG,
  assertLoopbackUrl,
  hubModelFor,
  hubModelId,
  probeRuntime,
  type RuntimeKind,
} from "@/lib/modelHub/runtimes";
import { ensureHubModelsLoaded } from "@/lib/modelHub/registry";
import { bridgeStatus } from "@/lib/modelHub/agentBridge";
import { dynamicModels } from "@/lib/models";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireUser();
    await ensureHubModelsLoaded(true);
    const [saved] = await Promise.all([
      db.select().from(modelHubConnections),
    ]);
    const probed = await Promise.all(saved.map((row) => probeRuntime(row.baseUrl)));
    const scanned = await Promise.all(
      DEFAULT_SCAN_PORTS.map((port) => probeRuntime(`http://127.0.0.1:${port}`)),
    );
    const known = new Set(saved.map((row) => row.baseUrl.replace(/\/$/, "")));
    return NextResponse.json({
      connections: saved.map((row, index) => ({
        id: row.id,
        kind: row.kind,
        baseUrl: row.baseUrl,
        label: row.label,
        online: probed[index].online,
        models: probed[index].models,
        detail: probed[index].detail,
      })),
      discovered: scanned.filter(
        (probe) => probe.online && !known.has(probe.baseUrl.replace(/\/$/, "")),
      ),
      catalog: PULL_CATALOG,
      registered: dynamicModels(),
      agentBridge: await bridgeStatus(),
    });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("model hub status failed", error);
    return NextResponse.json({ error: "Model Hub status could not be read." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    await requireUser();
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const action = typeof body.action === "string" ? body.action : "";

    if (action === "scan") {
      const raw = typeof body.baseUrl === "string" && body.baseUrl.trim() !== "" ? body.baseUrl.trim() : null;
      if (raw !== null) {
        assertLoopbackUrl(raw);
        return NextResponse.json({ probe: await probeRuntime(raw) });
      }
      const probes = await Promise.all(DEFAULT_SCAN_PORTS.map((port) => probeRuntime(`http://127.0.0.1:${port}`)));
      return NextResponse.json({ probes });
    }

    if (action === "connect") {
      const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
      const label = typeof body.label === "string" && body.label.trim() !== "" ? body.label.trim().slice(0, 80) : "Local runtime";
      if (baseUrl === "") return NextResponse.json({ error: "A base URL is required." }, { status: 400 });
      assertLoopbackUrl(baseUrl);
      const probe = await probeRuntime(baseUrl);
      if (!probe.online) {
        return NextResponse.json({ error: `No runtime answered at ${baseUrl}. Start it first (e.g. \`ollama serve\`).` }, { status: 422 });
      }
      const kind = (typeof body.kind === "string" && body.kind !== "" ? body.kind : probe.kind) as RuntimeKind;
      const normalized = baseUrl.replace(/\/$/, "");
      const [existing] = await db.select().from(modelHubConnections).where(eq(modelHubConnections.baseUrl, normalized)).limit(1);
      if (existing) {
        const [updated] = await db.update(modelHubConnections)
          .set({ kind, label, lastCheckedAt: new Date() })
          .where(eq(modelHubConnections.id, existing.id))
          .returning();
        return NextResponse.json({ connection: updated, models: probe.models });
      }
      const [created] = await db.insert(modelHubConnections)
        .values({ kind, baseUrl: normalized, label, lastCheckedAt: new Date() })
        .returning();
      return NextResponse.json({ connection: created, models: probe.models }, { status: 201 });
    }

    if (action === "register") {
      const connectionId = typeof body.connectionId === "string" ? body.connectionId : "";
      const remoteModel = typeof body.remoteModel === "string" ? body.remoteModel.trim() : "";
      if (connectionId === "" || remoteModel === "") {
        return NextResponse.json({ error: "connectionId and remoteModel are required." }, { status: 400 });
      }
      const [connection] = await db.select().from(modelHubConnections).where(eq(modelHubConnections.id, connectionId)).limit(1);
      if (!connection) return NextResponse.json({ error: "Connection not found." }, { status: 404 });
      assertLoopbackUrl(connection.baseUrl);
      const probe = await probeRuntime(connection.baseUrl);
      if (probe.online && probe.models.length > 0 && !probe.models.includes(remoteModel)) {
        return NextResponse.json({ error: `That runtime does not list "${remoteModel}".` }, { status: 422 });
      }
      const entry = hubModelFor(connection.kind as RuntimeKind, connection.baseUrl, remoteModel, connection.label);
      await db.insert(modelsTable)
        .values({
          id: entry.id,
          name: entry.name,
          provider: entry.provider,
          description: entry.description,
          isFree: true,
          supportsStructuredOutput: false,
        })
        .onConflictDoNothing({ target: modelsTable.id });
      await db.insert(modelHubBindings)
        .values({ modelId: entry.id, connectionId: connection.id, remoteModel })
        .onConflictDoUpdate({
          target: modelHubBindings.modelId,
          set: { connectionId: connection.id, remoteModel },
        });
      await ensureHubModelsLoaded(true);
      return NextResponse.json({ model: entry }, { status: 201 });
    }

    if (action === "unregister") {
      const modelId = typeof body.modelId === "string" ? body.modelId : "";
      if (modelId === "") return NextResponse.json({ error: "modelId is required." }, { status: 400 });
      await db.delete(modelHubBindings).where(eq(modelHubBindings.modelId, modelId));
      await db.delete(modelsTable).where(eq(modelsTable.id, modelId));
      await ensureHubModelsLoaded(true);
      return NextResponse.json({ removed: modelId });
    }

    if (action === "disconnect") {
      const connectionId = typeof body.connectionId === "string" ? body.connectionId : "";
      if (connectionId === "") return NextResponse.json({ error: "connectionId is required." }, { status: 400 });
      const bindings = await db.select().from(modelHubBindings).where(eq(modelHubBindings.connectionId, connectionId));
      for (const binding of bindings) {
        await db.delete(modelsTable).where(eq(modelsTable.id, binding.modelId));
      }
      await db.delete(modelHubConnections).where(eq(modelHubConnections.id, connectionId));
      await ensureHubModelsLoaded(true);
      return NextResponse.json({ removed: connectionId });
    }

    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  } catch (error) {
    if (error instanceof Response) return error;
    const message = error instanceof Error ? error.message : "Model Hub action failed.";
    const loopback = message.includes("127.0.0.1") || message.includes("http");
    console.error("model hub action failed", error);
    return NextResponse.json({ error: message }, { status: loopback ? 400 : 500 });
  }
}

export { hubModelId };
