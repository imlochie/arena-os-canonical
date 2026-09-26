# Phase 3 — Worker-Owned Persisted WAV Export Report

**Status: VERIFIED**  
**Verified commit:** `232fe8ae23b1f6705a60e148b59c1e6778243b66`

## Scope

Phase 3 completes the private creation loop from a persisted `RemixVersion` to a real, worker-rendered WAV:

```text
RemixSession → RemixTrack / RemixClip → RemixVersion → ExportJob → ExportAsset
```

It adds neither public publication nor browser-authoritative rendering. The authoritative path remains browser UI → authenticated API → PostgreSQL / private storage / BullMQ → worker-owned FFmpeg.

## Provenance and durable records

An `ExportJob` holds the requested project/session/version identity, requester, WAV settings, lifecycle status, stages, durable attempt count, errors, timestamps, and idempotency identity. Its successful `ExportAsset` holds the linked job and remix-version provenance, private storage identity, checksum, filename, duration, sample rate, channels, codec, format, size, and creation time.

A duplicate compatible request reuses the existing durable job. Object-store keys and credentials are not returned by application APIs.

## Worker and export lifecycle

The export worker validates its explicit queue payload against the durable job, reconstructs the mix only from the immutable persisted RemixVersion snapshot and project-owned stems, downloads input through `@waveyard/storage`, and renders deterministic 44.1 kHz stereo PCM WAV audio with FFmpeg. It FFprobe-validates and checksums output before private persistence and the transaction that creates the one linked asset and completes the job.

Handled failures record a terminal failed job, create no `ExportAsset`, and clean up newly written uncommitted output. A completed job and the unique job-to-asset relationship protect against duplicate durable assets.

## Authorization, idempotency, and retries

- Export requests and retries require project editor authorization.
- Job status and completed media require project viewer authorization.
- Private delivery uses authenticated streaming or a short-lived signed URL; storage keys stay server-side.
- A retry uses the same `ExportJob` identity and may begin only from durable `failed` state.
- The retry route waits briefly for BullMQ to settle the database-failed/queue-active transition, serializes duplicate retry requests with a conditional durable transition, and resets BullMQ attempt counters while retaining the database attempt history.
- If requeueing fails, the job returns to durable `failed` state with `queue_retry_failed` metadata.

## Runtime gate

**Command**

```bash
npm run test:compose
```

**Result**

```text
5 passed (3.3m)
```

The Docker-capable-host Compose run passed all five real-stack Playwright scenarios. Its export scenario covered persisted RemixVersion request, worker-owned FFmpeg rendering, private retrieval, an injected terminal render failure with no asset, same-job manual retry, and successful re-render. The original four Studio Core acceptance paths remained in the suite.

## Remaining boundaries

- This is local Docker Compose evidence, **not GitHub Actions CI verification**. The repository workflow remains configured, but runner allocation is blocked by an external GitHub billing limitation; that is a verification gap rather than a repository defect.
- CUDA/GPU execution is not verified; the Compose proof is CPU-oriented.
- Production storage behavior, credentials, backups, monitoring, long-duration/load behavior, operational response, and public delivery are outside this milestone.
- Publication, discovery, moderation operations, collaboration, video, advanced mastering/plugins, and full DAW behavior remain separate work.
