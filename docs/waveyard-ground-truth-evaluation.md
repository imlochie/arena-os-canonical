# Independent full-track Waveyard ground truth

## Status

This is a reproducible evaluation protocol and a versioned annotation template—not a completed ground-truth dataset. The exact user-provided MP3s are present in the current Replit workspace under `attached_assets/` (ignored by Git), and their SHA-256s match the production route manifest. They are not bundled in the repository and may be absent in other checkouts. The production route exports a complete source-bound prediction snapshot in this workspace, and its producer/source provenance validates. Rights evidence, two independent reviews, and adjudication are missing. The evaluator therefore emits a blocked report with null performance metrics instead of substituting algorithm-generated labels.

### Latest full-track live-alignment probe

On 2026-11-13, the opt-in acceptance runner analyzed all six owner-uploaded
recordings (215.14–405.93 seconds; pinned hashes) and evaluated the current
`liveStemSectionAlignment` helper over 3,180 rolling-window positions in 30
directed song-pair combinations. These are eight-beat feature windows, not
detected vocal or lyric phrases. The probe found **zero accepted section-window
candidates**, 197 positions where confidence gates allowed a beat-offset
fallback, and 2,983 positions with no automatic offset. The two directions
with beat fallback were September ↔ Stayin' Alive. The primary September ↔
Another One Bites the Dust pair had zero accepted section-window alignments
and zero beat-fallback positions over 155 windows. The local Queen analysis reported
0.426 BPM confidence and 0.234 beat confidence; this is the offline
source-PCM analyzer's result, not the separate persisted API analysis value.

This run is a real-audio capability check, **not** an accuracy score or a
lyric-phrase evaluation. The source-only offline scan does not exercise
separated stems or the persisted database route. Without independent
vocal-phrase pairs and adjudicated
usefulness judgments, correct matches, misses, false matches, and timing error
remain `null`; a zero candidate count must not be read as zero false matches or
as proof that the songs are incompatible. No thresholds were tuned to this
recording set. The ignored detailed report is
`generated-artifacts/waveyard-real-world-acceptance/alignment-probe-six-tracks-20261113.json`.

The target pair and expected durations follow the production handoff: _Another One Bites the Dust_ (222.67 s) and _September_ (215.14 s). A database-backed production run captures 25 and 34 structural sections, 89 isolated-vocal pitch-continuity runs for the donor, and all 17 donor windows with ranked bed candidates. The local snapshot is `generated-artifacts/waveyard-real-world-acceptance/predictions-v2-captured.json`; the full acceptance report is `generated-artifacts/waveyard-real-world-acceptance/full-track-ground-truth-predictions-capture.json`. These files are ignored by Git. Persisted section endpoints are clamped to decoded PCM duration rather than whole-second database metadata; capture validation allows only the 50 ms source-metadata rounding difference. Pitch-continuity runs are not lyric-phrase boundaries, and no words or lyrics are detected. The section engine emits structural windows/repeats, not verse/chorus/bridge/breakdown labels.

### Full-track vocal-activity evidence (not semantic classification)

The current local analysis was also run directly against the complete separated vocal WAVs from the two user-provided recordings. It found 36 coarse activity intervals across the 215.14-second _September_ stem and 40 across the 222.67-second _Another One Bites the Dust_ stem. The first measured activity was 19.294 s and 25.077 s, respectively. Using the source beat grids, sustained vocal-presence boundaries were placed at 19.145 s for _September_ and 26.389 s for _Another One Bites the Dust_. These are signal-activity events, not detected words or semantic section labels.

Those two entry times are within 0.86 s and 0.61 s of the owner’s approximate notes for the first lyrical sections (~20 s and ~27 s). This is a useful real-track timing check, not an independent benchmark: there is one listener, two approximate annotations, no adjudication, and no precision/recall claim. The other measured vocal-change events are retained as structural evidence; they should not be called verse, chorus, bridge, or breakdown without human confirmation. Interval confidence/strength values are heuristic signal scores, not calibrated probabilities; event strength is the measured difference in vocal-activity coverage between adjacent two-bar windows.

