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
missing adjudication, or less than 95% timeline coverage. It compares adjudicated
timeline bins, reports per-song and per-partition chord/root/quality metrics,
abstention and unsupported named predictions, and one-to-one chord-change timing
within the declared two-second tolerance. Macro-F1 confidence intervals resample
whole songs, never time bins. Metrics remain null while annotation is incomplete.
The test fixture for evaluator arithmetic is synthetic and is not musical
accuracy evidence.

## Remaining human review

The owner or reviewers must provide two locked, independent full-song chord
timelines and boundary marks for all six exact sources, then adjudicate them.
Rights metadata must be completed before external sharing. No independent chord
labels currently exist; the prior approximate form notes are not a substitute.
