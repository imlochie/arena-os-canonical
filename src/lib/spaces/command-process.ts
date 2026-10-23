/** Bounded host subprocess primitive shared by mission command adapters.
 * This is timeout enforcement, NOT execution isolation. POSIX commands get
 * their own process group so descendants cannot keep inherited pipes alive. */
import { spawn, spawnSync } from "node:child_process";
export function runCommandProcess(command: string, args: string[], opts: { cwd?: string; timeoutMs: number; env?: NodeJS.ProcessEnv; shell?: boolean; signal?: AbortSignal }) {
  return new Promise<{ code: number; output: string; timedOut: boolean; signal: string | null }>((resolve) => {
    if (opts.signal?.aborted) { resolve({ code: 130, output: "error: command cancelled before start", timedOut: false, signal: null }); return; }
    const env = { ...(opts.env ?? process.env) };
    delete env.NODE_TEST_CONTEXT;
    const grouped = process.platform !== "win32";
    const child = spawn(command, args, { cwd: opts.cwd, env, shell: opts.shell ?? false, detached: grouped });
    let output = "", timedOut = false;
    const capture = (data: Buffer) => { if (output.length < 8000) output += data.toString().slice(0, 8000 - output.length); };
    child.stdout?.on("data", capture); child.stderr?.on("data", capture);
    let cancelled = false;
    const kill = () => {
      if (grouped && child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); return; } catch { /* fall through */ }
      }
      // Windows has no process groups. `child.kill()` terminates only the
      // direct child, so a shell (or anything it started) survives, keeps the
      // inherited stdout/stderr pipes open and 'close' never fires: a timeout
      // or cancellation would hang instead of resolving. taskkill /T walks the
      // tree the same way the POSIX group kill does.
      if (process.platform === "win32" && child.pid) {
        try { spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); }
        catch { /* fall through to the direct kill */ }
      }
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    };
    const onAbort = () => { cancelled = true; kill(); };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => { clearTimeout(timer); opts.signal?.removeEventListener("abort", onAbort); };
    const timer = setTimeout(() => { timedOut = true; kill(); }, Number.isFinite(opts.timeoutMs) ? Math.max(1, opts.timeoutMs) : 20_000);
    child.once("error", (error) => { cleanup(); resolve({ code: 127, output: `error: ${error.message}`, timedOut, signal: null }); });
    child.once("close", (code, signal) => {
      cleanup();
      if (cancelled) { resolve({ code: 130, signal, timedOut: false, output: `error: command cancelled\n${output}` }); return; }
      resolve({ code: timedOut ? 124 : code ?? 1, signal, timedOut, output: timedOut ? `error: command timed out after ${opts.timeoutMs}ms\n${output}` : output });
    });
  });
}
