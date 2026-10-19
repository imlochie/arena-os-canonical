import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { clearResolvedToolCache, execTool } from "./ffmpeg";

test("aborting execTool waits for child close before callers can clean its working files", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "arena-tool-close-"));
  const binary = join(root, "ffmpeg"), ready = join(root, "ready"), closed = join(root, "closed");
  const previous = process.env.ARENA_FFMPEG_PATH;
  try {
    await writeFile(binary, `#!/usr/bin/env node\nconst fs = require('node:fs');\nprocess.on('SIGTERM', () => setTimeout(() => { fs.writeFileSync(${JSON.stringify(closed)}, 'closed'); process.exit(0); }, 150));\nfs.writeFileSync(${JSON.stringify(ready)}, 'ready');\nsetInterval(() => {}, 1000);\n`, { mode: 0o755 });
    process.env.ARENA_FFMPEG_PATH = binary; clearResolvedToolCache();
    const controller = new AbortController();
    const rejected = assert.rejects(execTool("ffmpeg", [], { signal: controller.signal }), { name: "AbortError" });
    let started = false;
    for (let attempt = 0; attempt < 300; attempt++) { try { await readFile(ready); started = true; break; } catch { await delay(10); } }
    assert.equal(started, true, "the real test child must have installed its termination handler");
    controller.abort(); await rejected;
    assert.equal(await readFile(closed, "utf8"), "closed", "AbortError must not precede child termination/stdio close");
  } finally { if (previous === undefined) delete process.env.ARENA_FFMPEG_PATH; else process.env.ARENA_FFMPEG_PATH = previous; clearResolvedToolCache(); await rm(root, { recursive: true, force: true }); }
});

test("bounded native media diagnostics stop excessive output and await child closure", async () => {
  await assert.rejects(execTool("ffmpeg", ["-hide_banner", "-encoders"], { maxOutputBytes: 64 }), /bounded limit/);
});

test("native process timeout escalates a real TERM-ignoring child and rejects only after it is gone",{skip:process.platform==="win32"},async()=>{
 const root=await mkdtemp(join(tmpdir(),"arena-tool-timeout-")),binary=join(root,"ffmpeg"),ready=join(root,"ready"),previous=process.env.ARENA_FFMPEG_PATH;
 try{await writeFile(binary,`#!/usr/bin/env node\nconst fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000);\n`,{mode:0o755});process.env.ARENA_FFMPEG_PATH=binary;clearResolvedToolCache();const started=Date.now();await assert.rejects(execTool("ffmpeg",[],{timeoutMs:2000}),/timed out after 2000ms/);const pid=Number(await readFile(ready,"utf8"));assert.throws(()=>process.kill(pid,0),{code:"ESRCH"});assert.ok(Date.now()-started<10000);}finally{if(previous===undefined)delete process.env.ARENA_FFMPEG_PATH;else process.env.ARENA_FFMPEG_PATH=previous;clearResolvedToolCache();await rm(root,{recursive:true,force:true});}
});
