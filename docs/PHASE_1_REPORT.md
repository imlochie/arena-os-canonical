# Phase 1 Report — Compose Proof Harness

## IMPLEMENTED

- Added a real `/api/health` gate that checks PostgreSQL, Redis, and the configured storage provider.
- Added Docker health gates for web and worker plus a Playwright test profile that starts only after those gates pass.
- Added `npm run test:compose`: it requires Docker, starts the Compose stack, waits for the real health endpoint, runs the browser suite from the Playwright image, and tears down volumes unless `WAVEYARD_KEEP_COMPOSE=1` is selected.
- Added a real Compose-browser test suite. It does not mock the API, queue, storage, worker, or Demucs. It registers through the UI, uploads the generated original WAV fixture, waits for a terminal job, asserts four exact validated stem types/metadata/checksums, opens the private workspace, and begins actual browser audio playback.
- Added security assertions for unauthenticated private media, non-member project/media access, guessed asset IDs, viewer read access, and viewer upload denial.
- Added failure assertions for corrupt audio rejected before source/job persistence and a real invalid-Demucs-model terminal failure with no completed stems.
- Added server-side collaborator membership endpoints and a server-side failed-job retry endpoint.
- Made source upload persistence transactional and remove a just-written source object when the corresponding source/job database transaction fails.
- Made worker cleanup remove any stem objects uploaded before a downstream failure; source preservation after a queue failure remains intentional so an authorized user can retry.
- Upgraded Next.js and its ESLint config to 16.3.5; `npm audit --omit=dev` now reports zero production vulnerabilities in this lockfile.

## VERIFIED

- `npm run typecheck` passes.
- `npm test` passes.
- `npm run lint` exits successfully. Next emits a non-fatal App Router pages-directory configuration message.
- `npx playwright test --list` discovers the three real Compose E2E tests.
- `npm run build` passes for web and worker without the prior Turbopack tracing/lockfile warnings.
- `npm audit --omit=dev` reports 0 moderate/high/critical production vulnerabilities.

## FAILED

- `npm run test:compose` fails immediately and explicitly in this sandbox because the Docker CLI is not installed. It does not mark Docker, Demucs, MinIO, Redis, or browser E2E as passed.

## NOT VERIFIED

- Compose boot and container health checks.
- CPU Demucs proof, four real source outputs, and audio validation inside the worker image.
- Queue consumption, real MinIO persistence, authenticated range playback, retry behavior, and Playwright browser flow against live services.
- Forced storage outage, forced worker interruption, missing-output and invalid-output fault paths under Compose.
- CUDA; there is no NVIDIA runtime in this environment.

## KNOWN LIMITATIONS

- The new E2E suite is a required real-stack acceptance harness, not evidence that the stack has been executed here.
- The test fixture is generated at test time and intentionally ignored from Git; it is deterministic, original synthesis rather than copied music.
- Public sharing, waveform work, remixing, export, discovery, comments, moderation UI, and account recovery/deletion remain outside this gate.
- The project API deliberately redacts private storage keys from browser responses. Direct object-store bucket policy must still be verified in the real MinIO test run.

## NEXT PHASE

Run `npm run test:compose` in an environment with Docker. Fix every failing health/E2E assertion before starting waveforms, mixer expansion, or remix UI. Then add explicit Compose fault-injection profiles for worker interruption, unavailable storage, and missing/invalid Demucs output so the remaining failure matrix is verified rather than only specified.
