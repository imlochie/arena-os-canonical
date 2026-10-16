import assert from "node:assert/strict";
import { test } from "node:test";
import { authorizeApiRequest, isLoopbackHost, requireApiAccess } from "./api-access";
import { assertSafeUrl, isLoopbackAddress, isPublicAddress, safeFetch, SsrfError } from "./safe-fetch";
import { rejectOversizedBody } from "./request-limits";

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];
const privateLookup = async () => [{ address: "10.0.0.5", family: 4 }];
const mixedLookup = async () => [
  { address: "93.184.216.34", family: 4 },
  { address: "127.0.0.1", family: 4 },
];

test("isPublicAddress rejects private, loopback, link-local, metadata and mapped forms", () => {
  for (const a of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "0.0.0.0", "100.64.0.1", "::1", "fe80::1", "fc00::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1"]) {
    assert.equal(isPublicAddress(a), false, a);
  }
  assert.equal(isPublicAddress("93.184.216.34"), true);
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
});

test("isLoopbackAddress", () => {
  assert.equal(isLoopbackAddress("127.0.0.1"), true);
  assert.equal(isLoopbackAddress("::1"), true);
  assert.equal(isLoopbackAddress("10.0.0.1"), false);
});

test("assertSafeUrl: scheme, credentials, literals and DNS results", async () => {
  await assert.rejects(assertSafeUrl("file:///etc/passwd"), SsrfError);
  await assert.rejects(assertSafeUrl("ftp://example.com/x"), SsrfError);
  await assert.rejects(assertSafeUrl("not a url"), SsrfError);
  await assert.rejects(assertSafeUrl("https://user:pw@example.com/", { lookup: publicLookup }), SsrfError);
  await assert.rejects(assertSafeUrl("http://127.0.0.1/"), SsrfError);
  await assert.rejects(assertSafeUrl("http://[::1]/"), SsrfError);
  await assert.rejects(assertSafeUrl("http://169.254.169.254/latest/meta-data"), SsrfError);
  await assert.rejects(assertSafeUrl("http://internal.example/", { lookup: privateLookup }), SsrfError);
  await assert.rejects(assertSafeUrl("http://rebind.example/", { lookup: mixedLookup }), SsrfError);
  await assert.rejects(assertSafeUrl("http://gone.example/", { lookup: async () => { throw new Error("ENOTFOUND"); } }), SsrfError);
  const ok = await assertSafeUrl("https://example.com/a", { lookup: publicLookup });
  assert.equal(ok.hostname, "example.com");
});

test("assertSafeUrl loopback policy only permits localhost/loopback", async () => {
  await assertSafeUrl("http://127.0.0.1:8080/", { policy: "loopback" });
  await assertSafeUrl("http://localhost:8080/", { policy: "loopback", lookup: async () => [{ address: "127.0.0.1", family: 4 }] });
  await assert.rejects(assertSafeUrl("http://10.0.0.1/", { policy: "loopback" }), SsrfError);
  await assert.rejects(assertSafeUrl("http://example.com/", { policy: "loopback", lookup: publicLookup }), SsrfError);
});

test("safeFetch revalidates every redirect hop", async () => {
  const seen: string[] = [];
  const fetchImpl = (async (input: URL | string) => {
    seen.push(String(input));
    if (String(input).startsWith("https://a.example")) {
      return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/secret" } });
    }
    return new Response("leaked");
  }) as unknown as typeof fetch;
  await assert.rejects(safeFetch("https://a.example/", {}, { lookup: publicLookup, fetchImpl }), SsrfError);
  assert.deepEqual(seen, ["https://a.example/"]);
});

