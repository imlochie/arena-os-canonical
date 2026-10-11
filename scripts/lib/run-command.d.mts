import type { SpawnSyncReturns } from "node:child_process";

/** Platform-aware npm command shape (Windows .cmd shims need a shell). */
export declare function npmCommand(
  args: string[],
  platform?: string,
): { command: string; args: string[]; options: { shell?: boolean } };

/** Run npm synchronously; check `.error` as well as `.status`. */
export declare function runNpmSync(
  args: string[],
  options?: Record<string, unknown>,
  platform?: string,
): SpawnSyncReturns<string | Buffer>;
