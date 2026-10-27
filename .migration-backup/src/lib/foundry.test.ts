import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import net from "node:net";

// Bootstrap (same as the modelHub DB tests): replace the src-loader's dummy
// DATABASE_URL with the real local one before the first @/db import.
function resolveDatabaseUrl(): string {
  const envUrl = process.env.DATABASE_URL ?? "";
  if (envUrl && !envUrl.includes("arena-test-no-connect")) return envUrl;
  try {
    const env = readFileSync(new URL("../../../.env", import.meta.url), "utf8");
    const match = env.match(/^DATABASE_URL=(.+)$/m);
    if (match) return match[1].trim();
  } catch {
    // fall through
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

// --------------------------------------------------------------- pure logic

test("foundry: extractHtml accepts fenced and raw documents, rejects prose", async () => {
  const { extractHtml } = await import("./foundry");
  const doc = "<!doctype html><html><head></head><body><script>1<2</script></body></html>";
  assert.equal(extractHtml(`Here you go:\n\`\`\`html\n${doc}\n\`\`\`\nEnjoy!`), doc);
  assert.equal(extractHtml(doc), doc);
  assert.equal(extractHtml("```js\nconsole.log(1)\n```"), null);
  assert.equal(extractHtml("Sure! I would build a timer with..."), null);
});

test("foundry: injectCsp hard-blocks network and lands after <head>", async () => {
  const { injectCsp } = await import("./foundry");
  const code = `<!doctype html><html><head><title>x</title></head><body>hi</body></html>`;
  const withCsp = injectCsp(code);
  assert.ok(withCsp.indexOf("Content-Security-Policy") > withCsp.toLowerCase().indexOf("<head"));
  assert.match(withCsp, /default-src 'none'/);
  // already-constrained documents are not double-instrumented
  assert.equal(injectCsp(withCsp), withCsp);
  // headless fragments still get wrapped into a document
  assert.match(injectCsp("<p>bare</p>"), /<!doctype html>/);
});

test("foundry: fallbackScaffold is a real, honest offline app", async () => {
  const { fallbackScaffold } = await import("./foundry");
  const code = fallbackScaffold("a sick beat machine", "Beat Machine");
  assert.match(code, /<!doctype html>/);
  assert.match(code, /Beat Machine/);
  assert.match(code, /a sick beat machine/);
  assert.match(code, /clearly not model output/i);
});

// --------------------------------------------------------------- DB round-trip

test("foundry: create → iterate → list → delete, versions and honesty labels", { skip: !pgUp }, async () => {
  const { createApp, deleteApp, getApp, iterateApp, listApps } = await import("@/lib/foundry");
  const { pool } = await import("@/db");

  // No keys, default local-engine → generate() returns deterministic text,
  // not a real HTML document → the honest offline scaffold with fallback: true.
  const app = await createApp("a tiny drum machine with a big start button", { name: "Drums" });
  assert.ok(app.id);
  assert.equal(app.latest.version, 1);
  assert.equal(app.latest.fallback, true, "local engine must produce the labeled scaffold, not fake model output");
  assert.match(app.latest.code, /<!doctype html>/);
  assert.match(app.latest.via, /offline-scaffold/);

  const v2 = await iterateApp(app.id, "make the button huge and add a counter");
  assert.ok(v2);
  assert.equal(v2!.version, 2);
  assert.equal(v2!.fallback, true);
  // A failed iteration keeps the previous working app code.
  assert.equal(v2!.code, app.latest.code);

  const listed = await listApps();
  const entry = listed.find((a) => a.id === app.id);
  assert.equal(entry?.versionCount, 2);

  const fetched = await getApp(app.id);
  assert.equal(fetched?.latest.version, 2);

  assert.equal(await deleteApp(app.id), true);
  assert.equal(await getApp(app.id), null);
  // cascade: versions gone with the app
  const after = await listApps();
  assert.equal(after.some((a) => a.id === app.id), false);

  await pool.end();
});

// --------------------------------------------------------------- mistral BYOK

test("mistral BYOK: request shape (OpenAI-compatible, mistral-small-latest) via cascade", async () => {
  const { generate } = await import("@/lib/ai");
  const calls: { url: string; body: Record<string, unknown>; auth: string }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      auth: String((init?.headers as Record<string, string>).Authorization),
    });
    return new Response(JSON.stringify({ choices: [{ message: { content: "mistral says hi" } }] }), { status: 200 });
  }) as unknown as typeof fetch;

  // Remote-tier model + a mistral key → the mistral branch must answer.
  const result = await generate(
    { modelId: "openai", messages: [{ role: "user", content: "hi" }], keys: { mistral: "mk" } },
    { fetchImpl },
  );
  assert.equal(result.backend, "mistral");
  assert.equal(result.via, "mistral:small");
  assert.equal(result.text, "mistral says hi");
  assert.equal(calls[0].url, "https://api.mistral.ai/v1/chat/completions");
  assert.equal(calls[0].body.model, "mistral-small-latest");
  assert.equal(calls[0].auth, "Bearer mk");
});
