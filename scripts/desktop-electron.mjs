import { spawnSync } from "node:child_process";
import path from "node:path";
import { inspectElectronHost } from "./lib/electron-host.mjs";

const install = process.argv.includes("--install");
if (install) {
  // Explicit opt-in only. Use Electron's checksum-verifying supported installer.
  console.log("Preparing Electron binary using the installed package's official installer. Network/cache access is required; this does not prepare models.");
  const result = spawnSync(process.execPath, [path.join(process.cwd(), "node_modules/electron/install.js")], { stdio: "inherit" });
  if (result.status !== 0) {
    console.error("Electron preparation failed; retain the installer error above. Check release-host access or provide ELECTRON_OVERRIDE_DIST_PATH pointing to a trusted matching distribution. No launch acceptance is claimed.");
    process.exit(result.status || 1);
  }
}
const report = inspectElectronHost();
console.log(JSON.stringify(report, null, 2));
// Preparation can succeed on a headless build host without claiming UI launch.
process.exitCode = install ? (report.binaryVerified ? 0 : 1) : report.readyToLaunch ? 0 : 1;
