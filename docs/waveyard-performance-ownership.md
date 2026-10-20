> Historical proposal below: the original sections describe **PR16 at
> `349cd6788650cb3175c7305e1f0c65c2c66c9f7e`**, not the implementation on this
> branch. Its Worker-only ownership change is **not integrated**. The appended
> 2026-10-20 review supersedes its missing-harness assertion and missing validation.

# Waveyard decoded-source ownership experiment

**Status: implementation present; browser-memory acceptance is not yet verified.**
This receipt does not claim the 512 MiB target passed or that sampled Chromium
PSS decreased.

## Revision and working state

- Performance task base: live PR #15 head `ee13987e8ea74d0c438d4c9be4d061a97862d033`
  (`arena/331aa502-arena-os-canonical`), fetched from GitHub on 2026-10-20.
- `main` was `f0e4180841cd047080b06d6cb43cd2effa9ab98f` and does not contain the
  referenced canonical preparation/PCM Worker or replacement scorecard. This
  branch therefore starts from the exact live PR #15 head; PR #15 itself was not
  modified.
- The local checkout was clean before creating
  `replit/waveyard-memory-ownership`.

## Observed ownership path

`ArrangementPreparation.prepare()` fetches an immutable asset, decodes it into a
main-thread `AudioBuffer`, copies each channel with `slice()`, and transfers the
copies to the arrangement Worker. The Worker keeps the transferred channel
arrays in its `sources` map for warm edits and replay. Before this change, the
main-thread `decoded` map also kept the original `AudioBuffer`s after a
successful render. The existing 128 MiB check counted only that main-thread
map, not source arrays retained in the Worker.

For one 10-second stereo source at 44.1 kHz in float32 PCM, each owner holds
441,000 × 2 × 4 = 3,528,000 bytes. At 32 sources that is 112,896,000 bytes
(about 107.6 MiB) per ownership copy, or about 215.3 MiB across both copies.
This is an allocation calculation from the stated workload, not a Chromium PSS
measurement.

## Change made

- Keep the main-thread decoded copy until the Worker returns a successful
  render. Then remove decoded entries for the source keys the Worker owns.
- Keep those Worker-owned source arrays for master edits, replay, and unaffected
  tracks. A warm edit skips fetching/decoding sources already present there.
- Key each Worker source by its asset ID and that asset's own checksum/revision.
  `StudioCore` supplies per-asset revisions (including source checksum and
  analysis identity); changing one source revision invalidates that asset alone,
  rather than evicting unrelated source data.
- Report Worker source bytes by key and include the active Worker-owned bytes in
  the existing 128 MiB selected-source check. Obsolete Worker entries are not
  counted as part of the new selection.
- If preparation is cancelled or the Worker fails before a successful reply,
  retain the main-thread decoded buffers as the retry path. Worker failure also
  clears its cached-byte accounting.
- A synchronous `postMessage` failure terminates the unusable Worker without
  marking its sources sent; decoded buffers remain available for retry.

No DSP kernel, sample rate, PCM format, rendering order, session schema, queue,
or persistence behavior was changed.

## Verification in this checkout

The focused suite was run against the real `prepareArrangementPcm()` function
with a Worker protocol fixture: **10 passed, 0 failed, 0 skipped**. Coverage
includes pre-master cache reuse, main-copy release after a successful render,
no refetch/redecode on a warm master edit, replacement of one track without
reloading its neighbor, checksum invalidation for a single asset, and
cancel-then-retry and synchronous Worker-post-failure recovery while retaining
valid decoded data. This fixture does not measure browser process memory or
prove native structured-clone behavior. The five changed TypeScript/TSX files
also passed a TypeScript 5.9.3 syntax transpilation check; this was not a
project typecheck.

`git diff --check` passed. The repository typecheck and full browser/runtime
acceptance have not passed in this environment: `npm ci --ignore-scripts` was
killed with exit code 137 before completion, and no Chromium
executable or checked-in 4/16/32-source PSS harness/receipt was available in
this checkout. No PostgreSQL/private-media benchmark runtime was started here.

