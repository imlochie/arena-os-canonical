import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, symlink, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { invokeReadOnlyTool, type ToolGrant } from "./toolRuntime";

const exec = promisify(execFile);

async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), "arena-tools-"));
  const a = join(parent, "project-a");
  const b = join(parent, "project-b");
  await mkdir(a); await mkdir(b);
  await writeFile(join(a, "visible.txt"), "visible");
  await writeFile(join(b, "secret.txt"), "secret");
  const grant: ToolGrant = {
    id: "grant-a", sessionId: "session-a", resourceId: "repo-a", root: a,
    capabilities: ["filesystem.list", "filesystem.read", "filesystem.search", "git.status", "git.diff", "git.log"],
  };
  return { a, b, grant };
}

function request(capability: Parameters<typeof invokeReadOnlyTool>[0]["capability"], extra = {}) {
  return { sessionId: "session-a", actorId: "worker-a", resourceId: "repo-a", capability, ...extra };
}

test("scope authorization rejects another session, resource, sibling root, traversal, and escaping symlink", async () => {
  const { a, b, grant } = await fixture();
  await assert.rejects(() => invokeReadOnlyTool({ ...request("filesystem.read", { path: "visible.txt" }), sessionId: "session-b" }, grant), /TOOL_SCOPE_DENIED/);
  await assert.rejects(() => invokeReadOnlyTool({ ...request("filesystem.read", { path: "visible.txt" }), resourceId: "repo-b" }, grant), /TOOL_SCOPE_DENIED/);
  await assert.rejects(() => invokeReadOnlyTool(request("filesystem.read", { path: join(b, "secret.txt") }), grant), /TOOL_SCOPE_DENIED/);
  await assert.rejects(() => invokeReadOnlyTool(request("filesystem.read", { path: "../project-b/secret.txt" }), grant), /TOOL_SCOPE_DENIED/);
  await symlink(join(b, "secret.txt"), join(a, "escape"));
  await assert.rejects(() => invokeReadOnlyTool(request("filesystem.read", { path: "escape" }), grant), /TOOL_SCOPE_DENIED/);
});

test("filesystem tools are bounded, read-only, and expose capability versus adapter provenance", async () => {
  const { a, grant } = await fixture();
  for (let i = 0; i < 205; i++) await writeFile(join(a, `match-${i}.txt`), "x");
  await writeFile(join(a, "large.txt"), "x".repeat(100_001));
  const listed = await invokeReadOnlyTool(request("filesystem.list", { limit: 2 }), grant);
  const searched = await invokeReadOnlyTool(request("filesystem.search", { query: "match", limit: 3 }), grant);
  const read = await invokeReadOnlyTool(request("filesystem.read", { path: "large.txt" }), grant);
  assert.equal(listed.requestedCapability, "filesystem.list");
  assert.equal(listed.selectedAdapter, "local_filesystem");
  assert.equal(listed.truncated, true);
  assert.equal((listed.data as string[]).length, 2);
  assert.equal(searched.truncated, true);
  assert.equal((searched.data as string[]).length, 3);
  assert.equal(read.truncated, true);
  assert.equal((read.data as string).length, 100_000);
  assert.equal(await readFile(join(a, "visible.txt"), "utf8"), "visible");
});

test("git tools use fixed read-only commands and cannot interpret path text as a command", async () => {
  const { a, grant } = await fixture();
  await exec("git", ["init"], { cwd: a });
  await exec("git", ["config", "user.email", "test@example.com"], { cwd: a });
  await exec("git", ["config", "user.name", "Test"], { cwd: a });
  await exec("git", ["add", "visible.txt"], { cwd: a });
  await exec("git", ["commit", "-m", "initial"], { cwd: a });
  await writeFile(join(a, "visible.txt"), "changed");
  const marker = join(a, "command-ran");
  const hostileName = "visible.txt;touch-command-ran";
  await writeFile(join(a, hostileName), "not a command");
  const diff = await invokeReadOnlyTool(request("git.diff", { path: hostileName }), grant);
  const status = await invokeReadOnlyTool(request("git.status"), grant);
  const log = await invokeReadOnlyTool(request("git.log", { limit: 1 }), grant);
  assert.equal(diff.selectedAdapter, "local_git");
  assert.match(status.data as string, /visible\.txt/);
  assert.match(log.data as string, /initial/);
  await assert.rejects(() => readFile(marker));
});

test("the same runtime entry point accepts actors from every core mode", async () => {
  const { grant } = await fixture();
  for (const actorId of ["chat", "council", "arena", "collab"]) {
    const result = await invokeReadOnlyTool({ ...request("filesystem.read", { path: "visible.txt" }), actorId }, grant);
    assert.equal(result.data, "visible");
  }
});
