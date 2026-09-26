# Phase 4 — Publication & Discovery

Phase 4 turns a completed private Waveyard project into a small, deliberate public release system. It adds no social graph, public stems, public remix editing, or browser-authoritative publication state.

## Public state

The canonical state remains on `projects`:

```text
visibility: private | unlisted | public
publication_status: draft | published
moderation_status: active | reported | hidden | removed
```

A private draft is private. A published unlisted project is directly addressable but absent from discovery. A published public project is directly addressable and discoverable. `hidden` and `removed` withdraw all public detail, discovery, and release-media access while preserving the private owner workspace and durable media records.

Publication reuses the existing license and download policy fields, and requires a selected completed worker-generated `ExportAsset`. `projects.published_export_asset_id` identifies that one deliberate release; no source, stem, remix snapshot, processing job, or non-selected export becomes public by implication.

## Rights and audit history

Publishing to `unlisted` or `public` requires an explicit acknowledgement of the server-controlled `waveyard-publication-rights-v1` statement, a non-empty license, an eligible `active` moderation state, and a completed export belonging to the same project.

`project_audit_events` is append-only and records actor, optional reason, normalized before/after metadata, and timestamp for:

```text
rights_acknowledged | published | visibility_changed | unpublished
report_submitted | hidden | restored | removed
```

Project editors can inspect the private audit history. Public responses never contain audit identities, report reasons, or audit records.

## Access boundaries

- Project editor/owner: configure publication.
- Project viewer: inspect current private publication state, but cannot configure it.
- Authenticated user: submit one bounded report per publicly readable project.
- Durable `users.platform_role = moderator`: review reported projects and hide, restore, or remove with a required reason.
- Public clients: access only eligible public/unlisted project representation and its selected final WAV.

The pre-existing `/api/assets/:id`, `/api/exports/:id`, and `/api/exports/:id/media` routes remain membership-protected. Their storage/signed-download behavior is unchanged.

## Public media delivery

The public release endpoint is application-proxied and range-aware. `StorageProvider.openReadStream()` is the shared server-side read capability used for local and S3-compatible backends. Public release delivery does not redirect to an object-store URL and does not return storage keys, bucket names, or S3/MinIO details.

Public WAV attachment download is available only when the existing project `download_permission` is `public`. Playback of the selected public release is still constrained by the project effective state.

## Routes and UI

Authenticated project controls:

```text
GET/PUT /api/projects/:id/publication
GET     /api/projects/:id/publication/audit
```

Public and moderation routes:

```text
GET  /api/public/projects
GET  /api/public/projects/:id
GET  /api/public/projects/:id/release
POST /api/public/projects/:id/reports
GET  /api/moderation/projects?status=reported
POST /api/moderation/projects/:id/actions
```

The private workspace has a publication panel. `/discover` is a cursor-paginated catalogue with basic title/creator/tag search and genre filtering. `/p/:id` is the public release page, with safe release metadata, Open Graph/Twitter metadata, streaming, optional download, reporting, and a copy-link action. `/moderation` is a minimal API-enforced moderator review surface.

## Runtime status

Phase 4 static validation is tracked with its implementation. The expanded Compose gate must be run on a Docker-capable host before Phase 4 is reported as runtime-verified. This is separate from the verified Phase 3 gate and from unavailable GitHub Actions runtime evidence.

## Deliberately absent

No likes, follows, comments, feeds, recommendations, public source/stem access, public remix editing, collaboration, video, plugins, mastering, BPM/beat grids, CUDA, or second queue/storage/authorization/media system are part of Phase 4.

## Moderator bootstrap

There is deliberately no public role-granting endpoint. An operator may set the optional comma-separated `WAVEYARD_INITIAL_MODERATOR_EMAILS` allowlist while registering initial staff accounts. A matching registration receives the durable `moderator` role; remove the setting after bootstrap. The Compose gate sets it only for its deterministic moderator account.
