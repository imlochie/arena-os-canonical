# Waveyard v0.2.0 acceptance readiness

## Decision

Keep v0.2.0 offline. The latest run verified all six original recordings and all
eight pinned stems, then measured original mixes, individual stems and
recombined instrumental beds. The source assets were used as-is; none were
regenerated or modified. The raw report is ignored at
`generated-artifacts/waveyard-real-world-acceptance/harmonic-candidate-pinned-domain-rerun.json`.
Candidate and production output coverage differ on several stem domains, but no
independent chord annotations exist, so accuracy and improvement remain unknown.
See [`waveyard-harmonic-candidate-findings.md`](./waveyard-harmonic-candidate-findings.md)
for the measured comparison.

## Exact external stem inputs

The exact files are present at the paths below and all eight hashes matched in
the latest run. Preserve their bytes and path names. A fresh separation is a
different experiment and must not be substituted for the pinned historical
inputs.

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

Run output confirms `sourceCountVerified: 6`, `stemsVerified: 8`,
`stemsRequired: 8`, and `measurementCount: 16`. The run command is:

```sh
pnpm --filter @workspace/scripts exec tsx waveyard-harmonic-candidate-run.ts \
  generated-artifacts/waveyard-real-world-acceptance/harmonic-candidate-pinned-domain-rerun.json
```

The runner verifies each file against
[`waveyard-musical-evaluation.json`](../scripts/fixtures/waveyard-musical-evaluation.json)
before analysis. It records the audio container,
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

## Current analysis-to-audio dependency map

| Stage | Current implementation | Outputs that affect downstream decisions | Limit that remains |
|---|---|---|---|
| Import and provenance | `artifacts/api-server/src/imported/waveyard/projects/[id]/source-intake/route.ts`; source assets carry checksum and duration | Asset identity and checksum anchor later source analyses | These private originals and stems are workspace artifacts, not tracked Git assets |
| Separation | Waveyard separation routes, local worker and `stem_assets` persistence | Versioned stem IDs and source/separation association | The eight historical stem WAVs are present locally and hash-verified; their origin/persistence association is not re-proven by this offline benchmark |
| Source analysis | `lib/arena/src/lib/waveyard/worker-local/analysis-engine.ts` and `worker-local/stem-analysis.ts` | BPM/key confidence, beat/downbeat grids, section fingerprints, local HarmonyEvents | Chord labels still lack independent accuracy references |
| Evidence loading | `lib/arena/src/lib/waveyard/studio/mashup-sources.ts` verifies current checksums and engine versions; `chooseStemForHarmony` selects instrumental/other/piano/guitar evidence | Current source-mix or selected non-vocal-stem harmony timeline; isolated vocal pitch/activity | It loads one preferred harmony stem, not a bass/drums/other evidence fusion with conflict reporting |
| Automatic pairing | `lib/arena/src/lib/waveyard/types/automatic-remix.ts` uses trusted tempo, complete-bar length, onset rhythm and beat phase; vocal role checks use isolated vocal notes against retained-bed harmony when available, while drum role decisions use checksum-current isolated drum transients | Cross-song section pairing, exact clip transforms, donor-vocal activity and transformed entry offset, retained-vocal harmony decision, and drum retain/replace/layer decision | Vocal structural alignment still uses whole-mix onset rhythm/beat phase; activity intervals are not phrase or lyric boundaries; harmonic accuracy and perceptual quality remain unvalidated against references and listening |
| Manual mashup planning | `planMashup` and `scoreVocalChordToneFit` in `lib/arena/src/lib/waveyard/studio/mashup.ts` | Section/entry ranking, trusted tempo/key transforms, optional placed-vocal vs bed-chord ranking cue | Chord-tone fit is a ranking cue when coverage exists, not a calibrated dissonance or harmonic-change acceptance gate |
| Persistence and editing | `projects/[id]/automatic-remixes/route.ts`, remix session/track/clip records, and `StudioCore.tsx` | Persisted tracks, clips, provenance and user edits | No persisted post-render harmonic re-analysis or automatic rollback on a musical clash |
| Rendering and playback | `renderMashupWithBus`/`renderMashup` in `studio/mashup.ts`, export workers/routes, and `SessionExperience.tsx` | Actual WSOLA/pitch-shifted PCM, mix bus, saved render and playback | Render quality and musical success require an actual listener; no listening acceptance is recorded |

