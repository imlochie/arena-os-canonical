# Waveyard harmonic annotation protocol

## Scope and safeguards

The versioned template at `scripts/fixtures/waveyard-ground-truth/harmonic-chords-v1.template.json`
contains the six manifest-pinned source hashes. It has no chord labels yet.
Two reviewers must annotate each exact source independently and blind to both
production and candidate predictions. Lock both files before adjudication.
Store reviewer IDs, dates, rights basis, coverage, disagreements and the
adjudicator's rationale. Never infer chord labels from owner-supplied section
notes or algorithm output.

The whole-song split is fixed in the template: four development songs and two
held-out songs. Do not use held-out annotations to adjust thresholds or code.
The current candidate was inspected on unlabeled source audio; no real-audio
labels were available for tuning. The held-out set has only two songs, so its
bootstrap interval will be broad and should not be generalized beyond these
recordings.

Before giving audio to another reviewer, establish that the exact recording may
be shared for this review. If that basis is unavailable, the owner can annotate
locally; leave reviewer fields incomplete until the record is complete and
locked. Chord intervals should use milliseconds, the controlled quality list,
and explicit unknown intervals where the sound is ambiguous or does not support
a chord. Mark the heard chord, not an inferred key or song-theory expectation.
Record change points separately from chord intervals. Do not transcribe lyrics.

## Reproduction and metrics

Generate predictions with `scripts/waveyard-harmonic-candidate-run.ts`, then run:

```sh
node scripts/waveyard-harmonic-ground-truth-evaluation.mjs \
  scripts/fixtures/waveyard-ground-truth/harmonic-chords-v1.template.json \
  docs/waveyard-harmonic-candidate-run-report.json \
  docs/waveyard-harmonic-ground-truth-report.json
```

The evaluator refuses mismatched source hashes, incomplete independent reviews,
missing adjudication, or less than 95% timeline coverage. It scores candidate
and production timelines against the same adjudicated source timeline, reports
per-song/per-partition chord, root, quality, abstention, unsupported-prediction
and chord-change metrics, and computes a paired song-level candidate-minus-
production macro-F1 interval. It resamples whole songs, never time bins. With
only two held-out songs, that interval is descriptive and not generalizable.
Metrics remain null while annotation is incomplete. Test fixtures are synthetic
arithmetic checks, not musical accuracy evidence.

The source annotations apply only to original mixes. Stem and recombined-bed
measurements are not scored against full-mix labels. To score those domains,
create separately reviewed, explicitly domain-labeled references; cross-domain
agreement is not chord accuracy.

## Creating and importing blind reviewer packets

Create two independent, blank packets from the pinned template:

```sh
node scripts/waveyard-harmonic-annotation-packets.mjs prepare \
  scripts/fixtures/waveyard-ground-truth/harmonic-chords-v1.template.json \
  generated-artifacts/waveyard-harmonic-reviews
```

The packets contain exact source hashes and durations plus a reviewer slot and
packet ID, but omit song titles,
the development/held-out split, chord predictions and candidate output. The
owner must deliver the matching hash-verified source audio separately, after
recording the rights basis. Reviewers fill only their assigned packet, including
reviewer ID, rights basis, labels, coverage and a lock timestamp. The command refuses to
overwrite existing packet files so an accidental regeneration cannot discard
review work.

After both reviewers have independently completed and locked their packets,
merge them into a new annotation template:

```sh
node scripts/waveyard-harmonic-annotation-packets.mjs merge \
  scripts/fixtures/waveyard-ground-truth/harmonic-chords-v1.template.json \
  generated-artifacts/waveyard-harmonic-reviews/waveyard-harmonic-chords-v1-reviewer-1.json \
  generated-artifacts/waveyard-harmonic-reviews/waveyard-harmonic-chords-v1-reviewer-2.json \
  generated-artifacts/waveyard-harmonic-reviews/harmonic-chords-v1-reviewed.json
```

Merge validates packet slots, distinct reviewer IDs, source hashes, chord
labels, locked status and the 95% minimum coverage. It preserves both source
timelines, hashes the exact submitted JSON bytes, creates a compact disagreement
queue, and leaves `adjudicated` null. Reviewer IDs are self-reported: the study
owner must verify identity and independent completion before accepting
submissions. Rights-basis text is a record, not legal clearance. A qualified
adjudicator must resolve disagreements before the evaluator can score. Keep
review packets and merged evidence restricted and private. Never regenerate
packets into a directory that contains completed reviews.

`reviewMerge.disagreementQueue` lists spans where reviewer labels differ; it is
a work queue, not an adjudicated answer. The original packet files remain the
authoritative submissions.

## Remaining human review

The owner or reviewers must provide two locked, independent full-song chord
timelines and boundary marks for all six exact sources, then adjudicate them.
Rights metadata must be completed before external sharing. No independent chord
labels currently exist; the prior approximate form notes are not a substitute.