Vocal RMS activity intervals are now stored separately from pitch-continuity runs. Current-version section fingerprints keep both signals separately and may emit explicit `vocal-change` boundaries only for sustained two-bar entry/dropout evidence. Versioned vocal analysis refreshes old local records in place and uses a version-specific queue identity; stale queued jobs must not overwrite a refreshed record. The database route regression test verifies persisted activity rows, the version refresh, and protection from a late stale job using deterministic audio fixtures. The commercial full-track result above is an offline analysis of the real isolated stems, not a replay of the complete separation-to-database route using those recordings.

This still does not establish that Waveyard understands musical form, lyrics, or cross-song arrangement quality. Repeated choruses, vocal phrase starts/ends, and whether a vocal passage fits another song remain unscored until authorized independent annotations and a blinded rendered-mashup review are available.

A first listening pass supplied 18 approximate section-start times. A nearest-boundary comparison found a machine structural boundary within two seconds for 6 of 18, and within one second for 1 of 18. This is exploratory only: it is based on approximate single-listener notes, allows many-to-one nearest matches, and does not measure semantic classification accuracy. Algorithm output must stay hidden until independent annotations are locked. Titles and durations alone do not establish licensing; establish review authorization before any second reviewer receives or opens the recordings.

## What is versioned

- `scripts/fixtures/waveyard-ground-truth/ground-truth-v2.template.json` stores source identity and rights fields, two independent blind-review slots per recording, and a separate adjudicated result. Each review distinguishes semantic section intervals, transition timestamps, typed structural events (transition, repetition, arrangement change), vocal-phrase intervals, and optional bed-pair judgments. Human phrase labels are reference data only; the current production pipeline has no lyric-phrase predictions.
- `scripts/fixtures/waveyard-ground-truth/predictions-v2.template.json` is the blank capture shape. The real route acceptance test writes a filled local snapshot with source-bound structural sections/boundaries, pitch-continuity runs, and all ranked bed candidates. `sourceDurationMs` is pinned to source metadata; section endpoints must stay within 50 ms of that duration. Pitch-continuity runs are retained as evidence but are not scored as lyric phrases. Candidate output does not change scoring, gates, or selection behavior.
- `scripts/waveyard-ground-truth-evaluation.mjs` validates source/rights/reviewer provenance and calculates metrics only after the dataset is adjudicated and has at least 95% section-timeline coverage.
- `scripts/waveyard-ground-truth-evaluation.test.mjs` checks evaluator behavior with synthetic fixtures only. Those tests are not real-song evidence.

## Annotation protocol

1. The two exact source copies used by the prior production run are currently available as ignored user-uploaded attachments in this Replit workspace. Verify each against the template SHA-256 before review. Keep audio outside Git; record the original filename, SHA-256, duration, license/source URL, and rights basis in the dataset only when known. Do not infer rights from song titles or redistribute source audio or derived mixes. If authorization for independent review cannot be established, leave that evidence missing and keep the result blocked.
2. Give each reviewer only the recordings and a separate copy of [`waveyard-reviewer-worksheet.md`](./waveyard-reviewer-worksheet.md)—not this repository, handoff, Waveyard analysis, scores, selected windows, or the other reviewer's work. Confirm the reviewers are authorized to receive and listen to the exact source recordings before sharing them. Have them independently annotate both complete recordings:
   - **Musical form:** mark the full timeline using the controlled labels in the template. Use `unknown` with ambiguous certainty rather than guessing. A breakdown is a distinct section where the arrangement drops to core vocals/percussion or sparse claps; do not relabel it as a bridge or generic instrumental.
   - **Structural events:** separately mark transition times, repetitions (a recognizable section or motif returning), and arrangement changes (for example, bass or drums dropping out, an instrument entering, or the texture thinning). Add a short audible description and certainty. Do not infer semantic section labels from event type.
   - **Vocal phrase timing:** mark approximate start/end for each distinct lead-vocal lyrical phrase. A phrase is a connected sung line or short group of lines, separated from the next by a clear vocal pause, breath, or musical break. Include timestamps only—do not transcribe lyrics. Mark uncertain phrase boundaries as ambiguous.
   - Cover the complete recording, including instrumental/no-vocal spans in the section timeline; do not leave gaps merely because a label is uncertain.
