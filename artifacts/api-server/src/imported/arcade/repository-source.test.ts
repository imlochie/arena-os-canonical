import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { lookup } from "node:dns/promises";
import type { request } from "node:https";
import {
  acquireRepository, createGithubReader, inspectRepository, isPublicV4, parseRepositoryLink,
  recalledRepositoryPlan, rememberRepositoryPlan, RepositoryImportError,
} from "./repository-source";

const revision = "a".repeat(40);
const fixtureBytes = new Map([
  ["game/index.html", Buffer.from('<!doctype html><html><body><canvas id="game"></canvas><script src="game.js"></script></body></html>')],
  ["game/game.js", Buffer.from('document.querySelector("canvas").width=200;')],
  ["game/font.woff2", Buffer.from([0x77, 0x4f, 0x46, 0x32])],
  ["LICENSE", Buffer.from("SPDX-License-Identifier: MIT\nFixture copyright $&\nPermission is hereby granted, free of charge.")],
]);
const blobSha = (bytes: Buffer) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
function fixture(overrides: { spdx?: string; tree?: any[]; private?: boolean; truncated?: boolean } = {}) {
  const calls: string[] = [];
  const tree = overrides.tree ?? [...fixtureBytes].map(([path, bytes]) =>
    ({ path, type: "blob", mode: "100644", size: bytes.length, sha: blobSha(bytes) }));
  const read = async (url: string, limit: number) => {
    calls.push(url);
    const path = new URL(url).pathname;
    let data: unknown;
    if (path === "/repos/author/game") data = { private: overrides.private ?? false, default_branch: "main" };
    else if (path.endsWith("/git/ref/tags/v1")) data = { object: { type: "commit", sha: revision } };
    else if (path.endsWith("/commits/main") || path.endsWith(`/commits/${revision}`) || path.endsWith("/commits/v1")) data = { sha: revision };
    else if (path.endsWith(`/git/trees/${revision}`)) data = { tree, truncated: overrides.truncated ?? false };
    else if (path.endsWith("/license")) data = { path: "LICENSE", encoding: "base64", content: fixtureBytes.get("LICENSE")!.toString("base64"), license: { spdx_id: overrides.spdx ?? "MIT" } };
    else {
      assert.equal(new URL(url).hostname, "raw.githubusercontent.com");
      assert.ok(path.startsWith(`/author/game/${revision}/`));
      const bytes = fixtureBytes.get(decodeURIComponent(path.slice(`/author/game/${revision}/`.length)));
      assert.ok(bytes, `unexpected download: ${url}`);
      assert.ok(bytes.length <= limit);
      return bytes;
    }
    const bytes = Buffer.from(JSON.stringify(data));
    assert.ok(bytes.length <= limit);
    return bytes;
  };
  return { calls, read, tree };
}
const signal = () => AbortSignal.timeout(10_000);

test("repository and release-tag links resolve to an immutable reviewed manifest", async () => {
  for (const link of ["https://github.com/author/game", "https://github.com/author/game/releases/tag/v1", `https://github.com/author/game/tree/${revision}/game`]) {
    const f = fixture();
    const plan = await inspectRepository(link, signal(), f.read);
    assert.equal(plan.revision, revision);
    assert.equal(plan.license.spdx, "MIT");
    assert.equal(plan.entryPath, "game/index.html");
    assert.deepEqual(plan.files.map(file => file.path), [...fixtureBytes.keys()]);
    assert.ok(f.calls.every(url => new URL(url).hostname === "api.github.com"), "inspection does not acquire game bytes");
    const result = await acquireRepository(plan, signal(), f.read);
    assert.equal(result.provenance.revision, revision);
    for (const file of result.files) assert.deepEqual(Buffer.from(file.contentBase64, "base64"), fixtureBytes.get(file.path));
  }
});

test("untrusted destinations and unsupported link forms are refused before any request", () => {
  for (const url of ["http://github.com/a/b", "https://localhost/a/b", "https://github.com.evil/a/b", "https://u:p@github.com/a/b",
    "https://github.com:8443/a/b", "https://github.com/a/b?url=http://127.0.0.1", "https://github.com/a/b/releases/download/v1/game.zip",
    "https://github.com/a/b/tree/main", "file:///etc/passwd", "https://github.com/a/b/tree/" + revision + "/%2e%2e/private"]) {
    assert.throws(() => parseRepositoryLink(url), RepositoryImportError, url);
  }
});

test("a root index is preferred and unrelated HTML pages are not imported", async () => {
  const f = fixture();
  const tree = f.tree.map(row => row.path === "game/index.html" ? { ...row, path: "index.html" } : row);
  tree.push({ path: "docs/example.html", type: "blob", mode: "100644", size: 1, sha: revision });
  const plan = await inspectRepository("https://github.com/author/game", signal(), fixture({ tree }).read);
  assert.equal(plan.entryPath, "index.html");
  assert.ok(!plan.files.some(file => file.path === "docs/example.html"));
});

