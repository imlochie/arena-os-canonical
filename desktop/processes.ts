/**
 * Child-process registry for the desktop supervisor.
 *
 * Phase 1: spawn + output capture + clean tree shutdown on quit.
 * Phase 5 grows this into full supervision (readiness, restart with
 * backoff, crash detection) for the Arena server, Postgres, queue, and
 * Waveyard worker — the registry is where all children are tracked so
 * "shut everything down cleanly" is one call.
 */

import { spawn, type ChildProcess } from "node:child_process";

export interface TrackedSpawnOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  shell?: boolean;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
}

export type CommandRunner = (command: string, args: string[]) => Promise<void>;

async function runCommand(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve) => {
    const child = spawn(command, args, { stdio: "ignore", windowsHide: true });
    child.on("error", () => resolve());
    child.on("exit", () => resolve());
  });
}

export interface KillableChild {
  pid?: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: (signal?: NodeJS.Signals) => boolean;
}

export interface KillTreeOptions {
  platform?: string;
  run?: CommandRunner;
}

/**
 * Kill a child and (on Windows) its entire process tree. Windows has no
 * process groups for plain spawns, so taskkill /T is the reliable tree
 * killer; POSIX gets SIGTERM.
 */
export async function killTree(
  child: KillableChild,
  opts: KillTreeOptions = {},
): Promise<void> {
  const platform = opts.platform ?? process.platform;
  const run = opts.run ?? runCommand;
  if (platform === "win32" && child.pid !== undefined) {
    await run("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
    return;
  }
  child.kill("SIGTERM");
}

export interface RegistryOptions {
  spawnImpl?: typeof spawn;
  kill?: typeof killTree;
}

export class ChildProcessRegistry {
  private readonly children = new Map<number, ChildProcess>();
  private readonly spawnImpl: typeof spawn;
  private readonly kill: typeof killTree;

  constructor(opts: RegistryOptions = {}) {
    this.spawnImpl = opts.spawnImpl ?? spawn;
    this.kill = opts.kill ?? killTree;
  }

  get size(): number {
    return this.children.size;
  }

  spawn(
    command: string,
    args: string[],
    opts: TrackedSpawnOptions = {},
  ): ChildProcess {
    const child = this.spawnImpl(command, args, {
      cwd: opts.cwd,
      env: opts.env,
      shell: opts.shell,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    if (child.pid !== undefined) this.children.set(child.pid, child);
    child.stdout?.on("data", (chunk: Buffer) => opts.onStdout?.(String(chunk)));
    child.stderr?.on("data", (chunk: Buffer) => opts.onStderr?.(String(chunk)));
    child.once("exit", (code, signal) => {
      if (child.pid !== undefined) this.children.delete(child.pid);
      opts.onExit?.(code, signal);
    });
    return child;
  }

  /** Gracefully stop every tracked child; force-kill stragglers. */
  async shutdownAll(timeoutMs = 5000): Promise<void> {
    const live = [...this.children.values()];
    this.children.clear();
    await Promise.all(live.map((child) => this.stop(child, timeoutMs)));
  }

  private async stop(child: ChildProcess, timeoutMs: number): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await this.kill(child);
    const graceful = await waitForExit(child, timeoutMs);
    if (!graceful && child.exitCode === null && child.signalCode === null) {
      // Force-kill stragglers, and wait for the kernel to confirm the exit.
      child.kill("SIGKILL");
      await waitForExit(child, 2000);
    }
  }
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}