## Performance evidence and remaining gate

The existing PR #15 scorecard records the prior preparation-only baseline as
**1,415.8 ms cold / 531.0 MiB sampled Chromium process-tree PSS at 32 sources**;
it explicitly says the provisional 512 MiB sampled-browser target failed. That
baseline was not reproduced in this session. No before/after PSS, latency,
UI-gap, decode-count, or full PCM-hash run is claimed here.

The change releases a known decoded-source owner after successful preparation,
but because release occurs after the Worker reply, it may reduce retained
workspace memory without reducing the cold-preparation peak. Garbage collection
timing may also affect when the browser returns those pages. A fresh run of the
same production harness at 4, 16, and 32 sources, with repeated runs and PCM
hash/frame-count checks, is still required before claiming a measurable browser
memory improvement or changing the scorecard's performance status.

This branch is based on PR #15 because that is where the target implementation
exists. It should be reviewed against that branch first and retargeted only
after PR #15's changes are integrated; do not merge it into `main` as a
standalone branch without that base.


## 2026-10-20 review and execution (Asia/Jakarta)

### Reconciled identities and scope

Baseline: clean published `571a05a3cb2f74cf8e2c038102da686dc20ce1cd` on
`arena/331aa502-arena-os-canonical`. PR16 head was independently rechecked as
`349cd6788650cb3175c7305e1f0c65c2c66c9f7e`, base this session branch, OPEN,
no reviews/checks reported. PR14/15 remain OPEN; none was merged or retargeted.
All owner-branch edits stayed on the session branch. Candidate comparisons used
an archived baseline plus the five PR16 source/test files under
`/home/user/pr16-evaluation`, sharing the exact installed dependencies/browser.
This is an **overlay on newer baseline**, NOT an exact PR16-head benchmark.
A separate full archive of exact PR16 head (`/home/user/pr16-exact`) passed the
project `npm run typecheck` and the two focused test files, 10/10. The overlay
also passed project typecheck and the three new preparation tests.

**Correction:** the existing 4/16/32-source browser-tree PSS test is present in
both exact PR16 (`studio-fx.test.mjs:621`) and current baseline (`:632` before
new tests). The original “no ... checked-in ... harness” claim is incorrect.
The environment limitation/install exit137 remains historical, not erased.

### Same-environment measurements

Extended, did not replace, `tests/acceptance/studio-preparation.fixture.ts` and
its existing `studio-fx.test.mjs` test. All-channel float32 planar PCM (L then R)
is hashed with SHA256 for the cold and edited buffers, with exact 441000-frame
and zero edit-error checks. The open controller, Worker and output buffers
remain alive for retained-memory samples. Natural retained PSS and explicitly
GC-assisted retained PSS are separate from the 50ms interval-sampled high-water
mark. PSS includes Chromium and actual `/proc` descendants, not JS counters.
Hashing/verification is outside the UI-gap measurement; its allocations are
included in the overall sampled workload peak. These are controlled PG/HTTP/
controller/real Worker runs, not compiled Next hydration, Electron or inference.

Three fresh runs per implementation, serial order B,C,C,B,B,C; each run profiles
4/16/32 distinct stereo ten-second assets. No concurrent builds/tests during
these comparisons. Medians below; MiB = 1048576 bytes:

| Sources | Implementation | Sampled tree peak MiB | Natural retained MiB | GC-assisted retained MiB | Cold ms | Replay ms | Edit ms | Max task gap ms |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| 4 | Baseline | 285.92 | 287.92 | 266.72 | 266.3 | 0.1 | 15.6 | 11.1 |
| 4 | PR16 overlay | 270.84 | 285.86 | 250.75 | 297.1 | 0.1 | 17.2 | 19.2 |
| 16 | Baseline | 384.49 | 384.49 | 374.96 | 753.7 | 0.2 | 18.9 | 40.0 |
| 16 | PR16 overlay | 373.94 | 329.77 | 320.21 | 758.9 | 0.2 | 18.6 | 43.3 |
| 32 | Baseline | 529.43 | 526.14 | 518.17 | 1367.9 | 0.2 | 20.1 | 85.9 |
| 32 | PR16 overlay | 519.64 | 416.79 | 410.24 | 1301.3 | 0.2 | 20.9 | 83.8 |

