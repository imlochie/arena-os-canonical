# Phase 4 — Publication & Discovery Report

**Status: VERIFIED**
**Verified commit:** `a1c8e37c3623a72dc6b9a5aee2bd10eabfe76cb5`

## Runtime gate

```bash
npm run test:compose
```

```text
7 passed (3.1m)
```

A Docker-capable host ran the full real Compose topology and tore it down cleanly after success. The topology included PostgreSQL, Redis/BullMQ, MinIO, migrations, the web application, the CPU Demucs/FFmpeg worker, and the profile-gated Playwright E2E container.

## Durable publication model

Phase 4 reuses the canonical project state:

```text
private | unlisted | public
draft | published
active | reported | hidden | removed
```

It adds a persisted `moderator` platform role, a nullable selected `published_export_asset_id`, and append-only `project_audit_events`. Existing projects remain private after migration; no historical project receives an implied publication, rights acknowledgement, or published export asset.

A published export asset must be a completed worker-generated `ExportAsset` belonging to the same project. This makes exactly one final render public by deliberate selection; source media, stems, RemixVersion snapshots, jobs, and non-selected exports remain private.

## Authorization and rights acknowledgement

Project editors and owners configure publication. Viewers can inspect private publication state but cannot mutate it. Publishing to unlisted or public requires a server-controlled rights-acknowledgement statement/version, a non-empty license, an active moderation state, and an explicit completed published export asset. State mutation and its audit entries are transactional.

Authenticated users can submit one bounded report per publicly readable project. Only a durable `moderator` can hide, restore, or remove public access, each with a required audit reason.

## Public discovery and media boundary

Public discovery contains only public, published, active/reported projects, with cursor pagination and basic title/creator/tag search plus genre filtering. Unlisted projects are directly addressable but excluded from discovery. Hidden and removed projects have no public page, discovery entry, or public release response.

The public release endpoint application-proxies only the selected final WAV with range support. It does not redirect to S3/MinIO, issue a public signed-object URL, or expose storage keys, bucket/object details, private asset identifiers, members, processing/export jobs, remix snapshots, or audit identities/reasons. Existing private media routes remain membership-protected.

## Verified runtime acceptance coverage

The seven real-stack scenarios verified:

1. real upload, CPU Demucs separation, persistence, and playback;
2. waveform recovery after injected storage faults and worker restart;
3. persisted RemixVersion export, failure, retry, privacy, and idempotency;
4. project/private-media and collaborator isolation;
5. corrupt-audio rejection and terminal real-Demucs failure without stems;
6. explicit publication, safe public release/discovery behavior, and private-data boundaries; and
7. reporting plus moderator hide, restore, and remove lifecycle with durable audit history.

## Remaining boundaries

This is **verified local Docker Compose evidence**, not GitHub Actions CI verification. GitHub runner allocation remains blocked by an external billing limitation; that is a verification gap, not a repository defect.

CUDA/GPU execution, production cloud-storage behavior, production credentials/networking, backups, monitoring, long-duration/load behavior, incident operations, and production moderation operations remain outside this gate. Phase 4 intentionally excludes social feeds, likes, follows, comments, recommendations, collaboration, public remix editing, video, advanced mastering/plugins, BPM/beat grids, and a second storage/queue/authorization/media system.
