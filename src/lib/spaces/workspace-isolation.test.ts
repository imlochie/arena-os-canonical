/**
 * Phase B isolation tests (docs/spaces-autonomy.md) — real workspace
 * isolation for mission commands.
 *
 * The container lifecycle and command construction are tested against an
 * injected fake runner (no Docker needed); the honest-fallback and
 * strict-mode behaviors are tested against the REAL machine (which has no
 * container runtime in CI — that IS the fallback case).
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  containerName,
  containerRunArgs,
  ensureIsolatedWorkspace,
  probeIsolation,
  runInTarget,
  teardownIsolatedWorkspace,
  type IsolatedEnv,
  type Runner,
} from "./workspace-isolation";

function fakeRunner(responses: { match: (cmd: string, args: string[]) => boolean; code: number; output: string }[]): Runner & { calls: { cmd: string; args: string[] }[] } {
  const calls: { cmd: string; args: string[] }[] = [];
  const runner: Runner = async (cmd, args) => {
    calls.push({ cmd, args });
    for (const r of responses) {
      if (r.match(cmd, args)) return { code: r.code, output: r.output };
    }
    return { code: 0, output: "" };
  };
  return Object.assign(runner, { calls });
}

const ENV: IsolatedEnv = { kind: "docker", ref: "arena-space-t1", image: "node:22-slim", networkMode: "none" };

test("probe: docker is detected from the real version output", async () => {
  const runner = fakeRunner([
    { match: (c) => c === "docker", code: 0, output: "27.3.1" },
  ]);
  assert.deepEqual(await probeIsolation(runner), { kind: "docker", version: "27.3.1" });
});

test("probe: podman is the fallback runtime; none when nothing answers", async () => {
  const podman = fakeRunner([
    { match: (c) => c === "docker", code: 1, output: "command not found" },
    { match: (c) => c === "podman", code: 0, output: "podman version 5.2.3" },
  ]);
  assert.equal((await probeIsolation(podman)).kind, "podman");

  // "nothing answers" must include wsl — the win32 probe checks it and the
  // fake runner's default response is success, which would leak through.
  const empty = fakeRunner([
    { match: (c) => c === "docker", code: 127, output: "not found" },
    { match: (c) => c === "podman", code: 127, output: "not found" },
    { match: (c) => c === "wsl", code: 1, output: "not found" },
  ]);
  assert.equal((await probeIsolation(empty)).kind, "none");

  // A wsl-only machine: the probe honestly REPORTS wsl on win32 (detection,
  // not usability — see the ensure tests below) and cannot see it elsewhere.
  const wslOnly = fakeRunner([
    { match: (c) => c === "docker", code: 127, output: "" },
    { match: (c) => c === "podman", code: 127, output: "" },
    { match: (c) => c === "wsl", code: 0, output: "Default Version: 2" },
  ]);
  assert.equal((await probeIsolation(wslOnly)).kind, process.platform === "win32" ? "wsl" : "none");
});

test("containment policy: the container is network-isolated, resource-capped, workspace-mounted only", () => {
  const args = containerRunArgs(ENV, "/host/.data/space-workspaces/t1");
  assert.deepEqual(args, [
    "run", "-d",
    "--name", "arena-space-t1",
    "--network", "none",
    "--memory", "1g",
    "--cpus", "1",
    "--pids-limit", "256",
    "-v", "/host/.data/space-workspaces/t1:/workspace",
    "-w", "/workspace",
    "node:22-slim",
    "sleep", "infinity",
  ]);
  // bridge networking is opt-in, never default
  assert.equal(containerRunArgs({ ...ENV, networkMode: "bridge" }, "/x").includes("--network"), true);
});

test("lifecycle: an absent container is started; an existing one is reused (idempotent)", async () => {
  const runner = fakeRunner([
    { match: (c, a) => c === "docker" && a[0] === "version", code: 0, output: "27.3.1" },
    { match: (c, a) => c === "docker" && a[0] === "ps", code: 0, output: "" }, // not running
    { match: (c, a) => c === "docker" && a[0] === "run", code: 0, output: "abc123" },
  ]);
  const env = await ensureIsolatedWorkspace("t1", { mode: "auto" }, runner);
  assert.equal(env?.ref, "arena-space-t1");
  const runCall = runner.calls.find((c) => c.args[0] === "run");
  assert.ok(runCall, "the container was started");

  // Second ensure with the container already listed → no new run
  const runner2 = fakeRunner([
    { match: (c, a) => c === "docker" && a[0] === "version", code: 0, output: "27.3.1" },
    { match: (c, a) => c === "docker" && a[0] === "ps", code: 0, output: "arena-space-t1" },
  ]);
  const env2 = await ensureIsolatedWorkspace("t1", { mode: "auto" }, runner2);
  assert.equal(env2?.ref, "arena-space-t1");
  assert.equal(runner2.calls.filter((c) => c.args[0] === "run").length, 0, "existing container reused");
});

test("strict mode: requesting isolation without a runtime fails LOUDLY", async () => {
  const runner = fakeRunner([
    { match: (c) => c === "docker", code: 127, output: "not found" },
    { match: (c) => c === "podman", code: 127, output: "not found" },
    { match: (c) => c === "wsl", code: 1, output: "not found" },
  ]);
  await assert.rejects(
    () => ensureIsolatedWorkspace("t1", { mode: "container" }, runner),
    /no container runtime is available/,
  );
});

test("strict mode on a wsl-only machine: a bare WSL distro is NOT isolation — loud failure, never a pretense", async () => {
  const runner = fakeRunner([
    { match: (c) => c === "docker", code: 127, output: "" },
    { match: (c) => c === "podman", code: 127, output: "" },
    { match: (c) => c === "wsl", code: 0, output: "Default Version: 2" },
  ]);
  // The precise WSL explanation is only reachable on win32 (where the
  // wsl-only scenario is real); elsewhere the scenario cannot arise.
  await assert.rejects(
    () => ensureIsolatedWorkspace("t1", { mode: "container" }, runner),
    process.platform === "win32"
      ? /no container runtime is available.*bare WSL distro shares the host filesystem and network/
      : /no container runtime is available/,
  );
});

test("execution: isolated commands run via docker exec with the honest environment prefix; host commands do not", async () => {
  const runner = fakeRunner([
    { match: (c) => c === "docker", code: 0, output: "hello from the container" },
  ]);
  const isolatedOut = await runInTarget({ env: "isolated", isolation: ENV }, "node hello.js", 20_000, runner);
  assert.match(isolatedOut, /\[isolated:arena-space-t1 · node:22-slim · net=none\]/);
  assert.match(isolatedOut, /hello from the container/);
  assert.deepEqual(runner.calls[0].args, ["exec", "-w", "/workspace", "arena-space-t1", "sh", "-c", "node hello.js"]);

  const hostOut = await runInTarget({ env: "host" }, "echo hi", 20_000, runner);
  assert.ok(!hostOut.includes("[isolated:"), "host execution carries no isolation prefix");
});

test("execution: a failing isolated command reports its exit code honestly", async () => {
  const runner = fakeRunner([
    { match: (c) => c === "docker", code: 3, output: "boom" },
  ]);
  const out = await runInTarget({ env: "isolated", isolation: ENV }, "bad-command", 20_000, runner);
  assert.match(out, /boom/);
  assert.match(out, /\(exit 3\)/);
});

test("this machine: auto mode is honest about what isolation it can actually provide", async () => {
  const probe = await probeIsolation();
  const env = await ensureIsolatedWorkspace("t-probe", { mode: "auto" });
  if (probe.kind === "docker" || probe.kind === "podman") {
    // A machine with a real container runtime: auto mode isolates for real.
    assert.equal(env?.kind, probe.kind);
    await teardownIsolatedWorkspace("t-probe"); // remove the real container
  } else {
    // No container runtime (CI), or a wsl-only Windows machine: a bare WSL
    // distro shares the host filesystem and network, so treating it as
    // isolation would be a lie. The honest answer is the host jail.
    assert.equal(env, null, "auto mode honestly falls back to the host jail");
  }
});
