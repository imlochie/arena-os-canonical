# Capture monitoring: measurement and functional checks

The signal observer must not alter captured PCM or retain a recording in RAM.
Disk writing and signal observation currently share the API event loop, with
native-pipe backpressure and one chunk processed at a time.

## Reproduce the benchmark

From the workspace root, replace `/absolute/workspace` with the checkout path:

```sh
pnpm --filter @workspace/scripts exec node --expose-gc --import tsx \
  /absolute/workspace/scripts/waveyard-capture-performance.ts \
  --out /absolute/workspace/generated-artifacts/capture-performance/run.json
```

This opt-in benchmark uses a deterministic, reusable source pool of at most
64 KiB, randomized chunk boundaries, and streamed RF64 writes. It does not
allocate a whole recording. Default coverage:

- 48, 96 and 192 kHz.
- Mono, stereo and eight channels.
- Signed 16/24/32-bit PCM (one depth per sample rate), plus float32 and
  float64 (eight-channel float cases).
- 30 seconds of equivalent PCM per case, two repetitions, alternating
  disk-only versus disk-plus-monitor order; monitor-only runs are also included.
- Status requests against an HTTP server on the same event loop, at up to
  100 Hz (the actual capture UI polls at 1 Hz).
- CPU time, wall time, single-write time, event-loop delay, HTTP latency,
  bounded partial-frame length, and post-GC memory snapshots every ten seconds
  of equivalent audio.
- Byte-identical source-pool verification and streaming SHA-256 comparison of
  the actual RF64 PCM against the generated original.

`CAPTURE_BENCH_AUDIO_SECONDS` accepts 5–600 and
`CAPTURE_BENCH_REPETITIONS` accepts 1–5. A longer memory-only soak is available:

```sh
pnpm --filter @workspace/scripts exec node --expose-gc --import tsx \
  /absolute/workspace/scripts/waveyard-capture-performance.ts --soak-only \
  --out /absolute/workspace/generated-artifacts/capture-performance/soak.json
```

That streams five minutes equivalent of 192 kHz, eight-channel float64 PCM
through one monitor with a fixed source pool and no recording-sized allocation.
All input is accelerated rather than paced at real time. Neither benchmark
calls WASAPI or exercises the installed Windows application. Generated RF64s
are created in the OS temporary directory, verified, and removed; JSON reports
remain in the ignored `generated-artifacts/` directory.

Use `--retention-only` instead of `--soak-only` for paired source-only and
monitor-only five-minute-equivalent passes without repeated HTTP requests.
This separates observer retention from HTTP client/cache warmup and the
probe history maintained by the benchmark itself.

CPU figures include generation, HTTP probes, GC and disk writes when enabled.
Use paired disk-plus-monitor minus disk-only results to estimate monitoring
overhead; raw run CPU is not isolated observer CPU. GC is deliberately included
in event-loop/latency measurements. RSS/external-memory high-water marks alone
do not establish a leak. Compare post-GC heap and ArrayBuffer trends alongside
the fixed one-frame carry invariant. OS scheduling and file cache effects
produce noise; these numbers are observations, not release pass/fail limits.

## Separate functional acceptance

```sh
pnpm --filter @workspace/scripts exec tsx --test \
  /absolute/workspace/lib/arena/src/lib/waveyard/capture/pcm-signal.test.ts \
  /absolute/workspace/artifacts/api-server/src/lib/waveyard/audio-capture-throughput.test.ts \
  /absolute/workspace/artifacts/api-server/src/lib/waveyard/audio-capture-manager.test.ts
```

The signal unit tests cover randomized frames, padding, all supported sample
depths, silence versus missing packets, full-scale samples, NaN/Infinity,
incomplete-frame carry and input immutability.

The throughput test uses the actual capture manager, a synthetic subprocess,
real RF64 disk writes, 192 kHz eight-channel float64 PCM, and HTTP status/stop
requests. It verifies those requests complete during intake, stop drains
accepted PCM, the file hash is unchanged, and another owner cannot read status.
It is Linux-only because its subprocess fixture emulates the Windows host; it
is explicitly not native Windows acceptance. Its generous control deadlines
catch starvation, not small performance regressions. Do not turn hardware-
dependent benchmark numbers into brittle CI thresholds.

Native Windows recording/isolation acceptance is described separately in
`WINDOWS_CAPTURE_TEST.md`. Linux benchmarks cannot prove Windows laptop CPU
cost, native host behavior, protected-output compatibility, or audio quality.

## Observed Linux results — 2026-10-31

Environment: Linux x64, kernel 6.18.59, Node v24.22.1, four exposed logical
CPUs, Intel Xeon Platinum 8581C @ 2.30 GHz. Before/after reports each contain
108 runs: 18 formats × three modes × two repetitions. This is a shared
development container, not a controlled Windows laptop benchmark.

The optimization replaces tail-plus-entire-chunk concatenation with one
reusable frame and caches integer normalization/full-scale constants.
The following numbers average two repetitions per format; CPU includes the
benchmark overhead described above.

| PCM format | Monitor-only CPU before → after, per 30 s equivalent audio | Paired extra CPU for monitoring before → after |
| --- | ---: | ---: |
| 48 kHz stereo int16 | 155.5 → 88.8 ms | 130.2 → 69.0 ms |
| 48 kHz stereo float32 | 113.1 → 101.6 ms | 70.6 → 66.2 ms |
| 96 kHz eight-channel int24 | 735.9 → 363.4 ms | 947.9 → 472.1 ms |
| 192 kHz eight-channel int32 | 1495.3 → 694.1 ms | 2154.2 → 1041.9 ms |
| 192 kHz eight-channel float64 | 1099.6 → 1075.7 ms | 1789.7 → 1048.2 ms |

Aggregate monitor-only CPU across all 36 before/after runs decreased from
13,551.5 to 9,719.4 ms (28.3%). This does not mean every format improved:
96 kHz mono float32 was noisier/slower in the monitor-only runs, and some
paired differences also increased. Do not generalize the aggregate number
as a Windows speedup or an end-to-end recording improvement.

Maximum observed individual observer call: 10.20 ms before, 6.63 ms after.
Across the optimized matrix, maximum HTTP latency was 36.17 ms and maximum
event-loop delay was 18.12 ms, including forced collections; the baseline
maxima were 17.87 and 14.29 ms. The optimization reduced CPU/copying, **not**
the observed worst HTTP latency. No benchmark latency is a release guarantee.

The five-minute-equivalent, eight-channel 192 kHz float64 observer soak
processed 3.6864 GB from a fixed source pool in 6.26 s of wall time.
Its 613 HTTP probes had a 1.16 ms p95 and a 12.73 ms maximum; event-loop p99
was 2.10 ms. Carry never exceeded 63 bytes for a 64-byte frame.
The HTTP-enabled process heap increased during warmup, so it was not used
by itself as proof of observer retention.

In the separate source-only versus observer retention passes (HTTP probes
disabled), ArrayBuffer use stayed constant across all 30 post-GC samples:
397,689 bytes without the observer versus 397,753 with it, exactly one
64-byte frame more. Observer-pass heap after collection was 2,584 bytes
above its starting value; the final ten sampled heap values spanned about
14 KiB. This supports bounded observer retention for this run, not a claim
that the whole application never grows in memory.

Full local measurements:
`generated-artifacts/capture-performance/{before,after,soak,retention}.json`.
The functional checks passed separately, including hash verification through
the actual manager's subprocess and RF64 path. No Windows run was performed.
