import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

/** Never import electron/index.js here: Electron 44 downloads on require(). */
export function inspectElectronHost({ root = process.cwd(), env = process.env, platform = process.platform, probe = spawnSync } = {}) {
  const directory = path.join(root, "node_modules", "electron");
  const report = { platform, architecture: process.arch, packageVersion: null, binary: null, binaryVerified: false, displayAvailable: platform !== "linux" || Boolean(env.DISPLAY || env.WAYLAND_DISPLAY), issues: [], evidence: "preflight only; not Electron UI acceptance" };
  let relative;
  try {
    report.packageVersion = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8")).version;
    try { relative = readFileSync(path.join(directory, "path.txt"), "utf8").trim(); } catch { /* binary not hydrated */ }
  } catch {
    report.issues.push("Electron package is missing. Install the repository dependencies first.");
  }
  report.binary = env.ELECTRON_OVERRIDE_DIST_PATH
    ? path.join(env.ELECTRON_OVERRIDE_DIST_PATH, relative || (platform === "win32" ? "electron.exe" : "electron"))
    : relative ? path.resolve(directory, "dist", relative) : null;
  if (!report.binary || !existsSync(report.binary)) report.issues.push("Electron binary is missing. On an authorised network-capable host run npm run desktop:prepare-electron. This explicitly downloads Electron, not model weights.");
  else {
    const result = probe(report.binary, ["-p", "process.versions.electron"], { env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8", timeout: 15000 });
    report.binaryVerified = result.status === 0 && String(result.stdout).trim() === report.packageVersion;
    if (!report.binaryVerified) report.issues.push(`Electron binary failed the version/runtime probe (expected ${report.packageVersion}). ${String(result.error?.message || result.stderr || "version mismatch").slice(0, 1500)}`);
  }
  if (!report.displayAvailable) report.issues.push("No Linux desktop display is configured. Use a desktop session, or install Xvfb/system Electron libraries on a capable host and run xvfb-run -a npm run desktop:smoke. Browser/server tests do not establish Electron acceptance.");
  report.readyToLaunch = report.binaryVerified && report.displayAvailable;
  return report;
}
