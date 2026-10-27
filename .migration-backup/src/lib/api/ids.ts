/**
 * Route-parameter UUID validation.
 *
 * Every id column in the waveyard schema is a Postgres `uuid`. Drizzle binds
 * path ids as text and Postgres casts them — a malformed value (`junk`,
 * `../etc`, overlong input) raises 22P02 `invalid input syntax for type uuid`
 * at query time, which surfaces as an uncaught 500. Guarding before the first
 * query turns that into a clean 400 and keeps junk away from the database.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}
