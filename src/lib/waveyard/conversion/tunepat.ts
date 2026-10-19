/** Optional, explicit external app launch. No undocumented automation arguments. */
import { spawn } from "node:child_process";
import { lstat, access } from "node:fs/promises";
import { constants } from "node:fs";
import { win32 } from "node:path";
import { resolveExecutable } from "@/lib/capabilities/resolver";
export const tunePatCandidate = "C:\\Program Files (x86)\\TunePat\\TunePat Apple Music Converter\\TunePat Apple Music Converter.exe";
export function validateTunePatPath(path: string) {
  if (!path || path.length > 2048 || /[\x00-\x1f"]/.test(path) || !/^[a-z]:\\/i.test(path) || path.split(/[\\/]/).includes("..") || win32.basename(path).toLowerCase() !== "tunepat apple music converter.exe") throw new Error("Select the absolute local TunePat Apple Music Converter.exe path, not a directory, network share, command or script.");
  return win32.normalize(path);
}
export async function tunePatStatus(path: string) {
  const executable = validateTunePatPath(path);
  if (process.platform !== "win32") return { available: false, state: "unsupported-platform", message: "This configured Windows executable cannot be launched on this host. Native conversion and explicit output-file import remain available." };
  try {
    const details = await lstat(executable);
    if (!details.isFile() || details.isSymbolicLink()) throw new Error("Unsafe executable alias");
    await access(executable, constants.X_OK);
    const resolved = resolveExecutable("tunepat", { envVar: "ARENA_TUNEPAT_PATH", env: { ARENA_TUNEPAT_PATH: executable }, allowSystem: false });
    if (!resolved) throw new Error("Executable not found");
    return { available: true, state: "executable-found", message: "Configured executable exists; application launch and window have not been verified." };
  } catch { return { available: false, state: "missing-or-unreadable", message: "Configured TunePat executable is missing, unreadable or unsafe. Check this installation's actual path." }; }
}
export async function launchTunePat(path: string) {
  const status = await tunePatStatus(path);
  if (!status.available) throw new Error(status.message);
  if (process.env.ARENA_DESKTOP_MODE !== "1") throw new Error("External application launch is available only in the local desktop runtime, never a hosted web server.");
  const executable = validateTunePatPath(path);
  return new Promise<{ state: string; pid?: number; message: string }>((resolve, reject) => {
    // No user args, no shell, no protected playback capture or private API.
    const child = spawn(executable, [], { cwd: win32.dirname(executable), stdio: "ignore", detached: true, windowsHide: false });
    let settled = false;
    const timer = setTimeout(() => { settled = true; child.unref(); resolve({ state: "process-started", pid: child.pid, message: "TunePat process started. Its window and any conversion are external and unverified; import completed files explicitly." }); }, 1200);
    child.once("error", error => { clearTimeout(timer); if (!settled) { settled = true; reject(new Error(`TunePat launch failed: ${error.message}`)); } });
    child.once("exit", code => { clearTimeout(timer); if (!settled) { settled = true; if (code !== 0) reject(new Error(`TunePat exited during launch (${code}); no successful application launch claimed.`)); else resolve({ state: "process-exited", message: "TunePat process exited. It may have handed off to another instance; no application window or output was verified." }); } });
  });
}
