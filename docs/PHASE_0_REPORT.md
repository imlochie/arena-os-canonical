# Phase 0 Report — Foundation and Narrow Separation Slice

## IMPLEMENTED

- Retired the unrelated predecessor application from the runtime path after documented reconnaissance.
- Established the Waveyard npm workspace with separate web, worker, database, auth, storage, queue, audio, types, and separation-service boundaries.
- Added PostgreSQL schema/migration for users, opaque sessions, projects/memberships, source assets, separation jobs, and stem assets.
- Added registration/login/logout with bcrypt password hashing and hashed opaque HTTP-only sessions.
- Added server-side project membership checks to project, upload, job, and private asset routes.
- Added local and S3-compatible/MinIO storage providers with private UUID object keys.
- Added a real upload path: filename/type/size guard → temporary file → FFprobe metadata → checksum → private object storage → durable database job → BullMQ enqueue.
- Added a separate worker path: isolated temp directory → real `python -m demucs` adapter → model-produced expected source files → FFprobe/non-zero signal validation → storage → atomic stem/job finalization → cleanup.
- Added a private project workspace with no fabricated waveform. Once real stems exist, it exposes a simple synchronized real-audio play/pause, seek, per-stem mute, and volume baseline.
- Added Docker Compose definitions for PostgreSQL, Redis, MinIO, migration, web, and CPU Demucs worker, plus a worker doctor and non-mocked `prove:demucs` command.

## VERIFIED

- `npm run typecheck` passes.
- `npm test` passes (2 unit tests for upload filename guarding).
- `npm run lint` exits successfully. ESLint prints a non-fatal Next pages-directory configuration warning because the app uses only the App Router.
- `npm run build` exits successfully for web and worker. Next prints a non-fatal lockfile patch network warning in this sandbox and a trace warning from the filesystem-backed storage adapter; the build artifact is still produced.
- The Demucs proof command generated its original deterministic fixture, started the real Python adapter, and failed honestly because this environment has no PyTorch/Demucs installation.

## FAILED

- `STEM_DEVICE=cpu npm run prove:demucs` fails here with `PyTorch is not installed; cannot run Demucs.` This is the expected honest failure in the inspected host environment. No output stems were accepted or generated.

## NOT VERIFIED

- Docker Compose was not run: Docker is unavailable in this sandbox.
- PostgreSQL/Redis/MinIO integration has not been run because no services are available here.
- End-to-end registration, upload, queue claim, actual Demucs output, storage, and browser playback are not verified until Compose or equivalent infrastructure is running.
- CUDA is not verified; no NVIDIA/CUDA runtime is available.
- Waveform jobs, remix engine, export rendering, public sharing, discovery, collaboration, comments, moderation, notification, and account recovery/deletion are not implemented.
- No browser Playwright or integration test suite exists yet.

## KNOWN LIMITATIONS

- The worker uses the standard real Demucs `htdemucs` source set only: vocals, drums, bass, other. It intentionally does not label filtered/derived signals as instruments.
- The initial private player is a functional baseline, not the finished mixer: pan, solo, waveform cache, loop regions, playback-rate controls, downloads, and stem inspection UI remain future phases.
- The current account slice does not yet include password reset, email verification, rate limits, CSRF strategy, or account deletion. It is not production-release ready.
- The source upload retains a project if queue availability fails so the user can retry; a dedicated retry API/UI is still needed.
- Dependency audit currently reports production advisories inherited from the Next.js stack; these need remediation before any release.

## NEXT PHASE

**Phase 1 acceptance gate:** run the Compose stack, execute the real CPU Demucs proof, and add integration tests that prove user/project isolation, queue-to-worker job progression, source/stem storage, and private media playback. Do not begin waveform/mixer polish until this actual vertical slice passes.
