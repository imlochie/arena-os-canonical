# Independent full-track Waveyard ground truth

## Status

This is a reproducible evaluation protocol and an empty, versioned annotation template—not a completed ground-truth dataset. No exact source files, file hashes, license evidence, two independent reviews, or complete prediction snapshot are available in this checkout. The evaluation command therefore emits a blocked report with null metrics rather than substituting algorithm-generated labels.

The target pair and expected durations follow the prior production handoff: _Another One Bites the Dust_ (222.67 s) and _September_ (215.14 s). Those titles and durations do not uniquely identify a recording edition, establish licensing, or prove that the current analysis used the same files. Each source must be verified by its exact SHA-256 before review.

## What is versioned

- `scripts/fixtures/waveyard-ground-truth/ground-truth-v1.template.json` stores source identity and rights fields, two independent blind-review slots per recording, and a separate adjudicated result. No source audio or fabricated annotations are included.
- `scripts/fixtures/waveyard-ground-truth/predictions-v1.template.json` is the capture shape for a production run. The passage-search route now exposes every ranked bed candidate it already computed, plus the actual selected candidate, its source checksum, time window, relative score, and detector confidence. This is output instrumentation only: it does not change candidate scoring, compatibility gates, or selection behavior. The plan JSON remains the persisted record.
- `scripts/waveyard-ground-truth-evaluation.mjs` validates source/rights/reviewer provenance and calculates metrics only after the dataset is adjudicated and has at least 95% section-timeline coverage.
- `scripts/waveyard-ground-truth-evaluation.test.mjs` checks evaluator behavior with synthetic fixtures only. Those tests are not real-song evidence.

## Annotation protocol

1. Obtain the exact full-length source copies under a documented license or permission that covers analysis and the planned private review. Keep audio outside Git; record the original filename, SHA-256, duration, license/source URL, and rights basis in the dataset. Do not infer rights from song titles or redistribute source audio or derived mixes.
2. Two reviewers independently annotate both complete recordings, blind to Waveyard analysis, scores, selected windows, and one another. Mark section intervals using the controlled labels in the template. Mark uncertain boundaries or section identity as `ambiguous`/`unknown`, not as a forced semantic label. Mark vocal-phrase start/end intervals and their certainty.
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

The expected status is `blocked`, with no performance metrics. Once licensed source identities, both independent reviews, adjudication, and a checksum-matched production snapshot are available, save completed inputs as new versioned files and pass those paths to the same evaluator. Do not overwrite the templates or represent this pending report as real-song validation.
