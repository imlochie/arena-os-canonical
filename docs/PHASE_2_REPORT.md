# Phase 2 Report — Studio Core

## Scope

Phase 2 adds a small, real Studio workspace to Waveyard’s existing private upload → separation foundation. It deliberately stops short of audio rendering/export, sharing, publication, or a full DAW.

## Implemented

### Derived waveform pipeline

- A source upload creates a durable `waveform_jobs` record alongside its separation job. Successful separation creates one durable waveform job per stored stem.
- A separate BullMQ `waveyard-waveform` queue is consumed only by `apps/worker`. The web process never invokes FFmpeg for waveform work.
- The worker downloads the private object into an isolated temporary directory, uses FFmpeg to decode actual audio to mono signed-16 PCM, and deterministically reduces it to normalized min/max peaks at 256, 512, 1024, 2048, and 4096 buckets.
- The resulting `waveyard-peaks-v1` JSON is checksummed and stored privately. PostgreSQL holds relationships, status, checksum, format, and small metadata only; it never holds audio or waveform JSON payloads.
- `GET /api/assets/:id/waveform` authenticates the user, requires at least viewer access to the asset’s project, performs a bounded private-object read, validates the document, and returns no storage key.

### Studio UI and private delivery

- The project workspace renders only waveform data returned by the authenticated API. It does not receive object keys or object-store credentials.
- One lazily created Web Audio graph owns master gain, per-stem gain, stereo pan, mute/solo semantics, synchronized seek, play, pause, stop, a loop range, and browser-level drift correction. It is an audition transport, not a sample-accurate DAW claim.
- Each selected stem exposes real persisted metadata and authenticated stem/source download links. `?download=1` uses attachment disposition for local streaming or signed S3 delivery.
- A waveform that is queued, unavailable, malformed, too large, or unauthorized is shown as unavailable; the UI does not draw substitute/random peaks.

### Non-destructive remix sessions

- `remix_sessions`, tracks, clips, and named `remix_versions` are persistent database entities. A newly created session initializes tracks/clips from existing project stems; no audio is copied.
- State is normalized and bounded server-side, then saved only by project editors. Track identity is immutable per session, and clip asset references must belong to the same project.
- The UI supports clip start/length editing, duplicate/delete, mixer state, debounced persistence, bounded 80-step undo/redo, named state-only snapshots, and restore.
- Snapshots contain arrangement metadata only. There is no Phase 2 worker-side remix render or export endpoint, and browser audition must not be described as an exported/remixed audio file.

### Schema and migration safety

- `0001_waveyard_studio_core.sql` adds waveform and remix tables, indexes, exact-one-asset checks for waveform rows/jobs, partial unique waveform indexes, and numeric range checks for persisted mixer/clip fields.
- `scripts/migrate.ts` now discovers ordered SQL migrations and writes an applied-migration ledger transactionally.

## Verification completed

| Check | Result |
| --- | --- |
| `npm run typecheck` | passed |
| `npm test` | passed — 7 unit tests |
| `npm run lint` | passed |
| `npm run build` | passed — web route compilation and worker TypeScript build |
| `npx playwright test --list` | passed — discovers the real Compose suite including waveform/remix assertions |
| `git diff --check` | passed |
| `npm run test:compose` | passed — 3 real-stack Playwright tests against the canonical Docker Compose topology |

The unit coverage directly tests deterministic PCM min/max reduction, malformed waveform validation, remix numeric bounds, malformed input rejection, and mute/solo semantics.

The Compose release gate exercised the full CPU separation path: browser registration and project creation; Waveyard upload; web-process `probeAudio`/FFprobe validation; durable source, separation-job, and waveform-job creation; Redis/BullMQ worker consumption; real CPU Demucs separation; persisted private stems; worker-generated waveform artifacts; authenticated waveform and media access; playback; remix persistence; and lifecycle completion assertions.

Its three passing tests also established the exercised authorization and terminal-failure behavior: project/private-media isolation and collaborator roles, corrupt-audio rejection, and a terminal real-Demucs failure that did not produce stems. This is runtime evidence for the tested Compose path, not a general claim that every infrastructure-failure mode has been exercised.

## Remaining verification boundaries

- CUDA Demucs remains unverified and must be tested only on actual NVIDIA-capable infrastructure.
- The completed gate did not inject interrupted waveform work, worker restart/recovery, storage read/write failures, partial-artifact cleanup, or retry/idempotency failures. Those scenarios require explicit failure-injection coverage.
- The completed gate is a canonical Compose result. CI/release automation still needs to reproduce it without undocumented workstation state.

## Follow-up work

1. Add Compose release-gate failure injection for interrupted waveform work, worker recovery, storage faults, cleanup, retry/idempotency, and duplicate durable-record prevention.
2. Automate the Compose release gate in repository-level CI.
3. Add worker-owned remix render/export jobs before representing a remix as a rendered audio artifact.
4. Add server-side optimistic concurrency conflict handling if concurrent editor support is introduced.
5. Decide remix/publication licensing policy with the project owner; this change makes no license decision.