test("missing eligibility, unsafe layouts and oversized sources are specifically rejected", async () => {
  for (const [overrides, message] of [
    [{ spdx: "NOASSERTION" }, /license/i], [{ private: true }, /public/i], [{ truncated: true }, /too large/i],
    [{ tree: [] }, /HTML page/i],
    [{ tree: [...fixture().tree, { path: "other.html", type: "blob", mode: "100644", size: 1, sha: revision }] }, /HTML pages/i],
    [{ tree: fixture().tree.map(row => row.path.endsWith(".js") ? { ...row, mode: "120000" } : row) }, /links/i],
    [{ tree: fixture().tree.map(row => row.path.endsWith(".js") ? { ...row, size: 3 * 1024 * 1024 } : row) }, /2 MB/i],
    [{ tree: fixture().tree.map(row => row.path.endsWith(".js") ? { ...row, path: "../game.js" } : row) }, /unsafe/i],
  ] as const) {
    await assert.rejects(inspectRepository("https://github.com/author/game", signal(), fixture(overrides).read), message);
  }
});

test("content changes after preview cannot replace the pinned source or license", async () => {
  const f = fixture(), plan = await inspectRepository("https://github.com/author/game", signal(), f.read);
  await assert.rejects(acquireRepository(plan, signal(), async () => Buffer.from("changed")), /verification failed/i);
  const bad = fixture({ tree: fixture().tree.map(row => row.path === "LICENSE" ? { ...row, sha: "0".repeat(40) } : row) });
  await assert.rejects(inspectRepository("https://github.com/author/game", signal(), bad.read), /license.*verified/i);
});

test("a preview is owner-scoped, replaced on reinspection, and expires", async (t) => {
  const plan = await inspectRepository("https://github.com/author/game", signal(), fixture().read);
  const first = rememberRepositoryPlan("owner", plan);
  assert.equal(recalledRepositoryPlan("owner", first.token), plan);
  assert.throws(() => recalledRepositoryPlan("other", first.token), /another session/i);
  const second = rememberRepositoryPlan("owner", plan);
  assert.throws(() => recalledRepositoryPlan("owner", first.token), /expired/i);
  t.mock.method(Date, "now", () => second.expiresAt + 1);
  assert.throws(() => recalledRepositoryPlan("owner", second.token), /expired/i);
});

test("private, reserved and IPv6 addresses are never selected as public GitHub destinations", async () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "169.254.169.254", "172.16.0.1", "192.168.1.1", "100.64.0.1", "0.0.0.0", "224.0.0.1", "198.18.0.1", "::1", "::ffff:127.0.0.1"]) {
    assert.equal(isPublicV4(ip), false);
  }
  assert.equal(isPublicV4("140.82.112.5"), true);
  let connections = 0;
  const reader = createGithubReader((async () => [{ address: "127.0.0.1", family: 4 }]) as unknown as typeof lookup,
    (() => { connections++; throw new Error("must not connect"); }) as unknown as typeof request);
  await assert.rejects(reader("https://api.github.com/repos/a/b", 100, signal()), /unsafe/i);
  await assert.rejects(reader("https://evil.test/repos/a/b", 100, signal()), /unsafe/i);
  assert.equal(connections, 0);
});

test("the checked DNS address is used by the socket; redirects and streaming oversize are rejected", async () => {
  for (const scenario of ["redirect", "oversize", "success"]) {
    const reader = createGithubReader((async () => [{ address: "140.82.112.5", family: 4 }]) as unknown as typeof lookup,
      ((_url: URL, options: any, callback: (response: any) => void) => {
        options.lookup("api.github.com", { all: true }, (_error: unknown, rows: unknown) =>
          assert.deepEqual(rows, [{ address: "140.82.112.5", family: 4 }]));
        const req = new EventEmitter() as any;
        req.setTimeout = () => req;
        req.end = () => queueMicrotask(() => {
          const response = new PassThrough() as any;
          response.statusCode = scenario === "redirect" ? 302 : 200;
          response.headers = {};
          callback(response);
          if (scenario !== "redirect") response.end(Buffer.from(scenario === "oversize" ? "too large" : "ok"));
        });
        return req;
      }) as unknown as typeof request);
    if (scenario === "success") assert.equal((await reader("https://api.github.com/repos/a/b", 2, signal())).toString(), "ok");
    else await assert.rejects(reader("https://api.github.com/repos/a/b", 2, signal()), scenario === "redirect" ? /redirect/i : /size limit/i);
  }
});
