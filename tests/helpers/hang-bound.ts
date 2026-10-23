/**
 * A bound for test-owned child processes: crash fixtures, cluster tooling and
 * scripts that the test spawns synchronously.
 *
 * These children do the same work a test does — load the TypeScript loader,
 * talk to PostgreSQL, run commands — so a fixed number here measures the
 * machine, not the product. Run 39905312322 killed a crash fixture at 60 s on a
 * runner that was otherwise healthy: the harness reported it correctly ("the
 * HARNESS killed it after its own timeout"), but the gate went red for a number
 * nobody had asserted.
 *
 * The suite declares its per-test bound once (`scripts/test-source.mjs`, ten
 * minutes in CI, exported as ARENA_TEST_TIMEOUT_MS). When that declaration is
 * present it is used here too; a developer run keeps the local bound.
 */
export function hangBound(localMs: number): number {
  const declared = Number(process.env.ARENA_TEST_TIMEOUT_MS);
  return Number.isFinite(declared) && declared > 0 ? Math.max(localMs, declared) : localMs;
}
