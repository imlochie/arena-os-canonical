# Harmonic perception: bounded investigation, replacement rejected

## Decision

Production remains at the harmonic implementation in `2b0781e2`.
**No replacement passed the real-recording gate.** No threshold was lowered,
provider installed, database migrated, separation restarted, renderer changed
or production harmony version advanced.

This is a completed investigation, **not completion of the harmonic-perception
upgrade**. The six controlled prototype tests passed, but that did not establish
real musical correctness. The unsuccessful candidate was removed from runtime
source, with its code and tests preserved in a private workspace patch.

## Verified checkout and inputs

Work stayed on `arena/669984d8-arena-os-canonical`; the investigation started at
`2b0781e27244c57927d904f7ea785f796b83b9be`. Origin agreed and the working tree
was clean before the experiment. No branches or worktrees were created.

Inputs were verified against `scripts/fixtures/waveyard-musical-evaluation.json`,
SHA-256 `cb45c97f59bca06e0b4d990ed7d6dc3af00e99b851661f0bc900f5b90b68447f`.
Both complete four-stem sets were used for instrumental-bed probes. All six
original uploads were used for source controls; no additional stems exist for
the other four. Bytes remain private and excluded from Git.

## Architectural findings

- `worker-local/analysis-engine.ts:chromaFromPcm` adds six harmonics for every
  candidate from C2 through B6. An unplayed candidate can receive salience from
  another note's partials even when its own fundamental is absent.
- The same key-oriented chroma is reused by `detectHarmonyTimeline` in independent
  two-second windows. Those windows can contain arpeggios, different chords,
  percussive energy and changing voicings. Named-window count is not correctness.
- `types/harmony-analysis.ts:matchHarmonyChroma` already uses normalised templates
  and the 0.04 margin. The remaining limitation cannot be attributed solely to
  the additive-template defect corrected previously.
- The sampled spectra contain substantial bass energy below the extractor's
  C2 floor: 21.14% for September and 30.45% for Queen, measured over the
  instrumental-bed audit's FFT frames, relative to energy at/above 20 Hz.
  This includes percussion; it is not a measure of bass-note accuracy.
- Peak-derived global tuning concentration was weak (0.222 and 0.083 on the
  same audit). A +14.73/-29.71 cent circular mean is therefore **not** sufficient
  justification for retuning either recording.
- Production source/stem jobs remain in `worker-local/stem-analysis.ts`, with
  independently versioned harmony persistence. Existing passage/arrangement
  ranking consumes eligible observations through `scoreVocalChordToneFit`.
  No separate planner or harmonic scoring subsystem was introduced.

## Controlled alternatives and complete-bed results

All rows used the same two full instrumental-bed inputs and unchanged
0.04 chord-template margin. These are availability counts, not accuracy.

| Method | September | Queen |
|---|---:|---:|
| Production baseline | 18/108 | 7/112 |
| Cap partial support by observed fundamental | 16/108 | 9/112 |
| Fundamental-only diagnostic | 19/108 | 14/112 |
| Final harmonic-fit candidate with temporal pitch-class support | 3/108 | 6/112 |

The final candidate fitted sparse, nonnegative overlapping note spectra, with
fundamental-only and two harmonic-decay profiles. It included C1 bass range,
a local broadband floor and a temporal/frequency soft harmonic mask. It did
not time-stretch or retune audio.

Temporal corroboration used the selected chord's pitch classes, not a requirement
that every short frame independently identify the whole chord. The latter
rejects legitimate arpeggios. The final candidate required at least two frames
and a majority of active frames with at least 75% pitch-class support.
It never filled an unknown passage using neighboring chord labels.

Six controlled tests passed: F-major phantom-note rejection; a dense harmonic
mixture with noise; single-note overtones/noise/silence abstention; missing and
contradictory temporal evidence; low inverted bass; and known arpeggio context.
**Those tests are not grounds for enabling the candidate.** It did not improve
the complete-bed availability result. Without independent chord references,
the precision/recall tradeoff of its rejected labels is unknown.

## All-six original-recording controls

The production detector scanned each full original upload. Separately, the
candidate's spectral fit was measured on five predetermined two-second probes
at 5%, 25%, 50%, 75% and 95% of the available start-position range.
**Candidate probes are sampled diagnostics, not full-track candidate acceptance.**

| Original recording | Production named windows | Median sampled candidate spectral fit |
|---|---:|---:|
| September | 20/108 | 0.42236 |
| Another One Bites the Dust | 20/112 | 0.48964 |
| I Feel It Coming — 80s remix | 49/130 | 0.80210 |
| Stayin' Alive — Reflex revision | 18/186 | 0.58892 |
| I Want To Break Free — Reflex revision | 69/203 | 0.77126 |
| Blinding Lights — 80s remix | 12/115 | 0.70698 |

Fit is the fraction of processed spectral squared energy explained by the
candidate's note dictionary. It is **not chord confidence or pitch accuracy**.

For the first two songs, the same five probes on the sum of all four cached
stems had median fit 0.26565 and 0.28562, lower than the original controls.
Original-to-recombined unaligned sample correlations were 0.85428 and 0.87910.
These observations warrant examining cached separation artifacts, but do not
prove a separation defect: alignment, gain, phase, publication provenance and
perceptual quality have not been adjudicated. Both original recordings also
have sparse production chord availability. Do not blame the entire problem
on separation, or present original-mix controls as instrumental-only evidence.

## Preserved evidence in this workspace

Under ignored `generated-artifacts/waveyard-note-harmony/`:

- `report-baseline-2b0781e2.json`: prior full-recording production baseline.
- `extraction-audit.json`: final complete-bed experiment and spectral diagnostics.
- `input-control.json`: all-six controls, fixed probe positions and source hashes.
- `rejected-harmonic-fit.patch`: unshipped candidate and its six tests.
- `audit.ts`, `input-control.ts`: experiment drivers, not production entry points.
- `rejected-fit-summary.log`, `input-control-summary.log`: recorded summaries.

These files are workspace evidence, not files published on GitHub. Replaying
the candidate requires the private pinned recordings and the archived patch;
it is intentionally absent from runtime source. Do not silently enable it.
The production code and its prior persisted workflow checks were not changed.

## Budget boundary and next decision

Stop parameter iteration here. A larger harmonic front-end investigation is
required before selecting a replacement: compare tuning-aware, multiresolution
pitch/chroma extraction with temporal harmonic context, using license-compatible
local implementations. Keep original, instrumental-bed and recombined-stem
controls separate. Benchmark measured runtime/memory before enabling a heavier
implementation: the experimental fit is materially more expensive than the
current synchronous extractor, which would need cooperative or worker execution
before being put on the API path.

The follow-on must also obtain reference chord/boundary labels before claiming
accuracy, false-positive reduction, calibrated strong/probable confidence or
better listening quality. Do not fill gaps or expand semantic labels simply
to make coverage look better.