## Role-specific automatic pairing correction

The automatic hybrid planner previously substituted alternating full-song clips
when it had no usable cross-song passage evidence or when every measured passage
conflicted. That produced a saved “hybrid” without a compatible pairing. The
planner now returns the existing `hybrid_evidence_unavailable` or
`no_compatible_hybrid_source` failure with its compatibility report, so the API
can explain the missing evidence or measured conflict. Semantic roles plus
global key/tempo are no longer enough to admit a donor; measured passage chroma,
rhythm, beat-phase and trusted tempo must support the pair. Successful evidence
based plans and the renderer remain intact. The planner provenance version is
now 6. For vocal pairs, checksum-current isolated vocal notes versus the retained
bed chord timeline replace source-mix chroma when that role evidence is
available; measured sustained conflict rejects a pair even if the whole mixes
match. If that evidence is unavailable, the existing source-mix chroma path
remains, and the report names the missing role-specific evidence.

For drum pairs, donor source-mix chroma is context only because the donor's
instruments are discarded. Actual retain/replace/layer decisions still require
checksum-current isolated drum attacks and both tracks' measured beat grids.
Vocal activity in the exact selected donor window is checked when available:
known silence rejects that passage, and the report gives the measured activity
entry after the planned transform. It explicitly does not call the coarse RMS
region a lyric or word timestamp.

Both roles still use whole-mix onset rhythm and beat phase to establish section
structure. Those features can disagree with the isolated vocal or drum layer;
replacing them with role-specific phrase alignment remains open. Chord labels,
timing quality on actual recordings and listener-perceived mix quality have not
been validated against the human-reference packets or real rendered mixes.
Source-mix chord progression is retained in the report as advisory context only;
it no longer breaks ties between candidate passages whose backing will be
discarded.

## Production use path and evidence boundary

Production still calls `detectHarmonyTimeline` in
`lib/arena/src/lib/waveyard/worker-local/analysis-engine.ts`. Existing local
harmony events flow into the mashup planner's harmony comparison and
`scoreVocalChordToneFit` in `lib/arena/src/lib/waveyard/studio/mashup.ts`;
the offline v0.2.0 candidate runner remains separate. This increment changes
automatic-hybrid role-specific passage selection but does not change database
schema, production detector or confidence thresholds. A planner regression or a
persisted synthetic route test is not a real-source mashup or listening test.

## Engineering validation

This increment passed the focused automatic-remix suite (27/27), workspace
library and API-server typechecks, the synthetic PostgreSQL automatic-remix
and donor-drum route tests, and `git diff --check`. The prior
12 focused packet/evaluator tests and earlier candidate/harmonic results are
recorded in [`HANDOFF.md`](./HANDOFF.md). The broad repository test sweep remains
incomplete. Its known failure classes are PostgreSQL/service prerequisites,
network-dependent assertions, Windows sandbox filesystem restrictions,
route/test-harness assumptions and a worker URL import failure. The test batch
that stalled was stopped; this does not establish a complete failure inventory
or a passing repository-wide suite. There is no lint script in the workspace.

## Completion gates

1. **Complete:** verify all eight exact stem hashes. The latest runner also
   verified the six pinned original recordings.
2. Obtain two independently reviewed, owner-verified chord timelines for all
   six sources, adjudicate them, and confirm the sharing basis.
3. **Complete:** run the candidate and unchanged production detector on original
   sources, individual stems and the bass+drums+other instrumental bed. This
   establishes measured output and runtime only, not accuracy.
4. Run the evaluator against adjudicated references and review held-out paired
   metrics without tuning on held-out labels.
5. Run the required broader engineering validation and triage the known
   environment/test-harness failure classes.
6. Write a final acceptance decision. Production remains unchanged until then.

## Increment: unmeasured vocal harmony no longer reads as agreement

### The musical limitation addressed

The planner scores a whole-bar passage pair as a weighted mean over the
features it has (`sum(score*weight)/sum(weight)` in `rankPassagePair`). The
placed donor vocal's chord-tone fit against the bed is one of those features,
weight 0.12. When `scoreVocalChordToneFit` could not measure that fit, the term
was simply **omitted**, which shrinks the denominator and raises the mean.

