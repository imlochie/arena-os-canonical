/**
 * Test support — retry-safe embedded-PostgreSQL readiness (P5 harness fix).
 *
 * The original inline loop in service.test.ts created ONE pg Client and
 * retried `client.connect()` on it. node-postgres NEVER allows reusing a
 * client after a failed connection attempt — the second attempt throws
 * "Client has already been connected. You cannot reuse a client." — so a
 * single lost race against postgres startup (observed on the Windows
 * acceptance run of 9431870) poisoned the client and collapsed every
 * integration test in the file.
 *
 * This helper mirrors the PRODUCTION readiness loop
 * (desktop/runtime/embedded-postgres.ts waitForReadiness): a FRESH client
 * per attempt, the failed client is ended best-effort, attempts are bounded
 * by a deadline, and diagnostics carry the last real error.
 */

/** Structural slice of pg.Client the readiness probe needs (testable
 * without a database — fakes satisfy this shape). pg's real Client
 * overloads connect()/end() (promise and callback forms), so the slice
 * accepts every overload shape. */
export interface PgReadinessClient {
  connect(...args: never[]): Promise<unknown> | void;
  end(...args: never[]): Promise<unknown> | void;
}

export interface PgReadinessOptions<TClient extends PgReadinessClient> {
  /** MUST build a fresh client each call — a failed pg Client cannot be
   * reused. The regression tests enforce this contract. */
  createClient: () => TClient;
  /** Runs on the CONNECTED client (e.g. `create database`). A failure here
   * propagates immediately — it is a setup error, not unreadiness, exactly
   * like the original harness. The client is always ended afterwards. */
  useConnectedClient: (client: TClient) => Promise<void>;
  /** Total deadline in milliseconds (default 30_000 — the original value). */
  timeoutMs?: number;
  /** Delay between attempts in milliseconds (default 150 — the original). */
  intervalMs?: number;
  /** Diagnostics label (default "embedded postgres" — keeps the original
   * error message text). */
  label?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_INTERVAL_MS = 150;

/** Best-effort cleanup: end() on a failed/never-connected client may itself
 * reject depending on where the connection broke — never let cleanup mask
 * the real readiness error. */
async function endQuietly(client: PgReadinessClient): Promise<void> {
  try {
    await client.end();
  } catch {
    // The socket is already gone; nothing to release.
  }
}

/**
 * Wait until a fresh client can connect, then run `useConnectedClient` on
 * it and end it. Throws when the deadline is exhausted, with the last real
 * connection error in the message (original diagnostics preserved).
 */
export async function waitForPostgresReady<TClient extends PgReadinessClient>(
  options: PgReadinessOptions<TClient>,
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const label = options.label ?? "embedded postgres";
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    // A pg Client that failed to connect is unusable forever — every
    // attempt builds a fresh one. This is the fix for the Windows
    // acceptance failure on 9431870.
    const client = options.createClient();
    try {
      await client.connect();
    } catch (error) {
      lastError = error;
      await endQuietly(client);
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      continue;
    }
    // Connected: use it, then ALWAYS end it — including on use failure.
    try {
      await options.useConnectedClient(client);
    } finally {
      await endQuietly(client);
    }
    return;
  }
  throw new Error(`${label} never became ready: ${String(lastError)}`);
}
