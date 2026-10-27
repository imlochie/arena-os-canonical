/**
 * Trust-boundary tests (adopted from PR #10's security suite during the
 * recovery-branch reconciliation): the Host check that stops LAN clients and
 * DNS-rebinding pages from inheriting local trust, and the access guard's
 * three admission paths (local trust / owner session / internal key).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { authorizeApiRequest, requireApiAccess } from "./api-access";
import { isLoopbackHost } from "./loopback-host";

test("isLoopbackHost", () => {
  assert.equal(isLoopbackHost("127.0.0.1:3000"), true);
  assert.equal(isLoopbackHost("localhost"), true);
  assert.equal(isLoopbackHost("[::1]:3000"), true);
  assert.equal(isLoopbackHost("::1"), true);
  assert.equal(isLoopbackHost("192.168.1.10:3000"), false);
  assert.equal(isLoopbackHost("evil.example"), false);
  assert.equal(isLoopbackHost("localhost.evil.example"), false);
  assert.equal(isLoopbackHost("127.0.0.1.evil.example"), false);
  assert.equal(isLoopbackHost(null), false);
  assert.equal(isLoopbackHost("  "), false);
});

const denyIdentity = async () => {
  throw new Error("no session");
};
const req = (host: string, headers: Record<string, string> = {}) =>
  new Request("http://x/api/arcade", { headers: { host, ...headers } });

test("api access: loopback allowed in desktop mode, LAN/DNS-rebinding hosts denied", async () => {
  const env = { ARENA_DESKTOP_MODE: "1", NODE_ENV: "production" };
  assert.equal((await authorizeApiRequest(req("127.0.0.1:62039"), { env, identity: denyIdentity })).allowed, true);
  const lan = await authorizeApiRequest(req("192.168.1.20:62039"), { env, identity: denyIdentity });
  assert.equal(lan.allowed, false);
  const rebind = await authorizeApiRequest(req("attacker.example"), { env, identity: denyIdentity });
  assert.equal(rebind.allowed, false);
});

test("api access: dev server trusts loopback; production web mode denies anonymous even loopback", async () => {
  const dev = { NODE_ENV: "development" };
  assert.equal((await authorizeApiRequest(req("localhost:3000"), { env: dev, identity: denyIdentity })).allowed, true);
  assert.equal((await authorizeApiRequest(req("attacker.example"), { env: dev, identity: denyIdentity })).allowed, false);

  const prod = { NODE_ENV: "production" };
  const res = await requireApiAccess(req("localhost:3000"), { env: prod, identity: denyIdentity });
  assert.equal(res?.status, 401);
});

test("api access: valid session or internal key is allowed; wrong key denied", async () => {
  const env = { NODE_ENV: "production" };
  const viaSession = await authorizeApiRequest(req("arena.example"), { env, identity: async () => ({}) });
  assert.deepEqual(viaSession, { allowed: true, via: "session" });

  const key = { NODE_ENV: "production", ARENA_INTERNAL_API_KEY: "k".repeat(40) };
  const viaKey = await authorizeApiRequest(req("arena.example", { authorization: `Bearer ${"k".repeat(40)}` }), {
    env: key,
    identity: denyIdentity,
  });
  assert.equal(viaKey.allowed, true);

  const wrongKey = await authorizeApiRequest(req("arena.example", { authorization: "Bearer nope" }), {
    env: key,
    identity: denyIdentity,
  });
  assert.equal(wrongKey.allowed, false);
});