So a placement whose vocal harmony nobody could check scored *better* than one
that was checked and found to clash. Measured through the real planner on a
controlled fixture:

| Bed passage | Placed-vocal chord fit | Score before | Rank before |
|---|---|---|---|
| no chord coverage | unmeasurable (`null`) | **1.000** | **1st (selected)** |
| measured C# over a C-major vocal | measured clash (`0.0`) | 0.8937 | 2nd |

The planner preferred the arrangement whose harmony it could not evaluate.
That is the "inventing confidence" failure the owner prohibited, expressed as
arithmetic rather than as prose: an unknown was being averaged as if it were a
high score.

### What changed

`rankPassagePair` now distinguishes the two ways the fit can be `null`:

* **Not applicable** — no isolated pitch frames, or no bed chords at all — the
  cue stays absent and the candidate is not judged on it.
* **Applicable but unmeasurable** — the placement carries voiced, confident
  material the bed's chords should have had to agree with, but too little was
  measurable to decide. This now contributes **zero agreement at full weight**,
  so unknown scores exactly like a measured maximum clash: never better than a
  clash, and never punished below one merely for being unknown.

The fix is not a tuned constant. The defect was a shrinking denominator, so the
correction is to stop shrinking it; no threshold was introduced, and the
existing 0.12 cue weight is unchanged. `vocalHarmonyAssessmentApplicable` makes
the applicability decision explicit and is exported so it can be tested alone.

