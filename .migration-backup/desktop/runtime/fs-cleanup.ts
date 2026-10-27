/**
 * Retry-safe directory removal for Windows.
 *
 * On Windows, removing a directory that a process JUST released can still
 * fail transiently with EBUSY/EPERM/ENOTEMPTY: file handles are closed
 * asynchronously, and antivirus/indexers can hold handles for a moment.
 * This helper retries ONLY those transient codes, with backoff, and rethrows
 * anything else (or the last error after the final attempt) — it never
 * swallows a real failure and never masks a process that is still running.
 *
 * Callers must have already stopped the owning process (e.g. through
 * EmbeddedPostgres.stop, which waits for the cluster to be released);
 * retrying is for kernel-level handle lag, not for racing a live server.
 */

import { rm, type RmOptions } from "node:fs";

export type RmFunction = (path: string, options: RmOptions) => Promise<void>;

export interface RemoveDirWithRetryOptions {
  /** Total attempts (default 10 → up to ~9s with the default backoff). */
  attempts?: number;
  /** Base delay; grows linearly per attempt (default 250ms). */
  delayMs?: number;
  /** Injection seam for tests. */
  rmImpl?: RmFunction;
  /** Sleep seam for tests. */
  sleepImpl?: (ms: number) => Promise<void>;
}

const TRANSIENT_CODES = new Set(["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"]);

const defaultRm: RmFunction = (path, options) =>
  new Promise((resolve, reject) => {
    // node callback convention: success passes null (and some paths undefined).
    rm(path, options, (error) => (error == null ? resolve() : reject(error)));
  });

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function removeDirWithRetry(
  target: string,
  options: RemoveDirWithRetryOptions = {},
): Promise<void> {
  const attempts = options.attempts ?? 10;
  const delayMs = options.delayMs ?? 250;
  const rmImpl = options.rmImpl ?? defaultRm;
  const sleepImpl = options.sleepImpl ?? defaultSleep;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await rmImpl(target, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code === undefined || !TRANSIENT_CODES.has(code)) throw error;
      if (attempt < attempts) await sleepImpl(delayMs * attempt);
    }
  }
  throw lastError;
}
