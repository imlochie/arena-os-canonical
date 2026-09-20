# Deployment Guide

## Current status: do not deploy the legacy application publicly

The preserved application is not ready for a public or multi-user deployment. The new Stem Lab slice has its own private account/session, membership, queue, worker, and private storage path, but the broader legacy Arena application still lacks equivalent authentication/authorization, complete migrations, rate limits, and dependency remediation. Treat the repository as local development/prototype software until the complete release gate is met.

## Canonical self-hosted topology (partially implemented for Stem Lab)

```text
reverse proxy / TLS
        │
        ├── Arena web application
        ├── Arena worker
        ├── PostgreSQL
        ├── Redis-compatible queue/event backend
        ├── S3-compatible object storage
        └── optional local inference runtime (Ollama/OpenAI-compatible)
```

Each service will be independently configurable and replaceable. The core application must not require a proprietary provider. Cloud model use is optional and configured per user/project policy.

## Target Docker Compose services

| Service | Responsibility | Required for minimum self-hosted deployment |
| --- | --- | ---: |
| `web` | authenticated UI, API, stream gateway | yes |
| `worker` | generation, Battles, Councils, extraction, exports, deletions | yes |
| `postgres` | relational metadata and state | yes |
| `redis` | jobs, cancellation signaling, real-time fan-out | yes |
| `minio` or equivalent | project file and export blobs | yes when files/exports enabled |
| `ollama` or external local endpoint | optional local inference | no, but required for local-first acceptance test |

`docker-compose.yml` now implements PostgreSQL, Redis, MinIO, migrations, web, a CPU Demucs worker, health checks, persistent named volumes, and an isolated Playwright profile for the Stem Lab acceptance slice. Its local credentials are deliberately development-only. It has **not** been executed in this Docker-less sandbox, and it does not make the rest of the legacy Arena application production-ready.

## Environment policy

- Secrets are supplied through deployment configuration or a secret manager, never client bundles or committed files.
- Credentials are scoped to the smallest required provider/storage permissions.
- Provider connections that belong to a user are encrypted at rest and unavailable to other users.
- Set secure cookie/TLS/origin configuration in production.
- Object storage buckets must not be public; download access is authorized and short-lived.
- Worker and web use a shared queue configuration but distinct runtime identities.

See `.env.example` for the current legacy variables and reserved canonical placeholders. Those placeholders do not yet constitute an implementation.

## Required production checks before release

1. Run all migrations against a copy of production data and verify rollback/restore documentation.
2. Verify the web app and worker health checks separately.
3. Verify a non-member cannot read any project, artifact, file, response, memory, activity event, or export.
4. Verify local-only work makes no cloud-provider/embedding/moderation request.
5. Verify job retries are idempotent and cancellation preserves completed content.
6. Verify export and deletion worker jobs complete and write privacy events.
7. Verify TLS, secure cookies, CSP/security headers, CSRF strategy, upload limits, and rate limits.
8. Pin/remediate production dependency vulnerabilities and produce an SBOM or equivalent dependency report.
9. Run a clean-install demo: question → 3 agents → Battle → challenge → Council → provenance-bearing artifact.

## Backup and recovery target

- Back up PostgreSQL with encrypted, tested restores.
- Version and back up object storage separately from database metadata.
- Keep queue/job state reconstructable from durable database records.
- Document retention and deletion interaction with backups; deletion completion must state any delayed backup expiry truthfully.
- Test restore into an isolated environment before claiming disaster recovery readiness.
