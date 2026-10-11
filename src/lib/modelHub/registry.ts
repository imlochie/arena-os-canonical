/**
 * Model Hub registry — loads registered local-server models from the DB into
 * the dynamic model registry (lib/models.ts) so every surface can select
 * them. Loaded lazily once per process (cached promise); refreshed by the
 * hub routes after any change. Never throws — a DB hiccup leaves the static
 * catalog intact.
 */

import { eq } from "drizzle-orm";

import { db } from "@/db";
import { modelHubBindings, modelHubConnections } from "@/db/schema";
import { clearDynamicModels, registerDynamicModels, type FreeModel } from "@/lib/models";
import { hubModelFor, type RuntimeKind } from "./runtimes";

let loaded: Promise<void> | null = null;
const RELOAD_MS = 30_000;
let lastLoadedAt = 0;

async function load(): Promise<void> {
  const rows = await db
    .select({
      modelId: modelHubBindings.modelId,
      remoteModel: modelHubBindings.remoteModel,
      kind: modelHubConnections.kind,
      baseUrl: modelHubConnections.baseUrl,
      label: modelHubConnections.label,
    })
    .from(modelHubBindings)
    .innerJoin(modelHubConnections, eq(modelHubBindings.connectionId, modelHubConnections.id));
  const entries: FreeModel[] = rows.map((row) =>
    hubModelFor(row.kind as RuntimeKind, row.baseUrl, row.remoteModel, row.label),
  );
  // Replace-merge semantics: rows that were unregistered/disconnected must
  // disappear from the dynamic registry, not linger until process restart.
  clearDynamicModels();
  registerDynamicModels(entries);
  lastLoadedAt = Date.now();
}

/** Ensure hub models are registered (no-op after the first load unless stale). */
export function ensureHubModelsLoaded(force = false): Promise<void> {
  if (force) {
    loaded = load().catch(() => {});
    return loaded;
  }
  if (loaded !== null && Date.now() - lastLoadedAt < RELOAD_MS) return loaded;
  if (loaded === null) {
    loaded = load().catch(() => {});
  }
  return loaded;
}
