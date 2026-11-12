# Independent full-track Waveyard ground truth

## Status

This is a reproducible evaluation protocol and a versioned annotation template—not a completed ground-truth dataset. The exact user-provided MP3s are present in the current Replit workspace under `attached_assets/` (ignored by Git), and their SHA-256s match the production route manifest. They are not bundled in the repository and may be absent in other checkouts. The production route now exports a complete source-bound prediction snapshot in this workspace, and its producer/source provenance validates. Rights evidence for independent review, two independent reviews, and adjudication are still missing. The evaluation command therefore emits a blocked report with null metrics rather than substituting algorithm-generated labels.

The target pair and expected durations follow the prior production handoff: _Another One Bites the Dust_ (222.67 s) and _September_ (215.14 s). The current workspace source identities are recorded in the template. A fresh database-backed production route run exports every persisted section for both sources, all 89 isolated-vocal pitch-continuity intervals for _Another One Bites the Dust_, and the complete feasible rankings for all 17 donor windows. The prediction snapshot is `generated-artifacts/waveyard-real-world-acceptance/predictions-v1-captured.json`; the full acceptance report is `generated-artifacts/waveyard-real-world-acceptance/full-track-ground-truth-predictions-capture.json`. These generated files are ignored by Git and are local to this workspace. The bed has no vocal-phrase analysis in this route direction, and the 89 donor intervals are pitch-continuity phrases, not word or syllable timing. The section engine emits structural windows/repeats, not verse/chorus/bridge/breakdown labels. Keep algorithm output away from annotators until their independent labels are locked. Titles and durations alone do not establish licensing. Before any second reviewer receives or opens the audio, establish that the copies and review are authorized; do not redistribute the recordings or derived mixes.

## What is versioned

- `scripts/fixtures/waveyard-ground-truth/ground-truth-v1.template.json` stores source identity and rights fields, two independent blind-review slots per recording, and a separate adjudicated result. No source audio or fabricated annotations are included.
- `scripts/fixtures/waveyard-ground-truth/predictions-v1.template.json` is the blank capture shape for a production run. The real route acceptance test can write a filled local snapshot with source-bound sections, persisted donor vocal intervals, and all ranked bed candidates. The passage-search route exposes candidates it already computed; this output instrumentation does not change candidate scoring, compatibility gates, or selection behavior. The plan JSON remains the persisted record.
- `scripts/waveyard-ground-truth-evaluation.mjs` validates source/rights/reviewer provenance and calculates metrics only after the dataset is adjudicated and has at least 95% section-timeline coverage.
- `scripts/waveyard-ground-truth-evaluation.test.mjs` checks evaluator behavior with synthetic fixtures only. Those tests are not real-song evidence.

## Annotation protocol

1. The two exact source copies used by the prior production run are currently available as ignored user-uploaded attachments in this Replit workspace. Verify each against the template SHA-256 before review. Keep audio outside Git; record the original filename, SHA-256, duration, license/source URL, and rights basis in the dataset only when known. Do not infer rights from song titles or redistribute source audio or derived mixes. If authorization for independent review cannot be established, leave that evidence missing and keep the result blocked.
2. Give each reviewer only the recordings and blank annotation instructions—not this repository, handoff, Waveyard analysis, scores, selected windows, or the other reviewer's work. Have them independently annotate both complete recordings. Mark section intervals using the controlled labels in the template. Mark uncertain boundaries or section identity as `ambiguous`/`unknown`, not as a forced semantic label. Mark vocal-phrase start/end intervals and their certainty.
3. Independently judge the vocal/bed window pairs for musical usefulness by listening to the pair; use `useful`, `not-useful`, or `ambiguous`. Randomize pair order and hide algorithm rank and score. Rhythm resemblance alone is not evidence of harmonic compatibility. Include the full candidate universe intended for the reported recall metric; otherwise report only recall within the adjudicated pool.
4. Lock both review files before adjudication. Preserve the original reviews, a list of disagreements, the resolution method, and the adjudicated intervals. Do not copy analyzer labels into either human review.
5. Capture the exact production plan from the same source files, including the 40-character producer revision, capture time, and source SHA-256s. Copy each donor evaluation's `rankedBedCandidates` without reordering or rescoring. The selected candidate is rank 1 in the serialized selection order. Historical reports that only recorded the winning candidate cannot be expanded into a complete ranking after the fact; rerun the exact inputs.

The `breakdown` label is distinct from `bridge` and `instrumental`: use it when
the arrangement strips down to core vocals/percussion or the band drops away
and sparse claps or similar elements remain. Preserve a reviewer’s own term;
do not remap a breakdown to bridge merely because a taxonomy lacks the label.

## Metrics and interpretation

- Passage detection uses one-to-one maximum-cardinality matching over interval pairs with IoU >= 0.5, preferring stronger overlaps, and reports precision, recall, F1, and matched start/end boundary error. Confident human vocal intervals are scored; ambiguous intervals are excluded from both false negatives and false positives.
- Section classification accuracy is measured only on matched, confident, non-`unknown` human labels. This tests labels, not musical compatibility.
- Candidate ranking reports top-1 accuracy, MRR, and Recall@K against adjudicated useful bed windows. Unjudged or ambiguous pairs are never negative labels; affected donor windows are listed as unjudged. The report states the adjudicated candidate universe, so Recall@K must not be generalized beyond it.
- Section coverage is reported per source. Less than 95% coverage blocks full-track metrics; reviewers should mark reviewed-but-uncertain intervals as unknown rather than leave gaps.

The report does not measure perceived mix quality, vocal quality, transition smoothness, loudness, clipping, or WAV render correctness. Those need a separate blind listening/render acceptance test.

## Reproduce the current blocked report

In this workspace, evaluate the real-route capture with:

```sh
node scripts/waveyard-ground-truth-evaluation.mjs \
  scripts/fixtures/waveyard-ground-truth/ground-truth-v1.template.json \
  generated-artifacts/waveyard-real-world-acceptance/predictions-v1-captured.json \
  generated-artifacts/waveyard-real-world-acceptance/owner-review-pending-report.json
```

The expected status remains `blocked`, with null performance metrics because
the ground-truth file has no rights basis, two locked independent reviews, or
adjudication. On a clean checkout without the ignored source and generated
artifacts, use the blank prediction template to reproduce the blocked baseline.
Once review authorization, both blind reviews, and adjudication exist, save
completed inputs as new versioned files and pass those paths to the evaluator.
Do not overwrite templates or represent this pending report as real-song
accuracy evidence.
