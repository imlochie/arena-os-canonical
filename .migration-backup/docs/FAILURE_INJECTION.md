# Compose Failure-Injection Gate

The Compose release gate runs the real web process, PostgreSQL, Redis/BullMQ, MinIO, worker, FFmpeg, Demucs, and Playwright browser suite. Its fault scenarios use one-time, token-gated worker boundary faults rather than replacing storage, queueing, audio decoding, or separation with mocks.

**Status:** the canonical Docker Compose release gate exercised these scenarios successfully as part of its four-test runtime baseline. The repository CI workflow now reruns the same gate from a clean checkout; a green workflow is CI evidence for this Compose path, not a production-readiness or CUDA claim.

The gate generates a per-run secret in `scripts/test-compose.ts`. It is supplied only to the Compose services for that run. The fault-control route returns `404` unless that secret is configured, and requires the secret on every request. Production deployments must not set `WAVEYARD_TEST_FAULT_TOKEN`.

## Lifecycle expectations

| Scenario | Injected boundary | Required durable outcome |
| --- | --- | --- |
| Storage read failure | Before a stem waveform worker reads its private audio object | The first BullMQ attempt fails; the retry completes the same durable `waveform_jobs` row, and exactly one waveform asset exists for that stem. |
| Storage write failure | Before a stem waveform worker writes its generated private waveform document | The first attempt fails without a durable waveform asset; the retry completes the same waveform job and creates exactly one asset. |
| Partial waveform artifact | After MinIO accepts a generated waveform object but before the database transaction commits | The failed attempt deletes the unreferenced private object. A retry completes the same job and creates exactly one durable waveform asset. |
| Worker restart during waveform processing | While a stem waveform job is active | The worker exits, Compose restarts it, BullMQ recovers the stalled attempt, and the original durable job completes without duplicate waveform assets. |
| Terminal separation failure | Demucs is given an invalid model | The separation job reaches `failed` and creates no stems. It is not represented as a recoverable successful artifact. |

The faulted waveform test uses one real separation to create four stem waveform jobs. Each independent one-time fault is consumed by a different stem job. The worker still uses real MinIO reads/writes and FFmpeg waveform generation on its recovery attempt.

## Invariants asserted by Playwright

- A recoverable waveform failure reaches `complete` after a retry and has at least two durable attempts.
- The worker-restart fault is observed, and the worker recovers the same job rather than creating a replacement job.
- Cleanup after a post-write failure is verified against the storage provider before retrying.
- One upload produces exactly four distinct stem rows, five waveform jobs, and five waveform assets (one source plus four stems); retries do not create duplicates.
- The existing terminal-Demucs scenario continues to prove that a non-recoverable separation failure leaves no stems.

Run the complete release gate with:

```bash
npm run test:compose
```
