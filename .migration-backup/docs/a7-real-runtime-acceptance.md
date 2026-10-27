# A7 real-runtime acceptance

The A7 retry/claim work is covered by fast PGlite tests with a `fakeQueue`
stand-in (`src/lib/waveyard/separation/retry.test.ts`). Those tests prove the
branch logic. They cannot prove the behaviour on the runtime it is for —
PostgreSQL's real query planner, real BullMQ records and a real worker.

This suite is that proof. It is deliberately **not** part of `npm test`: it
needs PostgreSQL and Redis, and the normal suite must stay service-light and
must keep exercising the desktop `LocalJobBroker` policy (which changes when
`REDIS_URL` is set).

- Suite: `tests/acceptance/a7-real-runtime.test.ts`
- Script: `npm run test:acceptance:a7`
- CI: the `a7-acceptance` job in `.github/workflows/ci.yml` (PostgreSQL 16 +
  Redis 7 services, schema pushed with `drizzle-kit push --force`).

## What it proves

| Scenario | Behaviour |
| --- | --- |
| A | A failed row with **no BullMQ record** (the original enqueue never reached Redis) is retried by a **fresh submission rebuilt from the row**: the real worker receives the payload, the row was claimed before the queue saw it, and a layer retry still carries `parentStemAssetId`. |
| B | Existing **finished** records (failed and completed) are retried **in place**: the same BullMQ record (creation time unchanged), one record, one new execution — no duplicate beside it. |
| C | Records BullMQ still holds — **waiting, delayed, active** — are not duplicated by a retry, and the row honestly reads `queued` while the executor owns the work, then follows the record to `complete`. |
| D | **Unreachable Redis** fails in bounded time: the hand-off's designed deadline fires, the row is restored to exactly its failed state, and the retry route answers **503** instead of hanging or claiming success. D2 deliberately waits out the real 15 s deadline. |
| E | A retry **raced against a fresh claim**: `processing_jobs_active_idempotency_unique` admits at most one active attempt per target, whichever side wins; the loser never hands work to an executor. E1 also proves the database itself refuses a second active attempt and frees the key once the attempt is terminal. |

## What it does **not** prove

- **Separation itself.** The worker in this suite records the payload and
  follows the row lifecycle; it does not fabricate stems. Real Demucs
  inference needs the owner-prepared engine (Demucs installed + the
  `5c90dfd2-34c22ccb.th` checkpoint in `WAVEYARD_MODELS_DIR`), which a CI
  runner does not have. The deep-stems route's honest 503 path is covered by
  the existing unit tests; real inference remains an owner-machine check.
- **Production security.** Green CI means the configured checks pass; the
  auth sweep is tracked separately (issue #12).

## Running it locally

1. PostgreSQL with the repo schema:

   ```bash
   export DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/app_db
   npx drizzle-kit push --force
   ```

2. A **dedicated** Redis. Use a separate port or database index — the suite
   adds real records to the app's real `waveyard-separation` queue. Never
   point it at a Redis that serves a live worker: the worker would consume
   the acceptance jobs.

   ```bash
   redis-server --port 56379 --save '' --appendonly no --daemonize yes
   ```

3. Run:

   ```bash
   A7_ACCEPTANCE=1 \
   DATABASE_URL="$DATABASE_URL" \
   A7_ACCEPTANCE_REDIS_URL=redis://127.0.0.1:56379/0 \
   npm run test:acceptance:a7
   ```

With `A7_ACCEPTANCE` unset the file registers one skipped test, so an
accidental invocation is harmless. With it set and `DATABASE_URL` or
`A7_ACCEPTANCE_REDIS_URL` missing (or a service down), the suite fails loudly
at startup — a CI job that lost Redis must not turn into a silent skip.

The suite sets `REDIS_URL` **inside its own process only** and clears
`ARENA_DESKTOP_MODE` / `WAVEYARD_LOCAL_WORKER` so it always exercises the
server (BullMQ) runtime. The parent environment and `npm test` are untouched.

## Safety rules the suite follows

- Only the BullMQ job ids it created are removed — never `FLUSHDB`,
  `obliterate`, `drain` or a queue-wide delete.
- Only the `wy_projects` rows it created are deleted; the cascade removes
  their sources and processing jobs. Unique run-scoped fixture ids.
- Workers, queues, pools and Redis clients are closed in `finally` blocks.

BullMQ leaves queue-level keys (`bull:waveyard-separation:events|id|meta`)
behind; they hold no job payloads and are shared with the queue by design, so
the suite does not delete them.