A manual retained sample can exceed the coarse interval maximum (4-source row);
neither is an instantaneous process maximum. At32, natural retained median
falls109.35MiB and GC-assisted median107.94MiB, but sampled peak falls only9.78MiB
and still exceeds the provisional512MiB target. No whole-app speed win or
performance-gate pass follows. SHA256 for each count/cold-or-edit combination
matches across **all six runs**, not just a sparse frame probe:

| Sources | Cold stereo SHA256 | Edited stereo SHA256 |
|---|---|---|
|4|c8eb5867512bed4a4cffae858c30fa02e316f1451189c27790a06a1b029514fd|4dc82c6e9f0ed4c6878e00b16c94f5bb708dfe02e7dd58268611a8470cfb3e6c|
|16|fff73ba3cf75076610b49d3db738ef6822d47dc98c61b353b0f320205ef103a8|f6412ed86c7188cdfa0c34b448f1f4558d7e1f8db97d1a457145410a9926618c|
|32|21b9578a7d5667b5a14cd6f2f724b9910406f881aaa947f4d311e34fc9b760d0|95bccdce18f61521d3839a0f94ca782315f66b90a2a89904128d81fb2e530660|

Receipts: `.data/acceptance/ownership-review/comparison.json`, raw
`ownership-{baseline,pr16}-{1,2,3}.txt`. Earlier `*-superseded.txt` runs had a
fixture lifetime error (disposed before retained measurement). They are retained
as failed instrumentation evidence and excluded entirely from this table.

Commands (from each isolated source root, same dependencies/browser):

```sh
CHROMIUM_EXECUTABLE_PATH=/tmp/chromium LD_LIBRARY_PATH=/tmp/al2023/lib   ARENA_MEMORY_CANDIDATE=baseline node --import ./scripts/register-src-loader.mjs   --test --test-name-pattern='distinct-source preparation' tests/acceptance/studio-fx.test.mjs
# For candidate: source root /home/user/pr16-evaluation, ARENA_MEMORY_CANDIDATE=pr16.
# Default remains baseline's exact decoded-byte assertion; candidate mode checks
# decodedBytes=0 AND the full expected Worker source bytes, not deleted assertions.
```

### Regressions found, fixes executed, ownership decision

1. Existing real-browser warm cancellation/cache test passes baseline but fails
   overlay: fetch counts1→2 after cancelled edit (expected1), reopen2→3.
   A new controlled endpoint-outage test demonstrates the consequence: after
   first successful render/cancel, baseline recovers from retained PCM; overlay
   throws `Controlled source endpoint outage`. Its pre-first-success cancellation
   fixture did not cover this warm-success→cancel case. Worker termination
   destroys the only released-source owner. **Do not merge the ownership release
   on this evidence; fix and remeasure recovery first.**
2. New genuine Chromium structured-clone test invokes native `postMessage` on
   a non-cloneable function once. Baseline surfaces DataCloneError but next
   prepare rejects an orphan promise (`AbortError: Preparation cancelled`).
   The owner-branch fix clears the unsendable pending request, terminates/reset
   Worker ownership/stats, preserves decoded PCM and retries without another
   fetch or unhandled rejection. The analogous fix already exists in PR16;
   this small correctness fix is adopted independently, not its memory policy.
