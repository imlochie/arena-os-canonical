import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";

import {
  PULL_CATALOG,
  assertLoopbackUrl,
  hubModelFor,
  hubModelId,
  parsePullLine,
  parseServerRoutingId,
  probeRuntime,
  serverRoutingId,
} from "./runtimes";

// --------------------------------------------------------- loopback security

test("assertLoopbackUrl: loopback passes, LAN needs the flag, public always refused", () => {
  // loopback family
  for (const url of ["http://127.0.0.1:11434", "http://localhost:1234", "http://[::1]:8080"]) {
    assert.doesNotThrow(() => assertLoopbackUrl(url), url);
  }
  // LAN without the flag
  assert.throws(() => assertLoopbackUrl("http://192.168.1.20:11434"), /127\.0\.0\.1/);
  assert.throws(() => assertLoopbackUrl("http://10.0.0.5:11434"));
  // LAN with the flag
  const previous = process.env.MODEL_HUB_ALLOW_LAN;
  process.env.MODEL_HUB_ALLOW_LAN = "1";
  try {
    assert.doesNotThrow(() => assertLoopbackUrl("http://192.168.1.20:11434"));
    assert.doesNotThrow(() => assertLoopbackUrl("http://10.1.2.3:1234"));
  } finally {
    if (previous === undefined) delete process.env.MODEL_HUB_ALLOW_LAN;
    else process.env.MODEL_HUB_ALLOW_LAN = previous;
  }
  // public is never allowed
  assert.throws(() => assertLoopbackUrl("http://api.openai.com:8080"));
  assert.throws(() => assertLoopbackUrl("https://evil.example"));
  // non-http refused
  assert.throws(() => assertLoopbackUrl("file:///etc/passwd"));
});

// ------------------------------------------------------- routing id formats

test("server routing ids round-trip and resist ambiguity", () => {
  const id = serverRoutingId("http://127.0.0.1:11434/", "llama3.2:3b");
  const parsed = parseServerRoutingId(id);
  assert.deepEqual(parsed, { baseUrl: "http://127.0.0.1:11434", remoteModel: "llama3.2:3b" });
  // colons in the model survive because both parts are encoded
  assert.equal(parseServerRoutingId("__server__:http%3A%2F%2F127.0.0.1%3A11434:qwen2.5%3A7b")!.remoteModel, "qwen2.5:7b");
  assert.equal(parseServerRoutingId("openai"), null);
  assert.equal(parseServerRoutingId("__server__broken"), null);
  // hub model ids are stable slugs
  assert.equal(hubModelId("ollama", "llama3.2:3b"), "hub:ollama:llama3.2-3b");
});

test("hubModelFor produces an honest on-device registry entry", () => {
  const entry = hubModelFor("ollama", "http://127.0.0.1:11434", "llama3.2:3b", "My Ollama");
  assert.equal(entry.backend, "local-server");
  assert.equal(entry.level, "on-device");
  assert.equal(entry.requiresNetwork, false);
  assert.equal(entry.requiresKey, false);
  assert.ok(entry.pollinationsId.startsWith("__server__:"));
  assert.ok(entry.description.includes("your machine"));
});

// ------------------------------------------------------------ pull catalog

test("pull catalog entries are honest and well-formed", () => {
  assert.ok(PULL_CATALOG.length >= 6);
  for (const entry of PULL_CATALOG) {
    assert.match(entry.tag, /^[a-zA-Z0-9._:/-]+$/);
    assert.ok(entry.sizeGb > 0 && entry.sizeGb < 10);
    assert.ok(entry.minRamGb >= entry.sizeGb, "RAM class must cover the download");
    assert.ok(entry.description.length > 10);
  }
});

test("parsePullLine parses NDJSON progress and rejects junk", () => {
  assert.deepEqual(parsePullLine('{"status":"pulling manifest"}'), { status: "pulling manifest" });
  const progress = parsePullLine('{"status":"downloading","digest":"abc","total":100,"completed":42}');
  assert.equal(progress!.completed, 42);
  assert.equal(parsePullLine(""), null);
  assert.equal(parsePullLine("not json"), null);
});

// --------------------------------------------- probe against a FAKE runtime
// (test double: a local http server speaking the Ollama + OpenAI dialects;
//  it proves our detection/routing code, NOT any real model quality.)

async function withFakeRuntime(handler: (path: string) => unknown, run: (port: number) => Promise<void>) {
  const server: Server = createServer((request, response) => {
    const body = handler(request.url ?? "");
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    await run(port);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("probeRuntime classifies an Ollama dialect server and lists its models", async () => {
  await withFakeRuntime(
    (path) => (path === "/api/tags" ? { models: [{ name: "llama3.2:3b" }, { name: "qwen2.5:7b" }] } : null),
    async (port) => {
      const probe = await probeRuntime(`http://127.0.0.1:${port}`);
      assert.equal(probe.kind, "ollama");
      assert.equal(probe.online, true);
      assert.deepEqual(probe.models, ["llama3.2:3b", "qwen2.5:7b"]);
    },
  );
});

test("probeRuntime classifies an OpenAI-compat server (LM Studio port) and reports offline when silent", async () => {
  await withFakeRuntime(
    (path) => (path === "/v1/models" ? { data: [{ id: "gpt-oss-20b" }] } : null),
    async (port) => {
      const probe = await probeRuntime(`http://127.0.0.1:${port}`);
      // Random port → generic openai-compat classification.
      assert.equal(probe.online, true);
      assert.deepEqual(probe.models, ["gpt-oss-20b"]);
    },
  );
  const offline = await probeRuntime("http://127.0.0.1:59999");
  assert.equal(offline.online, false);
  assert.deepEqual(offline.models, []);
});
