# CI and Release Gate

The repository-level release workflow is [`.github/workflows/compose-release.yml`](../.github/workflows/compose-release.yml).

## Jobs

### Static validation

A clean Ubuntu runner uses Node 22 and the committed lockfile:

```bash
npm ci
npm run typecheck
npm run lint
npm test
npm run build
```

### Real Compose release gate

A second clean Ubuntu runner uses the same committed lockfile, then runs:

```bash
npm ci
npm run test:compose
```

`test:compose` is the authoritative integration gate. It builds the Compose web, worker, migration, and profile-gated Playwright images from the checkout; waits for the real web health endpoint; and runs the E2E container against PostgreSQL, Redis/BullMQ, MinIO, FFmpeg/FFprobe, and the CPU Demucs worker.

The E2E image is rebuilt at the point it is run. This is required because the service is Compose-profile-gated and would otherwise be able to use an older cached image.

The CI job keeps Compose resources temporarily so it can collect logs when a failure occurs. It uploads Compose service logs, the E2E container log, and Playwright report/test-result directories when available, then removes the one-off E2E container and tears down services and volumes in an `always` cleanup step.

## Evidence boundary

The current Compose release gate discovers a seven-test real-stack suite, including:

- authenticated project creation and original upload;
- FFprobe validation, durable source/job records, real CPU Demucs separation, persisted stems, waveform/media access, browser playback, remix persistence, and completion lifecycle assertions;
- waveform retry/recovery after injected storage-boundary failures and a worker restart, including duplicate-artifact and cleanup assertions;
- worker-owned persisted RemixVersion WAV export, private export retrieval, terminal render failure without an asset, same-job manual retry, and successful re-render;
- collaborator/private-media authorization;
- corrupt-audio rejection and a terminal Demucs failure with no generated stems;
- durable publication, public discovery, application-proxied selected-export range delivery, report deduplication, and moderator hide/restore/remove lifecycle.

At `232fe8ae23b1f6705a60e148b59c1e6778243b66`, a Docker-capable host ran the then-five-test `npm run test:compose` suite successfully: `5 passed (3.3m)`. Phase 4 expands that suite to seven tests and requires a new full Compose run before its runtime status is claimed. This is local Compose evidence, not a GitHub Actions result: Actions runner allocation is presently blocked by an external billing limitation.

A green workflow, when one is available, is evidence for that local Compose topology and its asserted CPU processing path. It is **not** a production-readiness claim. It does not by itself verify production credentials/networking/backups/monitoring, cloud-object-store behavior outside MinIO, long-duration load behavior, or CUDA/GPU execution. CUDA remains a separate check on NVIDIA-capable infrastructure.
