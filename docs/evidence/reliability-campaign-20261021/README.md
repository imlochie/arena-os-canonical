# Agent A reliability campaign — 2026-10-21 (Tokyo)

Starting owner revision: `ba5cfa731712b8f4759416830ed66b9cb50b9d84`.
Owner branch: `arena/331aa502-arena-os-canonical`; PR 15 remains unmerged.
Agent B PR 19 and PRs 14/16 are outside this campaign.

## Cycle 1: lost separation retry handoff acknowledgement

Reproduction: injected handoff advances the real PGlite job row then throws.
The old ID-only rollback replaced newer executor state and metadata. A second
reproduction returned the row to queued through a later retry; the older
submission's catch still reset it to failed. Both tests failed before the fix
(`campaign-retry-before.json`).

Fix: assign a random per-submission identifier inside existing job metadata;
rollback requires ID + queued status + the same submission. Advanced execution,
completion, cancellation and later retries are never reverted. An uncertain
handoff returns an actionable conflict, not claimed success. Refusal of an
unclaimed submission still restores the original failed metadata/error exactly,
preserving independently appended recovery history.

Evidence (overlapping, do not sum):
- `node --import ./scripts/register-src-loader.mjs --test src/lib/waveyard/separation/retry.test.ts`: 13 pass, including five advanced statuses and queued ABA.
- `node --import ./scripts/register-src-loader.mjs --test tests/acceptance/separation-crash.test.ts`: 44 pass. Added actual PostgreSQL/native controlled-worker completion followed by lost acknowledgement; four published stem objects remain checksum-valid and complete after reconciliation.
- `npm run typecheck`: pass after cycle 1.

The native matrix uses controlled PCM/CLI, not trained inference. Its Linux
SIGKILL cases are genuine process termination; this does not establish Windows,
Electron, reboot, subjective audio quality or live-provider acceptance.

Final exact-revision checks and later cycles are recorded below when executed.

## Cycle 2: conversion lost acquisition rights

Real PostgreSQL/native FFmpeg reproduction: authorized WAV → FLAC completed,
but `getTrack` returned `rights: null` instead of the original attribution and
notice (`campaign-provenance-before.json`). The converted source was ingested
with the default local-upload provenance.

Fix: carry the existing acquisition method/URL/notice through normal ingestion,
with immediate parent source ID/checksum and processing job ID in existing
acquisition metadata. No new identity table, licence inference, or audio rewrite.
Normalize absent source URLs in existing-intake comparisons so a legitimate
local-upload publication can reconcile after a lost completion acknowledgement.
Corrupt/unknown provenance fails closed; verified objects remain recoverable.

`node --import ./scripts/register-src-loader.mjs --test src/lib/waveyard/conversion/provenance.test.ts`:
3 pass (parent plus two subtests). Covers WAV → FLAC → AIFF with inherited
rights, repeat completion, local unknown-rights, interrupted library handoff,
and malformed JSON/null/array → durable failed job → provenance repair → same
verified bytes → completion. Uses actual PostgreSQL, FFmpeg and full decode;
controlled PCM, not model/provider/music-quality evidence. `npm run typecheck`
passes. The intermediate harness failure is retained: it initially omitted
`assert.rejects` around the intentionally corrupt provenance execution, which
correctly rejects as well as persisting failure. The final test asserts both.

## Cycle 3: Studio attribution bundle

Regression before implementation: the actual export download handler returned
`audio/wav`, not a portable attribution bundle (`campaign-bundle-before.json`).
Library acquisitions were not represented in Studio downloads.

Fix: `download=1` now packages exact published WAV/MIDI + `RIGHTS.txt` +
`export-manifest.json` with the existing bounded verified ZIP implementation.
Manual/automatic versions capture notices inside the existing immutable version
snapshot, with source checksum identities and every referenced lane. The UI
explicitly labels the ZIP. Legacy current-acquisition evidence and extra MIDI
analysis-source evidence are labelled, not backdated. Unknown permission remains
unknown. Invalid/incomplete frozen notices, owner-mismatched references and
MIDI source checksum drift refuse the bundle. Preview remains raw audio. No
new dependency, audio renderer, storage registry or schema migration.

