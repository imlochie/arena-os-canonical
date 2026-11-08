import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, link, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readMissionMemory } from "./mission-memory";
test("ordinary workspace notes are bounded; missing notes are not fabricated", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "arena-notes-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(await readMissionMemory(root), { text: "" });
  await writeFile(path.join(root, "AGENT_NOTES.md"), "observed finding\n".repeat(200));
  const notes = await readMissionMemory(root); assert.equal(notes.text.length, 1500); assert.equal(notes.issue, undefined);
});
test("symlink/hardlink/oversized notes cannot import outside-workspace bytes into model context", async t => {
  const parent = await mkdtemp(path.join(tmpdir(), "arena-notes-boundary-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const outside = path.join(parent, "outside.txt"); await writeFile(outside, "PRIVATE_OUTSIDE_FIXTURE");
  for (const kind of ["symlink", "hardlink", "oversize", "directory"]) {
    const root = path.join(parent, kind); await mkdir(root);
    const target = path.join(root, "AGENT_NOTES.md");
    if (kind === "symlink") await symlink(outside, target);
    if (kind === "hardlink") await link(outside, target);
    if (kind === "oversize") await writeFile(target, "x".repeat(65537));
    if (kind === "directory") await mkdir(target);
    const result = await readMissionMemory(root);
    assert.equal(result.text, "", kind); assert.match(result.issue ?? "", /not loaded/, kind);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_OUTSIDE_FIXTURE/);
  }
});
