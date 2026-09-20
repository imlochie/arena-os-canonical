# Workers and Jobs

The worker is an independent process. It consumes BullMQ jobs and is the only runtime allowed to start Demucs, FFmpeg rendering, waveform generation, transcoding, or export work.

## Implemented job types

- `separation` — one processing job drives the real Demucs adapter and persists validated `vocals`, `drums`, `bass`, and `other` outputs.
- `waveform` — one durable job targets exactly one source or stem asset and persists a validated peak document.

Preview/transcode/remix-render/export jobs are not implemented by Phase 2 and must not be represented as available.

Jobs record durable status, attempts, timestamps, named stage, safe error summary, and idempotency key. Separation additionally records engine/model/device metadata. Percentages are shown only if measurable; otherwise the UI displays a truthful named stage.

## Failure and retry rules

Retryable infrastructure errors (temporary Redis/S3 connection loss) may retry with bounded backoff. Invalid input, missing model output, and configuration/device errors do not retry blindly. A retry never creates a second stem set or export record for the same job idempotency key.

## Worker doctor

`npm run worker:doctor` checks Python, FFmpeg, PyTorch, Demucs, device availability, database connectivity, Redis connectivity, storage write/read, and model configuration. A missing dependency is an explicit failed check.
