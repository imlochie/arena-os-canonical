/**
 * Atomic file replacement that tolerates Windows sharing violations.
 *
 * `writeFile(temp)` + `rename(temp, target)` is the standard atomic-update
 * idiom, and its failure mode differs on Windows: `rename` is
 * `MoveFileEx(REPLACE_EXISTING)`, which fails with EPERM/EACCES/EBUSY while
 * any other handle holds the destination without FILE_SHARE_DELETE. A status
 * poller reading the file every 20 ms, an indexer, or Defender scanning a
 * freshly created temp file is enough.
 *
 * Observed on the Windows runner: `preparation.json.tmp -> preparation.json`
 * returned `EPERM: operation not permitted` while the test polled the status,
 * and the provisioning manager recorded a failed preparation for a write that
 * was perfectly valid.
 *
 * Only those three codes are retried, the attempts are few and bounded, and
 * the original error is rethrown when they are exhausted — a real permission
 * problem still fails, with its own code, a quarter of a second later. POSIX
 * is unaffected: the first attempt succeeds and no timer is created.
 */

import { rename as fsRename } from "node:fs/promises";

export type RenameFunction = (from: string, to: string) => Promise<void>;

export interface ReplaceFileOptions {
  /** Total attempts (default 6 → up to ~1.9 s with the default backoff). */
  attempts?: number;
  /** Base delay; grows linearly per attempt (default 25 ms). */
  delayMs?: number;
  /** Injection seams for deterministic tests. */
  renameImpl?: RenameFunction;
  sleepImpl?: (ms: number) => Promise<void>;
}

/** Codes Windows reports when the destination is momentarily open. */
const TRANSIENT_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function replaceFile(
  temp: string,
  target: string,
  options: ReplaceFileOptions = {},
): Promise<void> {
  const attempts = options.attempts ?? 6;
  const delayMs = options.delayMs ?? 25;
  const sleep = options.sleepImpl ?? defaultSleep;
  const rename: RenameFunction = options.renameImpl ?? fsRename;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await rename(temp, target);
      return;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code === undefined || !TRANSIENT_RENAME_CODES.has(code)) throw error;
      if (attempt < attempts) await sleep(delayMs * attempt);
    }
  }
  throw lastError;
}
