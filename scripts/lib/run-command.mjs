/**
 * Cross-platform npm invocation.
 *
 * Windows: npm is `npm.cmd`, and Node (since the CVE-2024-27980 hardening
 * in 18.20/20.12+) REFUSES to spawn .cmd/.bat shims without a shell —
 * spawnSync returns a silent EINVAL result (status null, no output, nothing
 * printed). That is exactly how the first real Windows acceptance run died
 * at the typecheck gate, and how desktop:dist died right after its preflight
 * line: the child process never started and said nothing.
 *
 * POSIX keeps the plain binary with no shell (no quoting concerns).
 */

import { spawnSync } from "node:child_process";

export function npmCommand(args, platform = process.platform) {
  return platform === "win32"
    ? { command: "npm.cmd", args, options: { shell: true } }
    : { command: "npm", args, options: {} };
}

/**
 * Run npm synchronously. Callers MUST check `run.error` in addition to the
 * exit status so a spawn failure is never mistaken for a test failure —
 * or worse, silently ignored.
 */
export function runNpmSync(args, options = {}, platform = process.platform) {
  const { command, options: platformOptions } = npmCommand(args, platform);
  return spawnSync(command, args, { ...options, ...platformOptions });
}
