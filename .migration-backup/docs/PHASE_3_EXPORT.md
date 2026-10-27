# Phase 3 — Studio Export

Phase 3 adds the first worker-owned persisted audio export path. It is intentionally a focused WAV mixdown capability, not a browser-authoritative renderer or a full production DAW.

## Domain and provenance

An export is immutable provenance over a persisted remix version:

```text
Project
→ RemixSession
→ RemixTrack / RemixClip
→ RemixVersion
→ ExportJob
→ ExportAsset
```

`export_jobs` records the request identity, project/session/version relationship, requester, requested WAV settings, durable lifecycle status/stage/attempts, idempotency key, timestamps, and safe error state. Its idempotency key permits one `wav/44100/2` output request for a remix version; a repeated request returns the same durable job rather than creating parallel output work.

`export_assets` is the successful result only. It records the exact `remix_version_id`, linked export job, private storage key, checksum, filename, duration, sample rate, channels, codec, format, size, and creation time. Storage keys are never returned through application APIs.

## Request and access boundaries

- `POST /api/remix-versions/:id/exports` requires project editor access and requests the persisted RemixVersion, never arbitrary browser arrangement JSON.
- `GET /api/exports/:id` requires project viewer access and reports durable job state plus safe asset metadata.
- `POST /api/exports/:id/retry` requires editor access and requeues the same durable job identity after failure.
- `GET /api/exports/:id/media` requires viewer access and uses the existing private-media delivery boundary: a short-lived signed object URL when storage supports it, or authenticated local streaming with range support.

The APIs do not reveal object-store credentials or storage keys. Collaborators retain only the project role they already hold; unauthorized users cannot inspect or retrieve export media.

## Worker render lifecycle

The existing BullMQ connection has a `waveyard-export` queue. Its worker:

1. claims the durable `ExportJob` and verifies queue payload/provenance identity;
2. reads the immutable RemixVersion snapshot and verifies every referenced stem belongs to the project;
3. downloads required private stems through `StorageProvider` into an isolated temporary directory;
4. resolves persisted clip offsets, durations, track mute/solo/volume/pan values, and master volume;
5. invokes FFmpeg to trim, delay, pan, gain, and mix real stem audio into a deterministic 44.1 kHz stereo WAV;
6. validates the rendered file with the existing FFprobe/non-zero-signal helper;
7. writes the result to private storage, then transactionally records `ExportAsset` and marks the job complete;
8. records a terminal failure without a false-success asset and deletes unreferenced uploaded output on a handled failure.

A completed job is idempotent. A retry always reuses the same `ExportJob`; the unique job-to-asset relationship prevents duplicate durable output assets.

## Runtime coverage

The Phase 3 Compose scenario is added to the existing real-stack suite. It exercises:

```text
persisted RemixVersion
→ authenticated export request
→ BullMQ export job
→ worker-owned real FFmpeg render
→ FFprobe validation and private object persistence
→ authorized range retrieval
```

It also exercises a terminal worker render fault without an asset, a retry of that same durable job, request idempotency, and collaborator/intruder authorization behavior.

**Status: VERIFIED.** On a Docker-capable host, `npm run test:compose` passed all five real-stack scenarios in 3.3 minutes at commit `232fe8ae23b1f6705a60e148b59c1e6778243b66`. The expanded suite includes the original four Compose acceptance paths plus the persisted RemixVersion → worker export → injected terminal render failure → same-job manual retry → successful re-render lifecycle. This is local Docker Compose evidence, not GitHub Actions CI evidence. GitHub Actions runner execution remains blocked by an external billing limitation and is not a Phase 3 repository defect. See [the Phase 3 report](PHASE_3_REPORT.md) for the evidence and remaining boundaries.

## Deliberately absent

Phase 3 does not add video, public delivery, browser-authoritative rendering, plugin processing, advanced mastering, GPU rendering, collaboration, or live DAW behavior. CUDA/GPU and production-cloud operational behavior remain separate verification concerns.
