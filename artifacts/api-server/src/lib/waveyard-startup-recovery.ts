import { once } from "node:events";
import type { Server } from "node:http";

const TRANSIENT_DATABASE_CONNECTION_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
  "57P01",
  "57P02",
  "57P03",
]);

const TRANSIENT_CONNECTION_MESSAGE =
  /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN)\b|connection terminated unexpectedly|server closed the connection unexpectedly|could not connect to server|connection timeout|socket hang up/i;

export const WAVEYARD_RECOVERY_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000] as const;

export async function waitForServerListening(server: Server): Promise<void> {
  if (server.listening) return;
  await once(server, "listening");
}

export async function startApiServerAfterBestEffortRestoreUploadCleanup<T>(
  cleanup: () => Promise<string[]>,
  startServer: () => T,
  logging: {
    onCleanupComplete: (cleanedCount: number) => void;
    onCleanupFailure: (error: unknown) => void;
  },
): Promise<T> {
  try {
    const cleaned = await cleanup();
    if (cleaned.length > 0) logging.onCleanupComplete(cleaned.length);
  } catch (error) {
    logging.onCleanupFailure(error);
  }

  return startServer();
}

export function isTransientDatabaseConnectionFailure(error: unknown): boolean {
  const visited = new Set<object>();
  let current: unknown = error;

  for (let depth = 0; depth < 6; depth += 1) {
    if (typeof current === "string") return TRANSIENT_CONNECTION_MESSAGE.test(current);
    if (!current || typeof current !== "object" || visited.has(current)) return false;
    visited.add(current);

    const details = current as { code?: unknown; message?: unknown; cause?: unknown };
    const code = typeof details.code === "string" ? details.code.toUpperCase() : "";
    if (code.startsWith("08") || TRANSIENT_DATABASE_CONNECTION_CODES.has(code)) return true;

    const message = typeof details.message === "string" ? details.message : "";
    if (TRANSIENT_CONNECTION_MESSAGE.test(message)) return true;
    current = details.cause;
  }

  return false;
}

export async function runWaveyardStartupRecovery<T>(
  recover: () => Promise<T>,
  options: {
    retryDelaysMs?: readonly number[];
    sleep?: (milliseconds: number) => Promise<void>;
    onRetry?: (error: unknown, nextAttempt: number, delayMs: number) => void;
  } = {},
): Promise<T> {
  const retryDelays = options.retryDelaysMs ?? WAVEYARD_RECOVERY_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  let retries = 0;

  for (;;) {
    try {
      return await recover();
    } catch (error) {
      if (!isTransientDatabaseConnectionFailure(error) || retries >= retryDelays.length) throw error;

      const delayMs = retryDelays[retries]!;
      retries += 1;
      options.onRetry?.(error, retries + 1, delayMs);
      await sleep(delayMs);
    }
  }
}
