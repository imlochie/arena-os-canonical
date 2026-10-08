/** Compiled-shell freshness contract (see scripts/lib/desktop-shell-freshness.mjs). */
export interface ShellFreshnessInput {
  sources: Array<{ file: string; mtimeMs: number }>;
  outputs: Array<{ file: string; mtimeMs: number }>;
}

export interface ShellFreshnessVerdict {
  ok: boolean;
  reason: string;
  staleSources: string[];
}

export declare function compareFreshness(input: ShellFreshnessInput): ShellFreshnessVerdict;
export declare function verifyDesktopShellFreshness(root: string): ShellFreshnessVerdict;
