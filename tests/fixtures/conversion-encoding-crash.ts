/** Pause a real encoder only AFTER payload bytes, or a verifier only AFTER decoded progress. */
import childProcess from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { syncBuiltinESMExports } from "node:module";
const original = childProcess.spawn;
const phase = process.argv[3] === "verification" ? "verification" : "encoding";
childProcess.spawn = ((...args: Parameters<typeof original>) => {
  const supplied = args[1];
  const target = Array.isArray(supplied) && supplied.includes(phase === "encoding" ? "-fs" : "-xerror");
  if (target && Array.isArray(supplied)) {
    const i = supplied.indexOf("-i");
    // Test-only speed control. Actual codec/metadata/decoder still run; no simulated output.
    args[1] = [...supplied.slice(0, i), "-re", ...(phase === "verification" ? ["-progress", "pipe:1"] : []), ...supplied.slice(i)];
  }
  const child = original(...args);
  if (target && Array.isArray(supplied)) {
    const output = phase === "encoding" ? supplied.at(-1) : supplied[supplied.indexOf("-i") + 1];
    let sent = false, checking = false;
    const pause = (evidence: { encodedBytes?: number; decodedTimeUs?: number }) => {
      if (sent || !child.kill("SIGSTOP")) return;
      sent = true;
      // kill() confirms signal delivery, NOT that the kernel has stopped the
      // process. Sending IPC immediately raced the parent's /proc assertion
      // (reproduced State:R under load). Acknowledge the observed stop instead
      // of sleeping blindly or weakening the interruption acceptance.
      void (async () => {
        const deadline = Date.now() + 2000;
        let state = "unknown";
        do {
          const status = await readFile(`/proc/${child.pid}/status`, "utf8");
          state = status.match(/^State:\s+(\S+)/m)?.[1] ?? "unknown";
          if (state === "T") {
            process.send?.({ event: `${phase}-started`, pid: child.pid, output, ...evidence, realTimeInputHarness: true, stoppedStateConfirmed: true });
            return;
          }
          await delay(5);
        } while (Date.now() < deadline);
        throw new Error(`Encoder did not acknowledge SIGSTOP within 2000ms (last state ${state}).`);
      })().catch(error => {
        console.error("Real conversion interruption fixture failed:", error);
        child.kill("SIGKILL");
      });
    };
    if (phase === "encoding") {
      const timer = setInterval(() => {
        if (checking || sent || !output) return;
        checking = true;
        void stat(output).then(file => { if (file.size > 65_536) pause({ encodedBytes: file.size }); }).catch(() => undefined).finally(() => { checking = false; });
      }, 10);
      child.once("close", () => clearInterval(timer));
    } else {
      let progress = "";
      child.stdout?.on("data", bytes => {
        progress = (progress + bytes.toString()).slice(-4096);
        for (const match of progress.matchAll(/out_time_us=(\d+)/g)) if (Number(match[1]) > 0) pause({ decodedTimeUs: Number(match[1]) });
      });
    }
  }
  return child;
}) as typeof original;
syncBuiltinESMExports();
const { execute } = await import("../../src/lib/waveyard/conversion/jobs");
await execute(process.argv[2]);
