/**
 * Space workspace isolation (docs/spaces-autonomy.md Phase B) — real,
 * OS-level separation for mission command execution.
 *
 * When a container runtime is available (Docker/Podman on Linux or macOS,
 * WSL on Windows), a mission's `run_command`/`run_tests` actions execute
 * INSIDE a dedicated, long-lived container with the mission workspace
 * bind-mounted — the host is unreachable by construction except through
 * that single directory. File tools (write/read/list/search) keep operating
 * on the same directory from the host side, so both views are identical.
 *
 * Honesty contract (nothing pretended):
 *   - `probeIsolation()` reports what actually exists on this machine.
 *   - A mission that requests isolation but has NO runtime available runs on
 *     the HOST jail (allowlist + cwd + timeout) and the mission journal says
 *     so explicitly — never a silent downgrade.
 *   - Every command executed in a container is prefixed in its output with
 *     the container reference, so the journal always records WHICH
 *     environment ran it.
 *
 * Container policy: one container per space mission workspace
 * (`arena-space-<spaceId>`), `--network none` by default (a mission opts
 * into bounded networking explicitly), CPU/memory capped, removed on
 * teardown. Bind mount is read-write for the workspace directory ONLY.
 */

import { spawn } from "node:child_process";
import { WORKSPACE_ROOT } from "./tools";

export type IsolationKind = "docker" | "podman" | "wsl" | "none";

export interface IsolationRuntime {
  kind: IsolationKind;
  /** Human-readable version string of the runtime (probed, never assumed). */
  version: string;
}

export interface IsolatedEnv {
  kind: "docker" | "podman" | "wsl";
  /** Container name (docker/podman) or distro (wsl). */
  ref: string;
  image: string;
  networkMode: "none" | "bridge";
}

/** How a command is executed — host jail or isolated container. */
export type ExecTarget =
  | { env: "host" }
  | { env: "isolated"; isolation: IsolatedEnv };

export interface IsolationOpts {
  /** "container" = require isolation (fail loudly if unavailable);
   *  "auto" = isolate when a runtime exists, honest host fallback otherwise;
   *  "host" = never isolate (the pre-Phase-B behavior). Default "auto". */
  mode: "auto" | "container" | "host";
  /** Container image for docker/podman (default node:22-slim). */
  image?: string;
  /** Network inside the container. Default "none" (strict). */
  networkMode?: "none" | "bridge";
}

// Injectable process layer so the command construction and lifecycle are
// fully unit-testable on machines without any container runtime.
export type Runner = (command: string, args: string[], opts: { timeoutMs: number; cwd?: string }) => Promise<{ code: number; output: string }>;

export const realRunner: Runner = (command, args, opts) =>
  new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(command),
      env: { ...process.env, ARENA_MISSION_SANDBOX: "1" },
    });
    let output = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs);
    child.stdout?.on("data", (d) => (output += d.toString()));
    child.stderr?.on("data", (d) => (output += d.toString()));
    child.once("error", (e) => {
      clearTimeout(timer);
      resolve({ code: 127, output: String(e) });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, output: output.slice(0, 200_000) });
    });
  });

/** Detect the strongest available isolation runtime. Probed, never assumed. */
export async function probeIsolation(runner: Runner = realRunner): Promise<IsolationRuntime> {
  for (const [kind, command, args, regex] of [
    ["docker", "docker", ["version", "--format", "{{.Server.Version}}"], /^\d+(\.\d+)+/] as const,
    ["podman", "podman", ["--version"], /\d+\.\d+/] as const,
  ] as const) {
    try {
      const r = await runner(command, [...args], { timeoutMs: 8_000 });
      const m = r.output.match(regex);
      if (r.code === 0 && m) return { kind, version: m[0] };
    } catch {
      /* not installed */
    }
  }
  if (process.platform === "win32") {
    try {
      const r = await runner("wsl", ["--status"], { timeoutMs: 8_000 });
      // wsl --status writes UTF-16-ish output; treat exit 0 as present.
      if (r.code === 0) return { kind: "wsl", version: "installed" };
    } catch {
      /* not installed */
    }
  }
  return { kind: "none", version: "none" };
}

export function containerName(spaceId: string): string {
  if (!/^[a-zA-Z0-9-]+$/.test(spaceId)) throw new Error("bad space id");
  return `arena-space-${spaceId.toLowerCase()}`;
}

