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
