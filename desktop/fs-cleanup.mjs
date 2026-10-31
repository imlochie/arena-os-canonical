import { rm } from "node:fs/promises";

const TRANSIENT_CODES = new Set(["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retry Windows directory removal while antivirus or indexing handles clear.
 * Call only after the process that owns files in the directory has stopped.
 */
export async function removeDirWithRetry(
  target,
  { attempts = 10, delayMs = 250, rmImpl = rm, sleepImpl = sleep } = {},
) {
  if (!Number.isSafeInteger(attempts) || attempts < 1) {
    throw new Error("Directory cleanup attempts must be a positive integer.");
  }
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    throw new Error("Directory cleanup delay must be a non-negative number.");
  }

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await rmImpl(target, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      const code = error?.code;
      if (!TRANSIENT_CODES.has(code)) throw error;
      if (attempt < attempts) await sleepImpl(delayMs * attempt);
    }
  }
  throw lastError;
}
