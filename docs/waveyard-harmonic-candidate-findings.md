# Waveyard harmonic candidate: verified-source findings

## Decision

Candidate 0.2.0 stays offline. A new local rerun verified all six pinned
original recordings and all eight pinned stems, then measured 16 domains:
original mixes, each isolated stem, and two recombined instrumental beds. The
source and stem WAVs were not regenerated or modified. Raw measurements are in
the ignored `generated-artifacts/waveyard-real-world-acceptance/harmonic-candidate-pinned-domain-rerun.json`.

The candidate and production detector disagree substantially on some isolated
stems, but neither has an adjudicated chord reference. Their named-output
coverage cannot establish precision, recall, F1, root/quality accuracy, or
musical usefulness. No production promotion is supported.

## Six exact original-source comparisons

The production detector uses fixed two-second windows. Candidate segments are
variable-length, at most about one second, with additional detected change
points. Their denominators differ; compare these rows as diagnostics only.

| Source | Production named / windows | Candidate named / segments | Candidate segment abstention | Candidate analysis time | Additional sampled peak RSS |
|---|---:|---:|---:|---:|---:|
| September | 20 / 108 | 70 / 355 | 80.3% | 2.70 s | 31.1 MiB |
| Another One Bites the Dust | 20 / 112 | 67 / 271 | 75.3% | 2.39 s | 5.3 MiB |
| I Feel It Coming (80s remix) | 49 / 130 | 111 / 427 | 74.0% | 2.45 s | 2.5 MiB |
| Stayin' Alive (Reflex revision) | 18 / 186 | 137 / 602 | 77.2% | 3.68 s | 2.9 MiB |
| I Want to Break Free (Reflex revision) | 69 / 203 | 36 / 493 | 92.7% | 3.86 s | 4.3 MiB |
| Blinding Lights (80s remix) | 12 / 115 | 64 / 290 | 77.9% | 2.17 s | 2.7 MiB |

Candidate analysis time excludes audio decoding. In this local run it completed
each 215–406 second track in 2.17–3.86 seconds. Peak RSS was sampled in the
parent process every 10ms while the analyzer ran on a worker thread; additional
RSS is the observed peak minus the process RSS immediately before that worker
started. The observed maximum was 31.1 MiB, below the 128 MiB limit. This is a
local benchmark, not a measurement of the app's deployed worker queue or UI
responsiveness.

The production counts match the prior reported source baseline exactly. The
candidate named counts range from 36 to 137 despite lacking any independent
labels. This is not an accuracy result; unsupported-prediction rate remains
unknown. Some songs produce hundreds of short change segments. Their boundaries
and chord identities still need blind human review.

## New pinned source, isolated-stem and instrumental-bed run

The runner independently verified all six originals and all eight stems against
`scripts/fixtures/waveyard-musical-evaluation.json`. For each input, the table
reports the proportion of the timeline covered by named output (`root` present
and `quality` known), not the proportion of correct chords. Duration-weighted
coverage is more comparable than event counts because production emits fixed
two-second windows while the candidate emits variable-length segments.

| Track / domain | Production named-time coverage | Candidate named-time coverage | Candidate runtime |
|---|---:|---:|---:|
| September — original mix | 18.6% | 21.8% | 1.98 s |
| September — bass | 31.6% | 15.6% | 1.92 s |
| September — drums | 11.2% | 9.2% | 1.97 s |
| September — vocals | 26.0% | 22.8% | 1.97 s |
| September — other | 28.8% | 29.9% | 1.91 s |
| September — recombined instrumental bed | 16.7% | 16.8% | 2.02 s |
| Another One Bites the Dust — original mix | 18.0% | 25.9% | 1.97 s |
| Another One Bites the Dust — bass | 23.7% | 8.5% | 1.98 s |
| Another One Bites the Dust — drums | 3.9% | 10.6% | 1.94 s |
| Another One Bites the Dust — vocals | 10.8% | 24.2% | 1.95 s |
| Another One Bites the Dust — other | 9.0% | 25.9% | 2.01 s |
| Another One Bites the Dust — recombined instrumental bed | 6.3% | 16.6% | 1.98 s |
| I Feel It Coming (80s remix) — original mix | 37.7% | 29.0% | 2.42 s |
| Stayin' Alive (Reflex revision) — original mix | 9.7% | 26.8% | 3.39 s |
| I Want to Break Free (Reflex revision) — original mix | 34.0% | 7.5% | 3.49 s |
| Blinding Lights (80s remix) — original mix | 10.5% | 22.2% | 2.00 s |

The candidate took 1.91–3.49 seconds per 215–406 second recording. Its largest
sampled additional worker RSS was **33.4 MiB**; peak process RSS for the whole
run was **278,687,744 bytes**. This is a local sequential measurement, not a
deployed worker responsiveness or concurrency benchmark.

The strongest actionable result is disagreement, not a winner. On the Queen
instrumental bed the candidate names 16.6% of timeline versus 6.3% for
production; on September the two are nearly equal at 16.8% and 16.7%. The
candidate also labels appreciable portions of vocal and `other` stems. These may
contain useful harmonic information or false positives; coverage alone cannot
distinguish those explanations. No analyzer accuracy or improvement is claimed.

## Input provenance and remaining accuracy gap

All six source and eight stem SHA-256s matched the manifest in the latest
rerun. The exact stem paths are:

- `generated-artifacts/waveyard-real-world-acceptance/earth-wind-fire-stems/{bass,drums,vocals,other}-estimate.wav`
- `generated-artifacts/waveyard-real-world-acceptance/another-one-stems/{bass,drums,vocals,other}-estimate.wav`

Do not replace these pinned files with new separations: those would be different
inputs and would not prove the historical stem association.

## Accuracy and musical acceptance

The harmonic annotation template fixes a whole-song development/held-out split
and requires two independent, locked chord timelines plus adjudication. The
evaluator currently returns `blocked-reference-annotations-incomplete` with
all chord metrics null. It is not appropriate to derive reference chords from
the source mix, the previous provisional form notes, or the candidate output.

The synthetic suite now verifies that sequential arpeggio notes abstain instead
of becoming a simultaneous chord, low C1 ambiguity stays unknown below the
existing 0.04 margin, adjacent chords retain a detected boundary, and generated
candidate HarmonyEvents change the existing mashup passage ranking in favor of
a fitting bed interval. Existing production tempo/key confidence gates still
withhold automatic tempo or pitch movement when their own evidence is weak.
These checks verify software contracts; they do not establish that a rendered
real-song mashup sounds good.

Remaining human work is to establish the review rights basis, obtain two blind
full-song chord timelines and change-point annotations for the six exact source
files, lock and adjudicate them, then rerun the held-out evaluator without
tuning on those labels. A separate stem-domain result requires the eight exact
pinned artifacts or a separately authorized, explicitly new separation study.
