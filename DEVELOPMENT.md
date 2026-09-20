# Development Guide

## Status

This repository is in a Phase 0 rebuild-planning state. The checked-in application is the preserved legacy ArenaForge Personal implementation; canonical infrastructure described in [ARCHITECTURE.md](./ARCHITECTURE.md) has not been implemented yet.

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
npm run start      # serve compiled application
```

The dev server uses Next defaults. For an Arena preview it must be started with a host that accepts the preview environment, e.g. `next dev --hostname 0.0.0.0`; browser code must use relative API URLs.

## Database reality today

The application uses Drizzle ORM and PostgreSQL, but the repository has only `drizzle/0008_cognitive_sessions.sql` checked in while the code defines many more tables. A fresh database cannot be reliably initialized from checked-in migrations alone. The currently configured `drizzle.config.json` also contains a local default connection string.

Until the canonical database package and baseline migration are complete:

- use an isolated non-production database only;
- do not apply schema changes manually to shared data;
- do not claim migration reproducibility; and
- do not rely on the legacy endpoints for multi-user or sensitive work.

## Quality baseline observed in reconnaissance

After `npm ci` on 2026-09-20:

| Check | Status | Notes |
| --- | --- | --- |
| `npm run typecheck` | pass | Existing snapshot type-checks. |
| `npm run lint` | fail | 20 errors (notably `next/link` and React effect patterns) and 2 image warnings. |
| `npm run build` | fail after compilation | Compilation and TS complete, then route collection fails because database setup throws when `DATABASE_URL` is absent. |
| automated tests | absent | No unit, integration, API, DB, authorization, provider, worker, privacy, or E2E suite exists. |

No PR should treat a pass from mocked text generation alone as AI integration verification. Canonical tests will label provider paths as `MOCK`, `LOCAL`, or `REAL_PROVIDER`.

## Canonical development workflow (target)

The following is the intended developer path once the foundation is implemented:

```bash
git clone <repository>
npm install
cp .env.example .env
docker compose up -d
npm run db:migrate
npm run dev
npm run worker
```

It is documented as a target, not a command sequence that works in the current snapshot. The foundation slice must make it real, including a Docker Compose stack, migrations, worker, and documented provider setup.

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
