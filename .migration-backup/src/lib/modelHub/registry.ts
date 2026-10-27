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
import { clearDynamicModels, dynamicModels, registerDynamicModels, type FreeModel } from "@/lib/models";
import { hubModelFor, type RuntimeKind } from "./runtimes";

let loaded: Promise<void> | null = null;
const RELOAD_MS = 30_000;
let lastLoadedAt = 0;
/** Ids this loader put into the dynamic registry — the only entries it may
 *  remove on reload. Anything else registered at runtime (API calls, tool
 *  flows, tests) is not the hub's to erase. */
let hubOwnedIds = new Set<string>();

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
  // Replace-merge, scoped: rows that were unregistered/disconnected must
  // disappear from the dynamic registry (not linger until restart), while
  // non-hub registrations survive a reload untouched.
  const preserved = dynamicModels().filter((m) => !hubOwnedIds.has(m.id));
  clearDynamicModels();
  registerDynamicModels([...preserved, ...entries]);
  hubOwnedIds = new Set(entries.map((entry) => entry.id));
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
