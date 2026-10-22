/**
 * Platform-correct "the process was actually killed" assertion.
 *
 * Why this exists: the crash-recovery fixtures terminate themselves with
 * `process.kill(process.pid, "SIGKILL")`. On POSIX the parent observes
 * `{ signal: "SIGKILL" }`. **Windows has no signals**: Node implements
 * `process.kill(pid, "SIGKILL")` as `TerminateProcess`, so the parent observes
 * `{ signal: null, status: <non-zero exit code> }` instead. Asserting
 * `signal === "SIGKILL"` therefore fails on Windows for a reason that has
 * nothing to do with the recovery behaviour under test — and did, in the first
 * Windows suite run (six crash-recovery tests).
 *
 * The intent is preserved on both platforms: the child must have died
 * ABRUPTLY, not exited with a deliberate status. The fixture's deliberate exits
 * use 73 (checkpoint boundary) and 74 (mission busy), so those are explicitly
 * rejected on Windows as well.
 */

export interface ExitedChild {
  signal: NodeJS.Signals | null;
  status: number | null;
  stderr?: string | Buffer | null;
}

/** Exit codes the crash fixture uses for deliberate, non-crash outcomes. */
const DELIBERATE_EXITS = new Set([0, 73, 74]);

export function actuallyKilled(child: ExitedChild, platform: string = process.platform): boolean {
  if (platform === "win32") {
    // No signal is reported; a forced termination is a non-zero status that is
    // not one of the fixture's deliberate exits.
    return child.signal === null && child.status !== null && !DELIBERATE_EXITS.has(child.status);
  }
  return child.signal === "SIGKILL";
}

/** Assertion message names the platform so a failure is never ambiguous. */
export function describeExit(child: ExitedChild, platform: string = process.platform): string {
  return `platform=${platform} signal=${String(child.signal)} status=${String(child.status)}`;
}

export function assertActuallyKilled(
  assert: { equal: (actual: unknown, expected: unknown, message?: string) => void; ok: (value: unknown, message?: string) => void },
  child: ExitedChild,
  context: string,
  platform: string = process.platform,
): void {
  if (platform === "win32") {
    assert.ok(
      actuallyKilled(child, platform),
      `${context}: runtime must actually be killed at the boundary (${describeExit(child, platform)})${child.stderr ? `: ${String(child.stderr)}` : ""}`,
    );
    return;
  }
  assert.equal(child.signal, "SIGKILL", `${context}: ${describeExit(child, platform)}${child.stderr ? `: ${String(child.stderr)}` : ""}`);
}
