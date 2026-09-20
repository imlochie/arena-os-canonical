# Arena

> **Rebuild status: Phase 0 — reconnaissance and canonical architecture complete.**
>
> This repository currently contains the prior **ArenaForge Personal** implementation. It is being preserved as product and technical evidence while Arena is rebuilt as a private, local-first environment for human-directed, multi-agent work. The existing app is **not** yet the canonical architecture described in [REBUILD.md](./REBUILD.md).

Arena's guiding loop is:

```text
THINK → CHALLENGE → COMPARE → SYNTHESIZE → CREATE → REVIEW → ACT → REMEMBER
```

The human directs the work; agents contribute visible, attributable work. The canonical product will persist projects, artifacts, decisions, memory, and provenance without presenting simulations as real features.

## What is in this checkout today

The preserved implementation is a Next.js 16 / React 19 / PostgreSQL application with working proof-of-concept flows for:

- direct chat with persisted transcripts;
- blind two-model battles, voting, Elo/Bradley–Terry statistics, and partial SSE streaming;
- multi-agent collaboration and Council-style synthesis;
- project-scoped artifacts and simple project memory;
- custom assistant personas and prompt templates;
- a browser WebLLM experiment for the Arcade Forge; and
- a metadata-only privacy event log plus export/wipe endpoints.

These are valuable experiments, not a claim that the current app satisfies the canonical specification. There is no authentication, no server-side authorization, no worker, no durable provider registry, no file subsystem, no user-scoped privacy model, and no test suite. See [REBUILD.md](./REBUILD.md) for the audited classification and [SECURITY.md](./SECURITY.md) before exposing the current implementation to untrusted users.

## Canonical direction

The rebuild is designed around:

- project-owned work and explicit collaboration permissions;
- configurable agents and capability-aware model providers;
- structured responses, rounds, challenges, Council synthesis, and source provenance;
- inspectable memory with explicit scope and deletion;
- local/cloud routing that is visible to the user;
- a separately run worker for cancellable, retryable work; and
- real exports, deletion, and privacy auditing.

The intended target architecture, data model, boundaries, and vertical-slice order are in [ARCHITECTURE.md](./ARCHITECTURE.md). The plan for carrying forward prior data and product lessons is in [MIGRATION.md](./MIGRATION.md).

## Current local development (legacy application)

### Prerequisites

- Node.js 22 or later
- npm 10 or later
- PostgreSQL 16 or later

### Setup

```bash
npm ci
cp .env.example .env.local
# Set DATABASE_URL in .env.local to a local PostgreSQL database.
npm run dev
```

The current database schema was previously used with Drizzle's schema push workflow and includes only one checked-in SQL migration. It does **not** yet provide a reliable fresh-install migration chain. Do not use the current database setup for production data; the canonical migration baseline is a Phase 1 deliverable.

### Verification

```bash
npm run typecheck
npm run lint
npm run build
```

Reconnaissance results on 2026-09-20:

- `npm run typecheck` passes.
- `npm run lint` currently fails with 20 existing lint errors and 2 warnings.
- `npm run build` compiles but cannot collect route data without `DATABASE_URL`; it should be made configuration-safe during the foundation slice.
- `npm audit --omit=dev` reported 1 critical and 2 high production dependency advisories at this snapshot. Dependency remediation is a foundation task, not something to ignore.

## Documentation

| Document | Purpose |
| --- | --- |
| [REBUILD.md](./REBUILD.md) | Phase 0 evidence inventory, classification, retained lessons, and sequence |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Canonical system boundaries, data model, events, and invariants |
| [MIGRATION.md](./MIGRATION.md) | Legacy data and behavior mapping, export-first migration process |
| [DEVELOPMENT.md](./DEVELOPMENT.md) | Development commands, configuration, and current limitations |
| [DEPLOYMENT.md](./DEPLOYMENT.md) | Target self-hosting topology and current non-production status |
| [PRIVACY.md](./PRIVACY.md) | Data handling truth table and canonical privacy requirements |
| [SECURITY.md](./SECURITY.md) | Security posture, disclosure process, and release blockers |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | Contribution workflow and quality gates |

## License

A license has **not** been selected in this checkout. This is deliberately recorded as an `INVESTIGATE` item rather than silently choosing legal terms. Do not assume permission to redistribute or deploy the repository publicly until an explicit `LICENSE` is added by the project owner.
