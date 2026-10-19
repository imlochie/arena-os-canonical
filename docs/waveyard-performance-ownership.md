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
