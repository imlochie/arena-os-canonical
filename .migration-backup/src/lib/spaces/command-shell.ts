/**
 * Cross-platform shell invocation for mission command execution (host jail).
 *
 * Windows: npm/npx/py launchers are .cmd shims — spawn() needs a shell to
 * execute them (raw spawn dies with ENOENT). POSIX: no shell, unchanged.
 */

export function shellCommand(): string {
  return process.platform === "win32" ? "cmd" : "sh";
}

export function shellWrap(command: string): string[] {
  return process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command];
}
