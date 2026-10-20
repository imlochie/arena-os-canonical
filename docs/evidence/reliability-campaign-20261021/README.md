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

## Continuation: delivery-client compatibility and real queue proof

The first broad freeze was `3b3ee39`; static type/lint/build/desktop and retained
connected music passed, as did 44 native separation crash cases. While reviewing
all download clients, the real Studio FX acceptance reproduced a remaining
contract mismatch: older clients decoded the ZIP itself as WAV. The partial
full-source run was explicitly stopped (receipt exit 1, 103813 ms); it is **not**
a full-suite pass. Hosted browser/A7 jobs on that intermediate head failed for
the same download-contract transition; their history is not overwritten.

Existing acceptance consumers and the real-music CLI now retain/read the bundle
before the same audio/spectral/identity checks. A strict, Node-only canonical ZIP
reader checks directory/header/descriptor consistency, CRC, SHA-256/size, exact
entry names, job/version identity and required notices; it never extracts an
untrusted path or infers permission. Three reader tests pass, including actual
WAV/MIDI-shaped archive entries and corrupt/truncated/wrong-checksum/missing or
extra notice rejection. Independent Python ZIP extraction remains in connected
music/delivery/library tests; the new reader does not replace that independent
implementation.

Updated complete Studio/browser/native-worker suite: **35 pass / 2 explicit
trained-inference skips**, 348761 ms; raw output retained. Includes actual local
and isolated server WAV render parity after source outage/retry, as well as
unchanged FX/gain/polarity/timing checks. Other pre-existing product checks in
this suite are regression coverage, not new Arcade/Spaces work or credit.

Real export-lease acceptance initially failed because `redis-server` was absent
(raw ENOENT retained). Rather than substitute a mock, Redis 7.2.12 was built from
GitHub tag commit `9913c926510755fa0d241658f550338a02258edb` outside the repository:
source archive SHA-256 `e66253c339d0b7130d7bbebef7ca32d23a53f538dca0765fa9eaa62a72415024`,
`make -j2 MALLOC=libc REDIS_CFLAGS='' REDIS_LDFLAGS='' redis-server`.
No application dependency or lockfile changed. With that binary on PATH, the
actual PostgreSQL/Redis/BullMQ worker acceptance passes (1 test, 61866 ms): stale
worker cannot revoke completion; interruptions at resolve/render/FFmpeg/
validation/publication/commit/complete recover one checksum-valid asset with
zero sample error against the native reference. Raw log's pre-existing
`Redis7.2.6` label was inaccurate for this binary; the receipt producer now reads
`redis-server --version` instead of hardcoding a version. The final rerun will
record the actual version. This adds genuine server WAV/queue evidence to cycle
4; full server MIDI-analysis execution and installed Windows remain unverified.

## Cycle 6: exact copied export sources were never verified

Confirmed P0, not an inferred risk: a real standalone worker, PostgreSQL,
private storage and native FFmpeg exported a valid WAV after one PCM byte had
changed without updating its saved checksum. It reported `complete` and one
asset, instead of refusing the changed source. Original SHA-256:
`c35c13a02b1c60aa3dcea86f2329d7facaf933ba1ee7bbb8d25ff9fd8331e226`;
changed SHA-256:
`8fa9418d5127fe702d0cb42337322c53915f251632c52d3b2a22b99e28cbb8a2`.
The local production executor also failed the two newly added negative cases.
Raw failures are retained in `raw/source-identity-{standalone,local}-before.txt`.

Both renderers copied referenced stems into private working files without
checking those bytes. Output verification cannot establish input identity.
They now call the existing shared SHA-256/size/file-stability verifier on EACH
actual private copy, after copying and before FFmpeg consumes it. Verifying the
storage object before copying would miss faulty provider/copy results. Failures
persist `source_identity_unverified`, publish no asset, and explain restoration
and retry without treating every IO failure as corruption. Existing output
messages remain unchanged; the helper accepts a source-copy diagnostic label.
No metadata identities are rewritten and no substitute audio is rendered.

Permanent regressions cover changed stored bytes, changed private-copy bytes
(same-length, decodable WAV), an acknowledged copy with missing bytes, and
repair/re-execution of the SAME frozen request. The standalone fixture uses
actual PostgreSQL/storage/native FFmpeg, checks output SHA, independently fully
decodes the repaired output, and verifies previous committed outputs survive
later source faults. Library render fixtures now materialize real checksum/size
metadata BEFORE their immutability snapshot; production checks were not bypassed
for catalogue-only placeholder hashes. All pre-existing audio assertions remain.
The standalone test is also part of the existing hosted native acceptance step.

Focused command:
`node --import ./scripts/register-src-loader.mjs --test tests/acceptance/export-source-identity.test.mjs src/lib/waveyard/export-bundle.test.ts src/lib/waveyard/library/service.test.ts`
→ **42 pass, 0 fail, 14,897 ms** (overlapping parent/child counts; not 42 distinct
workflows). Raw: `raw/source-identity-focused-pass.txt`. Controlled PCM, NOT
trained inference or live cloud-provider evidence. The repaired standalone
outputs are 176,478 bytes, SHA-256
`e8026540aa00fa9c9b7953d717216db661fbebbd21b168d9b45ed4100680baef`.

New-harness failures are retained rather than erased: its first fidelity check
incorrectly assumed unity-centre pan, whereas Studio's existing legacy/live
acceptance explicitly uses sqrt(0.5) at centre. No audible law changed. The
subsequent one-PCM16-LSB numerical assumption also failed (maximum error
0.0000484459); the new check uses a documented two-LSB numerical bound against
original PCM times that existing law, below existing Studio parity tolerances.
These were new test-oracle corrections, not relaxed pre-existing assertions.
See `raw/new-harness-*-failed.txt`. This does not claim bit-identical source/output
PCM: cryptographic input identity and rendered output identity are separate.

The previous final full-source run on b025e86 was deliberately interrupted after
this P0 reproduction. Like the earlier interrupted run it is NOT a pass. A fresh
exact committed full-source run is required below.
