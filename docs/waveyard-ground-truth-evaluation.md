# Independent full-track Waveyard ground truth

## Status

This is a reproducible evaluation protocol and a versioned annotation template—not a completed ground-truth dataset. The exact user-provided MP3s are present in the current Replit workspace under `attached_assets/` (ignored by Git), and their SHA-256s match the prior production route manifest. They are not bundled in the repository and may be absent in other checkouts. Rights evidence for third-party review, two independent reviews, adjudication, and a complete prediction snapshot are still missing. The evaluation command therefore emits a blocked report with null metrics rather than substituting algorithm-generated labels.

The target pair and expected durations follow the prior production handoff: _Another One Bites the Dust_ (222.67 s) and _September_ (215.14 s). The current workspace source identities are recorded in the template. A fresh production route run captures the full feasible bed rankings for all 17 voice-bearing donor windows in the ignored `generated-artifacts/waveyard-real-world-acceptance/full-track-ground-truth-predictions-capture.json`. Keep that algorithm output away from annotators until both independent annotation files are locked. The capture is not yet a complete evaluation snapshot: per-track vocal-phrase and section prediction arrays still need to be exported. Titles and durations alone do not establish licensing. Before any second reviewer receives or opens the audio, establish that the copies and review are authorized; do not redistribute the recordings or derived mixes.

## What is versioned

- `scripts/fixtures/waveyard-ground-truth/ground-truth-v1.template.json` stores source identity and rights fields, two independent blind-review slots per recording, and a separate adjudicated result. No source audio or fabricated annotations are included.
- `scripts/fixtures/waveyard-ground-truth/predictions-v1.template.json` is the capture shape for a production run. The passage-search route now exposes every ranked bed candidate it already computed, plus the actual selected candidate, its source checksum, time window, relative score, and detector confidence. This is output instrumentation only: it does not change candidate scoring, compatibility gates, or selection behavior. The plan JSON remains the persisted record.
- `scripts/waveyard-ground-truth-evaluation.mjs` validates source/rights/reviewer provenance and calculates metrics only after the dataset is adjudicated and has at least 95% section-timeline coverage.
- `scripts/waveyard-ground-truth-evaluation.test.mjs` checks evaluator behavior with synthetic fixtures only. Those tests are not real-song evidence.

## Annotation protocol

1. The two exact source copies used by the prior production run are currently available as ignored user-uploaded attachments in this Replit workspace. Verify each against the template SHA-256 before review. Keep audio outside Git; record the original filename, SHA-256, duration, license/source URL, and rights basis in the dataset only when known. Do not infer rights from song titles or redistribute source audio or derived mixes. If authorization for independent review cannot be established, leave that evidence missing and keep the result blocked.
2. Give each reviewer only the recordings and blank annotation instructions—not this repository, handoff, Waveyard analysis, scores, selected windows, or the other reviewer's work. Have them independently annotate both complete recordings. Mark section intervals using the controlled labels in the template. Mark uncertain boundaries or section identity as `ambiguous`/`unknown`, not as a forced semantic label. Mark vocal-phrase start/end intervals and their certainty.
3. Independently judge the vocal/bed window pairs for musical usefulness by listening to the pair; use `useful`, `not-useful`, or `ambiguous`. Randomize pair order and hide algorithm rank and score. Rhythm resemblance alone is not evidence of harmonic compatibility. Include the full candidate universe intended for the reported recall metric; otherwise report only recall within the adjudicated pool.
4. Lock both review files before adjudication. Preserve the original reviews, a list of disagreements, the resolution method, and the adjudicated intervals. Do not copy analyzer labels into either human review.
5. Capture the exact production plan from the same source files, including the 40-character producer revision, capture time, and source SHA-256s. Copy each donor evaluation's `rankedBedCandidates` without reordering or rescoring. The selected candidate is rank 1 in the serialized selection order. Historical reports that only recorded the winning candidate cannot be expanded into a complete ranking after the fact; rerun the exact inputs.

## Metrics and interpretation

- Passage detection uses one-to-one maximum-cardinality matching over interval pairs with IoU >= 0.5, preferring stronger overlaps, and reports precision, recall, F1, and matched start/end boundary error. Confident human vocal intervals are scored; ambiguous intervals are excluded from both false negatives and false positives.
- Section classification accuracy is measured only on matched, confident, non-`unknown` human labels. This tests labels, not musical compatibility.
- Candidate ranking reports top-1 accuracy, MRR, and Recall@K against adjudicated useful bed windows. Unjudged or ambiguous pairs are never negative labels; affected donor windows are listed as unjudged. The report states the adjudicated candidate universe, so Recall@K must not be generalized beyond it.
- Section coverage is reported per source. Less than 95% coverage blocks full-track metrics; reviewers should mark reviewed-but-uncertain intervals as unknown rather than leave gaps.

The report does not measure perceived mix quality, vocal quality, transition smoothness, loudness, clipping, or WAV render correctness. Those need a separate blind listening/render acceptance test.

## Reproduce the current blocked report

```sh
node scripts/waveyard-ground-truth-evaluation.mjs \
  scripts/fixtures/waveyard-ground-truth/ground-truth-v1.template.json \
  scripts/fixtures/waveyard-ground-truth/predictions-v1.template.json \
  scripts/fixtures/waveyard-ground-truth/pending-report-v1.json
```

The expected status is `blocked`, with no performance metrics. The template pins the exact source hashes observed in this Replit workspace; the prediction template remains empty because the route capture is not yet a complete per-track evaluation snapshot. Once review authorization, both blind reviews, adjudication, and a checksum-matched production snapshot are available, save completed inputs as new versioned files and pass those paths to the same evaluator. Do not overwrite the templates or represent this pending report as real-song validation.
