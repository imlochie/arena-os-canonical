import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyFileEffect, approveToolEffect, proposeFileEffect, hash } from "./toolEffects";
import type { ToolGrant } from "./toolRuntime";
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "arena-effect-safety-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const grant: ToolGrant = { id: "grant", sessionId: "session", resourceId: "repo", root, capabilities: [] };
  await writeFile(join(root, "source.txt"), "before");
  const proposed = await proposeFileEffect({ sessionId: "session", actorId: "agent", grant, capability: "filesystem.patch", path: "source.txt", content: "approved change", expectedHash: hash("before") });
  return { root, grant, approved: approveToolEffect(proposed, "owner") };
}
test("approved bytes cannot be replaced after digest-bound approval", async (t) => {
  const f = await fixture(t);
  await assert.rejects(() => applyFileEffect({ ...f.approved, content: "unapproved change" }, f.grant), /DIGEST/);
  assert.equal(await readFile(join(f.root, "source.txt"), "utf8"), "before");
});
test("approved target cannot be changed or escaped while retaining its old digest", async (t) => {
  const f = await fixture(t); await writeFile(join(f.root, "other.txt"), "unrelated");
  await assert.rejects(() => applyFileEffect({ ...f.approved, path: "other.txt" }, f.grant), /DIGEST/);
  assert.equal(await readFile(join(f.root, "other.txt"), "utf8"), "unrelated");
});
test("creating through an escaping parent symlink is refused without external writes", async (t) => {
  const f = await fixture(t); const outside = await mkdtemp(join(tmpdir(), "arena-effect-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, join(f.root, "linked"), process.platform === "win32" ? "junction" : "dir");
  const proposed = await proposeFileEffect({ sessionId: "session", actorId: "agent", grant: f.grant, capability: "filesystem.write", path: "linked/new.txt", content: "must stay scoped", expectedHash: null });
  await assert.rejects(() => applyFileEffect(approveToolEffect(proposed, "owner"), f.grant), /SCOPE/);
  await assert.rejects(() => readFile(join(outside, "new.txt")), /ENOENT/);
});
test("legitimate approved edits and new files still work; stale preimages stay protected", async (t) => {
  const f = await fixture(t);
  assert.equal((await applyFileEffect(f.approved, f.grant)).status, "applied");
  assert.equal((await applyFileEffect(f.approved, f.grant)).status, "stale");
  await mkdir(join(f.root, "new"));
  const effect = await proposeFileEffect({ sessionId: "session", actorId: "agent", grant: f.grant, capability: "filesystem.write", path: "new/file.txt", content: "new approved file", expectedHash: null });
  assert.equal((await applyFileEffect(approveToolEffect(effect, "owner"), f.grant)).status, "applied");
});
