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

The added `src/lib/waveyard/arrangement-preparation.test.ts` ran with the
repository's `scripts/register-src-loader.mjs` on Node 22.22.0:
**3 passed, 0 failed**. It covers successful Worker ownership handoff and warm
edits, cancellation/retry, and synchronous `postMessage` failure recovery. This
unit fixture does not measure browser process memory or prove native
structured-clone behavior. The five changed TypeScript/TSX files also passed a
TypeScript 5.9.3 syntax-transpilation check; that is not a project typecheck.

The repository contains the established 4/16/32-source harness in
`tests/acceptance/studio-fx.test.mjs` and browser instrumentation in
`tests/acceptance/studio-preparation.fixture.ts` (imported by
`studio-fx.fixture.tsx`). It uses the production preparation controller and
Worker, synthetic owned PCM, and 50 ms descendant-tree Chromium PSS samples.
It records per-channel SHA-256 hashes of original and edited little-endian
float32 PCM after both the UI-gap and PSS samplers stop.

`git diff --check` passed and `package-lock.json` is unchanged. The first
`npm ci --ignore-scripts` attempt was killed with exit 137; a subsequent
bounded/offline `npm install` completed. `npm run typecheck` then exited 1
without a TypeScript diagnostic, and a direct `tsc` attempt ended without
output. Across those attempts the hierarchical cgroup `oom_kill` count rose
from 4 to 7 while `memory.events.local` remained 0. This supports resource
pressure but does not identify which process was killed; the project typecheck
is **not verified**.

The current runner has Node 22.22.0, Chromium 152.0.7977.64, and system
PostgreSQL 16.15. The historical run used Node 22.22.3 and Chromium 153.0.8010.0;
`/tmp/al2023/lib` is absent. The bundled embedded PostgreSQL tools require
`libpq.so.5` and `libicuuc.so.60`, which are unavailable here, so the browser
acceptance attempts used a temporary local-only wrapper for system PostgreSQL.
The baseline acceptance attempt used `tsx` to resolve source imports; the
candidate retry used the repository loader. This loader difference is another
reason not to treat the single-point comparison below as a repeated paired run.
The harness timeout was raised to 600 seconds and page-navigation timeout to
120 seconds; neither timeout is inside the measured preparation interval.

## Performance evidence and remaining gate

The existing PR #15 scorecard records the prior preparation-only baseline as
**1,415.8 ms cold / 531.0 MiB sampled Chromium process-tree PSS at 32 sources**;
it explicitly says the provisional 512 MiB sampled-browser target failed. That
32-source scorecard point was not reproduced in this session.

The established harness did complete the 4-source profile on both revisions:

- **Baseline:** ready 1,621.4 ms; replay 0.4 ms; edit 34.3 ms; maximum UI gap
  32.5 ms; 441,000 output frames; sampled browser-tree peak PSS
  **464,189,440 bytes (about 442.7 MiB)**. `decodedBytes` and `sourceBytes` were
  both 14,112,000 bytes.
- **Candidate:** ready 1,376.6 ms; replay 0.4 ms; edit 54.5 ms; maximum UI gap
  122.2 ms; 441,000 output frames; sampled browser-tree peak PSS
  **461,208,576 bytes (about 439.8 MiB)**. `decodedBytes` was 0 after the
  successful render; Worker-owned `sourceBytes` was 14,112,000 bytes.

Both 4-source results had zero latest-edit error and identical per-channel
hashes: original `8233a302ed22a7d0014db820813584fc760747b5bdec19a8e4ca4a5f8e32194c`,
edited `446720705711e3ec3b97c59415ac089947b39c8f0733a3fc5444ca886531defe`.
The one-run PSS difference is 2,980,864 bytes (about 2.8 MiB); it is too small
and too noisy to claim a memory improvement. The two runs used the same Node,
Chromium, PostgreSQL and fixture, but different Node source loaders.

The baseline run crashed in the 16-source `page.evaluate` with `Target crashed`.
The candidate run emitted its 4-source result, then crashed at the 16-source
`page.evaluate`; it produced no 16- or 32-source metric. During that candidate
run, the hierarchical cgroup `oom_kill` count increased from 7 to 8 while the
local counter remained 0. That is consistent with child-process memory
pressure, but does not identify the process or prove the renderer's cause.
No paired or repeated 16/32-source comparison is available.

The change releases a known decoded-source owner after successful preparation,
but because release occurs after the Worker reply, it may reduce retained
workspace memory without reducing the cold-preparation peak. Garbage collection
timing may also affect when the browser returns those pages. Keep this PR in
draft until the project typecheck and repeated, same-runtime 4/16/32 runs on
both base and candidate complete; compare PCM hashes, frame counts, PSS,
latency and UI gaps before claiming a measurable browser-memory improvement or
changing the scorecard's performance status.

This branch is based on PR #15 because that is where the target implementation
exists. It should be reviewed against that branch first and retargeted only
after PR #15's changes are integrated; do not merge it into `main` as a
standalone branch without that base.
