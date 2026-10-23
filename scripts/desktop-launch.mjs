import { spawn } from "node:child_process";
import { inspectElectronHost } from "./lib/electron-host.mjs";
const report = inspectElectronHost();
if (!report.readyToLaunch) {
  console.error(report.issues.join("\n"));
  process.exit(1);
}
// Spawn the verified binary directly, never Electron's lazy-download module.
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(report.binary, process.argv.slice(2), { env, stdio: "inherit" });
child.once("error", (error) => { console.error(`Electron launch failed: ${error.message}`); process.exitCode = 1; });
child.once("exit", (code, signal) => { if (signal) console.error(`Electron exited with ${signal}`); process.exitCode = code ?? 1; });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
