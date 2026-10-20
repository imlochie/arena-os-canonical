/** Executes real child processes for decoder lifecycle, not FFmpeg/DSP proof. */
import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { decodeSourceToStereoPcm } from "./pcm";

test("pre-aborted PCM decode does not read an input or resolve a binary", async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(decodeSourceToStereoPcm("missing-source", {}, { resolveFfmpeg: async () => { throw new Error("must not resolve"); } }, { signal: controller.signal }), { name: "AbortError" });
});

test("PCM decode abort waits for a TERM-ignoring decoder child to exit", { skip: process.platform === "win32" ? "POSIX executable script fixture; not Windows process acceptance" : false }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pcm-cancel-")); const controller = new AbortController();
  let pending: Promise<unknown> | undefined;
  try {
    const binary = join(root, "controlled-decoder"); const pidPath = join(root, "pid"); const input = join(root, "input");
    await writeFile(input, "controlled non-WAV input");
    await writeFile(binary, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 100);\n`); await chmod(binary, 0o755);
    pending = decodeSourceToStereoPcm(input, {}, { resolveFfmpeg: async () => binary }, { signal: controller.signal });
    let pid: number | undefined;
    for (let n = 0; n < 200; n++) { const text = await readFile(pidPath, "utf8").catch(() => ""); if (text) { pid = Number(text); break; } await delay(10); }
    assert.ok(pid, "controlled child actually started");
    controller.abort(); await assert.rejects(pending, { name: "AbortError" });
    assert.throws(() => process.kill(pid!, 0), { code: "ESRCH" }, "promise rejects only after the child is gone");
  } finally { controller.abort(); await pending?.catch(() => {}); await rm(root, { recursive: true, force: true }); }
});
