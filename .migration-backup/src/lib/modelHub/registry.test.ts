import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import net from "node:net";

// Same bootstrap as agentBridge.test.ts: replace the src-loader's dummy
// DATABASE_URL with the real local one before the first @/db import.
function resolveDatabaseUrl(): string {
  const envUrl = process.env.DATABASE_URL ?? "";
  if (envUrl && !envUrl.includes("arena-test-no-connect")) return envUrl;
  try {
    const env = readFileSync(new URL("../../../.env", import.meta.url), "utf8");
    const match = env.match(/^DATABASE_URL=(.+)$/m);
    if (match) return match[1].trim();
  } catch {
    // no .env — fall through to the standard local default
  }
  return "postgresql://postgres:postgres@127.0.0.1:5432/app_db";
}

async function localPostgresUp(url: string): Promise<boolean> {
  try {
    const parsed = new URL(url);
    const port = Number(parsed.port || 5432);
    return await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host: parsed.hostname, port, timeout: 800 });
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => resolve(false));
      socket.once("timeout", () => { socket.destroy(); resolve(false); });
    });
  } catch {
    return false;
  }
}

const databaseUrl = resolveDatabaseUrl();
const pgUp = await localPostgresUp(databaseUrl);
process.env.DATABASE_URL = databaseUrl;

test("registry: registering then unregistering is reflected immediately (replace-merge)", { skip: !pgUp }, async () => {
  const { db, pool } = await import("@/db");
  const { modelHubBindings, modelHubConnections, models: modelsTable } = await import("@/db/schema");
  const { clearDynamicModels, dynamicModels } = await import("@/lib/models");
  const { ensureHubModelsLoaded } = await import("./registry");
  const { hubModelId } = await import("./runtimes");
  const { eq } = await import("drizzle-orm");

  // The registry derives model ids from kind + remote model (hub:<kind>:<slug>).
  const modelId = hubModelId("ollama", "reg-model:1b");

  // Clean slate.
  await db.delete(modelHubBindings);
  await db.delete(modelHubConnections);
  await db.delete(modelsTable).where(eq(modelsTable.id, modelId));

  const [connection] = await db
    .insert(modelHubConnections)
    .values({ kind: "ollama", baseUrl: "http://127.0.0.1:11434", label: "regression" })
    .returning({ id: modelHubConnections.id });
  await db.insert(modelHubBindings).values({
    modelId,
    connectionId: connection.id,
    remoteModel: "reg-model:1b",
  });

  await ensureHubModelsLoaded(true);
  assert.ok(dynamicModels().some((m) => m.id === modelId), "registered model must appear");

  // Unregister (same deletes the hub route performs), then force reload:
  // the entry must be GONE — not linger until process restart.
  await db.delete(modelHubBindings);
  await db.delete(modelHubConnections);
  await ensureHubModelsLoaded(true);
  assert.equal(
    dynamicModels().some((m) => m.id === modelId),
    false,
    "unregistered model must disappear immediately",
  );

  clearDynamicModels();
  await pool.end();
});