Evidence (overlapping, do not sum):
- Delivery regression: 4 pass (parent + 3 subtests), actual PostgreSQL/handlers/storage and independent Python ZIP/CRC extraction. Seeded publication receipts, not a renderer claim. Covers unchanged media, frozen notices despite later acquisition changes, legacy unknown rights, malformed/incomplete frozen snapshots, owner fencing, an additional MIDI source, changed source identity, corrupt media and raw preview.
- Library + bundle integration: 34 pass. Existing actual FFmpeg render/decoded spectral/timing assertions are preserved; download tests now independently extract/verify ZIP bytes before those assertions. Raw-preview render coverage remains raw.
- Connected real licensed music/browser acceptance: 1 pass, 18,029 ms including process startup. Production UI/HTTP/PG/native conversion/Web Audio/session reopen/Studio render/download/independent ZIP+decode. Existing maximum sample error `5.9664249420166016e-5`, 959684 stereo 44.1 kHz frames; integer-ms grid difference remains -21 frames, not claimed sample-exact grid duration. Unknown local-upload licences are explicitly tested, not inferred from embedded lyrics. This first exploratory run's receipt is in its raw log; final exact-revision run will retain actual media separately.
- Typecheck/build pass; lint 0 errors, existing 49 warnings.

Intermediate failures are retained, not hidden: the first delivery harness lacked
the explicit passthrough bridge; a Buffer-vs-Uint8Array deep-equality failure
compared equal bytes with different prototypes (full raw output compressed); two
old download tests tried to decode ZIP as WAV and were upgraded to independent
ZIP extraction without weakening their audio checks; one broad harness edit
mistakenly applied ZIP extraction to raw preview and was corrected, retaining the
raw MIME assertion. These are distinct from the reproduced missing-bundle defect.
See `docs/STORAGE.md` for delivery semantics and limits. Desktop MIDI generation,
installed Windows/Electron, legal clearance and trained inference are not proved
by these bundle tests.

## Cycle 4: export cleanup destroyed committed audio after lost COMMIT ACK

Actual PostgreSQL + native FFmpeg reproduction: commit the normal export
transaction, then throw as if its acknowledgement was lost. The completed job
and asset row survived, but `finally` deleted the audio because a local boolean
was still false. `campaign-export-ack-before.json` retains the failed existence
assertion. The same local-boolean deletion existed in server WAV and MIDI paths.

Fix: one shared publication/cleanup boundary in existing DSP infrastructure.
Publication locks the job before inserting its asset. Cleanup takes the same
row lock, proves attempt ownership from its job-scoped key, and checks canonical
export/source/stem references before deleting. Unknown lookup/storage outcomes
retain the file. Completed/cancelled states fence late progress and failure
writes. All three desktop/server publication paths use the same boundary.
Unknown output is identifiable by durable job ID in its existing private storage
path; this is not a second output registry or an automatic orphan sweeper.

Evidence: combined bundle/native export and shared-boundary tests **14 pass**.
Includes actual local FFmpeg lost-COMMIT-ACK → checksum-valid completed asset →
redispatch without replacement; cancel after upload → no asset/no resurrection;
controlled publication/lookup outage → retained bytes and actionable durable
uncertainty → healthy explicit reconciliation. Actual PostgreSQL tests separately
prove rollback cleanup, cross-table reference protection, wrong-attempt refusal,
cancel fence, two concurrent publishers → exactly one asset, and independent
`pg_stat_activity` observation of cleanup blocked on the publication lock until
COMMIT. Primitive tests use controlled bytes, not rendered/model output.

The independently locked worker dependencies were installed with
`npm ci --ignore-scripts` in `waveyard-worker` (no manifest/lock changes).
Root and standalone worker-export dependency-graph typechecks pass with both
installations present. The first root typecheck after that install exposed
nominal private Drizzle-driver types crossing the shared boundary (raw failure
retained). The fix preserves the caller's transaction type and bridges only the
public SQL execution API; real PostgreSQL tests pass with both packages installed.
The standalone command uses `/home/user/campaign-worker-tsconfig.json`, extending
`waveyard-worker/tsconfig.json` and including `apps/worker/src/export.ts` plus its
transitive dependencies; this is not a claim that all legacy worker tests or
web apps compile. Server WAV/MIDI callers are typechecked and use the tested
shared boundary; their full queue/MIDI-analysis runtime is not newly exercised.
Abrupt export-process SIGKILL/restart, automatic orphan reconciliation and
installed Windows/Electron remain limitations, not awarded passes.
