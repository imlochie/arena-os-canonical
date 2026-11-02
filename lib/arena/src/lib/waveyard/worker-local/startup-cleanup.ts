export const STARTUP_CLEANUP_MAX_ATTEMPTS = 3;
export const STARTUP_CLEANUP_RETRY_DELAYS_MS = [1_000, 5_000] as const;

type RetryNotice = {
  name: string;
  attempt: number;
  nextAttempt: number;
  maxAttempts: number;
  delayMs: number;
  error: unknown;
};

type DeferredNotice = {
  name: string;
  attempts: number;
  maxAttempts: number;
  error: unknown;
};

export type StartupCleanupResult =
  | { status: "complete"; attempts: number }
  | { status: "deferred"; attempts: number; error: unknown };

export type StartupCleanupOptions = {
  maxAttempts?: number;
  retryDelaysMs?: readonly number[];
  isTransient?: (error: unknown) => boolean;
  sleep?: (delayMs: number) => Promise<void>;
  onRetry?: (notice: RetryNotice) => void;
  onDeferred?: (notice: DeferredNotice) => void;
};

const pendingCleanups = new Map<string, Promise<StartupCleanupResult>>();
const defaultSleep = (delayMs: number) => new Promise<void>(resolve => setTimeout(resolve, delayMs));

/** True only while one initial cleanup or its bounded retries are in flight. */
export function isStartupCleanupPending(name: string): boolean {
  return pendingCleanups.has(name);
}

/**
 * Try one idempotent startup cleanup, retry transient failures a bounded
 * number of times, and share concurrent attempts for the same cleanup name.
 */
export function runStartupCleanup(
  name: string,
  cleanup: () => Promise<unknown>,
  options: StartupCleanupOptions & { isTransient: (error: unknown) => boolean },
): Promise<StartupCleanupResult> {
  const existing = pendingCleanups.get(name);
  if (existing) return existing;

  const maxAttempts = options.maxAttempts ?? STARTUP_CLEANUP_MAX_ATTEMPTS;
  const retryDelaysMs = options.retryDelaysMs ?? STARTUP_CLEANUP_RETRY_DELAYS_MS;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 ||
    retryDelaysMs.length < maxAttempts - 1 ||
    retryDelaysMs.slice(0, maxAttempts - 1).some(delay => !Number.isSafeInteger(delay) || delay < 0)) {
    throw new Error("Startup cleanup retry settings must have a positive attempt limit and a delay for each retry.");
  }

  const task = (async (): Promise<StartupCleanupResult> => {
    const sleep = options.sleep ?? defaultSleep;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await cleanup();
        return { status: "complete", attempts: attempt };
      } catch (error) {
        if (attempt === maxAttempts || !options.isTransient(error)) {
          options.onDeferred?.({ name, attempts: attempt, maxAttempts, error });
          return { status: "deferred", attempts: attempt, error };
        }
        const delayMs = retryDelaysMs[attempt - 1]!;
        options.onRetry?.({
          name, attempt, nextAttempt: attempt + 1, maxAttempts, delayMs, error,
        });
        await sleep(delayMs);
      }
    }
    throw new Error("Unreachable startup cleanup retry state.");
  })();
  pendingCleanups.set(name, task);
  void task.then(
    () => { if (pendingCleanups.get(name) === task) pendingCleanups.delete(name); },
    () => { if (pendingCleanups.get(name) === task) pendingCleanups.delete(name); },
  );
  return task;
}
