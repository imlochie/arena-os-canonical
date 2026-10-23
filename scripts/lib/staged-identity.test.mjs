import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { computeSourceIdentity } from "./staged-identity.mjs";

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "arena-source-identity-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init");
  writeFileSync(path.join(root, "source.txt"), "base");
  git("add", "source.txt");
  git("-c", "user.name=Acceptance", "-c", "user.email=acceptance@example.invalid", "commit", "-m", "fixture");
  return { root, git };
}

test("staged identity detects edits even when porcelain status is unchanged", (t) => {
  const { root, git } = fixture(t);
  writeFileSync(path.join(root, "source.txt"), "first edit");
  const beforeStatus = git("status", "--porcelain").toString();
  const before = computeSourceIdentity(root);
  writeFileSync(path.join(root, "source.txt"), "different edit");
  assert.equal(git("status", "--porcelain").toString(), beforeStatus);
  const after = computeSourceIdentity(root);
  assert.equal(after.commit, before.commit);
  assert.notEqual(after.sourceDigest, before.sourceDigest);
  assert.deepEqual(computeSourceIdentity(root), after, "stable for identical content");
});

test("staged identity includes untracked source content but ignores excluded artifacts", (t) => {
  const { root } = fixture(t);
  writeFileSync(path.join(root, ".gitignore"), "artifact.wav\n");
  writeFileSync(path.join(root, "new-source.txt"), "one");
  const before = computeSourceIdentity(root);
  writeFileSync(path.join(root, "new-source.txt"), "two");
  const after = computeSourceIdentity(root);
  assert.notEqual(after.sourceDigest, before.sourceDigest);
  writeFileSync(path.join(root, "artifact.wav"), "large generated output");
  assert.deepEqual(computeSourceIdentity(root), after);
});
