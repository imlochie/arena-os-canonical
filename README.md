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

These are valuable experiments, not a claim that the current app satisfies the canonical specification. The legacy application still has no general authentication, server-side authorization, durable provider registry, user-scoped privacy model, or broad test suite. Stem Lab is a deliberately bounded exception with its own private media account/session, worker, storage, and Compose E2E harness; it does not secure every legacy Arena route. See [REBUILD.md](./REBUILD.md) for the audited classification and [SECURITY.md](./SECURITY.md) before exposing the current implementation to untrusted users.

## Stem Lab vertical-slice harness

Stem Lab is an Arena module at `/stems`, linked from normal Arena navigation and project workspaces. It does not replace Arena and it does not create fake stems, fake progress, waveform data, or downloads.

An Arena-owned durable path is now implemented behind `STEM_PIPELINE_ENABLED=true`:

- a private Stem Lab account/session and project-role layer for this media subsystem;
- source inspection with `ffprobe`, sanitized filenames, checksums, and private object keys;
- PostgreSQL source/job/stem records, Redis/BullMQ job delivery, and MinIO/S3-compatible private objects;
- a separate CPU Demucs worker with isolated temporary directories, output/audio validation, cleanup, and retryable failures;
- authenticated project state and byte-range private stem delivery; and
- a real Compose/Playwright acceptance harness that registers, creates a project, uploads an original generated WAV, waits for Demucs, asserts four validated outputs, exercises browser playback, verifies access isolation, and covers corrupt-input/model-failure cases.

`docker-compose.yml` provides PostgreSQL, Redis, MinIO, web, worker, migration, and browser-test services. Run the actual proof only on a Docker-capable machine:

```bash
npm run test:compose
```

This sandbox has no Docker CLI, so the Compose stack, real Demucs output, MinIO persistence, and browser E2E path are **implemented but not verified here**. The test harness fails explicitly instead of treating that missing prerequisite as success. Do not build waveforms, a mixer, downloads, or remix features until this command passes in a Docker-capable environment and every real-stack failure is resolved.

For an operator-managed worker outside the durable pipeline, the compatibility adapter remains available through `STEM_WORKER_URL` (`GET /health`, `POST /v1/separations`). It does not make a durable Arena separation claim.

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