3. Independently judge the vocal/bed window pairs for musical usefulness by listening to the pair; use `useful`, `not-useful`, or `ambiguous`. Randomize pair order and hide algorithm rank and score. Rhythm resemblance alone is not evidence of harmonic compatibility. Include the full candidate universe intended for the reported recall metric; otherwise report only recall within the adjudicated pool.
4. Lock both review files before adjudication. Preserve the original reviews, a list of disagreements, the resolution method, and the adjudicated intervals. Do not copy analyzer labels into either human review.
5. Capture the exact production plan from the same source files, including the 40-character producer revision, capture time, and source SHA-256s. Copy each donor evaluation's `rankedBedCandidates` without reordering or rescoring. The selected candidate is rank 1 in the serialized selection order. Historical reports that only recorded the winning candidate cannot be expanded into a complete ranking after the fact; rerun the exact inputs.

The `breakdown` label is distinct from `bridge` and `instrumental`: use it when
the arrangement strips down to core vocals/percussion or the band drops away
and sparse claps or similar elements remain. Preserve a reviewer’s own term;
do not remap a breakdown to bridge merely because a taxonomy lacks the label.

## Metrics and interpretation

- Structural boundary detection matches internal predicted and human timestamps one-to-one within a declared 2-second tolerance. It reports precision, recall, F1, signed/absolute timing error, and excludes predictions near boundaries reviewers marked ambiguous.
- Semantic section classification is explicitly unavailable until the production analyzer emits semantic labels such as verse, chorus, bridge, or breakdown. Structural labels are never compared as if they were semantic labels.
- Structural event types and vocal phrase intervals are retained in the human reference and summarized separately. There are no corresponding production predictions yet, so no accuracy, precision, recall, or timing score is reported for those tracks. Pitch-continuity runs are not scored as phrases or words.
- Candidate ranking reports top-1 accuracy, MRR, and Recall@K against adjudicated useful bed windows. Unjudged or ambiguous pairs are never negative labels; affected donor windows are listed as unjudged. The report states the adjudicated candidate universe, so Recall@K must not be generalized beyond it.
- Section coverage is reported per source. Less than 95% coverage blocks full-track metrics; reviewers should mark reviewed-but-uncertain intervals as unknown rather than leave gaps.

The report does not measure perceived mix quality, vocal quality, transition smoothness, loudness, clipping, or WAV render correctness. Those need a separate blind listening/render acceptance test.

## Reproduce the current blocked report

In this workspace, evaluate the real-route capture with:

```sh
node scripts/waveyard-ground-truth-evaluation.mjs \
  scripts/fixtures/waveyard-ground-truth/ground-truth-v2.template.json \
  generated-artifacts/waveyard-real-world-acceptance/predictions-v2-captured.json \
  generated-artifacts/waveyard-real-world-acceptance/owner-review-pending-report-v2.json
```

The expected status remains `blocked`, with null performance metrics because
the ground-truth file has no rights basis, two locked independent reviews, or
adjudication. On a clean checkout without the ignored source and generated
artifacts, use the v2 blank prediction template to reproduce the blocked
baseline. Once review authorization, both blind reviews, and adjudication
exist, save completed inputs as new files and pass those paths to the evaluator.
Do not overwrite templates or represent this pending report as real-song
accuracy evidence.
