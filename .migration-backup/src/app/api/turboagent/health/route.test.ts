/**
 * TurboAgent health-probe SSRF tests: the probe URL is caller-controlled, so
 * non-loopback destinations must be refused WITHOUT any request leaving the
 * process, while a real loopback probe still works.
 */

import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";

const { GET } = await import("./route");

const realFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = realFetch;
});

test("internal and remote destinations are refused without any fetch", async () => {
  let fetched = 0;
  globalThis.fetch = (async () => {
    fetched += 1;
    return new Response("{}");
  }) as unknown as typeof fetch;

  for (const target of [
    "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.5:8080",
    "https://example.com",
    "http://[::ffff:169.254.169.254]/",
    "http://[fd00::1]:9/",
  ]) {
    const response = await GET(new Request(`http://127.0.0.1/api/turboagent/health?url=${encodeURIComponent(target)}`, { headers: { host: "127.0.0.1" } }));
    const body = (await response.json()) as { online: boolean; detail: string };
    assert.equal(body.online, false, target);
    assert.match(body.detail, /limited to this machine/, target);
  }
  assert.equal(fetched, 0, "a refused destination must never be contacted");
});

test("a loopback probe really runs and reports the runtime's answer", async (t) => {
  globalThis.fetch = realFetch;
  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ model: "qwen2.5:7b", backend: "cpu", version: "0.1" }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const response = await GET(new Request(`http://127.0.0.1/api/turboagent/health?url=${encodeURIComponent(`http://127.0.0.1:${port}`)}`, { headers: { host: "127.0.0.1" } }));
  const body = (await response.json()) as { online: boolean; detail: string; backend?: string };
  assert.equal(body.online, true);
  assert.equal(body.detail, "qwen2.5:7b");
  assert.equal(body.backend, "cpu");
});

test("no configured URL is an honest offline answer", async () => {
  const previous = process.env.TURBOAGENT_URL;
  delete process.env.TURBOAGENT_URL;
  try {
    const response = await GET(new Request("http://127.0.0.1/api/turboagent/health", { headers: { host: "127.0.0.1" } }));
    const body = (await response.json()) as { online: boolean };
    assert.equal(body.online, false);
  } finally {
    if (previous !== undefined) process.env.TURBOAGENT_URL = previous;
  }
});
