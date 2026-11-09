import { setTimeout as delay } from "node:timers/promises";

const retryableStatus = status => status === 408 || status === 425 || status === 429 || status >= 500 && status <= 599;

/** Retry only transient transport failures. Callers still validate URLs and
 * must verify the complete pinned archive before using any downloaded bytes. */
export async function fetchWithTransientRetries(url, init = {}, {
  // Release/CDN gateways can return several consecutive 504s during regional
  // incidents. Keep retries bounded and retain the caller's original deadline;
  // every downloaded package is still checked against its exact byte count
  // and SHA-256 before use.
  attempts = 5,
  delayMs = 1_000,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 5 || !Number.isFinite(delayMs) || delayMs < 0) {
    throw new Error("Invalid bounded fetch retry policy.");
  }
  const signal = init.signal;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    signal?.throwIfAborted();
    let response;
    try {
      response = await fetchImpl(url, init);
    } catch (error) {
      if (signal?.aborted || !(error instanceof TypeError) || attempt === attempts) throw error;
      await delay(delayMs * attempt, undefined, signal ? { signal } : undefined);
      continue;
    }
    if (!retryableStatus(response.status) || attempt === attempts) return response;
    await response.body?.cancel().catch(() => {});
    await delay(delayMs * attempt, undefined, signal ? { signal } : undefined);
  }
  throw new Error("Pinned download retry loop ended unexpectedly.");
}