The state is reported, not hidden: candidates carry
`vocalChordFitUnmeasured`, and when the selected best placement is
harmonically unverifiable the plan says so in its own warning ("This placement
is not harmonically verified."). An unverified placement must not be
indistinguishable from a verified one.

### What fraction of the pipeline this covers

This changes **ranking and disclosure**. It does not add a harmonic model, a
new detector, a calibrated dissonance metric, or an acceptance gate, and it
does not alter rendered audio: `renderMashup`, `renderMashupWithBus`,
`renderSongExtension` and the export path are untouched. On the route
acceptance fixture the render and export WAVs are byte-for-byte the size they
were before this change (5,644,844 B and 5,633,090 B), with the same key
contract (−3 st plan, 1500 Hz donor, 1261/1262 Hz measured) — the decision path
changed, the audio for a harmonically verified fixture did not.

### Verification actually executed

| Suite | Result |
|---|---|
| `mashup.test.ts` (incl. 3 new regressions) | **53/53** |
| `note-harmony.test.ts` | 5/5 |
| `automatic-remix.test.ts` + `passage-compatibility.test.ts` | 31/31 |
| `harmonic-candidate.test.ts` | 4/4 |
| Combined focused set | **93/93, 0 skipped, 0 failed** |
| `route.test.ts` (real PostgreSQL + real ffmpeg) | **1/1, 0 skipped, 0 failed** |
| `tsc --noEmit` (`lib/arena`, `artifacts/arenaforge`) | clean |
| `git diff --check` | clean |

The two ranking regressions were **mutation-checked**: reverting to the old
omit-the-term behaviour makes both fail, and restoring the fix makes both pass.
A third test asserts the disclosure contract (the unverified placement names
itself in the plan warning).

### Real-audio evaluation: NOT run

`scripts/waveyard-note-harmony-evaluation.ts` fails closed with `ENOENT` on
`attached_assets/0_ytmp3free.cc_earth-wind-fire-september…mp3`; all six pinned
sources and all eight pinned stems are absent from this checkout. No real-song
evaluation was performed in this increment, and none of the above is real-song
evidence. The fixtures are synthetic pure tones with controlled chord
vocabularies.

### Human listening evidence: NONE

Listener count remains 0. Nothing here establishes that the selected arrangement
sounds better; it establishes only that an unmeasurable comparison no longer
scores as agreement, and that the planner now prefers a placement whose
harmony it could actually measure over one it could not.

### Still open

* Chord labels still lack independent accuracy references, so the fit remains a
  relative cue, not a calibrated harmonic-quality measure.
* The check is chord-tone **membership** over stable notes; passing tones,
  suspensions and intended dissonance are not classified.
* Chord-tone fit is still only one weighted input; it can be outvoted by rhythm,
  chroma and beat phase on a pair whose harmony is poor.
* The automatic (hybrid) planner's advisory `chordProgression` comparison still
  contrasts anchor and donor **source mixes**, while a hybrid keeps only
  selected stems. That remains unresolved and is the next honest gap.

## Increment: retained-stem harmonic assessment for hybrid planning

### The gap this closes

The dependency map above recorded that the automatic planner's `chordProgression`
comparison "contrasts anchor and donor **source mixes**". A hybrid neither plays
nor keeps those mixes: it keeps the anchor's instrumental and the donor's vocal,
and discards the donor's instrumental entirely. The planner was therefore
comparing harmony belonging to discarded material and never comparing the
material that survives. Two sources whose mixes both centre on C could pass the
progression check while the surviving melody fought the retained bed.

Measured on a controlled fixture with two donors that have identical
structurally compatible passages and one C-major anchor bed:

| Donor vocal that survives | Old ordering | New ordering |
|---|---|---|
| C-major arpeggio (fits the bed) | rejected | **selected** |
| same arpeggio a semitone up (fights the bed) | **selected** | rejected |

The old ordering sorted donor vocals by how many structural passage pairs
matched — a count that cannot distinguish these two. Reverting the new sort
reproduces the failure exactly: `expected "clashes-vocals" to contain "fits"`.

### What was built

* `types/stem-harmonic-fit.ts` — the assessment. Notes are split at chord
  boundaries; each segment is classified **chord tone**, **suspension**,
  **passing** or **clash**, with `bedChordChanges` reporting progression
  movement. This is the difference between "is this note a member?" and
  "does this melodic line work over this progression?".
* `types/stem-harmonic-adapter.ts` — bridges persisted `stem_harmony_events`
  and `vocal_pitch_frames`, applying the arrangement's real stretch ratio and
  authorized pitch shift. An `unknown`-quality chord is converted to an unnamed
  chord, never to a named one.
* `assessRetainedHybridHarmony` — places a donor section under its matched
  anchor section and returns `unavailable` when the bed analysis is missing,
  stale, or not bound to the current source checksum.
* `automatic-remixes/route.ts` — loads engine- and checksum-verified
  `stem_harmony_events` for each source's non-vocal stem, plus
  `vocal_pitch_frames`.

### Refusing to manufacture a score

* Shares divide by **judged** time. Bed regions the analyser declined to name are
  excluded from the ratio and reported as `unjudgedShare`; they never count as
  agreement.
* Below `MIN_JUDGED_MS` (1200 ms of judged sounding time) the whole assessment is
  `unavailable`, not a confident-looking number.
* With no bed evidence at all, donor ordering falls back to the previous rule
  unchanged — a second regression asserts `unknown` never becomes a preference.

### Verification actually executed

| Suite | Result |
|---|---|
| `stem-harmonic-fit.test.ts` (new) | **12/12** |
| `automatic-remix.test.ts` (2 new selection regressions) | 15/15 |
| `passage-compatibility.test.ts` | 16/16 |
| `note-harmony.test.ts` | 5/5 |
| `mashup.test.ts` | 53/53 |
| Focused combined | **98/98, 0 skipped, 0 failed** |
| `route.test.ts` (real PostgreSQL + ffmpeg) | **1/1, 0 skipped, 0 failed** |
| `tsc --noEmit` lib/arena, api-server, arenaforge | clean |

The selection regression is mutation-checked: restoring the previous sort makes
it fail. Render and export are untouched; the acceptance fixture produces
identical WAV sizes and key contract.

### What this does not establish

* **No real-audio evaluation and no listening evidence.** Every pinned source and
  stem is absent from this checkout; fixture audio is synthetic. Listener count
  remains 0. This shows the planner now accounts for the retained material and
  that its ordering changes accordingly — it does not show the result sounds
  better.
* Bed evidence is the anchor's **non-vocal stem chords**. A separate bass-line
  analysis (bass movement vs chord roots) and drum evidence are still not loaded
  by the automatic route.
* Suspension vs passing uses **resolution direction** as its rule, because no
  metrical accent position is available. Documented proxy, not a full
  voice-leading model.
* Chord labels remain unvalidated against independent references.
* Only the first matched section pair is assessed, not every section.
