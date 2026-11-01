import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, realpath, statfs, lstat, mkdir, mkdtemp, writeFile, readFile, rmdir, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const source = fileURLToPath(new URL("../native/arcade-linux-gate.c", import.meta.url));
async function resolveTool(name) {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    try {
      const file = await realpath(path.resolve(directory, name));
      await access(file, constants.X_OK);
      if ((await lstat(file)).isFile()) return file;
    } catch {}
  }
  throw new Error(`Required trusted tool not found: ${name}`);
}

// An admission check, NOT a game launch path. No game, Wine prefix, default
// ~/.wine, host display, audio socket or visitor data is opened. In particular,
// never "fix" a private-proc failure by binding the owner's existing /proc.
export async function probeLinuxAdmission({ cgroupRoot = "/sys/fs/cgroup" } = {}) {
  if (process.platform !== "linux" || process.arch !== "x64")
    return { status: "unsupported", reason: "This probe requires Linux x64.", gameplayVerified: false };
  const result = {
    status: "blocked", cgroupControlsConfigured: false, privateProcMounted: false,
    probeGroupCleaned: false, gameplayVerified: false, diagnostic: "",
  };
  const directory = await mkdtemp(path.join(os.tmpdir(), "arena-linux-admission-"));
  const group = path.join(cgroupRoot, `arena-admission-${randomUUID()}`);
  let groupCreated = false, child, closed;
  // Only trusted compiler/OS tools execute. No provider/session credentials are
  // inherited, and the game-facing environment is not created by this probe.
  const env = Object.fromEntries(["PATH", "LANG", "LC_ALL", "TMPDIR"].flatMap(key =>
    process.env[key] ? [[key, process.env[key]]] : []));
  try {
    if ((await lstat(cgroupRoot)).isSymbolicLink() || (await statfs(cgroupRoot)).type !== 0x63677270)
      throw new Error("A real delegated cgroup-v2 filesystem is required.");
    const [bubblewrap, trueCommand] = await Promise.all([resolveTool("bwrap"), resolveTool("true")]);
    if (![bubblewrap, trueCommand].every(file => file.startsWith("/nix/store/")))
      throw new Error("This admission distribution currently requires immutable Nix tooling.");
    await mkdir(group);
    groupCreated = true;
    for (const [name, value] of Object.entries({
      "memory.max": "536870912", "memory.swap.max": "0", "pids.max": "32", "cpu.max": "25000 100000",
    })) {
      await writeFile(path.join(group, name), value);
      if ((await readFile(path.join(group, name), "utf8")).trim() !== value)
        throw new Error(`Kernel did not retain ${name}.`);
    }
    result.cgroupControlsConfigured = true;
    const gate = path.join(directory, "gate");
    await exec("gcc", ["-O2", "-Wall", "-Wextra", source, "-o", gate],
      { env, timeout: 15_000, maxBuffer: 8192 });
    closed = new Promise((resolve, reject) => {
      // All mounted content is immutable OS tooling. Even on a permissive host,
      // the ONLY payload is trusted `true`, not Wine or an arbitrary input.
      child = spawn(gate, ["--gated", bubblewrap,
        "--unshare-all", "--new-session", "--die-with-parent",
        "--ro-bind", "/nix/store", "/nix/store", "--proc", "/proc",
        "--dev", "/dev", "--tmpfs", "/tmp", "--clearenv", "--",
        trueCommand],
      { env, stdio: ["pipe", "pipe", "pipe"] });
      child.stdin.on("error", () => {});
      child.stdout.resume();
      child.stderr.on("data", data => { result.diagnostic += data.toString().slice(0, Math.max(0, 4096 - result.diagnostic.length)); });
      child.once("error", reject);
      child.once("close", code => resolve(code));
    });
    // Prevent an unhandled rejection if attaching fails before awaiting close.
    closed.catch(() => {});
    await writeFile(path.join(group, "cgroup.procs"), String(child.pid));
    child.stdin.write("G");
    let timer;
    try {
      const code = await Promise.race([closed, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Private-proc probe timed out.")), 8000);
      })]);
      if (code === 0) { result.privateProcMounted = true; result.status = "primitives-only"; }
      else result.code = /mount proc/.test(result.diagnostic) ? "PRIVATE_PROC_MOUNT_DENIED" : "SANDBOX_SETUP_FAILED";
    } finally { clearTimeout(timer); }
  } catch (error) {
    result.code = error.code ?? "ADMISSION_CHECK_FAILED";
    result.diagnostic = String(error.message).slice(0, 4096);
  } finally {
    if (groupCreated) {
      // Never kill recorded/recycled PIDs or another user's/global Wine server.
      await writeFile(path.join(group, "cgroup.kill"), "1");
      if (closed) await closed.catch(() => {});
      for (let attempt = 0; attempt < 20; attempt++) {
        try { await rmdir(group); result.probeGroupCleaned = true; break; }
        catch (error) {
          if (!["EBUSY", "ENOTEMPTY"].includes(error.code) || attempt === 19) throw error;
          await new Promise(resolve => setTimeout(resolve, 25));
        }
      }
    }
    await rm(directory, { recursive: true, force: true });
  }
  result.diagnostic = result.diagnostic.trim();
  return result;
}
