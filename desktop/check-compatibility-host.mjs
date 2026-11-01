/**
 * Read-only facility assessment. Never installs or runs Wine/Proton, opens game
 * inputs, changes mappings, or promotes observations into gameplay evidence.
 */
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assessCompatibilityHost } from "./arcade/compatibility.mjs";
import { probeLinuxAdmission } from "./arcade/linux-admission.mjs";

const exec = promisify(execFile);
async function tool(name) {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.resolve(directory, name);
    try { await access(candidate, constants.X_OK); if ((await stat(candidate)).isFile()) return candidate; } catch {}
  }
  return null;
}
export async function inspectCompatibilityFacilities() {
  const facilities = {
    graphics: { displayAdvertised: !!process.env.DISPLAY, waylandAdvertised: !!process.env.WAYLAND_DISPLAY,
      x11Connected: false, rendererVerified: false, inputVerified: false },
    audio: { pulseConnected: false, audiblePlaybackVerified: false },
    containment: { namespacePrimitivePassed: false, gameSandboxVerified: false },
    tools: {},
    probes: {},
  };
  const names = ["wine", "wine64", "wineserver", "steam", "pressure-vessel-wrap"];
  for (const name of names) facilities.tools[name] = !!await tool(name);
  // Only ordinary OS diagnostics run; optional runtime commands above do not.
  const env = Object.fromEntries(["PATH", "DISPLAY", "XAUTHORITY", "PULSE_SERVER", "XDG_RUNTIME_DIR", "HOME", "LANG", "LC_ALL"]
    .flatMap(key => process.env[key] ? [[key, process.env[key]]] : []));
  for (const [name, args, group, field] of [
    ["unshare", ["--user", "--map-root-user", "--mount", "--pid", "--fork", "--net", "--", "true"], "containment", "namespacePrimitivePassed"],
    ["xdpyinfo", [], "graphics", "x11Connected"],
    ["pactl", ["info"], "audio", "pulseConnected"],
  ]) {
    if (process.platform !== "linux") { facilities.probes[name] = { status: "not-applicable" }; continue; }
    const binary = await tool(name);
    if (!binary) { facilities.probes[name] = { status: "not-found-in-path" }; continue; }
    try {
      await exec(binary, args, { env, timeout: 3000, maxBuffer: 32 * 1024 });
      facilities[group][field] = true;
      facilities.probes[name] = { status: "passed" };
    } catch (error) {
      facilities.probes[name] = { status: "failed", code: error.code ?? null, timedOut: !!error.killed };
    }
  }
  return facilities;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const assessment = assessCompatibilityHost({
    context: process.env.ARENA_DESKTOP_MODE === "1" ? "desktop" : "hosted",
    facilities: await inspectCompatibilityFacilities(),
  });
  if (process.argv.includes("--probe-sandbox")) {
    assessment.admission = await probeLinuxAdmission();
    // This is deliberately nonzero when the prerequisites fail. A successful
    // primitive check still cannot certify an absent game driver.
    if (assessment.admission.status !== "primitives-only") process.exitCode = 2;
  }
  console.log(JSON.stringify({ assessedAt: new Date().toISOString(), ...assessment }, null, 2));
}
