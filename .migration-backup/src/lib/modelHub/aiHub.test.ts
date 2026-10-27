import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";

import { generate } from "@/lib/ai";
import { clearDynamicModels, registerDynamicModels } from "@/lib/models";
import { hubModelFor, serverRoutingId } from "./runtimes";

// TEST DOUBLE NOTICE: the http servers below are local OpenAI-compatible
// fakes. They prove routing/classification code — NOT model quality. Real
// Ollama/LM Studio verification is owner-side (network-blocked in sandbox).

async function withOpenAiCompatFake(body: (payload: unknown) => string, run: (port: number) => Promise<void>) {
  const server: Server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      let payload: unknown = null;
      try {
        payload = JSON.parse(raw);
      } catch {
        /* leave null */
      }
      response.setHeader("Content-Type", "application/json");
      response.end(body(payload));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    await run(port);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("generate(): a registered hub model routes to its local OpenAI-compat server", async () => {
  await withOpenAiCompatFake(
    (payload) => {
      const body = payload as { messages?: { role: string; content: string }[]; model?: string };
      const last = body?.messages?.at(-1)?.content ?? "";
      return JSON.stringify({
        choices: [{ message: { role: "assistant", content: `echo:${body?.model}:${last}` } }],
      });
    },
    async (port) => {
      const baseUrl = `http://127.0.0.1:${port}`;
      // Unique per run: a deterministic id would collide with hub rows other
      // test files leave in a shared test database's `models` table and get
      // resolved from there instead of this registration.
      const remoteModel = `llama3.2:3b-${port}`;
      const entry = hubModelFor("ollama", baseUrl, remoteModel, "Test Runtime");
      registerDynamicModels([entry]);
      try {
        const result = await generate(
          { modelId: entry.id, messages: [{ role: "user", content: "hello hub" }], system: "be brief" },
        );
        assert.equal(result.backend, "local-server");
        assert.equal(result.fallback, false);
        assert.equal(result.runtimeLevel, "on-device");
        assert.match(result.via ?? "", new RegExp(`local-server:127\\.0\\.0\\.1:${port}/llama3\\.2:3b`));
        assert.equal(result.text, `echo:${remoteModel}:hello hub`);
      } finally {
        clearDynamicModels();
      }
    },
  );
});

test("generate(): a tampered public routing id is refused at execution time (SSRF re-assert)", async () => {
  const evil = serverRoutingId("http://registry.example.com:8080", "evil-model");
  const base = hubModelFor("llamacpp", "http://127.0.0.1:8080", "evil-model", "Tampered");
  registerDynamicModels([{ ...base, id: "hub:test:evil", pollinationsId: evil }]);
  try {
    const result = await generate({ modelId: "hub:test:evil", messages: [{ role: "user", content: "hi" }] });
    // Must NOT reach the network: honest local-engine fallback instead.
    assert.equal(result.fallback, true);
    assert.equal(result.backend, "arena-local-engine");
    assert.match(result.note ?? "", /Local server|refused|loopback|public/i);
  } finally {
    clearDynamicModels();
  }
});

test("generate(): agent-bridge model answers via the injected executor with honest labeling", async () => {
  const result = await generate(
    { modelId: "arena-agent", messages: [{ role: "user", content: "who are you?" }] },
    {
      agentBridgeExecutor: async (messages) => `bridge says: ${messages.at(-1)?.content ?? ""}`,
    },
  );
  assert.equal(result.backend, "agent-bridge");
  assert.equal(result.fallback, false);
  assert.equal(result.text, "bridge says: who are you?");
  assert.match(result.note ?? "", /not a language model/);
});

test("generate(): agent-bridge model falls back honestly when no bridge is connected", async () => {
  const result = await generate(
    { modelId: "arena-agent", messages: [{ role: "user", content: "anyone there?" }] },
    { agentBridgeExecutor: async () => null },
  );
  assert.equal(result.fallback, true);
  assert.equal(result.backend, "arena-local-engine");
  assert.match(result.text, /Arena Agent \(bridge\) was unavailable/); // notice names the model + reason
  assert.match(result.note ?? "", /Agent bridge not connected/);
});
