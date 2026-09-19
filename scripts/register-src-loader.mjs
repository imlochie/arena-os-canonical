/**
 * ESM hook registration for running TypeScript sources directly with Node's
 * native type-stripping: resolves the repo's `@/` path alias and
 * extensionless relative imports without a bundler. Used by `npm test` and
 * by the Archive Assistant smoke script (scripts/archive-context-smoke.ts).
 * Never used by the app itself.
 *
 * Also guarantees DATABASE_URL exists so importing db-touching modules
 * doesn't throw at module load: pg.Pool does not connect until first query.
 */

import { register } from "node:module";

process.env.DATABASE_URL ??= "postgres://arena-test:arena-test@127.0.0.1:1/arena-test-no-connect";

register("./src-loader-hooks.mjs", import.meta.url);
