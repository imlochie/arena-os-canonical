import childProcess from "node:child_process";
import { readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
// Fault fixture only: pause an ACTUAL spawned FFmpeg after its output graph
// is announced, rather than pretending that rendering happened.
if (process.env.HOLD_STAGE === "ffmpeg-active") {
  const spawn = childProcess.spawn;
  let paused = false;
  childProcess.spawn = ((...args: any[]) => {
    const child = (spawn as any)(...args);
    if (String(args[0]).includes("ffmpeg"))
      child.stderr?.on("data", (chunk: Buffer) => {
        if (
          !paused &&
          child.exitCode === null &&
          String(chunk).includes("Output #0")
        ) {
          paused = true;
          if (!child.kill("SIGSTOP"))
            throw new Error(
              "FFmpeg exited before the interruption fault could be established.",
            );
          const deadline = Date.now() + 1000;
          const proveStopped = () => {
            let stopped = false;
            try {
              stopped = /^State:\s+[Tt] /m.test(
                readFileSync(`/proc/${child.pid}/status`, "utf8"),
              );
            } catch {
              /* exit is not accepted as a paused renderer */
            }
            if (stopped)
              console.log(
                "EVENT",
                JSON.stringify({
                  kind: "stage",
                  stage: "ffmpeg-active",
                  pid: child.pid,
                  verifiedProcessState: "stopped",
                }),
              );
            else if (Date.now() < deadline) setTimeout(proveStopped, 5);
            else
              throw new Error(
                "Could not prove that the actual FFmpeg process was stopped.",
              );
          };
          proveStopped();
        }
      });
    return child;
  }) as typeof childProcess.spawn;
  syncBuiltinESMExports();
}
import BullMQ from "bullmq";
import { processExport } from "../src/export.ts";
const { Worker } = BullMQ;
const redis = new URL(process.env.REDIS_URL!);
const worker = new Worker(
  "waveyard-export",
  async (job) => {
    try {
      await processExport(job.data, async (stage) => {
        await job.updateProgress({ stage });
        console.log(
          "EVENT",
          JSON.stringify({ kind: "stage", stage, id: job.id }),
        );
        if (process.env.HOLD_STAGE === stage)
          await new Promise((resolve) => process.stdin.once("data", resolve));
      });
      console.log("EVENT", JSON.stringify({ kind: "returned", id: job.id }));
    } catch (error) {
      console.log(
        "EVENT",
        JSON.stringify({
          kind: "handler-error",
          id: job.id,
          error: String(error),
        }),
      );
      throw error;
    }
  },
  {
    connection: {
      host: redis.hostname,
      port: Number(redis.port),
      db: Number(redis.pathname.slice(1) || 0),
    },
    lockDuration: 700,
    stalledInterval: 200,
    maxStalledCount: 3,
  },
);
worker.on("ready", () =>
  console.log("EVENT", JSON.stringify({ kind: "ready" })),
);
worker.on("error", (error) => console.error(String(error)));
