/**
 * Desktop launch smoke — Phase 1 runtime verification.
 *
 * Launches the real Electron shell with ARENA_DESKTOP_SMOKE set. The main
 * process then: opens the window, verifies the preload bridge exists in
 * the renderer, performs a full getInfo() IPC roundtrip, validates it
 * against the zod contract, and writes a JSON result before exiting.
 *
 * This script just runs it and checks the result:
 *
 *   npm run desktop:smoke        (needs the electron binary — allow its
 *                                 postinstall once, or run install.js)
 *
 * Works on any OS with a display (or under xvfb on Linux CI). On a
 * headless Linux box, wrap it:  xvfb-run -a npm run desktop:smoke
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const electronPath = join("node_modules", "electron", "cli.js");
const resultPath = join(
  mkdtempSync(join(tmpdir(), "arena-desktop-smoke-")),
  "result.json",
);

console.log("[smoke] compiling desktop shell…");
const compile = spawnSync(process.execPath, [
  join("node_modules", "typescript", "bin", "tsc"),
  "-p", "desktop/tsconfig.json",
], { stdio: "inherit" });
if (compile.status !== 0) {
  console.error("[smoke] FAIL: desktop compile failed");
  process.exit(1);
}

console.log("[smoke] launching Electron shell…");
const run = spawnSync(process.execPath, [electronPath, "."], {
  env: { ...process.env, ARENA_DESKTOP_SMOKE: resultPath },
  stdio: "inherit",
  timeout: 60_000,
});

let result;
try {
  result = JSON.parse(readFileSync(resultPath, "utf8"));
} catch {
  console.error(
    `[smoke] FAIL: no result written (electron exit=${run.status}, signal=${run.signal}). ` +
      "If the binary is missing, run: node node_modules/electron/install.js",
  );
  process.exit(1);
} finally {
  rmSync(join(resultPath, ".."), { recursive: true, force: true });
}

console.log("[smoke] result:", JSON.stringify(result, null, 2));

const checks = [
  ["singleInstance", result.singleInstance === true],
  ["windowCreated", result.windowCreated === true],
  ["preloadBridge", result.preloadBridge === true],
  ["ipcRoundtrip", result.ipcRoundtrip === true],
  ["electronExit", run.status === 0],
];
const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);

if (failed.length > 0 || result.ok !== true) {
  console.error(`[smoke] FAIL: ${failed.join(", ") || "result.ok !== true"}`);
  process.exit(1);
}
console.log("[smoke] PASS: shell, bridge, typed IPC roundtrip all verified.");
