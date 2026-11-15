# Waveyard v0.2.0 acceptance readiness

## Decision

Keep v0.2.0 offline. The six original recordings have prior hash-verified
candidate measurements documented in
[`waveyard-harmonic-candidate-findings.md`](./waveyard-harmonic-candidate-findings.md).
The current checkout no longer contains those private source files, and this
run did not regenerate the measurements. The eight exact stem assets and all
independent chord annotations are still absent. There is no accuracy result
with which to accept or reject v0.2.0 against production.

## Exact external stem inputs

Restore the exact files from the canonical Waveyard workspace at the paths
below. Preserve their bytes and path names. A fresh separation is a different
experiment and must not be substituted for the pinned historical inputs.

| Track | Role | Canonical artifact path | Required SHA-256 |
|---|---|---|---|
| September | bass | `generated-artifacts/waveyard-real-world-acceptance/earth-wind-fire-stems/bass-estimate.wav` | `5004bd6b820f491f5c2831661433e174be76b214c4175ca48720b791ad707020` |
| September | drums | `generated-artifacts/waveyard-real-world-acceptance/earth-wind-fire-stems/drums-estimate.wav` | `c4b878fc4f0e80d4854f6e5fad9d37225a53fdb0b9d1f832de340b07e3c094a0` |
| September | vocals | `generated-artifacts/waveyard-real-world-acceptance/earth-wind-fire-stems/vocals-estimate.wav` | `2d8cb1ed15d1909df0253349c60690604f91ec5ad56dd31ae6ace6d540481a53` |
| September | other | `generated-artifacts/waveyard-real-world-acceptance/earth-wind-fire-stems/other-estimate.wav` | `d6404476c807c321201b57296e5d038c783e3f9461b8b2cd09bd963d83904c95` |
| Another One Bites the Dust | bass | `generated-artifacts/waveyard-real-world-acceptance/another-one-stems/bass-estimate.wav` | `c872e9da615ce359ed5d08c7e51a3a9b5e617aaf8866b567fc8c01b70fdb5608` |
| Another One Bites the Dust | drums | `generated-artifacts/waveyard-real-world-acceptance/another-one-stems/drums-estimate.wav` | `dd572546aaafa38a05187cd83dd7f35f5badae71fd6c1efc5d912ef20c67fc14` |
| Another One Bites the Dust | vocals | `generated-artifacts/waveyard-real-world-acceptance/another-one-stems/vocals-estimate.wav` | `633637f01a267f1fe43f2beb8e9efd23a4ed822d26784eb146fe97ce3740a44f` |
| Another One Bites the Dust | other | `generated-artifacts/waveyard-real-world-acceptance/another-one-stems/other-estimate.wav` | `13c498b7a54cd6689cbd372a16b34603fbd5d40008a22733594d6aad73d8f91c` |

Once restored, verify each file against
[`waveyard-musical-evaluation.json`](../scripts/fixtures/waveyard-musical-evaluation.json)
before running the candidate runner. The runner records the audio container,
duration, codec, sample rate and channel layout when `ffprobe` is available,
then validates decoding to mono 22.05 kHz analysis PCM. It requires all four
stems and equal decoded lengths. The recombined instrumental bed sums bass,
drums and other; vocals are verified but excluded. Equal lengths alone do not
prove phase, gain or historical source association.

## Human annotations

The blank packets are generated from
[`harmonic-chords-v1.template.json`](../scripts/fixtures/waveyard-ground-truth/harmonic-chords-v1.template.json).
Two reviewers must independently label each exact source, at least 95% timeline
coverage, using the assigned blinded packet. The merge command checks slot
identity, distinct reviewer IDs, hashes, interval validity and coverage; it
preserves original timelines and file hashes, then produces a disagreement
queue. Reviewer identity and independent work still require owner verification.
The study owner must record an acceptable sharing basis before sending private
audio to another person. Rights text entered in a packet does not itself grant
clearance. After a qualified human adjudicates disagreements, populate the
adjudicated timelines and run the evaluator.

Current source-mix annotations do not apply to individual stems or the
instrumental bed. Those require their own domain-specific blind references.
The evaluator compares candidate and production on the same reference and
reports paired, song-level candidate-minus-production macro-F1. The held-out
partition contains two songs, so its interval is descriptive only.

## Production use path and evidence boundary

Production still calls `detectHarmonyTimeline` in
`lib/arena/src/lib/waveyard/worker-local/analysis-engine.ts`. Existing local
harmony events flow into the mashup planner's harmony comparison and
`scoreVocalChordToneFit` in `lib/arena/src/lib/waveyard/studio/mashup.ts`;
the planner regression verifies a controlled ranking change when candidate
events are supplied to that interface. v0.2.0 remains a separate offline
candidate runner. No database, production detector, confidence threshold or
runtime selection path is changed here. A planner ranking unit test is not a
real-source mashup, completed separation-to-database route, or listening test.

## Engineering validation

This increment passed the 12 focused packet/evaluator tests and the workspace
typecheck. Previous focused harmonic/planner and build evidence is recorded in
[`HANDOFF.md`](./HANDOFF.md). The broad repository test sweep remains
incomplete. Its known failure classes are PostgreSQL/service prerequisites,
network-dependent assertions, Windows sandbox filesystem restrictions,
route/test-harness assumptions and a worker URL import failure. The test batch
that stalled was stopped; this does not establish a complete failure inventory
or a passing repository-wide suite. There is no lint script in the workspace.

## Completion gates

1. Recover eight exact stems and verify every listed hash.
2. Obtain two independently reviewed, owner-verified chord timelines for all
   six sources, adjudicate them, and confirm the sharing basis.
3. Run the candidate and unchanged production detector on original sources,
   individual stems and the bass+drums+other instrumental bed.
4. Run the evaluator against adjudicated references and review held-out paired
   metrics without tuning on held-out labels.
5. Run the required broader engineering validation and triage the known
   environment/test-harness failure classes.
6. Write a final acceptance decision. Production remains unchanged until then.
