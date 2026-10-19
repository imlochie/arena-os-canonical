/** Pause a real encoder only AFTER payload bytes, or a verifier only AFTER decoded progress. */
import childProcess from "node:child_process";
import { stat } from "node:fs/promises";
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
      process.send?.({ event: `${phase}-started`, pid: child.pid, output, ...evidence, realTimeInputHarness: true });
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
