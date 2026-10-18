// Real child-process evidence, not model reasoning or container acceptance.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { toolRunCommand } from "./tools";

test("a command ignoring SIGTERM cannot hold the mission past its deadline", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "arena-command-timeout-"));
  await writeFile(path.join(root, "stubborn.cjs"), "require('node:fs').writeFileSync('pid',String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);");
  let guard: ReturnType<typeof setTimeout> | undefined;
  try {
    let rescued = false;
    const rescue = new Promise<string>((resolve) => { guard = setTimeout(async () => {
      rescued = true;
      try { process.kill(Number(await readFile(path.join(root, "pid"), "utf8")), "SIGKILL"); } catch { /* already exited */ }
      resolve("test rescue: tool did not enforce timeout");
    }, 1500); });
    const result = await Promise.race([toolRunCommand(root, "node stubborn.cjs", 150), rescue]);
    assert.equal(rescued, false, result);
    assert.match(result, /error:.*timed out/i);
  } finally { clearTimeout(guard); await rm(root, { recursive: true, force: true }); }
});

test("POSIX timeout kills spawned descendants before they can write late results", { skip: process.platform === "win32" }, async () => {
  const { access } = await import("node:fs/promises");
  const root = await mkdtemp(path.join(tmpdir(), "arena-command-tree-"));
  try {
    await writeFile(path.join(root, "child.cjs"), "setTimeout(()=>require('node:fs').writeFileSync('late-result','not allowed'),600)");
    await writeFile(path.join(root, "parent.cjs"), "require('node:child_process').spawn(process.execPath,['child.cjs'],{stdio:'inherit'});setInterval(()=>{},1000)");
    const result = await toolRunCommand(root, "node parent.cjs", 150);
    assert.match(result, /timed out/); assert.match(result, /exit 124/);
    await new Promise((resolve) => setTimeout(resolve, 800));
    await assert.rejects(access(path.join(root, "late-result")), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
