import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import net from "node:net";

// Wave 3b: chat research mode helpers, deep-agent artifact saves, and the
// assistant module manifest.

function resolveDatabaseUrl(): string {
  const envUrl = process.env.DATABASE_URL ?? "";
  if (envUrl && !envUrl.includes("arena-test-no-connect")) return envUrl;
  try {
    const env = readFileSync(new URL("../../../.env", import.meta.url), "utf8");
    const match = env.match(/^DATABASE_URL=(.+)$/m);
    if (match) return match[1].trim();
  } catch {
    /* fall through */
  }
  return "postgresql://postgres:postgres@127.0.0.1:5432/app_db";
}

async function localPostgresUp(url: string): Promise<boolean> {
  try {
    const parsed = new URL(url);
    return await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host: parsed.hostname, port: Number(parsed.port || 5432), timeout: 800 });
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

test("research: the sources footer is honest in both cases", async () => {
  const { researchSourcesFooter } = await import("@/lib/creative/research");
  const withSources = researchSourcesFooter([
    { id: 1, title: "Chat message (10/10/2026)", snippet: "…", origin: "chat-history" },
    { id: 2, title: "Guide doc", snippet: "…", origin: "web:searxng", url: "https://example.com/x" },
  ]);
  assert.match(withSources, /— sources —/);
  assert.match(withSources, /\[1\] chat-history: Chat message/);
  assert.match(withSources, /\[2\] web:searxng: Guide doc \(https:\/\/example\.com\/x\)/);
  const empty = researchSourcesFooter([]);
  assert.match(empty, /no sources matched; answer is unverified/);
});

test("deep agent: a finished run saves into the artifact library with provenance", { skip: !pgUp }, async () => {
  const { saveRunAsArtifact, deleteRun } = await import("@/lib/deepAgent");
  const { db, pool } = await import("@/db");
  const { artifacts } = await import("@/db/schema");
  const { deepAgentRuns, deepAgentSteps } = await import("@/db/schema");
  const { eq } = await import("drizzle-orm");

  // A finished run (inserted directly — the run loop itself is covered in wave3).
  const [run] = await db
    .insert(deepAgentRuns)
    .values({ goal: "test the artifact save path", status: "done", engine: "arena-local-engine", via: "offline" })
    .returning();
  await db.insert(deepAgentSteps).values([
    { runId: run.id, idx: 0, title: "Step one", output: "output one", verdict: "pass", verdictReason: "fine", attempts: 1 },
    { runId: run.id, idx: 1, title: "Step two", output: "output two", verdict: "pass", verdictReason: "fine", attempts: 2 },
  ]);

  const saved = await saveRunAsArtifact(run.id);
  assert.equal(saved.ok, true, saved.note ?? "save failed");
  assert.ok(saved.artifactId);
  const [artifact] = await db.select().from(artifacts).where(eq(artifacts.id, saved.artifactId!)).limit(1);
  assert.equal(artifact.kind, "deep-agent");
  assert.equal(artifact.sourceType, "assistant");
  assert.match(artifact.title, /Deep Agent: test the artifact save path/);
  assert.match(artifact.body, /## Step 1: Step one/);
  assert.match(artifact.body, /verdict: pass/);
  assert.match(artifact.body, /\(2 attempts\)/);
  assert.match(artifact.body, /via: offline/);

  // Unknown run → honest no.
  const missing = await saveRunAsArtifact("00000000-0000-0000-0000-000000000000");
  assert.equal(missing.ok, false);

  // Cleanup: artifact + run (steps cascade).
  await db.delete(artifacts).where(eq(artifacts.id, saved.artifactId!));
  assert.equal(await deleteRun(run.id), true);
  await pool.end();
});

test("assistant manifest: the assistant knows every current room", async () => {
  const { PLATFORM_MODULES } = await import("@/lib/assistantTools");
  const paths = PLATFORM_MODULES.map((m) => m.path);
  for (const expected of ["/creative", "/foundry", "/deep-agent", "/model-hub", "/waveyard", "/studio", "/cut", "/archive"]) {
    assert.ok(paths.includes(expected), `${expected} missing from PLATFORM_MODULES`);
  }
  // One-line honesty: every entry says what it is.
  for (const entry of PLATFORM_MODULES) {
    assert.ok(entry.what.length > 10, `${entry.name} needs a real description`);
  }
});