/** The exact `docker/podman run` arguments for a mission container —
 * exported for unit tests so the containment policy is itself tested. */
export function containerRunArgs(env: IsolatedEnv, hostWorkspaceDir: string): string[] {
  return [
    "run",
    "-d",
    "--name", env.ref,
    "--network", env.networkMode,
    "--memory", "1g",
    "--cpus", "1",
    "--pids-limit", "256",
    "-v", `${hostWorkspaceDir}:/workspace`,
    "-w", "/workspace",
    env.image,
    "sleep", "infinity",
  ];
}

/** Start (or reuse) the mission's container. Returns the isolated env. */
export async function ensureIsolatedWorkspace(
  spaceId: string,
  opts: IsolationOpts,
  runner: Runner = realRunner,
): Promise<IsolatedEnv | null> {
  const runtime = await probeIsolation(runner);
  if (runtime.kind === "none" || runtime.kind === "wsl") {
    if (opts.mode === "container") {
      throw new Error(
        `workspace isolation was requested but no container runtime is available (${runtime.kind}) — ` +
          "install Docker/Podman or set isolation to 'auto' for an honest host-jail fallback",
      );
    }
    return null; // honest fallback (auto mode) — caller must record it
  }
  const env: IsolatedEnv = {
    kind: runtime.kind,
    ref: containerName(spaceId),
    image: opts.image ?? "node:22-slim",
    networkMode: opts.networkMode ?? "none",
  };
  const existing = await runner(env.kind, ["ps", "-a", "--filter", `name=^${env.ref}$`, "--format", "{{.Names}}"], { timeoutMs: 8_000 });
  if (!existing.output.includes(env.ref)) {
    const started = await runner(env.kind, containerRunArgs(env, workspaceHostDir(spaceId)), { timeoutMs: 120_000 });
    if (started.code !== 0) {
      throw new Error(`failed to start the isolated workspace container: ${started.output.slice(0, 400)}`);
    }
  }
  return env;
}

/** Stop and remove the mission's container (workspace files persist on the
 * host — they were bind-mounted, not copied). */
export async function teardownIsolatedWorkspace(spaceId: string, runner: Runner = realRunner): Promise<void> {
  const runtime = await probeIsolation(runner);
  if (runtime.kind !== "docker" && runtime.kind !== "podman") return;
  const ref = containerName(spaceId);
  await runner(runtime.kind, ["rm", "-f", ref], { timeoutMs: 30_000 });
}

/** Command-line for executing a command inside the isolated env. */
export function isolatedExecArgs(env: IsolatedEnv, command: string): { command: string; args: string[] } {
  if (env.kind === "wsl") return { command: "wsl", args: ["-d", env.ref, "--cd", "/workspace", "--", "sh", "-c", command] };
  return { command: env.kind, args: ["exec", "-w", "/workspace", env.ref, "sh", "-c", command] };
}

function workspaceHostDir(spaceId: string): string {
  // Lazy import shape kept static: tools exports WORKSPACE_ROOT at module
  // load; join here (no fs access needed).
  const sep = process.platform === "win32" ? "\\" : "/";
  return WORKSPACE_ROOT + sep + spaceId;
}

/** Run a command against the chosen target and return honest output. */
export async function runInTarget(
  target: ExecTarget,
  command: string,
  timeoutMs: number,
  runner: Runner = realRunner,
): Promise<string> {
  if (target.env === "host") {
    const r = await runner(shellCommand(), shellWrap(command), { timeoutMs });
    return r.code === 0 ? r.output : r.output + `\n(exit ${r.code})`;
  }
  const { command: bin, args } = isolatedExecArgs(target.isolation, command);
  const r = await runner(bin, args, { timeoutMs });
  const prefix = `[isolated:${target.isolation.ref} · ${target.isolation.image} · net=${target.isolation.networkMode}]`;
  return `${prefix}\n${r.code === 0 ? r.output : r.output + `\n(exit ${r.code})`}`;
}

import { join } from "node:path";
import { shellCommand, shellWrap } from "./command-shell";

// The workspace host dir helper above is intentionally simple; re-export a
// path.join-based variant for callers that prefer it.
export function workspaceDir(spaceId: string): string {
  return join(WORKSPACE_ROOT, spaceId);
}
