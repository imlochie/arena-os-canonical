/** Bounded host subprocess primitive shared by mission command adapters.
 * This is timeout enforcement, NOT execution isolation. POSIX commands get
 * their own process group so descendants cannot keep inherited pipes alive. */
import { spawn } from "node:child_process";
export function runCommandProcess(command: string, args: string[], opts: { cwd?: string; timeoutMs: number; env?: NodeJS.ProcessEnv; shell?: boolean }) {
  return new Promise<{ code: number; output: string; timedOut: boolean; signal: string | null }>((resolve) => {
    const env = { ...(opts.env ?? process.env) };
    delete env.NODE_TEST_CONTEXT;
    const grouped = process.platform !== "win32";
    const child = spawn(command, args, { cwd: opts.cwd, env, shell: opts.shell ?? false, detached: grouped });
    let output = "", timedOut = false;
    const capture = (data: Buffer) => { if (output.length < 8000) output += data.toString().slice(0, 8000 - output.length); };
    child.stdout?.on("data", capture); child.stderr?.on("data", capture);
    const timer = setTimeout(() => {
      timedOut = true;
      try { if (grouped && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); }
      catch { child.kill("SIGKILL"); }
    }, Number.isFinite(opts.timeoutMs) ? Math.max(1, opts.timeoutMs) : 20_000);
    child.once("error", (error) => { clearTimeout(timer); resolve({ code: 127, output: `error: ${error.message}`, timedOut, signal: null }); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? 124 : code ?? 1, signal, timedOut, output: timedOut ? `error: command timed out after ${opts.timeoutMs}ms\n${output}` : output });
    });
  });
}
