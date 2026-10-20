import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";

test("standalone native exports reject changed stored/copied bytes and unavailable copies, then recover the same request", { timeout: 120_000 }, async t => {
  const { requireTool } = await import("../../src/lib/waveyard/ffmpeg.ts");
  const ffmpeg = await requireTool("ffmpeg"), ffprobe = await requireTool("ffprobe");
  const child = spawn(process.execPath, ["--import", path.resolve("waveyard-worker/node_modules/tsx/dist/loader.mjs"), path.resolve("waveyard-worker/apps/worker/test-fixtures/export-source-identity.mts")], {
    env: { ...process.env, SOURCE_IDENTITY_TEST_FFMPEG: ffmpeg.path, PATH: [path.dirname(ffmpeg.path), path.dirname(ffprobe.path), process.env.PATH].join(path.delimiter), TSX_TSCONFIG_PATH: path.resolve("waveyard-worker/tsconfig.json") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { output += chunk; });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  console.log(output);
  assert.equal(code, 0, output);
  for (const fault of ["stored-bytes", "copied-bytes", "copy-unavailable"]) {
    const rows = output.split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line)).filter(row => row.fault === fault);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].assets, 0); assert.equal(rows[0].errorCode, "source_identity_unverified");
    assert.equal(rows[1].repaired, true); assert.ok(rows[1].bytes > 44);
  }
});
