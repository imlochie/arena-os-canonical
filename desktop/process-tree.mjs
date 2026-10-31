import { spawn } from "node:child_process";
import path from "node:path";

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("close", (code) => {
      code === 0
        ? resolve()
        : reject(new Error(`${path.basename(command)} exited (${code})`));
    });
  });
}

/**
 * Stop a timed-out child and its descendants. Windows has no process groups
 * for ordinary child_process.spawn calls, so taskkill /T is needed to reap
 * Chromium processes launched by the API server.
 */
export async function killProcessTree(child, options = {}) {
  if (child.exitCode !== null || child.signalCode !== null) return;

  const platform = options.platform ?? process.platform;
  if (platform === "win32" && child.pid !== undefined) {
    const systemRoot = options.systemRoot ?? process.env.SystemRoot ?? "C:\\Windows";
    const taskkill = path.win32.join(systemRoot, "System32", "taskkill.exe");
    try {
      await (options.runCommand ?? runCommand)(taskkill, ["/PID", String(child.pid), "/T", "/F"]);
    } catch (error) {
      // The process may have exited between the state check and taskkill.
      if (child.exitCode !== null || child.signalCode !== null) return;
      throw error;
    }
    return;
  }

  child.kill("SIGTERM");
}
