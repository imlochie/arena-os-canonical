/**
 * Test-only ESM hook registration: lets `node --test` run route handlers and
 * lib modules that use the repo's `@/` path alias (tsconfig paths) without a
 * bundler. Registered via `npm test` (package.json "test" script); never
 * used by the app itself.
 *
 * Also guarantees DATABASE_URL exists so importing db-touching modules in
 * tests doesn't throw at module load: pg.Pool does not connect until first
 * query, and tests never query.
 */

import { register } from "node:module";

process.env.DATABASE_URL ??= "postgres://arena-test:arena-test@127.0.0.1:1/arena-test-no-connect";

register("./test-alias-hooks.mjs", import.meta.url);
