# P5: bounded selected-source PCM ownership (experimental)

This experiment belongs only on `benchmark/waveyard-hybrid-ownership`, as a
child of the verified P4 benchmark snapshot
`92fee6b83aa1595a2e27658831c9d6606d173bc1`. It is not a production replacement,
does not open a PR, and must not modify P4's branch or evidence. Product batch
download PR #17 is separate.

## Allocation lifetime

P4 releases Worker-owned source PCM after its final canonical track consumer.
P5 makes one exception: source identities referenced by the user's selected
track/selected clips can remain in the Worker, up to **16 MiB** in total.
There is no second warm PCM owner on the main thread.

The caller supplies selected track IDs in priority order. StudioCore puts the
current clip selection first, followed by other selected clips' track IDs.
Preparation resolves these to the existing revision/transform-aware source
keys. The Worker retains completed sources in that order only while the actual
decoded channel byte lengths fit the budget. Oversized sources are not retained;
lower-priority sources are evicted when necessary. Unselected sources follow
P4's last-consumer release rule. This is explicit selection priority, not an LRU
policy or a fixed source-count allowance.

Removed/replaced source keys are pruned through the existing ownership path.
The existing five-second idle release clears the warm set as well. Worker
failure/cancellation discards Worker ownership; bounded encoded recovery remains
available. The pre-master mix, finished-buffer identity, canonical track/mix DSP,
encoded-recovery limits, and decoded-owner fallback are unchanged.

## Verification before interpretation

The workflow first checks types and runs recovery/warm-ownership correctness
without collecting performance samples. It then measures baseline, P2, P3, P4
and P5 in that order on one runner with the same lockfile, Node 22.22.3 and
Chromium 153.0.8010.0. The common harness is copied byte-for-byte to each control.
Three repeats at 4, 16 and 32 distinct ten-second sources produce 45 cells.
Controls are fixed; no implementation is changed between repeats.

The active-source fixture is declared before measurement and resolves synthetic
source identities to actual track IDs identically for every variant. It selects
up to four identities, leaving one source cold in the four-source case. This is
a workload declaration, not a source-count policy in production code. Hot,
repeated-hot and cold edits are reported separately. All five original PCM hash
stages remain; the two additional edit stages bring the exact comparison to
seven complete stereo hashes.

Additional ownership checks cover selected-source revision changes, priority
eviction, variable 1/7/30/60-second source sizes including a source larger than
the entire warm budget, selection switches, cancellation/retry and a real
Worker-instance error during a controlled network outage. Existing recovery,
disposal, source-reuse, replay, master-cache and responsiveness assertions remain.

Component instrumentation measures fetch/body reads, decoding, encoded/decoded
cache lookups, channel copies, transfer enqueue, and Worker acknowledgements.
Worker intervals include scheduling/IPC, not pure DSP CPU. In incremental
variants, the render-result interval also spans source acquisition and track
messages; legacy monolithic variants start that interval later. These
overlapping intervals must not be summed or treated as identical DSP stages.
The end-to-end edit latency is the directly comparable latency measure.

## Predeclared decision

Do not accept P5 merely because the workflow completes. At 32 sources, the
provisional targets are at least 25% lower median hot-edit latency than P4 and
at least 50 MiB lower median peak PSS than P3, with retained PSS still below P3.
Inspect cold edits, low-source behavior and recovery costs as well. The
250 ms UI-gap gate and 300 ms comparison ceiling are unchanged. The 512 MiB
peak target remains diagnostic, not an assumed achievement.

Only interpret a complete 45-cell comparison with exact hashes, recovery gates,
raw logs and final uploaded evidence. A failed target is a result to report,
not a reason to increase the budget or alter the workload after observing it.
No performance or correctness success is claimed by this design document.