3. New source-version browser regression: same selected asset IDs and global
   revision, changed per-asset version with a controlled changed source response.
   Both baseline and overlay incorrectly reuse the finished stereo buffer
   (hash8503361c7768d9e98b069571ef717ffec014bca65d5ae90c191cb6d2b2bdb489).
   Owner-branch fix includes deterministic per-asset revisions in finished and
   playback identity, keys decoded raw and transformed assets by own revision,
   and wires Studio source checksums/analysis through the existing hook. The
   changed asset is fetched twice total; unrelated neighbor once; unchanged
   replay is the same finished buffer. Global revision is a safe fallback when
   no per-asset revision is supplied. Decoded recovery buffers remain retained.

Owner-branch focused runtime5/5, canonical PCM7/7, project typecheck and lint
PASS (0errors/48existing warnings). These are bounded, overlapping checks,
not an added total or full replacement acceptance. Broad source/browser/build/
staged-native verification is pending at this documentation checkpoint; retain
its final exact-head receipts/PR comment separately rather than borrowing571a05a
CI. The new browser version/outage seams are controlled test boundaries; no
claim that an immutable production asset was overwritten or that a real provider
was offline. No sources, bank identities, sessions or DSP kernels were replaced.
Genuine learned4/6stems, live authorised acquisition, recording/recovery
replacement acceptance and actual Electron remain blocked/unaccepted. Gate CLOSED.

## 2026-10-20 next mandate — recoverable encoded ownership alternative

Re-anchored live PR15 at a8e015592e81fcd0916e5a0f97baf3f8721ec091, PR16 draft
at349cd678/unmerged, PR14 open. Local HEAD had reset to f0e4180 while all files
were restored to a8e0155. A temporary-index comparison against fetched a8e0155
showed ZERO tracked differences and ZERO extra untracked files; only then a
mixed metadata reset restored HEAD/index, preserving every working file. Prior
push39313141508/PR39313146456 independently report completedSUCCESS. No branch
switch, conflict resolution, PR merge or retarget occurred.

### Lifecycle design and decision

The original PR16 Worker-only source owner remains rejected/unmerged. A different
minimal alternative was developed in an isolated a8e archive, without touching
owner source ownership while investigating. Keep original encoded audio bytes in
an immutable main-thread Blob only when smaller than decoded PCM. Before a
successful reply retain decoded buffers, exactly as before; after success release
a decoded copy ONLY if the independent encoded bytes remain. Warm edits reuse
Worker PCM. Cancel/Worker error/clone failure still terminates CPU work, clears
sent/stats, and a retry decodes its locally retained Blob without a network call.
If encoding is not smaller, keep the decoded recovery copy instead. This means
no source depends solely on a terminable Worker. No re-encoding/quality loss,
new cache database, external service or second music collection. Blobs may use
browser-managed backing storage; memory savings are not a promise of zero disk
cost. Retry after Worker loss spends decode CPU instead of fetching again.
Removal, source revision, sample-rate change and workspace dispose prune both
representations. The128MiB logical selected-PCM budget counts either recovery
representation once, including Worker-owned selections. A self-found prototype
bug cached an oversized encoding before budget rejection, allowing retry to
bypass the limit. New controlled-decoder-metadata browser regression reproduced
that failure; fixed by rejecting the budget BEFORE caching and checking the
known-selection budget upfront. Two consecutive oversized attempts now reject.
No oversized real allocation or relaxed assertion was needed.

Isolated variant fresh full-source1407/1407PASS; a8e baseline independently
1407/1407PASS. Both same-session-branch local archive metadata, no candidate
commits/pushes or owner Git mutation; receipts have exact dirty-content digests.
Candidate isolated full music browsers58/58PASS, baseline58/58PASS, including
warm-success→cancel/outage, warm native clone failure/outage, controlled Worker
error-event/outage, cold native clone failure, individual source revision with
stable global revision and unchanged neighbor, plus existing complete workflows.
Worker error is a controlled browser event, not an OS-kill claim. New two-channel
recovery comparisons have error0/one fetch. Source suites overlap, not additive.

