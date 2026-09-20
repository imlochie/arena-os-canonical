# Development Guide

## Status

This repository preserves the legacy ArenaForge Personal implementation while the canonical rebuild is still in progress. A real, Docker-oriented **Stem Lab vertical slice** now exists inside that application; it is the only implemented durable worker/storage/auth path and must not be generalized into claims about every legacy Arena feature.

## Requirements

- Node.js 22+
- npm 10+
- PostgreSQL 16+
- A POSIX-compatible shell for the commands below

Future canonical local-provider testing will additionally require an Ollama-compatible endpoint or another explicitly configured OpenAI-compatible local model server.

## Install and configure

```bash
npm ci
cp .env.example .env.local
```

Set `DATABASE_URL` in `.env.local`:

```dotenv
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/arena
```

`SEAL_SECRET` is required if the legacy ephemeral battle reveal mechanism is used. Use a long random value rather than its legacy development fallback.

Do not commit `.env`, `.env.local`, provider credentials, database dumps, exports containing user data, or generated WebLLM model caches.

## Current commands

```bash
npm run dev        # Next development server
npm run typecheck  # TypeScript check
npm run lint       # ESLint
npm run build      # production compilation
npm run start          # serve compiled application
npm run db:migrate     # apply checked-in SQL migrations
npm run worker         # run the real Demucs/BullMQ worker (requires Python, Demucs, FFmpeg)
npm run worker:doctor  # check worker dependencies, DB, Redis, and storage
npm run test:compose   # build the real Docker stack and execute browser E2E
```

The dev server uses Next defaults. For an Arena preview it must be started with a host that accepts the preview environment, e.g. `next dev --hostname 0.0.0.0`; browser code must use relative API URLs.

## Database reality today

`npm run db:migrate` now applies a minimal project baseline plus the Stem Lab user/session/membership/source/job/stem tables. That migration path is sufficient for the Stem Lab Compose vertical slice. It does **not** yet reconstruct every legacy ArenaForge table defined in `src/db/schema.ts`; the broader canonical migration baseline remains unfinished.

Until that broader baseline is complete:

- use an isolated non-production database for legacy endpoints;
- do not apply schema changes manually to shared data;
- claim migration reproducibility only for the Stem Lab slice; and
- do not rely on legacy endpoints for multi-user or sensitive work.

## Quality baseline observed in reconnaissance

After `npm ci` on 2026-09-20:

| Check | Status | Notes |
| --- | --- | --- |
| `npm run typecheck` | pass | Existing snapshot type-checks. |
| `npm run lint` | fail | 20 errors (notably `next/link` and React effect patterns) and 2 image warnings. |
| `npm run build` | pass with `DATABASE_URL` set | Production compilation succeeds; the legacy app still requires a database URL at module load. |
| `npx playwright test --list` | pass | Lists the three real Compose acceptance tests. |
| `npm run test:compose` | blocked here | Fails explicitly when Docker is unavailable; it has not been counted as a real-stack pass in this sandbox. |

No PR should treat a pass from mocked text generation alone as AI integration verification. Canonical tests will label provider paths as `MOCK`, `LOCAL`, or `REAL_PROVIDER`.

## Real Stem Lab Compose workflow

On a Docker-capable machine, the full Stem Lab proof starts and cleans up its own real services:

```bash
npm ci
npm run test:compose
```

For inspection after a failure, preserve the stack with `ARENA_KEEP_COMPOSE=1 npm run test:compose`, then use `docker compose logs web worker` and finish with `docker compose down --volumes`. The Compose file supplies PostgreSQL, Redis, MinIO, migrations, web, CPU Demucs worker, and Playwright; it is not evidence of success until the acceptance command passes.

## Implementation rules

1. Read [REBUILD.md](./REBUILD.md) before replacing a legacy capability.
2. Add a migration for every persisted schema change; update import fixtures when schema affects migration.
3. Add input validation at the API boundary and authorization in the server/repository layer.
4. Give every long-running operation a job state, cancellation policy, and idempotency key.
5. Keep local/cloud execution mode visible and test that local-only prevents egress.
6. Never add seeded demo content to ordinary production reads; demo data must be explicit and removable.
7. Run typecheck, lint, relevant tests, and build before requesting review.
8. Document incomplete capabilities as unavailable rather than simulating completion.

## Suggested foundation order

1. Create the canonical database/auth package and an empty-database migration test.
2. Implement authenticated project ownership and a server-side authorization helper.
3. Add a provider registry plus one OpenAI-compatible local adapter and one cloud adapter.
4. Add durable response/job records and a worker execution path.
5. Deliver one project conversation end-to-end with visible provenance and cancellation.

This keeps the first code changes reversible and validates the architectural invariants before rebuilding visual surfaces.
