# Waveyard harmonic candidate: verified-source findings

## Decision

Candidate 0.2.0 stays offline. Six manifest-pinned source files were recovered
from the local Music library and every byte hash matched the evaluation
manifest. The unchanged production detector reproduced the documented
all-source named-window counts on all six tracks. These are source-mix results;
they do not isolate the backing arrangement.

The candidate has no adjudicated chord reference yet. Its higher or lower named
segment counts cannot establish improved precision, recall, F1, root/quality
accuracy, or usefulness. No production promotion is supported. All eight pinned
stems remain unavailable, so neither the separated-stem nor recombined-bed
domain was tested in this run.

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

## Input provenance and remaining domain gap

All six source SHA-256s are verified in
`waveyard-harmonic-candidate-run-report.json`. Source paths were resolved by
hash from the user's local library; only basenames and expected/actual hashes
are recorded. The private recordings remain outside Git.

No exact pinned stem hash was found in the local project generated-artifact
directories, local Waveyard data/blob stores, other checked project worktrees,
the local Music library or configured Dropbox search. The manifest identifies
the intended source as:

- `generated-artifacts/waveyard-real-world-acceptance/earth-wind-fire-stems/{bass,drums,vocals,other}-estimate.wav`
- `generated-artifacts/waveyard-real-world-acceptance/another-one-stems/{bass,drums,vocals,other}-estimate.wav`

The previous audit places these artifacts in the canonical Replit workspace,
but the available Replit connector exposes app lookup and prompting, not a
file-level workspace download. The precise external dependency is restoration
or export of these eight files from that canonical workspace with their expected
SHA-256s preserved. Newly separated outputs would have different hashes and
would be new evidence; they cannot stand in for the pinned stems or prove the
historical stem association.

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