After these bounded acceptance checks the repaired variant—not PR16's strategy—
was integrated into the owner implementation. Original PR16 stays draft and
unmerged; no wholesale source/checksum wiring or conflicting branch was copied.
Combined final-head source/browser/build/native acceptance is pending at this
tracked documentation checkpoint; read the final exact-head receipt separately.

### Fresh comparable memory measurements, not transferred historical figures

Latest comparison: identical acquisition-enhanced a8e working-tree snapshots,
sole production difference `arrangement-preparation.ts` baseline versus repaired
variant (including budget fix). Shared installed dependencies, Node22.22.3,
Chromium153, same private HTTP/PG/native ten-second stereo assets. Three serial
runs each, B,C,C,B,B,C, no competing local suite/build. Existing 4/16/32-source
harness, same full stereo hashes and441000frames/error0, real50ms Chromium
actual-descendant-tree PSS. No new benchmark or counter-only memory claim.

| Sources | Variant | Sampled peak MiB | Natural retained MiB | GC-assisted retained MiB | Cold ms | Replay ms | Edit ms | Max task gap ms |
|---|---|---:|---:|---:|---:|---:|---:|---:|
|4|baseline|290.48|290.48|269.74|358.5|0.2|18.4|13.9|
|4|encoded recovery|287.16|287.16|252.69|346.4|0.2|18.0|15.2|
|16|baseline|392.26|386.93|377.35|848.3|0.1|20.5|49.2|
|16|encoded recovery|368.57|321.93|312.34|802.5|0.2|22.2|51.0|
|32|baseline|526.59|521.35|515.27|1458.4|0.2|21.4|89.5|
|32|encoded recovery|508.69|403.50|397.41|1414.4|0.2|22.2|93.4|

At32:17.90MiB less sampled median peak;117.85MiB less natural retained median.
Cold/edit complete stereo SHA256 match across all6runs for EACH workload, with
the SAME hashes already listed in the prior review table above. Final candidate
32-source peaks496.219/508.690/510.586MiB (baseline530.683/521.350/526.591).
All three latest samples meet provisional512MiB, but this is NOT a general memory
ceiling: the initial isolated candidate set measured median519.13MiB, and coarse
sampling can miss instantaneous peaks. Earlier results remain in the receipts;
no blanket whole-app/Next/inference/Electron performance-gate claim follows.

Exact latest measurements/core source SHA, raw6logs, source-suite digests,
recovery evidence and repair patch: `.data/acceptance/acquisition-next/`.
`memory-comparison.json` identifies snapshots and the exact measured preparation
source SHA256. `encoded-final-{baseline,candidate}-{1,2,3}.txt` hold raw results.
Initial dependency failures (missing Chromium libnspr4 / worker local tsx/S3
packages), syntax-fixture failure and concurrent browser timing failures are
retained, not reported as passes. Local dependencies were restored from locked
npm packages without changing manifests. Candidate first full browser54/56 failed
because its worker executable/dependencies weren't linked; installed declared
worker lockfile and reran. Later57/58 failed Session seek persistence, and owner
58/59 failed natural-end/loop restart timing under concurrent workloads. Isolated
complete58/58 candidate and58/58 baseline then passed unchanged assertions/timeouts;
contention is not proven as the sole cause. Owner loop case also passes isolated.
These historical failures remain reliability signals, not hidden by source green.

Reproduce latest comparison from matching snapshots:

```sh
CHROMIUM_EXECUTABLE_PATH=/tmp/chromium LD_LIBRARY_PATH=/tmp/al2023/lib \
  ARENA_MEMORY_CANDIDATE=baseline node --import ./scripts/register-src-loader.mjs \
  --test --test-name-pattern='distinct-source preparation' tests/acceptance/studio-fx.test.mjs
# Candidate: ARENA_MEMORY_CANDIDATE=encoded-recovery. Default on repaired owner is
# encoded-recovery; explicit baseline mode retains its full decoded-byte gate.
```

Original SHA/version fixes remain intact. No real model weights or learned
inference produced; replacement gate remains CLOSED irrespective of cache wins.