test("safeFetch follows a safe redirect and caps redirect count", async () => {
  const okFetch = (async (input: URL | string) =>
    String(input).endsWith("/start")
      ? new Response(null, { status: 301, headers: { location: "/final" } })
      : new Response("done")) as unknown as typeof fetch;
  const res = await safeFetch("https://a.example/start", {}, { lookup: publicLookup, fetchImpl: okFetch });
  assert.equal(await res.text(), "done");

  const loop = (async () => new Response(null, { status: 302, headers: { location: "/again" } })) as unknown as typeof fetch;
  await assert.rejects(safeFetch("https://a.example/", {}, { lookup: publicLookup, fetchImpl: loop, maxRedirects: 2 }), /redirects/);
});

test("safeFetch with maxRedirects 0 refuses to follow", async () => {
  const redirect = (async () => new Response(null, { status: 302, headers: { location: "https://b.example/" } })) as unknown as typeof fetch;
  await assert.rejects(safeFetch("https://a.example/", {}, { lookup: publicLookup, fetchImpl: redirect, maxRedirects: 0 }), SsrfError);
});

test("isLoopbackHost", () => {
  assert.equal(isLoopbackHost("127.0.0.1:3000"), true);
  assert.equal(isLoopbackHost("localhost"), true);
  assert.equal(isLoopbackHost("[::1]:3000"), true);
  assert.equal(isLoopbackHost("192.168.1.10:3000"), false);
  assert.equal(isLoopbackHost("evil.example"), false);
  assert.equal(isLoopbackHost("localhost.evil.example"), false);
  assert.equal(isLoopbackHost(null), false);
});

const denyIdentity = async () => { throw new Error("no session"); };
const req = (host: string, headers: Record<string, string> = {}) => new Request("http://x/api/arcade", { headers: { host, ...headers } });

test("api access: loopback allowed in desktop mode, LAN/DNS-rebinding hosts denied", async () => {
  const env = { ARENA_DESKTOP_MODE: "1", NODE_ENV: "production" };
  assert.equal((await authorizeApiRequest(req("127.0.0.1:62039"), { env, identity: denyIdentity })).allowed, true);
  const lan = await authorizeApiRequest(req("192.168.1.20:62039"), { env, identity: denyIdentity });
  assert.equal(lan.allowed, false);
  const rebind = await authorizeApiRequest(req("attacker.example"), { env, identity: denyIdentity });
  assert.equal(rebind.allowed, false);
});

test("api access: production web mode without desktop flag denies even loopback", async () => {
  const env = { NODE_ENV: "production" };
  const res = await requireApiAccess(req("localhost:3000"), { env, identity: denyIdentity });
  assert.equal(res?.status, 401);
});

test("api access: valid session or internal key is allowed", async () => {
  const env = { NODE_ENV: "production" };
  const viaSession = await authorizeApiRequest(req("arena.example"), { env, identity: async () => ({}) });
  assert.deepEqual(viaSession, { allowed: true, via: "session" });
  const key = { NODE_ENV: "production", ARENA_INTERNAL_API_KEY: "k".repeat(40) };
  const viaKey = await authorizeApiRequest(req("arena.example", { authorization: `Bearer ${"k".repeat(40)}` }), { env: key, identity: denyIdentity });
  assert.equal(viaKey.allowed, true);
  const wrongKey = await authorizeApiRequest(req("arena.example", { authorization: "Bearer nope" }), { env: key, identity: denyIdentity });
  assert.equal(wrongKey.allowed, false);
});

test("rejectOversizedBody refuses declared oversize before buffering", () => {
  const big = new Request("http://x/", { method: "POST", headers: { "content-length": "5000000" }, body: "x" });
  assert.equal(rejectOversizedBody(big, 1000)?.status, 413);
  const bad = new Request("http://x/", { method: "POST", headers: { "content-length": "abc" }, body: "x" });
  assert.equal(rejectOversizedBody(bad, 1000)?.status, 400);
  const ok = new Request("http://x/", { method: "POST", headers: { "content-length": "500" }, body: "x" });
  assert.equal(rejectOversizedBody(ok, 1000), null);
});
