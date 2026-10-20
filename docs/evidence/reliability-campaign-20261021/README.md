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
