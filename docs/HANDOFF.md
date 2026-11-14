# Arena handoff — read this first

## Current: measured mashup mix bus and deliberate stem composition (P0/P1)

The production mashup render no longer sums a second rhythm section on top of
the bed and no longer hard-clips. Two concrete defects were fixed at the layer
they occur, both in `lib/arena/src/lib/waveyard/studio/mashup.ts`:

1. **Donor stems were additive and unaligned.** `renderMashup` summed every
   non-vocal donor stem from the donor's separation run at a fixed 0.6 gain,
   indexed from timeline frame 0. A vocal that entered at 20 s therefore
   arrived with a second drum kit and bass that started at 0 s and ignored the
   alignment strategy entirely. Donor stems are now summed **only** for stem
   types the caller names in `layerStemTypes`, and each is offset to the
   planned vocal entry. The default composition is the one the product wants:
   donor vocal over the bed's own drums, bass and other.
2. **The mix had no reference and clipped.** Vocal and bed were summed at
   unity and the total clamped with `Math.max(-1, Math.min(1, …))`, even though
   `OutputPeakLimiter` already existed (only the live output worklet used it).
   `renderMashupWithBus` (new) now measures both sides with BS.1770 gated
   loudness, applies a bounded (±6 LU, reported when clamped) vocal-to-bed
   correction, attenuates only when the sum genuinely overshoots, and passes the
   result through the existing stereo-linked 4× true-peak limiter. A mix that
   already fitted keeps unity gain, so this is not blanket attenuation. The
   window is ±6 rather than ±9 because a clamped correction must mean the
   *pairing* is the open question, not that the gain was allowed to do
   something a mix balance should never do.

3. **A "layer" was doubling, not replacing.** A layered donor stem was summed
   on top of the bed's own copy of the same role, so a donor drum part played
   against a second, unaligned drum part. `sumInstrumentalStems` now accepts
   `omitStemTypes`: the route defaults to `stemLayerMode: "replace"` (donor
   drums/bass *remove* the bed's drums/bass) and keeps `"layer"` as an explicit
   opt-in for deliberate doubling. `InstrumentalBedError("all-stems-replaced")`
   refuses a request that would leave no bed at all, rather than rendering a
   vocal over silence. Both modes are reported: `x-waveyard-stem-layer-mode`
   and `x-waveyard-bed-replaced-stems`, and the Studio states which happened.

4. **Donor layers lost the phrase's own source offset.** Offsetting a layer to
   the vocal *entry* was not enough: a phrase cropped from 1.75 s into the donor
   still dragged that 1.75 s of donor instrumental in ahead of the singer, so
   the layer led the vocal. `renderMashupWithBus` now trims the donor's own
   source lead-in (`segment.vocalsFromMs`) before tempo-mapping it, so the layer
   starts *with* the phrase. The regression test fails if that trim is removed.

The API route honours an explicit `layerStemTypes` array (400 for unknown or
`vocals`), reports `x-waveyard-layer-stems`, `x-waveyard-mix-balance-db`,
`x-waveyard-mix-balance-clamped`, `x-waveyard-mix-static-gain-db`,
`x-waveyard-mix-limiter` and `x-waveyard-mix-true-peak-db`, and adds the
measured post-limit level as a warning entry. `MashupStudio` displays the
composition and those measurements; it still shows no composite quality score.

**The whistle is investigated, not explained away.** A stage-isolating
diagnostic now exists (`scripts/waveyard-mashup-mix-diagnostic.ts`): it renders
the same fixture through untouched stems → WSOLA stretch → stretch + pitch →
summed pre-limit → final mix → exported WAV, and reports narrow components that
gain ≥6 dB over the comparison stage plus 8 k/12 k band fractions. On that
synthetic fixture no stage adds a strong stationary component. The measured
high-band movement is entirely from the deliberate pitch move (12 k+ fraction
−49.2 dB → −30.4 dB), which is relocated tonal content, not a whistle. **The
reported whistle is therefore still unexplained and needs real separated stems
to reproduce**; the previous handoff's habit of attributing it to WSOLA was not
evidence and is not repeated here.

Verification in this checkout: `tsx --test` on the mashup suites passed
**83/83** (`mashup.test.ts` 41, `mashup-mix-bus.test.ts` 12,
`donor-stem-integrity.test.ts` 12, `mashup-full-length` 4, `mashup-regression`
6, `output-peak-limiter` 8); API-server and ArenaForge typechecks pass.
The route acceptance test (`route.test.ts`) was extended to assert the default
composition, the honoured explicit layer, the rejected `vocals` layer and the
reported mix headers, but **it was not executed here** because this sandbox has
no PostgreSQL server or bundled binaries. It must be run before merge.

**Not established:** no listening test was performed, responses remain
**N=0**, and this checkout has no real source audio, no `generated-artifacts/`,
and no separated Queen/September stems. The four-way A/B/C/D render that the
product decision depends on is therefore **not** produced by this change. What
changed is that variants B and D are now possible to render at all: previously
"corrected composition" and "corrected mix" could not be expressed. Arrangement
intelligence (P2) is untouched: the planner still places one continuous vocal
body, and phrase/section placement remains future work.

## Replacement and phrase anchoring — measured on rendered audio

Everything below was produced by rendering WAVs and measuring the PCM. **No one
has listened to any of it: N=0.**

### A real replacement, not a label

Fixture: an 8 s, 120 BPM bed with distinguishable parts (bed drums = 90 Hz kick
plus 7 kHz hat, bass = 55 Hz, other = 330 Hz pad), a donor drum part at 3 kHz, a
sung-ish 440 Hz vocal, and bed supplied as **separated stems** so there is
something to omit. Rendered via the A/B/C/D harness with `layerStemTypes:
["drums"]`, once with `stemLayerMode: "replace"` and once with `"layer"`:

| variant | bed 7 kHz hat | donor 3 kHz | bed bass 55 Hz |
|---|---|---|---|
| replace, A-baseline | 0.00001 | 0.01346 | 0.08290 |
| replace, D-both | 0.00001 | 0.01048 | 0.06453 |
| layer, A-baseline | 0.00191 | 0.01333 | 0.08212 |
| layer, D-both | 0.00150 | 0.01048 | 0.06454 |

The bed's hat energy is ~150× lower under `replace` than under `layer`, the
donor part is present in both, and the bass is unchanged to five decimal places
in the same render — i.e. exactly one role changed. `abcd-report.json` records
`bedComposition: { mode: "separated-stem-sum", includedStemTypes: ["bass","other"],
replacedStemTypes: ["drums"] }`.

The harness warns rather than pretending when `stemLayerMode: "replace"` is
requested but only a premixed bed file was supplied, because there is nothing to
remove in that case and the render would double the part.

### A layer now starts with the phrase

With a vocal phrase planned from 1.75 s into the donor source, a click placed
0.5 s after that crop lands at **entry + 500 ms**; nothing is audible in the
first 100 ms. Removing the new trim makes the same assertion fail, so the test
measures the fix rather than the fixture.

Honest limit on this evidence: the 5 kHz-onset probe on the *audio files* for
this case still reports 0 ms, because the plan used there cropped from 0 ms, so
the trim had nothing to remove. The placement contract is proven by the unit
test on the real renderer, not by that WAV probe. A donor WAV whose phrase begins
later in its own file is what the Queen/September render needs to demonstrate it
end to end, and that pair is still unavailable here.

### A defect in the A/B/C/D harness itself, found and fixed

C ("mix only") was byte-identical to A on every fixture: the quarantined legacy
renderer ignored the loudness-match gain, so it reported `vocalGainDb: 6` while
applying 0 dB, and the only difference was the limiter. The match gain is now
applied inside both composition renderers, so C differs from A by the loudness
balance *and* the limiter, and D differs from B the same way. This is recorded
because it is exactly the class of error the directive warns about: a report that
describes a correction the audio never received.

After the fix, on the late-entry fixture: A/B −17.01 LUFS, C/D −15.13 LUFS, both
under a 2.18 dB listening-match gain so the comparison is level-fair.

### Reproduce

```
./scripts/node_modules/.bin/tsx scripts/waveyard-mashup-abcd.ts \
  --manifest /path/to/manifest.json --out /path/to/out
```

Manifest keys used above: `vocals`, `bed` (with `bpm`, `key`, confidences,
`sections`), `bedStems` (per-type WAVs, enables real replacement),
`donorStems`, `layerStemTypes`, `stemLayerMode`, `strategy`. Every WAV is a
44.1 kHz PCM16 stereo file; the harness refuses anything else instead of
resampling silently.

### Still unproven

- **No listening test. N=0.** Nothing above is a judgement of musical quality.
- **Route test still not executed** (no PostgreSQL in this sandbox); the new
  replacement assertions in `route.test.ts` are written but unrun.
- Local tempo *map* preservation under layering is tested with a constant
  stretch ratio; a segment with a piecewise `localTempoMap` and a donor layer has
  not been measured.
- Phrase-aware arrangement (P2) remains untouched and deferred.

## Acceptance evidence for the mix bus, and the A/B/C/D harness

Measurements taken on this checkout, all reproducible from the commands below.

**Full-length cost.** A 215 s render (the real Queen-over-September bed length)
completed in 157 s. Measurements are not free: whole-programme loudness and
4× true-peak reconstruction cost roughly 3 s each on 215 s of stereo. The bus
therefore takes true peak **before** limiting (that is where the decision is
made), and re-measures true peak **after** limiting only for renders up to
`FULL_TRUE_PEAK_MAX_SECONDS` (60 s). Longer renders report the post-limit
sample peak, clipped-region count and `postTruePeakMeasured: false` rather than
implying a measurement that was not taken.

**Loudness matching on awkward stems.** Fixtures in `mashup-mix-bus.test.ts`:
a 1.5 s phrase inside 30 s of near-silence, a −50 dBFS separation-bleed floor,
a one-hit bed, and vocals both much quieter and much louder than the bed. A
hand-rolled presence gate was implemented and then **removed**: BS.1770's own
absolute and relative gates already give the phrase its own level (measured
difference < 0.5 LU), so the extra statistic changed nothing. The correction
window was tightened from ±9 dB to **±6 dB**, and a clamped correction is
reported with the measured difference and an explicit instruction that the
pairing or phrase selection, not the gain, is the open question. Sparse-stem
active-block fractions are reported alongside, so a mostly-empty vocal stem is
visible.

**Limiter.** `OutputPeakLimiter` reports sample peak, true peak, loudness,
stereo correlation and clipped-region count at both stages. A genuinely
clipping fixture shows the difference: the legacy render leaves 65,873 samples
pinned at full scale with a +0.30 dBFS reconstructed peak; the corrected bus
reports 0 clipped regions at −0.81 dBFS sample peak.

**Donor layers follow the tempo map, not just the entry.** A 140→100 BPM pair
(stretch 1.4) with a click at 0.5 s of donor source time lands at the
tempo-mapped position and 200 ms away from the un-stretched one, pinned by
test.

**Four-way A/B/C/D harness — `scripts/waveyard-mashup-abcd.ts`.** Renders
baseline, composition-only, mix-only and both, from a JSON manifest of real
WAV paths, and loudness-matches every variant for playback (matched gain is
reported, and a trim prevents the matched file clipping). It was exercised on a
synthetic overload fixture: A and B pinned at 0.00 dBFS (the legacy clamp,
65k+ clipped samples), C and D at −0.81 dBFS with zero clipped regions, static
gain −3.6/−3.25 dB, limiter active and a +3.34 dB vocal-to-bed correction.
That is a check that each variant isolates one change — **not** a listening
result.

**Still blocked, and honestly so.**

- `route.test.ts` now actually loads when invoked by absolute path; it was
  previously matching zero tests under a bracketed glob. It **skips** in this
  sandbox (`PostgreSQL binaries are unavailable`) and there is no network to
  fetch them. Merging still requires that run.
- `mashup-db-acceptance.test.ts` does run here (PGlite) and passes 2/2 once
  `DATABASE_URL` is set; without it, the harness fails at import.
- No real Queen/September stems exist in this checkout, so the A/B/C/D harness
  has not been run on the pair the decision depends on. Listener count is **0**.

Reproduce:

```sh
DATABASE_URL=postgres://localhost:5432/arena_test \
  ./scripts/node_modules/.bin/tsx --test lib/arena/src/lib/waveyard/studio/mashup-db-acceptance.test.ts
./scripts/node_modules/.bin/tsx --test lib/arena/src/lib/waveyard/studio/mashup-mix-bus.test.ts
./scripts/node_modules/.bin/tsx scripts/waveyard-mashup-mix-diagnostic.ts
./scripts/node_modules/.bin/tsx scripts/waveyard-mashup-abcd.ts --manifest <manifest.json> --out <dir>
```

## Previous: auditionable mashup alignment candidates (planner v12)


Waveyard now compares four distinct real planner paths for the same vocal/bed
pair: a continuous baseline, paired beat-grid alignment, measured-downbeat
entry, and evidence-ranked phrase-aware entry. Each candidate has its own plan
and renders through the production route on demand; the selected strategy is
saved into the versioned remix snapshot. The new Studio panel shows entry,
tempo/pitch transforms, available beat-phase evidence, selected passage bounds,
warnings and limitations, with WAV playback/download. It does not display a
composite quality score. At most two rendered previews are retained at a time
to bound browser memory.

Downbeat entry uses only a checksum-current persisted full-source downbeat grid
with confidence ≥0.65. It never derives bar phase from ordinary beat positions;
without evidence the candidate is disabled with a reason. Paired-grid and
phrase-aware candidates likewise remain unavailable when their required
measurements are missing. The continuous fallback remains usable.

Verification in this checkout: `pnpm run typecheck` passed; the focused
`mashup.test.ts` and PGlite `mashup-db-acceptance.test.ts` passed 43/43; the
production route acceptance passed with synthetic audio, including candidate
comparison, actual continuous-candidate WAV rendering, and persistence of the
selected strategy. The page-level preview loads, but no saved Studio
arrangement was present to visually exercise the candidate panel. This turn
did not render or audition candidates from the real Queen-vocals/September-bed
pair, so it does **not** establish that the candidates sound good or that the
musical matching is accurate.

## Previous: paired-grid local WSOLA correction (planner v11)

Waveyard now checks ordered donor/bed drum-beat correspondence across a whole
vocal body and can apply a gentle, pitch-preserving local WSOLA rate map when
the measured grids show recoverable drift. It does not independently move or
cut vocal phrases. The local rate deviation is capped at 1.5%; missing,
irregular, or incomplete grids retain the continuous fallback. Plan clip
boundaries are rounded to integer milliseconds before persistence.

Real full-track fixture: Queen's *Another One Bites the Dust* vocals over
Earth, Wind & Fire's *September* separated bed. The complete route test passed:
plan → render → save → reopen → versioned edit → restore → Studio WAV export.
The route rendered a 215-second, 44.1 kHz stereo PCM16 WAV with no clipped
frames. The returned plan retains the local time map in its version snapshot.

On this pair, ordered corresponding-beat scoring found only 7/335 beats within
90 ms (1,193 ms mean error) before local correction, then 174/335 (152 ms mean
error) after it. This is a substantial measured reduction in drift, but 161/335
beats remain outside the 90 ms window; it is not a reliable-alignment claim.
The earlier v10 nearest-beat count is not directly comparable: it did not
preserve beat order and could report a good fit after cycle slips.

**Studio integration is now implemented:** the map is stored in the versioned
`mashupPlan.clipTimingMaps` snapshot and bound to the exact clip, track, stem,
source, source/stem SHA-256 checksums, source offset, timeline start, duration,
session tempo and base stretch ratio. Studio rehydrates it only while all those
identities still match. The PUT route preserves clip IDs across unrelated edits;
timing edits are invalidated in the UI and rejected as stale on reopen. Version
restore reinstates the original clip IDs so its map can be revalidated.

Editable playback now uses bounded PCM16 WAV range reads for each local-map
window and the same pitch-preserving WSOLA renderer used by export. Mapped clips
use segmented preview even when the full file would otherwise fit in memory.
The export worker verifies checksums and decoded stereo PCM16 bounds, renders
the mapped clip once to a float WAV input, and skips the clip's global tempo
filter to avoid double-stretching. Invalid, absent, or stale maps return to the
existing continuous global-tempo behavior.

Verification in this checkout: 2/2 focused local-map tests passed; the measured
pulse fixture reported 0 ms maximum full-render timing error and 0 ms maximum
chunk-versus-full difference across four transients at a preview-window
boundary. The
production-route regression passed with deterministic PCM audio: it exercised
map hydration, unrelated save, immutable versioning, one-millisecond stale-map
rejection, restore, and a downloaded Studio WAV export whose mid-clip waveform
had 1.0000 correlation with the same WSOLA-rendered preview reference. This is
a test-fixture proof, not a listening-quality or real-song result.

`pnpm run typecheck:libs`, API-server and ArenaForge typechecks, and
`git diff --check` pass. The real Queen-vocals/September-bed fixture is not
configured in this checkout, so local-map playback/export parity on that
full-length separated pair has **not** been rerun or verified here. The earlier
215-second direct mashup-route evidence above remains historical route evidence;
it is not proof of this new Studio path.

**Still unproven:** listening quality, lyric timing, verse/chorus accuracy,
semantic structure, or consistent performance on other song pairs. The pair
retains the honest continuous-placement fallback because no voice-bearing
passage pair met all the measured rhythm, harmony and beat-phase requirements.

## Previous: paired-drum-grid whole-body alignment (planner v10)

The planner now compares timing from both songs instead of snapping vocal
activity to the bed alone. When both checksum-current, completed drum stems
produce trusted beat grids, it maps donor drum beats into the bed using the
tempo stretch, tests whole-body offsets, and reports how many donor beats land
within 90 ms of a bed beat. It prefers candidates that do not worsen the
original paired-grid fit by more than one percentage point; a phase gain over
one point can justify a small contextual-score trade-off. The vocal remains one
continuous clip; internal pauses and phrase timing are not independently moved,
cut, reordered, or dropped. Without two trusted grids, the existing safe
fallback remains and the plan says the paired check was unavailable.

The route keeps BPM and beat-grid evidence together from the same isolated drum
stem when both values pass trust checks. Otherwise it falls back to the
existing per-feature confidence selection. Evidence remains request-time and
checksum-bound; it does not overwrite full-mix `source_analyses`.

Real full-track check: Queen's *Another One Bites the Dust* vocals over Earth,
Wind & Fire's *September* separated bed. The isolated drum stems measured
109.957 BPM (confidence 0.737) and 126.048 BPM (confidence 0.891); WSOLA retains
the planned 0.87234× pitch-preserving tempo ratio. The paired-grid offset moved
the full vocal body to 20.573 s as one clip, retaining all 44 coarse
voice-activity windows. On this pair, 200/335 donor beats (59.7%) land within
90 ms of a bed beat, versus 163/335 (48.7%) at the previous continuous entry;
mean nearest-beat error fell from 96.2 ms to 87.0 ms. This is a measured
improvement, not perfect synchronization. The contextual score was 19.85 versus
20.27 at the old entry (about 2.1% lower), within the planner's explicit
trade-off bound. These scores are uncalibrated and do not measure sound quality.

The full production route completed plan → save → reopen → versioned edit →
restore → WAV export using the real separated files. The restored Studio
session contained 4 tracks and 4 clips (one vocal clip plus three bed stems).
The route render was 215.000 s, 44.1 kHz stereo PCM16, 37,926,044 bytes,
checksum `7297f3d226152d07135389942f5b9075ab0865ff3c88a6ce6daf7403160c0bd9`.
The saved Studio export was 214.858 s, 44.1 kHz stereo PCM16, 37,901,026
bytes, checksum `52c58a9dae1a93296cd27018fab0e50d4b24fce705dc49ae511aac30cf61b003`.
Both WAVs match the report checksums. The request-time report is
`generated-artifacts/waveyard-real-world-acceptance/full-song-route-planner-v10-paired-beats-with-audio.json`;
the WAVs and analysis remain ignored local artifacts.

Verification: **38/38** mashup planner tests, including a synthetic regression
that verifies preserving a vocal's offbeat phase while aligning the two drum
grids; **1/1** real full-song production-route test including save/reopen/edit/
restore/export; `pnpm run typecheck:libs`,
`pnpm --filter @workspace/api-server run typecheck`, and
`pnpm --filter @workspace/arenaforge run typecheck` pass. Tests used a
disposable local database; no user or production database was modified.

**Still unproven:** the owner has not judged this output, and the measured pair
still has 135/335 donor beats outside the 90 ms window. This does not establish
a good-sounding mashup, verse/chorus accuracy, lyric timing, or semantic song
structure. The live preview screenshot reached Waveyard's empty library page,
so the arrangement detail panel has not been visually checked in a signed-in
Studio.

## Timestamped transcript opportunity

Creative already has a BYOK transcription primitive in
`lib/arena/src/lib/creative/captions.ts`: Groq Whisper or OpenAI Whisper can
return timestamped caption segments. This is an external upload, requires a
user-provided key, and currently returns coarse segments rather than
word-level forced alignment. Waveyard does not yet consume or persist this
transcript evidence. A future integration should be explicit opt-in, operate
on the isolated vocal stem where possible, bind timing to the source checksum
and transcription engine, and let users correct the timestamps. Do not upload
audio implicitly or treat ASR text as ground truth or as a verse/chorus label.
Its real value is supplying phrase/word timing that can be compared with
measured vocal activity and used to suggest beat/section snaps; the existing
audio-only fallback must keep mashup planning available.

## Previous: mashup planning consumes persisted vocal activity

Mashup planner v6 now loads the checksum-current `vocal_activity_intervals`
from the same completed vocal analysis as pitch frames and pitch-continuity
runs. These coarse energy intervals are included in the shared musical-evidence
packet and `MashupSourceProfile`; mashup body cropping, voice-bearing passage
eligibility, and transient timing use them alongside pitch-continuity runs:
pitch runs supply more precise onsets where available, and coarse intervals
remain for activity with no pitch match. Activity bounds also trim the donor
body even when pitch evidence is absent. This lets unpitched or weakly pitched
vocal activity participate in planning without pretending to provide
word, syllable, or verse/chorus timing. A stale source or stem checksum removes
both activity and pitch evidence.

Verification for this change: 38 mashup planner/full-length/database tests
passed, including a persisted profile round-trip and stale-checksum rejection;
API and ArenaForge typechecks passed. The real separated-stem route also
completed save/reopen/edit/restore/export for Another One Bites the Dust vocals
over the September instrumental bed, producing a 215-second WAV. Its existing
local vocal-activity detector produced 40 checksum-bound coarse intervals,
which the planner loaded alongside 88 pitch-continuity runs. The combined
94 timing starts overlapped drum transients at 59/94 and bass attacks at
87/94. Those counts are timing evidence, not a quality score. The planner still
correctly kept its measured-beat
fallback because no candidate had sufficient comparable whole-bar passage
evidence. This verifies persisted data flow and export, not that the mix sounds
good or that Waveyard recognizes lyrics or semantic song form.

## Previous: recurring-chorus anchors with distinct-verse support

The latest sweep includes all six owner uploads: September, Another One Bites
the Dust, I Feel It Coming (80s remix), Stayin' Alive (Reflex revision),
I Want to Break Free (Reflex revision), and Blinding Lights (80s remix).
Do not describe the corpus as only two songs. All six complete source recordings
passed the existing cross-track acceptance runner. That runner is **source-only**:
it does not supply separated vocal or accompaniment evidence and therefore
cannot certify semantic form recognition or successful intelligent alignment.
The persisted separated-stem acceptance set still contains September and Queen;
the other four need real full-track separation before the same form path can
evaluate them. The existing Queen full four-model CPU run took about 18 minutes;
no additional long separation runs or model downloads were performed here.

Section engine 1.12 changes the form-recognition output, not the upstream pitch
detector. Repeated eight-bar vocal/harmonic windows still have to establish a
recurrent chorus and a measured energy lift. Verses no longer have to repeat
the same melody or words: one-off verse windows are accepted only when they
carry beat-relative vocal timing, are distinct from the recurrent chorus, sit
at the expected positions before/between chorus anchors, share measured source
harmonic structure, and remain lower-energy than the chorus. Without those
signals the detector abstains. Each interval ends at the next opposite-role
anchor; a same-role hook reprise cannot extend a chorus through an unverified
breakdown or outro. Without later opposite-role evidence, the final anchor is
bounded to its directly observed eight bars. Other sections remain
structural/unknown. Source-section IDs and timing are not rewritten.

The real persisted save/reopen/edit/restore/export route was rerun on the actual
separated September and Queen files. Against the owner's approximate September
section notes, the same full-song route changed from engine 1.10 to 1.11:

* September's owner-note verse/chorus role-time score increased from **34.33%**
  to **78.30%**; claimed coverage increased from **21.37%** to **51.57%**.
* Precision among claims changed from **89.60%** to **84.69%**. This small
  precision loss is a real tradeoff for roughly 2.3× more correctly covered
  verse/chorus time; it should not be hidden.
* Verse F1 changed **0.596→0.880** and chorus F1 **0.384→0.725**.
* Queen still abstains with zero verse/chorus labels. The new distinct-verse
  path does not help when a track has no qualifying recurrent eight-bar chorus;
  the route produced the same labels and metrics as engine 1.11 on both
  separated-stem fixtures. This is a targeted logic correction, not a measured
  accuracy gain on the current two-track corpus.

An exploratory full-track short-hook comparison is not production code. A
shift-tolerant four-bar vocal/chroma/timing score found one Queen pair inside
the annotated first and second choruses, but the same exploratory gates yielded
176 September pairs, 137 crossing annotated section roles. Band-limited vocal
onset flux did not remove the cross-role matches, and the existing stricter
source phrase matcher found no repeats in either full track. Do not lower the
repeat threshold or label a short motif as a whole chorus; the current signals
do not separate repeated hooks from reused material in breakdowns/outros.
Word/lyric transcription is not implemented in the local vocal-analysis path.

These are **provisional**, owner-authored approximate boundaries from one
annotated track, not two independent reviewers or a broad accuracy benchmark.
They are useful comparative evidence for this iteration, not proof of Stem.fm
parity, generalization, lyric recognition, or listening quality. The route
test proves the new labels are produced from real persisted stems and survive
the normal workflow. The final local reports are
`generated-artifacts/waveyard-real-world-acceptance/form-route-acceptance-v112.json`
and `form-provisional-v112.json` (ignored, local audio evidence).

The earlier vocal correction remains in the section history: 1.2.0 pitch
analysis stores pitch-continuity runs, including corrected CMND valley
selection and fractional-period interpolation; coarse vocal activity keeps
unpitched vocal coverage. These are audio observations, not words or lyrics.
Invalid optional timing does not suppress valid PCM recurrence. Section 1.12
consumes those existing persisted checksummed analyses and requires reanalysis;
old results are not relabeled as new.

Historical verification for section engine 1.12: 10 musical-form tests, 7
persisted stem/section tests, API typecheck, and the actual separated-stem
save/reopen/edit/restore/export route passed. That section change did not add a
new model or schema.

## Previous: inferred verse/chorus roles and measured limitations

The earlier 1.9 local source-section worker used **checksum-verified isolated
vocal PCM** and the original full-track PCM. It compared eight-bar
vocal/harmonic contours across distant passages and required two distinct
recurring vocal arrangements, an alternating verse/chorus context and a
measured dynamic lift before assigning either role. The 1.9 engine also compared confidence-qualified, beat-relative
monophonic vocal-pitch-continuity timing when current stored voicing runs exist.
Those runs are supporting audio evidence, **not** words or lyric boundaries.
Repetition or energy alone does not count. Source-only/corrupt/missing stems
and ambiguous songs retain their structural labels; no trained semantic model,
third-party download or confidence-as-probability claim is involved.
Section IDs and coordinates are not changed by this labeling pass. New roles
are persisted through the existing section worker (engine 1.9), consumed by
the existing label display/source-profile and selected-section paths, and
displayed as **inferred, unverified hypotheses**, not certain form labels.

**Real route verification:** completed separation assets for September and
Another One Bites the Dust, a fresh isolated database, the production section
worker, source/profile loader, plan/render and saved/reopened/edited/exported
Studio arrangement all passed. The real fixture previously omitted the
separation jobs' source checksum metadata, so its section worker had been
silently exercising source-only analysis. The fixture now supplies the real
checksum provenance, enabling the actual verified vocal stems. The stored
September sections included **4 inferred verse + 3 inferred chorus windows**;
the Queen sections abstained. No structurally inferred label was renamed
simply because it was repeated. The 215-second render still had zero clipped
frames; no improved audible mashup quality was demonstrated.

**Second full-track result:** the 1.9 route repeated the complete persisted
analysis-to-export run with pitch-continuity timing attached. It produced the
same seven September labels, zero Queen labels, and exactly the same provisional
role-time metrics below. The added timing feature did **not** fix Queen's
abstention or improve measured coverage on this pair.

The failure was measured rather than patched by lowering the threshold.
Queen had 95 full-track eight-bar windows, 78 with sufficient vocal coverage,
and **no** repeated-vocal groups met the existing 0.78 similarity requirement.
The strongest distant pair (around 55 and 190 seconds) scored 0.604 overall:
vocal chroma 0.461, stored pitch-run timing 0.365, backing 0.984, and only
0.96 dB of lift. In other words, the backing riff repeats strongly while the
isolated vocal evidence does not; lowering the combined threshold risks
mistaking the repetitive bass for a repeated chorus.
The monophonic pitch detector voiced only **1,107 of 7,438 frames (14.9%)** on
that separated vocal stem. An offline four-bar contour probe found its best
match (0.754) between roughly 26 and 52 seconds—across the owner's annotated
verse-to-chorus change. That is not enough evidence to shorten windows or
lower gates safely.

**Before/after versus the owner's approximate notes:** v2 production capture
from the prior section engine assigned zero roles to both songs. The newer
engine's provisional role comparison finds:

| Source | Correct verse ms / reference | Correct chorus ms / reference | Extra claimed ms | Role-time overlap |
| --- | ---: | ---: | ---: | ---: |
| September | 26,185 / 61,000 | 15,008 / 59,000 | 4,783 | 34.33% |
| Queen | 0 / 26,000 | 0 / 62,000 | 0 | 0% |
| Combined | 26,185 / 87,000 | 15,008 / 121,000 | 4,783 | **19.80%** |

Precision among claimed, owner-reviewed time is **89.60%**, but it is only a
selective hypothesis score: most reviewed verse/chorus time was **missed**.
Queen produced no role predictions; precision there is undefined, not 100%.
The metric counts abstentions as misses, and penalizes chorus predictions
extending into the owner's breakdown and verse predictions outside a verse.
The source-pinned single-listener notes are approximate, not independently
adjudicated, and the analysis scale was developed while inspecting these
recordings: **these numbers are in-sample diagnostics, not a validated or
generalizable accuracy claim**. No boundary-tolerance credit is applied.
Results can be reproduced using:

```
node scripts/waveyard-ground-truth-evaluation.mjs --provisional-form \
  scripts/fixtures/waveyard-ground-truth/owner-form-notes-v1.json \
  generated-artifacts/waveyard-real-world-acceptance/form-route-acceptance.json \
  generated-artifacts/waveyard-real-world-acceptance/form-provisional-after.json
```

The full-audio manifest and production route capture in `generated-artifacts/`
are intentionally ignored; they must be generated locally from the owner's
authorized recordings before that command can run. Only the short timestamp
reference and evaluator are committed, not the songs or rendered output.

The normal evaluation still requires two blind independently reviewed,
adjudicated, source-licensed references before formal precision/recall can
be claimed. When genuine verse/chorus predictions and those references
are supplied, its semantic scorer now measures exact-time per-class
precision/recall/F1 independently of structural-boundary accuracy.
The high-value gap is now Queen's complete abstention and the low recall on
September. Do **not** tune thresholds against the same two recordings and
advertise the increased in-sample score as musical understanding; obtain an
independent held-out reference set first.

## Previous verse/chorus baseline — no semantic predictions

At `75cdc0a1`, inspection of the production section worker and the real
persisted profiles from the latest Queen/September route acceptance found:

| Recording | Persisted windows | Labels | Verse/chorus predictions |
| --- | ---: | --- | ---: |
| Another One Bites the Dust | 30 | 28 section, 1 energy-rise, 1 energy-drop | 0 |
| September | 30 | 27 section, 2 energy-rise, 1 energy-drop | 0 |

These are structural/energy observations, not semantic classifications.
Semantic prediction coverage is **0 of 60 windows** on this pair. Verse/chorus
accuracy, precision, recall and F1 are **unavailable**, not established at 0%
or any other percentage. No verse/chorus classifier is wired into this producer.
Finding a nearby structural boundary does not count as correctly naming a verse.

The existing evaluation command was rerun against the existing v2 capture and
reference template. Prediction-format validation passed, but scoring remained
blocked: both recordings lack documented reference rights, completed independent
reviews and adjudication. That capture is historical, not a new current-revision
prediction run. Current-output counts above come from the latest persisted route
profiles, not the historical capture. Owner notes remain exploratory references,
not adjudicated accuracy ground truth.

To establish an accuracy claim requires **both** an actual semantic prediction
path (with explicit unknown/abstention) **and** independently reviewed, source-pinned
reference sections. Report per-class verse/chorus precision/recall/F1, confusion,
time-weighted coverage and timing tolerance separately from structural-boundary
metrics. Until those inputs exist, do not describe this as merely missing test
coverage or publish a fabricated accuracy score.

## Current musical-intelligence change — score the vocal material actually placed

Starting checkout was clean at `868ebec6` on
`jules-2321982355158174303-7f554415`, matching its remote. No branch switch,
history rewrite, PR merge, new model dependency or UI redesign was performed.

**Production path inspected:** decoded source PCM → existing source/section
analysis and rolling fingerprints → persisted current source/stem analysis →
`studio/mashup-sources.ts` (checksum/separation-bound vocal pitch observations,
voiced runs and backing chord events) → `studio/mashup.ts` ranking/plan →
existing mashup route render and persisted Studio arrangement/export.
Structural windows remain distinct from semantic form and lyric phrases.

**Implemented:**
* Planner v5 scores vocal-to-chord agreement over the entire audible vocal body
  that each candidate offset would place, not only the short window that
  discovered the offset. This changes both rolling-window and section discovery.
  Original ranking weights, confidence gates, tempo/key protections and
  missing-evidence fallback are unchanged. Repeated offsets share a bounded
  cache; unrankable feature pairs do not trigger whole-body scans.
* A real separated-song run exposed a separate evidence-loss bug: the harmony
  workers rejected a complete timeline when decoded duration exceeded rounded
  source metadata by a fraction of a second. Both harmonic workers now validate
  against decoded audio first, conservatively crop only that sub-second tail
  to the existing source timeline, and still reject corrupt observations or
  discrepancies of a second or more. Original audio is never changed.
* The existing real-route fixture now persists actual vocal pitch observations
  and runs the existing isolated-backing harmony worker. Previously it saved
  voiced runs alone and did not exercise this harmonic decision path. An optional
  `WAVEYARD_MASHUP_PROFILE_REPORT_PATH` exports the actual persisted profiles for
  comparison, without introducing another analyzer/evaluation system.

**Evidence, kept separate:**
* Controlled known-note regression: both discovery paths previously chose the
  locally fitting opening at 0ms despite later harmonic disagreement. Both now
  choose the sustained-support placement at 8000ms, retain both vocal runs and
  render at that placement. The exact new regressions fail against the starting
  planner and pass against v5. Missing observations retain the original choice.
* Real September separated backing: decoded **215137ms**, metadata **215000ms**.
  The old validator rejected all **108** windows; the corrected worker retains
  108 bounded windows, **36** with accepted chord estimates. The real persisted
  Queen vocal profile carries **7438** pitch frames. These are analyzer
  observations, not independently verified notes/chords.
* On that real pair, v4 and v5 both retain the **279ms** fallback entry and
  **zero rankable passages**. Queen's confidence-limited passage features still
  prevent an evidence-backed match. There is **no demonstrated audible
  improvement on this pair**. No gate was lowered to fabricate one.
* The full real PostgreSQL route acceptance passes: plan/render → save/reopen →
  edit/restore/export, using existing separated recordings. Output was **215s,
  stereo 44.1kHz**, peak **0.432434**, RMS **0.037937**, **0 clipped frames**.
  This is signal/persistence evidence, not a listening-quality result. Its old
  unconditional “at least one ranked passage” assertion was replaced with
  accounting plus explicit no-selection/fallback checks when evidence yields none.
* Other checks: planner **32/32**; full-length/regression/bed **19/19**;
  harmony and persisted stem-worker **7/7**; API TypeScript check passed.
  The first real runs exposed the harmony failure and the invalid assumption
  that a real recording must yield a candidate; only the final run passed.
  Reports remain local/ignored under
  `generated-artifacts/waveyard-real-world-acceptance/full-placement-*.json`.

**Next highest-value work:** investigate why the real Queen route produces
zero-confidence passage features, measuring local beat/feature reliability
without authorizing untrusted stretching. After that, complete independently
reviewed phrase/form validation and rendered masking/phrase-continuity checks.
Semantic verse/chorus accuracy, general musical quality, and Stem.fm parity
remain unproven; this is a focused upgrade, not completion of the entire brief.

## Current verification — alternative live vocal entries

* The vocal source picker keeps its existing one-tap swap and now offers
  **Compare entry windows** as a separate, non-saving action. Up to five
  distinct alternatives expose donor times, rhythm/harmony similarity,
  duration fit, measurement confidence, boundary confidence and beat evidence.
  Scores are not advertised as musical-quality ratings or lyric recognition.
* Donor-only auditions use the actual selected vocal asset, are capped to the
  reviewed window, and stop on close/source changes. The listener may explicitly
  pause the mix for comparison. This browser-media preview is outside the mix
  recording and does not reproduce final WSOLA/key correction/output processing.
* Applying a reviewed match reprojects its offset against the live transport.
  An expired window, seek outside it, or changed tempo ratio requires refreshing;
  it cannot silently apply a stale start. Explicit manual starts and the existing
  automatic alignment fallback remain available and use the existing saved-swap API.
* Detailed alternatives require full session/donor analysis. Library-only
  summaries omit rolling windows; the picker explains adding the donor to the
  session rather than inventing evidence. Missing evidence never blocks a manual
  or ordinary swap. No similarity/confidence threshold was relaxed.
* Verified: frontend TypeScript check; session logic **57/57**; Chromium 155
  `node scripts/waveyard-live-stems.mjs --entry-audition-only`.
  The focused browser fixture checks evidence display, audition without a swap
  write, stop/close cleanup, applying/reopening an exact offset, an existing manual
  override, stale-window refusal, missing-evidence fallback and a 390px layout.
  It uses generated PCM and **mocked session persistence**, not PostgreSQL or
  human-reviewed music. Workflow startup and a mobile Waveyard landing screenshot
  were also checked; neither proves physical-device behavior.
* This delivers selection controls, **not better real-song detection**. The
  six-track result below is unchanged. Real persisted September/Queen offsets
  and independent musical validation remain outstanding.

## Current real-song result — full-track live alignment probe

* The current live section-alignment helper was exercised against all six complete uploaded
  recordings, using their pinned source hashes: 215.14–405.93 seconds each,
  255 detected sections total. The offline evaluator compared 26,825 section
  pairs and tested 3,180 rolling-window positions across all 30 ordered
  track-pair directions.
* **Measured result:** no rolling feature window produced an accepted section
  alignment. These eight-beat fingerprints are not vocal/lyric phrase
  boundaries. Confidence gates allowed a beat-offset fallback for 197 positions
  across two directions (September ↔ Stayin' Alive); the other 2,983 positions
  had no automatic offset. On the primary September ↔ Another One Bites the
  Dust pair, both directions had zero accepted section-window alignments and
  zero beat-fallback positions across 155 rolling windows. The offline Queen source
  analysis reported BPM confidence 0.426 and beat confidence 0.234, below the
  current alignment gates.
* **Interpretation limit:** this is a source-PCM/offline analysis run, not a
  database-backed separation-to-mixer run or a lyric-phrase detector. Its zero
  candidate count is not evidence of zero false matches or musical
  incompatibility. The report keeps correct matches, misses, false matches,
  and offset error null because no independent adjudicated phrase-pair labels
  exist. The coarse owner section notes in chat do not supply phrase-pair
  ground truth.
* **Verification:** the six-full-track acceptance test passes, as do
  `session-logic.test.ts` 56/56 and the ground-truth evaluator 12/12. The
  ignored local report is
  `generated-artifacts/waveyard-real-world-acceptance/alignment-probe-six-tracks-20261113.json`.
  It contains the per-track-pair alignment/fallback counts and explicitly blocked
  ground-truth metrics. No threshold was tuned to this dataset.

## Current verification — pitch lock with multiple live donors

* The browser acceptance fixture now loads two different swapped stems on each
  deck, then toggles pitch lock during a 1.10× crossfade. It measures each
  donor's actual worklet output separately, verifies the old buffer sources
  stopped, checks alignment to each deck clock, disables pitch lock to confirm
  all donors follow varispeed, then re-locks and completes the handoff.
* **Chromium 155 evidence:** donor sources at 230, 410, 370 and 130 Hz measured
  233.33, 408.33, 370.59 and 130.09 Hz with pitch lock; at 1.10× pitch-follow
  they measured 253.45, 450, 408.33 and 143.18 Hz. Re-lock returned them to
  229.69, 408.33, 370.59 and 130.09 Hz. Both incoming-deck donors remained
  audible and pitch-locked after handoff.
* **Verification:** `node scripts/waveyard-live-stems.mjs --pitch-transition-only`
  passes and emits `MULTI_DONOR_PITCH_LOCK_EVIDENCE`; the live stem layer suite
  passes 132/132. These are synthetic sine fixtures measured in Chromium, not
  separated music, cross-browser coverage, or physical-device evidence.

## Current implementation — bar actions require stable downbeat evidence

* Source analysis now compares onset-envelope accents across the four phases of
  a measured beat grid in overlapping four-bar windows. It emits a downbeat grid
  only when every window supports the same phase and the measured beat evidence
  is reliable; a pickup may begin on a non-zero phase. This identifies a
  repeating four-beat accent pattern, not time signature or semantic song form.
  Uniform pulses, weak evidence, short inputs and inconsistent openings produce
  no usable grid. Confidence is an evidence score, not a probability of musical
  correctness.
* Accepted positions are persisted in `source_analyses.downbeat_grid` with
  `downbeat_confidence`. The worker bounds them to the decoded source and checks
  that they follow the measured beat grid at four-beat intervals. Session APIs
  expose them only for current analysis provenance, a reliable beat grid and
  downbeat confidence at or above 0.65.
* Bar snap and one-/two-bar loops are disabled with an explanation when those
  conditions are absent. Saved bar actions do not silently fall back to beat
  snap; they apply immediately with an explicit unavailable message. Beat loops
  and beat snap remain independently available from the measured pulse.
* Migrations `lib/arena/drizzle/0029_source_analysis_downbeats.sql` and
  `lib/arena/desktop-migrations/0031_source_analysis_downbeats.sql` add nullable
  evidence columns. Existing analyses remain null; no broad reanalysis is
  triggered. The additive columns were applied to the development database and
  the API was restarted; production is not migrated.
* **Real-file check:** full decodes of the supplied 215-second September and
  223-second Another One Bites the Dust recordings both produced no usable
  downbeat grid. September had BPM 126.048 and persisted beat confidence 0.805,
  but downbeat confidence was 0; Another One measured BPM 109.957 and beat
  confidence 0.234, below the downbeat estimator's input gate. This shows the
  current gate refuses these two recordings; it does not measure accuracy
  against manually verified bar boundaries.
* **Verification:** downbeat/DJ/session tests pass 84/84. The persisted session
  service, retry and recovery suites pass 58 tests; 5 optional heavy-separation
  cases are skipped. ArenaForge and API-server typechecks pass after rebuilding
  the database project declarations. The signed-in bar controls and browser
  smoke are not verified here. No manually verified real-song downbeat
  evaluation has been run; synthetic signal tests establish gating behavior,
  not musical accuracy.

## Current implementation — live stem swaps honor beat snap

* When Snap is enabled on a playing active deck with a reliable measured beat
  grid, a saved donor replacement is scheduled on the next verified receiving
  track boundary. The donor buffer, the pitch-preserving AudioWorklet path and
  the base/donor gain crossfade all use the AudioContext clock; the UI timer is
  not responsible for the audible start.
* Preparation that reaches the boundary late falls back to an immediate ready
  swap and reports that the beat was missed. Missing/weak beat evidence reports
  that snap was unavailable. If playback pauses during preparation, the donor
  is prepared for resume without claiming a snapped activation. Cancellation
  before the boundary stops the future source and retains the currently audible
  layer.
* A configured bar snap uses the supported measured downbeat positions. If the
  grid is absent, weak or cannot be mapped to the audio clock, no bar claim is
  made and the swap follows the explicit unavailable/immediate path. Snap-off
  replacements remain immediate.
* **Verification:** focused live-stem and session-logic tests pass 187/187;
  ArenaForge typecheck and `git diff --check` pass. The Waveyard mobile smoke
  passes, including its existing browser audio and layout acceptance cases.
  Those browser audio fixtures use deterministic PCM and do not prove that a
  real-song swap sounds musically correct or sample-locked on a physical device.

## Current implementation — live phrase alignment tolerates weak unrelated sections

* Live phrase matching no longer fails for an entire track because some
  unrelated section boundaries have low structural confidence. The active
  recipient section and each donor candidate are still individually gated at
  0.6; weak active passages keep the beat-phase/manual fallback.
* Checksum-current rolling rhythm/chroma windows may be compared at native pace
  when both beat grids have confidence of at least 0.6, even if whole-track BPM
  confidence is lower. This does not authorize tempo stretching: uncertain BPM
  keeps the donor at 1×, and candidate windows must still meet the existing
  duration and rhythm/harmony similarity thresholds.
* **Real-track evidence:** the current full-track analyses of the supplied
  September and Another One Bites the Dust recordings contain 34 and 25
  sections; 11 and 14 sections, respectively, have structural confidence below
  0.6. The previous whole-list confidence check therefore rejected both tracks
  before it could consider a strong local passage. Their beat-grid confidences
  are 0.833 and 0.642, while the latter's whole-track BPM confidence is 0.426.
  The existing real mashup-route capture found no strong cross-song candidate:
  its selected relative score was 0.567, with 0.497 onset-rhythm similarity and
  0.246 harmony similarity. The new behavior permits evidence checks where
  locally justified, but these recordings do not demonstrate a successful
  automatic live match or a listenable mashup.
* **Verification:** `session-logic.test.ts` passes 53/53, including regressions
  for weak sections elsewhere in either track and for native-pace matching with
  uncertain global BPM. ArenaForge typecheck and
  `node scripts/arena-smoke.mjs --waveyard-mobile-only` pass. Listening quality
  and a real cross-song window match remain unverified. The full configured test
  workflow separately timed out waiting for a live-stem browser response; it
  did not report a failure in section-matching logic.

## Current implementation — editable vocal entry points and repeated vocal-activity evidence

* **Live vocal swaps:** the session picker now keeps open after choosing a vocal
  donor and exposes a donor-time slider. Users can select an exact source start
  or snap to checksum-current isolated vocal activity, pitch-continuity phrase
  candidates, or detected section boundaries. Applying a start persists it
  separately from the recipient's swap time in
  `wy_listen_session_swaps.donor_entry_offset_ms`; playback maps the selected
  donor time through any supported tempo stretch. “Automatic alignment” clears
  the manual choice and restores the existing section/beat fallback.
  The development schema was pushed and the nullable integer column was
  verified in PostgreSQL; production was not changed.
* **Evidence boundaries:** only completed vocal analysis tied to the current
  source/stem IDs, checksums, engine, and version is offered. Starts beyond the
  decoded source or vocal stem are excluded. The interface distinguishes coarse
  voice activity from pitch-continuity phrase candidates and explicitly says
  neither is word-level transcription; generic section labels are not promised
  to be verses or choruses. Desktop migration
  `0030_live_swap_vocal_entry_offset.sql` adds the nullable donor-time field.
* **Structure evidence:** when repeated audio sections already agree in
  beat-subdivision rhythm and four-bin chroma, matching isolated-vocal activity
  contours can strengthen their label to “repeated audio pattern … vocal-activity
  agreement.” The activity mask requires at least four active bins and at least
  90% contour agreement across occurrences. It does not identify repeated
  lyrics, infer chorus/verse meaning, or establish that a vocal donor will sound
  good over a different track.
* **Verification:** the real PostgreSQL service test checks persisted donor
  entry round-tripping and current-checksum activity/phrase evidence in a donor
  session response. Pure tests cover nearest-point snapping, native/stretch
  donor-clock offsets, matching and mismatching repeated vocal contours, and
  honest labels. These checks do not demonstrate lyric recognition or prove
  that a rendered mashup sounds musically right. Focused typechecks passed;
  relevant pure tests passed 73/73; the PostgreSQL service suite passed 53 with
  5 optional heavy-separation tests skipped. The focused live-donor recovery
  browser check passed. The broader `arena-smoke.mjs --waveyard-mobile-only`
  run did not finish cleanly: one attempt timed out waiting for the pending
  vocal-swap DELETE response; a retry stopped before completing the remaining
  stages. The empty-library preview loaded, but no signed-in live-session UI
  was available for visual verification. Treat the pending-cancel UI and
  real-device behavior as unverified.

## Current implementation — uncertain BPM correction before live stem swaps

* The session live-swap picker labels low-confidence BPM as approximate and
  uncertain instead of presenting it as an exact tempo. The same uncertainty
  is visible in the session deck and library player.
* Users can set or clear a 40–300 BPM correction for the current track or a
  donor before swapping. Corrections are saved only in browser local storage,
  scoped to that session and device; they do not change the shared analysis row.
  A correction can authorize the modest tempo stretch, but it does not increase
  beat-grid confidence or enable beat alignment. The picker says this directly,
  and swap status identifies when a manual BPM was used.
* A full-file local analysis of the supplied 215.1-second September recording
  measured 126.048 BPM at 0.697 confidence. The supplied 222.7-second Another
  One Bites the Dust recording measured 109.957 BPM at 0.426 confidence; given
  the currently used 0.5 tempo-evidence threshold, the latter stays visibly
  uncertain and will not authorize automatic tempo stretching without a
  correction. This comparison is evidence about these two recordings, not a
  general accuracy benchmark or proof of reliable beat-grid alignment.
* Focused verification: `session-logic.test.ts` passes 46/46 tests, including
  correction range checks, a low-confidence half-time-like estimate that stays
  at native pace, a user-confirmed correction that enables a modest tempo ratio,
  and a check that the correction does not promote weak beat-grid evidence.
  `node scripts/arena-smoke.mjs --waveyard-mobile-only` passes, including the
  portrait keyboard-safe live-swap picker and compact landscape layout.
  ArenaForge typecheck passes. No separated-stem listening comparison was
  performed in this pass.

## Current implementation — separated-bed chord evidence for mashup ranking

* **Production path:** a completed separation now provisions checksum-bound
  chord analysis for one non-vocal stem, preferring `instrumental`, then
  `other`, `piano`, and `guitar`. The local worker verifies the stem file hash,
  decodes its actual PCM, persists the chord events, and recovers interrupted
  jobs at API startup. Source-level harmony remains independently stored.
* **Mashup path:** the plan/render/save route resolves the exact completed bed
  separation first. It loads harmony only from the matching stem asset when its
  source checksum, stem checksum, engine, and version are current. If no valid
  stem result is available, planning falls back to current full-source harmony
  and surfaces that weaker evidence source as a warning. A stale stem analysis
  cannot silently contribute.
* **Persistence:** desktop migration `0029_stem_harmony_analysis.sql` and
  Drizzle migration `0028_stem_harmony_analysis.sql` add stem-scoped analysis
  and event tables. Re-separation deletes its old stem-linked evidence through
  the existing stem foreign-key cascade. The schema is applied to the Replit
  development database with `pnpm --filter @workspace/db run push`; production
  remains untouched and receives schema changes through the normal publish flow.
* **Planning behavior:** for a candidate passage, measured vocal pitch classes
  are mapped through the planned stretch and pitch shift onto the bed's measured
  chord timeline. Their chord-tone share is a soft ranking feature (12% before
  evidence weighting), not a gate. It needs at least six voiced frames and
  coverage of at least half of those frames; absent, stale, sparse, or unknown
  evidence leaves the previous ranking/fallback intact. This is not lyric
  transcription, a dissonance classifier, or proof of a good-sounding mix.
* **Planning behavior:** for a candidate passage, measured vocal pitch classes
  are mapped through the planned stretch and pitch shift onto the bed's measured
  chord timeline. Their chord-tone share is a soft ranking feature (12% before
  evidence weighting), not a gate. It needs at least six voiced frames and
  coverage of at least half of those frames; absent, stale, sparse, or unknown
  evidence leaves the previous ranking/fallback intact. This is not lyric
  transcription, a dissonance classifier, or proof of a good-sounding mix.
* **Harmony/MIDI correction:** the local chord detector stores a top-two
  template-score margin, not a calibrated probability. The shared minimum
  accepted margin is 0.04. Harmony MIDI export previously compared this value
  against 0.6 and then converted it into near-silent note velocity; its default
  now matches the detector's gate and uses a neutral velocity of 80. Callers
  can still set a stricter explicit threshold.
* **Verification:** the current focused batch passed 34 tests across persisted
  mashup/database acceptance, stem analysis, and mashup planning. The targeted
  queue-registration and four-stem separation-to-queue tests passed separately
  (2/2). `pnpm exec tsc --build --pretty false`,
  `pnpm --filter @workspace/api-server run typecheck`, and the API-server build
  passed. The persisted worker test
  decoded a real WAV stem and saved chord events with both checksums; the
  database acceptance test selected those events for the exact bed separation
  and confirmed stale stem evidence falls back to source-mix evidence.
  The separation test confirmed that publishing an `other` stem provisions
  its durable analysis and queue payload.
  The current local detector was also run on the full 222.67-second _Another
  One Bites the Dust_ vocal stem and 215.14-second _September_ non-vocal stem:
  7,438 pitch frames (1,107 voiced), 108 two-second chord windows (36 named),
  and 59 candidates with chord-fit measurements among the planner's returned
  top-eight rankings. The strongest displayed chord-tone share was 0.689.
* **Not proven:** the new worker and persistence tests use generated chord WAVs,
  and the separation integration uses identity inference; no full-length
  commercial track has yet completed this new separated-stem persistence
  path. The harmonic source is one selected stem (often the `other` residual),
  not a sum of all non-vocal layers. The planner selected the same bed window
  with and without the optional chord feature in the earlier real-track probe;
  that selected window had no sufficiently covered chord evidence. No
  listener-rated compatibility, lyric timing, semantic form,
  rendered-mashup quality, or Stem.fm parity is established. The full
  separation test file was terminated by the runner before a suite summary;
  its targeted four-stem queue-provision regression passed.

## Current implementation — tempo-locked vocal-chop patterns

* **Musical position:** generated pad hits now retain their sixteenth-step
  identity and original extracted sample length. Studio BPM changes retime the
  ordinary arrangement clips and cap each hit to the new step while keeping
  its original sample boundary. Preview, persistence, and export continue to
  consume the same clip timeline.
* **Persistence and editing:** migration `0028_remix_chop_grid.sql` adds the
  optional clip fields and backfills existing on-grid sequencer clips with
  their safest known duration. Whole-session saves, versions/restores, track
  edits, and clip moves preserve or deliberately detach the pad identity.
  Ordinary clips are unchanged.
* **Verification:** 18 focused vocal-chop tests passed. The API acceptance
  route test also passed using its synthetic audio fixture and embedded
  PostgreSQL: it created a blank sequencer track from a same-project stem,
  saved and reopened two assigned steps, rejected a stale save, kept the
  existing source clip exactly once, and exported a WAV through the persisted
  version and production media route. PCM checks found audio on both assigned
  steps, silence on the empty step, and no chops in an older version's export.
  `git diff --check` and the API-server package typecheck passed. The automatic
  remix route now builds the full fingerprint evidence from separately
  persisted vocal activity intervals and pitch-continuity phrases instead of
  omitting the newer evidence fields.
* **Not proven:** this sequencer acceptance used generated tones, not a
  real-world separated vocal stem. Export after changing the saved pattern's
  tempo remains unverified. These checks prove persistence and rendering, not
  that a real-world chop pattern sounds musically good.

## Current verification — active separation memory

* **Measurement:** each production inference worker samples
  `process.memoryUsage()` every 500 ms from model-session creation through the
  end of its model pass and after each completed model chunk. The parent
  independently samples process RSS every 100 ms, so ONNX calls that block the
  worker event loop cannot hide short RSS peaks. Both samplers retain only
  maxima and counts; they keep no sample history. RSS is process-wide; heap,
  external memory, and array-buffer counters are for the active worker isolate.
* **Reporting:** schema-v2 real-ORT memory reports record active peaks per model
  pass separately from `postReleaseMemory`, sampled after each complete
  four-model job and the existing worker-teardown settle. These are different
  measurement windows and must not be compared as though they were simultaneous.
  They are sampled maxima, not allocation tracing: a brief worker-isolate
  heap/external peak inside a single native call can still fall between chunk
  callbacks and timer samples.
* **Verification:** sampler unit coverage checks independent counter maxima,
  bounded report shape, and both intervals (4/4). The real-length worker and
  library-responsiveness check passed (1/1). The pinned four-model CPU memory
  acceptance passed six repeated four-second synthetic-input jobs. Active
  process-RSS maxima across those passes were 2,494.5 MiB for `kim_vocal_2`,
  1,488.3 MiB for `kuielab_b_drums`, 1,785.5 MiB for `kuielab_b_bass`, and
  1,823.4 MiB for `kuielab_b_other`; per-worker heap/external/array-buffer
  counters are also in each report. Post-release RSS ranged 766.2–1,330.1 MiB.
  The existing continued-growth check passed at 116.1 MiB against its 128 MiB
  limit, so this is not evidence that peak memory is safe on low-memory machines.
  The responsiveness test is not a paired throughput benchmark, so it does not
  prove that sampling has zero performance cost.
  A six-job rerun after adding per-chunk worker snapshots was terminated by the
  runner before it wrote a report; the exact six-job figures above are from the
  preceding version with the same independent 100 ms RSS sampler. The
  real-length worker test passed again on the final per-chunk-sampling version.
  Tests use the rebuilt worker (`pnpm --filter @workspace/api-server run build`)
  before running the real-ORT acceptance; a stale `dist` worker can report an
  obsolete sampling interval.

## Current verification — full-track vocal activity

* **Implementation:** isolated vocal analysis now persists coarse acoustic activity intervals separately from pitch-continuity runs. Source-linked section fingerprints preserve both signals; sustained two-bar activity entry/dropout can add a `vocal-change` structural event. Repeated-window matching may not erase a measured vocal or stem boundary. This does not detect lyrics or semantic musical form.
* **Persistence and refresh:** migration `0027_vocal_activity_intervals.sql` stores the new evidence in both desktop and Drizzle migration trees. Older local vocal-analysis rows refresh in place when a matching separated stem is provisioned again. Queue identity includes analysis engine/version, and an old queued payload cannot fail a refreshed current-version row.
* **Real-track check:** the full 215.14-second _September_ vocal stem yielded 36 activity intervals and a first sustained-entry boundary at 19.145 s, versus the owner’s approximate ~20 s marker. The full 222.67-second _Another One Bites the Dust_ vocal stem yielded 40 intervals and an entry boundary at 26.389 s, versus ~27 s. These two timing comparisons are within 0.86 s and 0.61 s, respectively, but they are only approximate single-listener checks—not independent accuracy metrics. Interval confidence/strength values are heuristic signal scores, not calibrated probabilities; event strength is a coverage difference.
* **Verification:** 89 focused Waveyard tests passed across vocal activity, section detection, version refresh, stale-job protection, fingerprint persistence/parser, mashup planner, and persisted remix acceptance. `pnpm run typecheck:libs` and `git diff --check` passed.
* **Not proven:** the commercial full-track stem check was offline; the complete current separation-to-database route was not rerun on those tracks. Musical form, phrase/word timing, chorus recurrence accuracy, rendered mashup quality, and independent-review accuracy remain unverified. See [`waveyard-ground-truth-evaluation.md`](./waveyard-ground-truth-evaluation.md) for the evidence boundary and review protocol.

## Current implementation — rolling mashup windows and pitch-aware chops

* **Passage evidence:** current source analysis persists checksum-bound local
  eight-beat rhythm, chroma, and beat-phase windows every four beats across
  longer passages (up to 256 windows per passage). Legacy fingerprints without
  this optional field remain readable. A desktop database round-trip test now
  verifies that these windows survive persistence and reload.
* **Mashup selection:** when both sources have valid local windows and measured
  beat grids, the planner compares voiced-activity windows against candidate
  backing windows throughout the full section instead of only comparing one
  whole-section summary. It samples bounded candidate sets, still uses the
  existing measured rhythm/harmony/phase/tempo evidence, and keeps the safe
  fallback when local evidence is missing. The selected local match changes
  alignment, not the full vocal recording; this is not word-level lyric timing
  or a semantic verse/chorus classifier.
* **Beat tracking:** the local beat-grid estimator now phase-locks against the
  opening attacks, corrects gradual drift from measured local attacks, and
  bounds each correction. Synthetic gradual-drift coverage passes. This is not
  yet a real-song beat-accuracy benchmark.
* **Stem-boundary precedence:** repeat-pattern labels can no longer swallow a
  checksum-verified sustained stem-activity boundary. The persisted worker test
  confirms the boundary and its source-linked evidence survive the database
  route.
* **Sampler controls:** the vocal-chop panel now offers pitch-class and
  estimated-key filters, prefers a diverse set of detected notes, and exposes
  Chopped, Chipmunk (+octave), and Screwed (−octave) sequencing styles instead
  of always sending the same default style.
* **Verification:** 99 focused tests passed across beat analysis (18), section
  structure (12), mashup planning/rendering (26), fingerprint parsing (11),
  persisted fingerprint round-trip (1), persisted stem-activity workflow (5),
  vocal chops (16), and the soul-chef sequencer (10). Workspace typecheck and
  `git diff --check` passed.
* **Not proven:** no independent word/phrase transcription, human annotation
  accuracy, real rendered two-song listening evaluation, or listener-rated
  mashup quality was performed in this change. The new ranking is measured
  relative evidence, not proof that the generated mashup sounds good. Continue
  with local vocal phrase timing and a real full-length rendered-mix acceptance
  before claiming intelligent mashups.

## Current verification — AAC/M4A library import

* **Acceptance command:** `WAVEYARD_RUN_REAL_LIBRARY_M4A=1 pnpm --filter @workspace/scripts exec node --import tsx --test --test-isolation=none "$(pwd)/lib/arena/src/lib/waveyard/library/service.test.ts"`.
* **Codec/import evidence:** FFmpeg generated a disposable one-second, stereo,
  44.1 kHz AAC stream in an M4A/MP4 container. `ffprobe` identified `aac`,
  `mov,mp4,m4a,3gp,3g2,mj2`, 44.1 kHz, and two channels. Library intake used no
  model override and persisted `audio/mp4`, the codec, sample rate, channels,
  and `.m4a` filename; the source checksum remained unchanged.
* **Separation/mixer evidence:** the default four-model CPU recipe completed
  (`kim_vocal_2`, `kuielab_b_drums`, `kuielab_b_bass`, `kuielab_b_other`). Four
  private WAV outputs were decoded, loaded by the live mixer through the private
  asset route, and played. Each isolation control left its matching stem
  audible and muted the other three. The full service suite reported 54 passed,
  4 skipped; the opt-in AAC/M4A acceptance itself passed.
* **Quality/performance boundary:** the fixture is synthetic, so this proves
  codec intake, processing, persistence, and mixer routing—not musical
  separation quality. The whole acceptance took about 45 seconds on Linux CPU;
  it is not Windows throughput evidence. The optional vocal-timing queue logged
  that no local executor was registered, but separation completed successfully.
* **Transition regression:** the existing two-track MP3 acceptance now uses
  four-second synthetic controls so playback does not reach end-of-file during
  the live transition/isolation checks. The filtered regression passed (1/1),
  completing both tracks through the pinned CPU models.

## Current implementation — checksum-bound stem activity and vocal timing

* **Behavior:** after a completed separation publishes its stems, Waveyard records
  the source checksum on that separation job, dispatches a fresh structural
  analysis for those exact source bytes, and automatically queues local
  pitch-continuity analysis for the top-level vocals stem. When vocal analysis
  completes, it dispatches a second structural refresh so persisted passage
  fingerprints can include the newly saved vocal timing. Each refresh has a
  distinct dispatch identity. A separation remains complete if optional vocal
  analysis cannot be queued.
* **Measurement:** the section worker verifies source and stem storage objects
  against their persisted hashes, accepts only top-level stems from a completed
  separation whose recorded source checksum matches, then measures per-bar RMS
  from decoded stem PCM. A candidate `stem-change` boundary requires at least a
  sustained 6 dB shift across two stable bars on each side. A single-bar fill
  is rejected. Vocal timing runs come from the existing local pitch detector,
  bounded to the decoded vocal PCM duration. They describe sustained voiced
  pitch continuity only: not words, lyrics, or semantic vocal phrases.
  Neither signal identifies verse, chorus, breakdown, or musical compatibility.
  Legacy completed separation rows without a recorded source checksum are
  intentionally ignored; re-run separation before their stem activity can be
  trusted.
* **Persistence/UI:** schema-v2 passage fingerprints now carry per-passage
  pitch-continuity run intervals with the exact vocal-analysis and stem identity
  and are versioned as `2.1.0`. The Studio labels these as pitch-continuity runs,
  not phrases or lyrics. Automatic-remix evidence shows their count and voiced
  coverage and the first three measured intervals as context only; none can gate
  compatibility. Old fingerprints
  are invalidated by the engine version bump and can be regenerated by
  analysis/separation.
* **Verification:** persisted PGlite worker acceptance proves checksum-matched
  stem PCM creates source-linked boundary evidence, a separation with a stale
  source checksum is ignored, corrupt optional stems fall back to source-only
  analysis, vocal runs are persisted into only the source passages they overlap,
  stale vocal-stem checksums remove that evidence on refresh, and completion of
  local vocal analysis dispatches a distinct section refresh. Four-stem
  separation also queues the vocal analyzer. Focused tests passed (27/27),
  including the persisted worker and vocal-analysis lifecycle; the four-stem
  separation integration test passed (1/1). Full workspace typecheck and
  `git diff --check` passed.
* **Real audio measurements:** *September* (215.14 s) produced 11 sustained
  per-stem changes, 9 retained as generic section boundaries after the
  nearby-boundary guard; *Another One Bites the Dust* (222.67 s) produced 7
  changes, 4 retained as boundaries. Examples include a Queen vocal-level rise
  of 43.6 dB at 24.21 s, a bass drop of 9.0 dB at 43.85 s, and an `other`-stem
  drop of 32.2 dB at 89.69 s. This proves the measurements can flow through the
  real PCM decoder and persisted worker path. It is not semantic accuracy or
  listener-rated quality. The recorded audio and stem artifacts are local,
  ignored files; no production database was changed.
  A separate full-length DSP pass over the existing separated vocal WAVs
  measured 7,186 pitch frames / 75 continuity runs for *September* and 7,438
  frames / 89 runs for *Another One Bites the Dust*. The first detected run
  begins at 19.336 s and 25.233 s respectively. The first is near the owner's
  approximate September intro boundary (19–20 s); the Queen run begins about
  1.8 s before the owner's approximate first-verse boundary (27 s). These are
  useful real-track observations, not an accuracy score: pitch voicing can miss
  breathy consonants and can include stem leakage. This standalone DSP pass did
  not write a new database-backed full-track result.
* **Next:** compare vocal runs and generic boundaries against independently
  locked human annotations, then run separated full tracks through persisted
  analysis → automatic arrangement → export → save/reopen and listen. Do not
  tune thresholds or call this lyric, verse/chorus, or mashup-quality
  recognition until those evaluations exist.

## Current implementation — relative-duration vocal-layer candidates

* **Behavior:** the mashup planner now compares whole-bar passages with
  different durations by resampling their per-beat onset shapes to a common
  normalized timeline. It reports duration similarity separately and includes
  it in the uncalibrated relative ranking; exact core-compatibility still
  requires equal phrase lengths and the existing tempo, rhythm, chroma, and
  beat-phase evidence. A mismatch is a ranked context candidate, not an
  equivalence or quality claim. Planner provenance is now version 3 so saved
  arrangements distinguish the revised ranking behavior.
* **User-facing result:** Mashup Studio exposes each donor passage's ranked bed
  alternatives with their proposed entry and separate duration, rhythm,
  harmony, and beat-phase comparisons. The UI continues to call these
  analyzer-defined windows, not verified verse or chorus labels.
* **Verification:** fixtures prove a 16-beat passage can be compared with
  20-beat and 12-beat whole-bar windows, that duration remains visible, and
  that exact-core eligibility is not fabricated. The mashup and compatibility
  suites passed (35/35) before the database fixture was brought in line; the
  final mashup, database round-trip, compatibility, and stem-evidence run passed
  (55/55), and full typecheck passed.
* **Archived-track probe:** re-scoring the existing full-track *Another One
  Bites the Dust* → *September* fingerprints found 533 non-identical whole-bar
  pairs with measured rhythm, chroma, and beat-phase inputs among 850 pairs.
  The best minimum across those three similarities was still low (rhythm 0.346,
  chroma 0.402, phase 0.795; 8 vs 16 beats). This was an exploratory in-memory
  comparison on an older report with absent stem-activity evidence treated as
  unavailable; it is not a new persisted run or a mashup-quality result.
* **Limit:** normalization compares each section's overall shape. It does not
  find a shorter repeated subsection inside a longer section, transcribe lyrics,
  or guarantee syllable-to-beat alignment. Run it against the real September /
  Queen pair and listen to full renders before treating the candidates as
  musically useful.

## Independent full-track ground-truth baseline — 2026-11-12

* **Implementation:** commit `a347f8615d65b8ae4b9d8f912ef79d7ba8c8e522` on `v0/independent-waveyard-eval`, based on `9ac6c612bd8809afb80353c126b494e2ad2b244d`. Adds a versioned two-reviewer annotation template, a provenance-gated evaluator, a blocked report, and protocol documentation; no audio was added to Git.
* **Non-interference:** the production passage-search result now serializes the full feasible bed-candidate list for each donor window, with source checksum, time bounds, existing relative score, detector confidence, transient tie-break score, and the currently selected candidate. The selected candidate remains rank 1. Candidate scoring, filters, thresholds, and selection behavior are unchanged. The new field is optional for compatibility with older saved plans.
* **Evaluation contract:** schema v2 separates semantic section labels from
  structural transition timestamps. Boundary detection uses one-to-one matching
  within a declared 2-second tolerance; candidate-window judgments use IoU 0.5.
  Semantic section accuracy and lyric-phrase timing remain unavailable until
  production predictors emit those respective outputs. Pitch-continuity runs
  are retained as evidence but never scored as lyrics. Full-track metrics require
  two independent blind reviews, adjudication, exact source identity, documented
  rights, producer revision and capture time, and at least 95% section coverage.
* **Current evidence:** `scripts/fixtures/waveyard-ground-truth/pending-report-v2.json`
  is `blocked`; metrics are null. The exact audio files are present only as
  ignored user-uploaded attachments in this Replit workspace, not in Git. Their
  SHA-256s match the prior production manifest and are recorded in the
  annotation and prediction templates. A fresh database-backed production
  acceptance run now exports a complete prediction snapshot to the ignored
  `generated-artifacts/waveyard-real-world-acceptance/predictions-v2-captured.json`:
  25 and 34 source-bound structural sections, 24 and 33 internal boundary
  timestamps, 89 pitch-continuity runs for the donor, and all 17 donor windows
  with feasible ranked bed candidates. Prediction provenance validates for
  producer revision `5699f22100c3128cfdb30019b0aa69751c4edf72`. Section analysis
  now clamps its final persisted windows to decoded PCM length instead of the
  source table's rounded whole-second duration: the two latest captures end at
  222,673 ms versus 222,670 ms metadata and 215,137 ms versus 215,140 ms.
  This fixes trailing-window overrun only; it does not improve the 6/18
  exploratory internal-boundary comparison. The 89 runs are
  not words, syllables, or lyric meanings; the bed track has no pitch-continuity
  analysis in this route direction. The captured report
  `generated-artifacts/waveyard-real-world-acceptance/owner-review-pending-report-v2.json`
  has complete prediction provenance but remains blocked because rights
  evidence, two independent reviews, adjudicated status, and review timestamps
  are absent. An exploratory check against 18 approximate owner-marked starts
  found nearest structural boundaries within 2 seconds for 6/18 and within 1
  second for 1/18. This is not a formal accuracy score or evidence of semantic
  section recognition.
  Production-code inspection confirms these are not semantic section
  predictions: candidate boundaries are local onset-envelope peaks at
  four-beat bar positions, and repeated 2/4/8-bar patterns split the windows.
  The 6/18 comparison therefore cannot distinguish missed song-form changes
  from different structural events. No thresholds were changed to fit these
  notes; independent section annotations are still required before tuning.
* **Additional regression coverage:** the production route test now requires
  full feasible candidate rankings to survive API serialization, in consecutive
  rank order, with the selected candidate first and source-bound passage IDs. A
  fresh real-track acceptance run passed (1/1) and wrote an ignored full-song
  report at
  `generated-artifacts/waveyard-real-world-acceptance/full-track-ground-truth-predictions-capture.json`.
  It covers the 17 real vocal-donor windows and their feasible rankings; the
  run also completed the persisted Studio round-trip and full WAV export. This
  checks evidence transport only; it does not change candidate scoring or
  selection. Do not provide the repository, handoff, or report to blind
  annotators until their independent labels are locked.
* **Verification:** ground-truth evaluator tests 11/11, source-section tests 9/9, local section-rhythm tests 10/10, real production route acceptance 1/1, API TypeScript typecheck, `git diff --check`, and Prettier checks on the evaluation files passed.
* **Next:** establish review authorization, obtain and lock two independent blind section reviews, and adjudicate disagreements. The owner has supplied first-pass listening notes in chat; they are not a second review or a committed annotation file. The vocal detector produces pitch-continuity intervals, not lyric phrases, so do not claim lyric-timing accuracy from the 89 predictions.

## Current verification update — 2026-11-12, whole-track passage search

* **Whole-track search:** the planner now evaluates every confidence-qualified,
  voice-bearing donor section against every checksum-current bed passage,
  including bed passages before the safe fallback entry. It records each
  section's measured time window, voiced-run count, candidate bed window,
  proposed entry, relative score, feature-detector confidence, and reason.
  A candidate is used only when phrase lengths match and rhythm, chroma, and
  beat-phase evidence are present. Transients only break near-ties. The chosen
  passage shifts the complete vocal body; it does not crop away earlier
  material. Incomplete evidence or loss of vocal coverage retains the fallback.
* **User-visible and persisted result:** Mashup Studio lists every evaluated
  donor passage and clearly says that the time windows are not verified
  verse/chorus labels, relative score is not a probability of musical fit, and
  feature confidence is detector confidence rather than predicted sound
  quality. The initial saved remix version records the plan and passage
  evaluations; subsequent named versions carry that provenance. Saved clip
  placement and donor source offsets are covered by the database round-trip
  acceptance test.
* **Real full-track result:** the production route evaluated all 17
  voice-bearing sections from *Another One Bites the Dust* (222.67 s) against
  *September* (215.14 s). Ten donor windows had at least one rankable bed
  candidate; seven had none. The top relative score was 0.567 (not a calibrated
  match probability), selecting donor window 67.860–72.226 s against bed
  window 43.897–47.705 s and proposing a 1.020 s bed entry. The full detected
  vocal body from 24.983–206.960 s remained in the plan. Its minimum reported
  feature confidence was 0.907, which is not confidence that the mashup sounds
  good. The complete 215 s session saved, reopened, edited, restored, and
  exported as stereo 44.1 kHz WAV; the acceptance run passed.
* **Ground-truth boundary:** the owner supplied coarse approximate section
  notes in chat, but they are not committed/adjudicated phrase-pair labels and
  do not cover the full candidate-usefulness review. Therefore this run cannot
  report phrase-match accuracy, missed/false matches, or offset error against
  independent references. Analyzer windows do not prove verse/chorus
  understanding, and no listener-rated mashup quality was measured.
* **Next missing capability:** the fingerprint worker currently gives chroma
  the beat-grid confidence; it does not independently quantify whether a
  passage's harmonic evidence is ambiguous or distinctive. The analysis also
  has no lyric/word timestamps or human-validated form labels. Do not tune
  ranking thresholds or call the selection musically intelligent until those
  missing measurements and listening evidence are evaluated.
* **Verification:** mashup planner tests 24/24, mashup database acceptance
  2/2, synthetic production-route acceptance 1/1, and real full-track
  save/reopen/edit/restore/export route acceptance 1/1 passed. Library,
  API-server, and frontend typechecks and `git diff --check` passed.

## Historical Stage 2 verification — 2026-11-12, durable bass-attack evidence

* **Status:** durable bass analysis and persistence remain current; only the
  transient-driven entry movement documented here is superseded by Stage 3.
* **Durable measurement:** Waveyard now has separate `bass_analyses` and
  `bass_events` records for low-band attacks measured from an isolated bass
  stem. Results are versioned (`arena-js-dsp-bass-lowband` 1.0.0) and bound to
  the source and stem IDs and SHA-256 values. The worker verifies the stored
  stem bytes, then rechecks both asset checksums transactionally before
  persisting events and beat-grid projections. Stale inputs are rejected, and
  interrupted jobs are recovered at API startup.
* **Planner workflow:** a mashup request reuses only complete, current
  persisted bass results. If none exists, the local worker is asked to produce
  one while the current request uses explicitly identified, checksum-verified
  request-time detection. The stem endpoint exposes analysis status and current
  events. A remote bass worker is not configured; hosted runtimes do not claim
  that queued local analysis will run.
* **Schema deployment:** additive migration `0026_bass_stem_analysis.sql` is
  applied to the development database. Production schema application was not
  performed; it remains a separate publish-time step.
* **Historical algorithm result (superseded above):** the production mashup route test processed the
  full 215-second separated bass stem from *September* and persisted 1,833
  low-band attack events. The route then loaded those database events while
  planning the full-length *Another One Bites the Dust* vocal over the
  instrumental bed. Eight of eight early voiced-run starts fell within 90 ms
  of a measured bass attack; the earlier transient-only planner moved the
  entry 952 ms from the initial grid candidate. Stage 3 above removes that
  transient-only objective and is the current behavior.
  The 215-second mashup was saved, reopened, edited, restored and exported by
  the same production acceptance test. Report:
  `generated-artifacts/waveyard-real-world-acceptance/stage2-durable-bass-acceptance.json`.
* **Historical verification:** the local stem-analysis database test passed 1/1, including
  durable event writes, startup recovery, changed-checksum rejection and
  corrupted stored-byte rejection. The synthetic route acceptance passed 1/1,
  proving seeded persisted drum and bass events affect planning. The real-track
  production route acceptance passed 1/1, including the worker-produced bass
  evidence and save/reopen/export workflow. `pnpm --filter
  @workspace/api-server typecheck`, `pnpm run typecheck:libs`, and
  `git diff --check` passed.
* **Limits:** 1,833 events are low-band attack measurements, not bass-note or
  pitch recognition. The eight timing matches demonstrate that persisted
  measurements reached the planner; they do not establish musical
  compatibility, lyric understanding, an intelligent full-song arrangement,
  or listenability. There was no human listening evaluation, and this is one
  song pair, not arbitrary-song proof.

## Historical Stage 1 verification — 2026-11-12, provenance-backed mashup evidence

* **Shared evidence packet:** Waveyard mashup planning now carries one
  versioned, per-source evidence packet for tempo, key, beat grid, sections,
  vocal activity, harmony, drum events, and bass attacks. Each available
  measurement records its source checksum, analysis engine/version, and whether
  it came from saved analysis or the current request. The planner consumes
  checksum-current values while retaining a fallback for older test fixtures.
* **Stale section protection:** mashup source loading now requires the section
  analysis to match the current source analysis and checksum. Individual rows
  must also match the same source/section analysis IDs, checksum, engine/version,
  valid time bounds, and confidence ranges. A stale section row is excluded.
* **Persisted drum reuse:** when a completed drum analysis matches the current
  source and exact saved stem checksums and a supported engine/version, mashup
  planning uses its persisted event timestamps. Otherwise the route explicitly
  warns and uses checksum-verified request-time detection. At this earlier
  checkpoint bass attacks were request-time only; the later Stage 2 update above
  adds checksum-bound persisted bass analysis.
* **User-visible evidence:** Mashup Studio now shows each source's measured or
  unavailable inputs, including the engine/version and saved-versus-current-run
  provenance. This reports measurements; it does not label a track's verse,
  chorus, lyrics, or musical quality.
* **Historical evidence limits (superseded by Stage 3 above):** the route test seeds three deterministic drum events and
  three vocal-activity intervals; the resulting plan moves entry by 500 ms and
  reports 3/3 timestamp matches. This verifies that persisted events drive the
  earlier planner, not that a generated or real mashup is listenable. Stage 3
  now uses checksum-current harmony and passage fingerprints for relative
  cross-song ranking, but did not find an eligible passage for the tested first
  vocal section. Lyric timing, bass-note identity, structural form understanding,
  and human listening quality remain unverified.
* **Verification:** `mashup-db-acceptance.test.ts` 2/2; production route and
  Arena handoff acceptance 1/1; musical evidence provenance tests 2/2; API
  server and ArenaForge typechecks passed; library typecheck and `git diff
  --check` passed. No migration or dependency change was made. Windows and
  human listening were not tested in this pass.
## Historical Stage 2 verification — 2026-11-12, transient-alignment entry comparison

* **Status:** this earlier planner behavior is superseded by the cross-song
  passage decision documented above.
* **Historical behavior:** mashup planning measured transient events from the
  exact latest completed separated bed stems. It verifies each stem file's
  checksum against its saved asset record and accepts only 44.1 kHz stereo
  WAV. The drum detector reports unlabeled full-band transients; the bass
  detector measures spectral changes from 35–250 Hz and rejects frames where
  that band contributes less than 4% of spectral energy. The planner compares
  the first 16 seconds of confidence-qualified voiced-run starts against those
  events, scores the first beat plus the next four trusted beats, and moves the
  entry only when the measured overlap score improves. A bounded 10-minute,
  eight-entry process cache stores event timings only, never audio bytes.
* **Full real-song proof:** the production route acceptance used the real
  separated Queen vocal, September drum stem and September bass stem, persisted
  vocal timing, and an ephemeral PostgreSQL database. It measured eight early
  voiced-run starts: 6/8 fell within 90 ms of a drum transient and 8/8 within
  90 ms of a low-band bass attack. The selected entry moved 952 ms from the
  first grid candidate at 2.009s to 2.961s; the detector's timing-overlap score
  improved by 0.106. A separate route call with a deliberately stale bass-stem
  checksum excluded bass events; the checksum was restored before rendering.
  The full bed remains 215s. Report:
  `generated-artifacts/waveyard-real-world-acceptance/full-vocal-flow-acceptance-final.json`.
* **Important boundary:** this is measurable timing proximity, not proof of a
  listenable or intelligent mashup. The vocal intervals are pitch-tracker
  continuity, not words or syllables. Drum transients are not identified as
  kick/snare/hat, and bass attacks are not bass-note or pitch labels. This does
  not infer lyrics, meter, or musical quality; no human listening evaluation
  was performed. Drum/bass events are computed on demand and held only in a
  bounded process cache; they are not durable analysis records. Automatic vocal
  tempo/key changes remain withheld below their confidence thresholds.
* **Verification:** real-song production route plus persisted save/reopen/export
  acceptance 1/1; mashup planner tests 18/18; local analysis-engine tests 17/17;
  API-server typecheck passed. This closes a measurable timing gap, not the
  larger requirement for full-length arbitrary-song mashups that adapt lyrics,
  bass notes, and distinct drum parts.

## Current verification update — 2026-11-12, full real-stem workflow

* **Real source processing:** two owner-provided full-length recordings
  (September, 215.14s; Another One Bites the Dust, 222.67s) were separated
  with the pinned four-model ONNX CPU recipe. All eight output stems were
  readable stereo 44.1 kHz PCM, full-length, finite, in PCM range, non-silent,
  and above the configured live-swap energy floor. The second separation run
  exceeded the separate playback scheduling limit by 18ms (1,018ms observed
  against a 1,000ms limit); its audio outputs are valid, but that responsiveness
  check is a failure and must not be reported as a full pass.
* **Production mashup and Studio persistence:** the acceptance test ran the
  production analysis/render/save routes against real separated PCM and an
  ephemeral PostgreSQL database. It saved and reopened a four-track session
  (donor vocal plus three instrumental stems), made a version-checked Studio
  edit, restored a saved version, ran the export worker, and downloaded the
  export from the production media endpoint with a matching SHA-256. The
  exported WAV is 215 seconds, stereo 44.1 kHz PCM; peak 0.438 and zero clipped
  frames. Retained report:
  `generated-artifacts/waveyard-real-world-acceptance/full-song-mashup-acceptance.json`.
* **Honest musical boundary:** analysis measured the September bed at 126.048
  BPM with 0.711 confidence and key A major at 0.406; the vocal source was
  measured at 109.957 BPM with 0.435 confidence. Because the vocal tempo and
  key evidence are below trust thresholds, the plan withheld automatic
  stretching and pitch shifting. It lays the full vocal over the separated
  September bed, starting after one bar, and fades at the bed end. This proves
  a complete technical mashup workflow—not structural understanding,
  intelligent compatibility, or that the result sounds good.
* **Real browser live swaps:** Linux Chromium 155 played actual full-length
  separated stems in `SessionExperience`. Vocal and drum donor swaps were
  audible in the captured browser output; unaffected lead stems kept advancing,
  and restoring the original layers succeeded. The session API in this test is
  fixture-backed, so this is playback/control evidence, not project
  persistence. Cold click-to-audible measured 2.118s for vocals and 1.357s for
  drums while fetching/decoding 39.3 MB WAV stems. This is still too slow to
  call an instant swap; warm-selection latency was not separately measured.
  Retained browser report and captures are under
  `generated-artifacts/waveyard-real-world-acceptance/full-song-live-captures/`.
* **Persistence validation fix found by this run:** source and stem duration
  metadata is stored as nearest whole seconds, while real arrangement clips use
  frame-accurate millisecond lengths. A valid 215,137ms clip was rejected
  against 215,000ms metadata during Studio edit/export. The save, clip-edit,
  batch-edit, restore, and export validators now allow only the 500ms maximum
  error introduced by nearest-second rounding; a regression test rejects
  overruns beyond that boundary.
* **Verification:** real-song production route acceptance 1/1; synthetic route
  fallback 1/1; clip editing and render-helper tests 16/16; API-server
  typecheck, browser script syntax check, and `git diff --check` passed. The
  real browser live-stem script passed for both stem types. The full separation
  evidence is objective PCM validation; listening quality remains unevaluated.
* **Artifacts:** route render and Studio WAV export are available locally at
  `generated-artifacts/waveyard-real-world-acceptance/full-song-route-render.wav`
  and `generated-artifacts/waveyard-real-world-acceptance/full-song-studio-export.wav`.
  Generated audio and reports are ignored build artifacts; do not add them to
  Git. Windows, iOS/physical-device performance, and human listening are not
  verified.

## Previous verification update — 2026-11-11, real-audio acceptance boundary

* **Starting revision and scope:** this acceptance pass fast-forwarded the
  shared PR #30 branch to `47acd882` before editing. The changes below are
  limited to test discovery, test-fixture correctness, truthful test labels,
  and retained acceptance evidence; no production audio behavior was changed.
* **Full-track source analysis:** the six checksum-pinned, owner-provided
  recordings were analyzed from beginning to end (215.14–405.93 seconds each;
  1,703.95 seconds total). The run produced 246 section records and evaluated
  24,941 cross-source passage pairs. **Zero** pairs met all compatibility
  gates. Missing measurements include donor vocal activity, anchor
  non-vocal-stem activity, and downbeat confidence. Only one recording had
  both tempo and key confidence at the engine's 0.5 threshold. The result is
  an honest analysis rejection, not a generated mashup.
* **Retained report:** the test now supports `WAVEYARD_ACCEPTANCE_REPORT` and
  refuses to overwrite an existing file or write outside `generated-artifacts`.
  The current full analysis report is
  `generated-artifacts/waveyard-real-world-acceptance/full-track-analysis-47acd882.json`.
  Re-run with six original files using:

  ```sh
  WAVEYARD_ACCEPTANCE_TRACKS="<six full paths separated by the OS path delimiter>" \
  WAVEYARD_ACCEPTANCE_REPORT="generated-artifacts/waveyard-real-world-acceptance/<new-report>.json" \
  node --test scripts/waveyard-cross-track-acceptance.test.mjs
  ```

  This checks the pinned input checksums, full-track durations, section
  fingerprints, and absence of false-positive matches. It does not synthesize
  audio or establish subjective quality.
* **Route acceptance discovery and repair:** running the route test directly
  through `tsx --test` returned TAP `0 tests`; Node interpreted its literal
  `[id]` directory as a glob. Restored the normal-name entry point
  `scripts/waveyard-mashup-route-acceptance.test.ts`, which imports and runs the
  actual route test. Its generated-tone fixture now marks the bed separation
  unavailable for the fallback render, asserts that editable save returns 422
  without creating a partial session, restores the completed run, and then
  verifies successful persistence. The test uses an ephemeral PostgreSQL
  database and the production route, but its PCM is synthetic—not real songs.
* **Synthetic-test wording:** `mashup-full-length.test.ts` uses generated tones
  and click patterns, including a 120-second WAV encode/decode check and plan
  JSON round-trip. Its test names now say “synthetic”; none of those cases is a
  real-song or save/reopen listening acceptance.
* **Existing audition files measured:** seven WAV files under
  `generated-artifacts/waveyard-real-mashup` are 16.470–16.515 seconds,
  44.1 kHz, stereo, 16-bit PCM. They have no clipped samples; each contains a
  0.507–0.513-second interval below −60 dB. There is no source/arrangement
  manifest to establish whether those intervals are intended A/B separators,
  or to verify that the audio matches the planned arrangement. They are not
  full-length mashups.
* **Verification on this pass:** full-track acceptance 1/1; production route
  acceptance 1/1; donor-integrity, mashup, and synthetic full-duration suites
  29/29; database round-trip suites 2/2; workspace typecheck passed. These
  results validate source analysis and individual route/database components,
  not one complete real-song production workflow.
* **What remained unproven at that point:** a single current-HEAD run through
  production separation, mashup generation, real-player swaps, Studio
  edit/export, and save/reopen. The 2026-11-12 update above now covers that
  technical workflow, but still does not establish subjective musical quality
  or physical-device performance.

## Current verification update — 2026-11-10, end-to-end mashup route integration, multi-stem arrangements, and database round-trip acceptance

* **Highest-priority capability completed:** Connected `analyseStereoPcm` directly to the `POST /api/waveyard/projects/[id]/mashup` route workflow. When either selected track lacks formal BPM or musical key analysis, raw decoded audio PCM is analysed on the fly using native autocorrelation and spectral/chroma DSP to populate the source profile before planning, rendering, or persisting. The resulting analysis is persisted to the `sourceAnalyses` table using canonical desktop provenance (`arena-js-dsp` v1.4.0) to prevent redundant re-analysis.
* **Stem run reconciliation & save safety:** Updated `action === "save"` to use `findBedSource(projectId, bedId)`, guaranteeing that only stems from the latest completed separation run (or single instrumental stem) are saved into `remixTracks`, matching the render path. Added validation ensuring vocal separation jobs are complete (`status === 'complete'`) and requiring both vocal and bed stems before saving to avoid single-stem incomplete remix sessions.
* **Vocal tempo adoption:** When bed BPM is unanalyzed but vocal BPM is verified, `planMashup` now adopts the vocal BPM as the master tempo rather than falling back to an unverified duration guess.
* **Checksum & provenance validation:** Updated `loadSourceProfile` in `lib/arena/src/lib/waveyard/studio/mashup-sources.ts` to verify source checksum matches `sourceChecksumSha256` and `status === 'complete'`, preventing consumption of stale or unverified analyses.
* **Intelligent multi-stem arrangement:** Enhanced `renderMashup` and route rendering so discrete stems receive structured timeline placements with role-aware dynamic gains without duplicating bed audio.
* **Genuine database round-trip acceptance:** Created and passed `lib/arena/src/lib/waveyard/studio/mashup-db-acceptance.test.ts` running against PGlite with canonical desktop migrations. Verified the full lifecycle: creating project, source assets, and stem assets; executing the mashup save transaction into `remixSessions`, `remixTracks`, and `remixClips`; querying and verifying tracks and clips from the database; and updating track volume, clip gain, and master volume with proper session version incrementation.
* **Synthetic-signal & 4-plan coverage:** `mashup-full-length.test.ts` uses generated tones and click patterns to test tempo divergence (85 vs 135 BPM), on-the-fly analysis, harmonic adaptation, and a 120-second multi-stem WAV encode/decode plus plan-serialization round-trip. It does not use real recordings or persist and reopen a Studio session. Passed all 15 unit tests in `mashup.test.ts`.
* **Automatic musical analysis reliability:** Enforced `trustedAnalysisKey` and `trustedAnalysisBpm` in mashup planning; low-confidence keys withhold automatic pitch shifting (0 semitones); removed fabricated confidence in section-derived fallback estimates; integrated beat grid end-to-end; failed closed in `latestStem` when separation job rows are missing; and strengthened multi-window tempo testing.
* **Files changed:** `artifacts/api-server/src/imported/waveyard/projects/[id]/mashup/route.ts`, `lib/arena/src/lib/waveyard/studio/mashup-sources.ts`, `lib/arena/src/lib/waveyard/studio/mashup.ts`, `lib/arena/src/lib/waveyard/studio/analysis-reliability.test.ts`, `lib/arena/src/lib/waveyard/studio/mashup-db-acceptance.test.ts`, and this handoff.
* **Verification:** Passed all 158 test cases cleanly across Waveyard studio test suites (`donor-stem-integrity.test.ts`, `analysis-reliability.test.ts`, `mashup-db-acceptance.test.ts`, `mashup-full-length.test.ts`, `mashup.test.ts`, `mashup-regression.test.ts`, `mashup-bed.test.ts`), plus 15/15 passing tests in `seed-http.test.ts`; full workspace `pnpm run typecheck` passed cleanly across libraries, API server, ArenaForge, mockup sandbox, and scripts with zero errors; `git diff --check` cleanly passed.
* **Exact Git revision:** `2435a269fe80c4c469d410eed7481a935829fbcc`.
* **Agent B Coverage Matrix (Donor-Stem Integrity):**
  - Completed-run provenance: `donor-stem-integrity.test.ts` (Test 1) — PASS
  - Retry isolation: `donor-stem-integrity.test.ts` (Test 2) — PASS
  - Failed/cancelled exclusion: `donor-stem-integrity.test.ts` (Test 3) — PASS
  - No mixed-run stems: `donor-stem-integrity.test.ts` (Test 4) — PASS
  - PCM validation: `donor-stem-integrity.test.ts` (Test 5) — PASS
  - Vocal isolation: `donor-stem-integrity.test.ts` (Test 6) — PASS
  - Instrumental transformation safety: `donor-stem-integrity.test.ts` (Test 7) — PASS
  - Missing optional stems: `donor-stem-integrity.test.ts` (Test 8) — PASS
  - Donor pitch preservation via autocorrelation: `donor-stem-integrity.test.ts` (Test 9) — PASS
  - Duplicate stem type rejection: `donor-stem-integrity.test.ts` (Test 10) — PASS
* **Remaining limitation:** Subjective musical quality of arbitrary song mashups depends on source stem separation quality and listening evaluation; fallback decisions preserve provenance and explain all assumptions.

## Current verification update — 2026-11-10, fallback renderability checks

* **Highest-priority follow-up:** corrected the automatic-remix fallback assertions to follow the actual persisted track ordering and to verify instrumental fallback removes vocals. The fallback remains conservative: both complete sources are represented, source windows alternate across the full timeline, and no untrusted tempo/key/beat transforms are enabled.
* **Files changed:** `lib/arena/src/lib/waveyard/types/__tests__/automatic-remix.test.ts` and this handoff.
* **Verification:** the focused `tsx --test` run passed 23/23 across automatic-remix and render-helper tests; `pnpm run typecheck:libs` passed; `git diff --check` passed.
* **Remaining limitation:** real-song analysis → render → WAV export → save/reopen evidence is still pending; this validates plan/render-helper compatibility, not subjective audio quality.
* **Exact Git revision:** `6cadad5d76e7c12408bccd7975fcfccb6cdb8209`.

Living document for every human or AI agent working on Arena. **Update it in
the same PR as any change that alters status, priorities or the ledger.**
Last updated: 2026-11-12.

## Current verification update — 2026-11-10, fallback reachability fix

* **Highest-priority fix:** removed the stale `hybrid_evidence_unavailable` early return that made the conservative full-song fallback unreachable whenever the anchor lacked trusted structure. Instrumental mode now removes vocals correctly from source-qualified fallback track IDs.
* **Files changed:** `lib/arena/src/lib/waveyard/types/automatic-remix.ts` and this handoff.
* **Verification:** repository `pnpm run typecheck` passes across libraries, API server, ArenaForge, mockup sandbox, and scripts. `git diff --check` is required before commit. The focused automatic-remix test remains blocked because this checkout does not provide `tsx`.
* **Remaining limitation:** real-song render/export/save-reopen evidence is still pending; this fix makes the existing fallback reachable but does not add a second renderer or claim musical quality.
* **Exact Git revision:** `4a6ad6697e3de6e6761a1da653a470b9a2c47d31`.

## Current verification update — 2026-11-10, full-song fallback vertical slice

* **Implementation completed:** `buildAutomaticRemixPlan` no longer rejects a requested hybrid solely because passage evidence is missing or no pair clears the existing confidence gates. It preserves those gates and falls back to the existing persisted `AutomaticRemixPlan`/`RemixClip` shape: every usable stem from both complete sources is arranged as alternating first-half/second-half passages across a continuous timeline. The fallback makes no unverified BPM, key, or beat-snap claim, uses conservative gain and short fades, and records notices/decisions explaining the evidence boundary.
* **Files changed:** `lib/arena/src/lib/waveyard/types/automatic-remix.ts` and `lib/arena/src/lib/waveyard/types/__tests__/automatic-remix.test.ts`. This is intentionally inside the existing arranger; no second renderer, persistence model, or UI engine was introduced.
* **Test evidence:** Added coverage proving a difficult pair with generic/unavailable section evidence produces eight stem tracks, two clips per source track, alternating timeline ownership, and conservative beat/key flags. Existing compatible, low-confidence, provenance, semantic-label, and empty-source cases remain covered. The focused test could not execute in this checkout because `tsx` is not installed; `pnpm run typecheck` passes for libraries, API server, ArenaForge, mockup sandbox, and scripts; `git diff --check` passes.
* **Real-song evidence:** No real-song render was run in this task because the checked-out acceptance recordings are not present in the repository and the focused test runner dependency is unavailable. The new fallback is designed to accept those difficult pairs, but continuous audio quality, WAV export, and save/reopen still require the existing real-stem acceptance harness to be run with the supplied recordings.
* **Remaining limitations:** This slice is an arrangement decision, not a new DSP renderer. It does not yet time-stretch, pitch-shift, isolate stems, or synthesize beat/bar transitions for the fallback; it deliberately preserves source timing and provenance. The existing rendering/export path must consume the generated clips, and real separated-stem acceptance remains required before claiming listening quality.
* **Exact Git revision:** `00214f08712e1a912f6cb988626e86fc6df27ce0`.

## Current verification update — 2026-11-10, Waveyard cross-song passage compatibility

* **Preserved checkout:** still on `arena/convergence-2026-11-07` at
  `52a0ba903854234a135e583814cb7ba1be73d3e7`, five commits ahead of
  `origin/arena/convergence-2026-11-07`. This work is local and uncommitted;
  no commits, pushes, merges, branch switches or history edits were made. The
  user-provided audio remains untracked and is not part of the change.
* **Persisted evidence:** source-section engine provenance is now 1.5.0.
  Each source section can retain a checksum- and beat-range-bound passage
  fingerprint: a four-subdivision-per-beat onset pattern (length varies with
  the phrase), four-window/12-pitch-class chroma
  sequence, four-subdivision beat-phase profile and source RMS energy. The
  record also has explicit `measured` / `unavailable` slots for downbeat
  confidence, vocal activity and non-vocal instrument density. The section
  worker currently measures the first four from source PCM; current isolated
  vocal phrase coverage is attached by the automatic-remix route when matching
  stem/source provenance exists. No downbeat or non-vocal activity detector is
  claimed. Fingerprints are persisted in nullable `source_sections` JSONB;
  additive desktop migration `0025_source_section_passage_fingerprints.sql`
  and a PGlite persist/reload test cover the schema. The development schema
  push completed; production was not changed.
* **Compatibility and product path:** automatic hybrid planning now evaluates
  tempo and confidence, exact measured phrase length, onset rhythm, chroma,
  beat phase and allowed transposition independently. It no longer hides
  rejected donors behind an early tempo-ratio filter. Rhythm cannot substitute
  for harmony; a shifted chroma match is permitted only when both trusted key
  analyses authorize that shift. Passage matches do not need verse/chorus
  labels. Reports retain source names, passage IDs, per-dimension explanations
  and missing evidence. The existing route still creates ordinary persisted
  RemixTrack/RemixClip sessions only for eligible candidates. The Studio shows
  compatibility evidence expanded by default, including on a no-match error;
  it explicitly calls a match an audition candidate rather than a quality
  claim.
* **Real-audio acceptance:** the six user-provided recordings were each analyzed
  in full (215–406 seconds), producing 246 section fingerprints and 24,941
  cross-track passage comparisons. **Zero** pairs passed every core gate, so no
  hybrid arrangement or render was generated and none was listened to. Examples
  of correctly rejected pairs: a Queen / “Blinding Lights” two-bar pair had
  tempo ratio 0.638, rhythm similarity 0.818, chroma 0.811 and beat-phase
  similarity 0.992; “I Feel It Coming” / “Blinding Lights” had ratio 0.909,
  rhythm 0.794, chroma 0.803 and phase 0.987. Another Queen / “Blinding
  Lights” window had chroma 0.939 only after a one-semitone shift, but the
  key estimates did not authorize it, and tempo/rhythm also conflicted. A
  matching beat-phase profile by itself did not produce a match. The scan found
  missing isolated-vocal activity, non-vocal stem activity and downbeat
  confidence across these source-only files.
* **Repeatable real-audio check:** run
  `WAVEYARD_ACCEPTANCE_TRACKS="<six full paths separated by the OS path delimiter>" node --test scripts/waveyard-cross-track-acceptance.test.mjs`.
  It calls the existing full-track analyzer, requires six tracks with
  fingerprints and at least 180 seconds each, and asserts no false compatible
  pair for this six-track acceptance set. This run passed 1/1 in 82.1 seconds.
  It is an opt-in local acceptance, not a CI fixture: the supplied tracks are
  not copied into or committed to the repository. Synthetic positive/negative
  unit fixtures separately cover compatibility logic. The pinned input
  checksums were verified, and the acceptance run passed 1/1 in about 79
  seconds.
* **Verification:** focused Waveyard tests passed 40/40, including provenance,
  rejection cases, tempo conflict visibility and PGlite persistence. Library,
  API-server, ArenaForge and scripts TypeScript checks passed; `git diff
  --check` passed. The configured broad `test` workflow is **not green**: its
  Arena smoke step failed on browser error `Cannot close a closed AudioContext`
  after the preceding Waveyard browser-audio checks passed. This work did not
  change the playback context lifecycle. A Waveyard landing-page screenshot
  loaded without browser errors, but it had no song/remix open, so it does not
  verify the interactive evidence panel.
* **Remaining gap / next evidence needed:** the current engine can compare
  measured source passages but this dataset supplies no compatible pair. To
  produce reliable vocal-over-instrumental candidates, add and validate a
  downbeat detector plus per-passage isolated-vocal and non-vocal-stem
  activity; retain source/stem checksum provenance. Then run a real separated
  stem project through analysis → automatic remix → persisted clips → export →
  save/reopen, and listen to any candidate before making quality claims.
  This implementation does not establish musical form, reliable smart-mashup
  quality, a successful real-stem hybrid, or listening quality.

## Current verification update — 2026-11-10, Waveyard full-track analysis and PR #29

* **Branch and preserved history:** work remains on
  `arena/convergence-2026-11-07`. The preserved local commits
  `0b11894`, `a25af3a`, and `be50cc1` remain ahead of PR #29's remote head
  `8083fd88`; the Waveyard implementation is committed locally as `be262941`.
  The PR is still open against `main`; none of these newer local commits has
  been pushed or merged. GitHub check results documented below apply to the
  remote PR head, not the local Waveyard work.
* **Remote CI boundary:** the four successful Windows package, recovered-stack,
  browser-timing and Linux worker-local DB runs listed below are evidence for
  their exact recorded SHAs only. The recovered-stack inference probe uses a
  controlled Demucs stand-in, not a trained model. No new CI run is claimed for
  `be262941`.
* **Real mixer acceptance already completed:** two user-provided MP3s (Earth,
  Wind & Fire “September” and Queen “Another One Bites the Dust”) were imported
  as 48 kHz stereo and completed all four pinned CPU separation passes. The
  corrected Linux acceptance persisted four stems per 30.024-second excerpt,
  verified unchanged source checksums, loaded real stems through private
  routes, crossfaded between tracks, isolated incoming drums while playback
  continued, then restored all four gains. It passed 1/1 in about 273 seconds.
  This proves the persisted playback and control path for short excerpts, not
  subjective stem quality or a good mashup.
* **Implemented musical-analysis slice:** the local section engine now searches
  beat-grid-aligned 2-, 4- and 8-bar windows independently of variable
  novelty-boundary lengths. It uses half-window hops, prefers longer
  non-overlapping matches, keeps the existing 0.92 similarity threshold, and
  requires both rhythm and four-bin chroma similarity for a “pattern” label.
  Otherwise it reports a rhythm-only recurrence. The engine provenance is
  `arena-js-structure` 1.4.0. Repeated labels are exposed as measured
  similarity in the Studio label text, not presented as calibrated
  probabilities. One-past-last beat boundaries now normalize using the median
  beat interval and clamp to known source duration, so final sections can be
  validated and persisted without extending beyond the file.
* **Full-track evidence:** the reproducible `scripts/waveyard-mashup-analysis.ts
  -- <output.json> 0 full <audio paths...>` run analyzed six user-provided
  tracks, each for its complete 215–406 seconds. The evaluator passed the same
  section normalization/provenance validator used by the worker for all six.
  It found 41 rhythm-only windows and 10 combined rhythm+chroma windows; those
  combined windows occurred in two tracks. Four windows were four bars long;
  none reached eight bars. The previous zero-result scan compared
  novelty-segment candidates with varying lengths; fixed phrase windows
  exposed recurrences hidden inside those segments without lowering thresholds.
* **What this does not prove:** “pattern” means a repeated beat-grid onset and
  coarse chroma fingerprint, not a verified chord progression, downbeat,
  verse, chorus, or cross-song match. The analyzer still has no vocal-activity
  feature or manually annotated reference sections. On this full-track
  six-source set, only one track passed the existing 0.5 BPM/key/beat
  confidence gates, so there is no eligible donor pair to demonstrate a real
  hybrid. No mashup render was listened to or rated. The automatic hybrid
  arranger still requires explicit high-confidence semantic roles; its passing
  synthetic-role tests do not establish that real analysis can produce them.
* **Verification:** focused Waveyard section, source-section, provenance and
  automatic-remix tests passed 33/33; `pnpm run typecheck` and `git diff
  --check` passed. The six-track full-audio scan also completed with all section
  records passing persistence-shape validation. That scan is analysis evidence,
  not a database persist/reopen or musical listening acceptance.
* **Next concrete work:** add explainable, persisted passage features for
  cross-source compatibility—harmonic movement, vocal/instrument activity and
  beat/downbeat phase—then use them in the existing RemixTrack/RemixClip
  arranger. Validate against manually annotated sections and listen to actual
  candidate renders. Keep confidence gates unchanged until the measurements
  justify any adjustment.

## Current verification update — 2026-11-10, Windows readiness at `dd2d2862`

This section supersedes older Windows/AI acceptance claims below. Green CI is
not equivalent to owner-side release acceptance.

* **Branch preservation:** the starting workspace was clean on
  `arena/convergence-2026-11-07` at `7c2df817`. Its remote branch and PR #29
  had advanced linearly to `ef042aea`; the supplied branch
  `arena/caafeea9-arena-os-canonical` was a further linear descendant at
  `dd2d2862`, with no PR of its own. The three commits `3f064578`,
  `d1948f0f`, and `dd2d2862` were fast-forwarded onto the existing convergence
  branch. No branch was deleted, no history rewritten, and PR #29 was not
  merged. The handoff-only change in this PR does not alter the tested code.
* **What happened at `ef042aea`:** that commit changed only `docs/HANDOFF.md`
  and `docs/LINUX-TEST-COVERAGE-2026-11-09.md`. Nevertheless, the recovered-stack
  workflow did execute (run
  [42673833952](https://github.com/imlochie/arena-os-canonical/actions/runs/42673833952))
  and failed: `python-guardian.test.ts`'s first test exceeded its unchanged
  10-second budget, and the inference-probe test skipped because Windows had no
  FFmpeg/FFprobe. This was an executed failing run, not a rerun refusal.
* **FFmpeg and test reporting fix:** `3f064578` stages the exact SHA-256-pinned
  FFmpeg bundle used by the installer, executes both `ffmpeg.exe` and
  `ffprobe.exe`, and sets `ARENA_FFMPEG_PATH` / `ARENA_FFPROBE_PATH`. A skipped
  or missing probe is now an error. Failed-file TAP output is included in
  bounded check annotations. The same commit improves browser timing failure
  annotations; it does not alter the app's audio engine.
* **Python guardian regression:** `d1948f0f` discovers the test interpreter once
  before the individual test clocks begin. The two tests retain their 10-second
  timeouts and the 1.5-second owned-process termination bound; the assertions
  were not relaxed. Windows run
  [42681735032](https://github.com/imlochie/arena-os-canonical/actions/runs/42681735032)
  passed. Its runner was Python 3.15.2: spawn-to-close was 273 ms; the
  termination test reported 73 ms to start, 3 ms for executor close, and 3 ms
  until the owned Python process was gone. These are one CI-runner's timings,
  not laptop performance guarantees.
* **Windows package evidence:** run
  [42681734757](https://github.com/imlochie/arena-os-canonical/actions/runs/42681734757)
  passed on `dd2d2862`. It built the x64 NSIS installer, installed
  `ArenaForge.exe`, passed the installed-package smoke, then passed the
  previous-to-current package update smoke. The `arenaforge-windows-x64`
  artifact was uploaded (390,749,118 bytes; 14-day retention at run time).
  This proves hosted Windows CI packaging/install/update behavior, not
  installation on the owner's laptop.
* **Local regression checks after integration:** the focused
  `python-guardian.test.ts` run passed 2/2 with no skips, and `pnpm run
  typecheck` passed.
* **Inference-probe limit:** the passing CI probe used the real staged FFmpeg
  binaries to process six controlled WAV inputs, but its Demucs runner is a
  controlled stand-in and no trained checkpoint was present. The log explicitly
  says real Demucs inference is **not** proven. No real provider/model inference
  was performed; do not mark the AI-runtime gate PASS.
* **Owner-side Windows acceptance checklist (not yet performed):**
  1. Open the Windows package run above and download its
     `arenaforge-windows-x64` artifact. Extract the ZIP and run the non-
     uninstaller `.exe`; use the install directory selected in the installer.
     Launch `ArenaForge.exe` from that directory.
  2. Open **Model Hub** in the installed app and confirm its host notice says
     Arena is running on **this device**. Do not use the Replit preview for a
     laptop-local model: that preview checks Replit's server.
  3. To avoid cloud fees and quotas, install and open Ollama on this same PC.
     In Model Hub, select **Refresh runtime status**, **Connect runtime** for
     the discovered Ollama service, then **+ Add [model] to Arena** for an
     installed model. Choose a catalog model only after checking its displayed
     download size and approximate RAM class against the laptop.
  4. In **Spaces**, select that registered model and run a new disposable task:
     use `write_file` to create `acceptance-check.txt` with a unique
     owner-chosen token, then use `read_file` to return its exact contents.
     Reopen the Space and verify the file is still present.
  5. Count this as genuine inference/tool acceptance only if the journal shows
     the real runtime level, provider and actual model ID, **no `FALLBACK`**,
     a successful tool action and the expected file contents. A model being
     listed or a health check passing is insufficient. Return a screenshot of
     that result and the package-smoke report; do not include API keys or other
     secrets.
* **Waveyard real-audio status:** the full-track scan of six user-provided
  tracks found zero qualifying repeated rhythm/harmony patterns and no manual
  verse/chorus reference labels; it does not establish musical-form understanding.
  A real 20-second September excerpt did pass the pinned four-model separation
  and persisted four stems on Linux, but audio quality was not evaluated. The
  later report of a second-track stem-ID mismatch was a test false positive:
  standby sources are `blob:` URLs, not asset IDs. The latest two-track browser
  trials persisted the expected stems but did not reach a passing crossfade
  and incoming-isolation acceptance. See the current verification update
  above. MIDI/export/save/reopen as one real-audio workflow and owner-device
  listening remain unverified.

## Current verification update — 2026-11-09, cold-start acceptance at `32cf4a54`

This section supersedes older status claims below where they conflict.

* **Deep checkpoint identity, applied consistently (2026-11-09):** the deep
  separation path verifies the pinned Demucs checkpoint's full SHA-256 before
  any inference (`verifyDeepCheckpoint`, injectable through `deps`). Two handler
  tests already used the explicit stand-in checkpoint; the deep-cancellation
  process-group test still called the real verifier with the fixture's
  presence-only dummy checkpoint, so it failed *before* spawning the stub engine
  and reported "the Demucs process started" instead of testing cancellation.
  It now uses the same stand-in override as its siblings; checkpoint identity
  remains covered by `separation/deep.test.ts`. Local evidence on this branch
  (Linux, real embedded PostgreSQL, real Python 3.11 stub engine, ffmpeg from
  the installer packages): `worker-local/separation.test.ts` 54/54 pass,
  including process-group cancellation and clean retry; the library service
  suite 53 pass with its 4 opt-in real-worker/browser tests skipped by default;
  the other branch-changed Waveyard suites 194/194 pass; `pnpm run typecheck`
  passes. This is **not** evidence of real Demucs inference or weights, the
  browser retry/donor acceptance runs (no Chromium or pinned model files in
  this environment), or packaged Windows. The CI gap this exposed (no workflow
  ran this suite; `windows-recovered-stack.yml` omits it and its cancellation
  case skips on win32) is closed by the Linux job in the next bullet.
* **Linux CI for the DB-backed Waveyard worker-local suites (2026-11-09):**
  `.github/workflows/waveyard-worker-local-db.yml`, job `worker-local-db` on
  `ubuntu-22.04` (push, pull_request, workflow_dispatch; 30-minute cap). It
  installs `@workspace/scripts... @workspace/arena... @workspace/desktop...`
  (desktop is required: `separation.test.ts` migrates its disposable cluster
  through the production migrator `desktop/database.mjs`, which imports `pg`
  from `desktop/node_modules`), puts the runner image's PostgreSQL server
  binaries on PATH, boots a throwaway cluster the way the suite does (initdb
  as the runner user, TCP on 127.0.0.1, no Unix socket) and fails loudly if
  that, ffmpeg/ffprobe or Python 3 is missing, then runs
  `worker-local/separation.test.ts`, `stem-analysis.test.ts` and
  `analysis-recovery.test.ts` one file at a time with per-file TAP evidence
  (artifact `worker-local-linux-<run>-<attempt>`, 14 days). The
  deep-cancellation process-group test is a hard gate: the job greps for its
  passing TAP line and a skip or missing line fails the job; other skips are
  surfaced as warnings, never counted as passes. Failing TAP results are
  annotated with their diagnostic block because job logs and artifacts were
  not readable from the authoring sandbox. **Evidence:** first green run
  <https://github.com/imlochie/arena-os-canonical/actions/runs/42650096758>
  (push of `8d8e319` on `arena/convergence-2026-11-07`, 3m14s): all three
  files PASS, zero skips, no error annotations; environment notice reports
  PostgreSQL 14.24 (`14.24-1.pgdg22.04+2`), ffmpeg 4.4.2, Python 3.10.12.
  The three earlier runs on this branch (`f5cf74d`, `7d73635`, `9d16d12`)
  failed only separation tests 5/15/16, the ones that start a real cluster,
  with "Cannot find package 'pg' imported from desktop/database.mjs"; adding
  the desktop filter fixed it, and the fix was first reproduced locally after
  deleting every `node_modules` directory (an earlier clean-room check had
  missed `desktop/node_modules`). Local clean-room run of the workflow's test
  step with embedded PostgreSQL 14.24: 54/54, 1/1, 2/2, zero skips.
  **Limitations:** the job uses the runner's PGDG PostgreSQL 14, not the
  embedded 16.14 build the desktop ships (the 25 desktop migrations use no
  15+-only syntax, and the suite passes on both); the deep pass is the stub
  engine driven by real Python, with no pinned Demucs/ONNX weights, no GPU and
  no real inference; `separation-real-ort.test.ts` is deliberately excluded
  (it skips without pinned weights); the job cannot run on the Windows runner
  (no PostgreSQL server binaries there, and the cancellation case skips on
  win32), so Windows coverage of this suite is still not claimed. The only
  remaining annotation on the green run is GitHub's generic "Node.js 20 is
  deprecated" notice about the `@v4` actions, shared by every workflow here.
* **Linux test coverage map (2026-11-09, measured; supersedes the "76
  environment-dependent failures" figure):** every one of the 285 test files
  was run on provisioned Linux (PostgreSQL server binaries, ffmpeg, Python 3,
  `DATABASE_URL` unit convention, package cwd): **2,152 tests, 2,078 pass, 51
  fail, 23 skip, 22 failing files**; with a live PostgreSQL on 5432 and the
  migrations applied, 2,102 pass / 34 fail / 16 skip / 16 failing files. CI
  today runs 53 of the 285 files automatically (24 Windows recovered-stack,
  26 desktop on Windows, 3 on Linux); **232 files run nowhere, 212 of them
  pass on Linux today** (1,658 passing tests). Every failing file is
  attributed by class (browser 5, live-postgres 6, network 2, built
  artifacts 2, stale/vite-only/browser-globals/fixture 6, cwd 1) in
  `docs/LINUX-TEST-COVERAGE-2026-11-09.md`, with the per-file appendix and the
  reproducible method. Four files only pass from their package directory
  (`authorization.integration`, `deviceChannel.integration`, `wave3`,
  `arenaRooms`), so a Linux job must not run everything from `scripts/`.
  **Chosen next step (one credit):** a Linux sweep job over `lib/`,
  `artifacts/`, `scripts/` test files minus the 3 the DB job runs and an
  explicit, reasoned exclusion list — measured today at 235 files / 1,838
  passing tests / 16 opt-in skips, ~9 minutes of summed per-file time. Not
  chosen yet, with numbers in the doc: a live PostgreSQL service (+24 tests),
  Playwright browsers (+21 tests, 5 files), and the small test fixes (stale
  `broker` queue list, two dead-path tests, four cwd-relative paths).
* **Arcade CSP policy map (2026-11-09, investigation only; nothing changed):**
  plan B.2 ("wire `sandboxGameDocument` into the player") predates the player
  having its own policy, and the two are not interchangeable. There are four
  hand-maintained policies, not two:
  1. **Player** — `artifacts/arenaforge/src/lib/arcadeGameSave.ts:74`
     (`createGameSandboxDocument`): `script-src`/`style-src 'unsafe-inline'
     data: blob:`, `font-src data: blob:`, `img/media-src data: blob:`,
     `connect-src/frame-src/object-src/form-action 'none'`, `base-uri 'none'`;
     no `worker-src`, so blob/data workers fall back to `script-src` and are
     allowed. It injects the policy *and the save runtime* into the game's
     existing `<head>`. Used by `ArcadeForge.tsx:2171`, the local-model check
     at `ArcadeForge.tsx:1857` and `ImportedGameWorkspace.tsx:1351`, all with
     `sandbox="allow-scripts"`; only the imported-game frame sets
     `referrerPolicy="no-referrer"`.
  2. **Arcade runtime gate** — `artifacts/api-server/src/imported/arcade/runtime-verification.ts:33`:
     the *same string as the player*, copied, plus a probe; the verification
     page itself is served with `frame-src 'self'` and every http(s)/ws request
     is aborted and counted (`blockedRequests`).
  3. **2048 source-rule gate** — `lib/arena/src/lib/games/sandbox.ts`
     (`GAME_CSP`: no data:/blob: scripts or styles, `font-src 'none'`,
     `worker-src 'none'`, referrer meta) used by `source-rule-validation.ts`
     and for the `preview` document that `ArcadeSourceWorkshop.tsx:83` renders
     verbatim, under `ARCADE_HOST_CSP` (`frame-src 'none'`). Its header says
     "same CSP as Arcade validation"; that is no longer true (see 2).
  4. **Foundry** — `lib/arena/src/lib/foundry.ts:44` (`injectCsp`): `font-src
     data:` only, no connect/frame/form-action directives, and it *skips
     injection when the code already carries a CSP meta*; rendered by
     `app/foundry/page.tsx:257` with `allow-scripts allow-forms allow-modals`.
     Outside the Arcade scope; noted because the opt-out is a real gap.
  **Why the player is looser than `GAME_CSP`, and why that is required:**
  `games/imported-html.ts:17-19` deliberately admits `data:`/`blob:` in
  `src`/`href`/`url()`, so base64 scripts, fonts, images and blob workers are
  part of the accepted single-file game contract; the runtime gate uses the
  same string so that what is verified is what runs. `GAME_CSP` is right for
  the 2048 gate, which verifies a pinned fragment it wraps itself. The
  player's extras are all non-network sources: with an opaque origin
  (`allow-scripts` only), `connect-src 'none'`, `frame-src 'none'`,
  `object-src 'none'` and `form-action 'none'`, and workers inheriting the
  owner document's policy, they add no exfiltration path. So unifying on
  `GAME_CSP` would break accepted games for no isolation gain, and unifying on
  the player policy is only a *copy* problem, not a policy problem.
  **Safe without a decision (not done yet):** export the player policy once
  (next to `GAME_CSP` in `games/sandbox.ts`; `@workspace/arenaforge` and
  `@workspace/api-server` both already depend on `@workspace/arena`), import
  it in `arcadeGameSave.ts` and `runtime-verification.ts`, add the test plan
  B.1 asked for (policy precedes untrusted markup; gate and player documents
  embed the identical policy), and fix the stale header comment in
  `source-rule-validation.ts`. Zero behaviour change.
  **Needs a design decision (stopped here):** both gates run the game under a
  *host* CSP that stops the sandboxed frame from navigating itself to a
  network URL, which is the one channel the inner policy cannot close; the
  production pages have no host CSP at all (none in `artifacts/`, `desktop/`
  or `lib/` outside the gates), so a game that passes verification can still
  navigate its frame later. A document-level CSP on the app affects every
  embed (e.g. `EmulatorJsPlayer.tsx:124` uses `allow-same-origin`) and the
  Vite, api-server static and Electron delivery paths, so it is a product
  decision, not a cleanup. Adding `referrerPolicy="no-referrer"` to the two
  Arcade frames that lack it belongs to the same decision.
* **Waveyard local analyses:** the desktop API selects the versioned local
  engine and starts the existing drum, harmony, and vocal queues. Their DSP
  handlers persist events/frames with checksums and engine provenance; API
  startup replays interrupted durable jobs. Generated WAV + PGlite +
  filesystem-backed tests: 25/25 pass, including failure, retry, stale
  provenance, and restart recovery. This is generated-audio evidence, not a
  real-song run.
* **Queued MIDI export:** the local exporter rechecks the immutable job's
  source/stem/analysis identity, validates a Standard MIDI round trip, and
  persists a checksummed MIDI export asset. It does not fabricate drum classes
  or weak harmony notes.
* **Waveyard reliability suites:** 169/169 tests pass across the original full
  live-stem-layer regression suite, session-save journal replay/acknowledgment,
  MIDI writer/reader, player state, normalization, and source-section data.
  Full workspace typecheck passes. Pre-existing normalization source/tests
  remain uncommitted user work.
* **Browser timing:** push run `42598958628` and PR run `42598965343` passed
  Chromium, Firefox, and WebKit in the Linux PulseAudio harness. The earlier
  WebKit timing failures were test fixture/session lifecycle races; the harness
  now isolates session state and loops the normal-sized timing fixture. This is
  timing acceptance, not hardware listening or the full browser app matrix.
* **Windows packaged acceptance:** push run `42598958551` and PR run
  `42598965368` both passed. Each built the current x64 installer, installed
  and launched it, exercised the packaged app/database/migrations, navigated to
  Waveyard and played generated test audio, checked encrypted backup/restore
  including tamper rejection, then installed the current package over the
  older package and verified a saved record survived restart.
* **Cold-start source fallback:** forced workflow-dispatch run `42600674680`
  passed end to end with `force_source_baseline=true`, which skips accepted
  installer lookup. It first built the current installer from scratch, then
  built the previous app from source using validated SDL/FFmpeg inputs from
  that build. The prior app's independent emulator downloads are not installer
  payload and are skipped in this update-only build. The temporary worktree now
  carries repository metadata for electron-builder and uses a short
  long-path-safe location. The installed-app and in-place update smoke passed.
  No pinned release CDN 504 occurred in this forced source run.
* **Recovered-stack Windows tests:** push run `42598958617` and PR run
  `42598965365` passed.
* **Real-song section evaluation:** the local DSP analyzed the first 65 seconds
  of six user-supplied MP3/M4A tracks. BPM / BPM-confidence and key /
  key-confidence were: Another One Bites the Dust 109.957 / 0.512, F minor /
  0.034; September 123.047 / 0.624, A major / 0.573; I Feel It Coming remix
  156.605 / 0.323, D# major / 0.086; Stayin' Alive remix 103.359 / 0.380,
  F minor / 0.472; I Want to Break Free remix 72.788 / 0.913, C# minor /
  0.584; Blinding Lights remix 172.266 / 0.878, C minor / 0.245. Only
  September and I Want to Break Free pass both current tempo and key gates.
* Section notation below is `bar-range start–end label (L/S)`: `L` is the
  stored label evidence value and `S` is the existing onset-boundary structural
  confidence. For energy labels only, `L = min(1, |RMS dB change| / 6)`; it is
  a normalized signal-change strength, **not** a calibrated probability.
  `section L0` means a detected boundary with no stronger label evidence.
  Energy deltas compare a section's RMS with the immediately preceding section.
  No manual verse/chorus ground truth was available; no semantic roles were
  assigned.
  * Another One Bites the Dust: `b1–4 0:00–0:08 section (0/.050)`; `b5–6
    0:08–0:13 energy-rise (.811/.521, +4.9 dB)`; `b7–13 0:13–0:28 section
    (0/.489)`; `b14–18 0:28–0:39 section (0/.514)`; `b19–22 0:39–0:48
    section (0/.455)`; `b23–24 0:48–0:52 section (0/.961)`; `b25–29
    0:52–1:03 section (0/.850)`.
  * September: `b1–4 0:00–0:07 section (0/.150)`; `b5–7 0:07–0:13
    energy-rise (1/.781, +9.4 dB)`; `b8–19 0:13–0:37 energy-rise (.763/.854,
    +4.6 dB)`; `b20–22 0:37–0:42 section (0/.635)`; `b23–32 0:42–1:02
    section (0/1.000)`; `b33–33 1:02–1:04 section (0/1.000)`.
  * I Feel It Coming remix: `b1–2 0:00–0:03 section (0/.846)`; `b3–6
    0:03–0:09 energy-rise (1/.960, +15.4 dB)`; `b7–8 0:09–0:12 section
    (0/.627)`; `b9–16 0:12–0:24 section (0/.444)`; `b17–19 0:24–0:29
    energy-rise (1/.407, +7.3 dB)`; `b20–21 0:29–0:32 section (0/.495)`;
    `b22–23 0:32–0:35 section (0/.452)`; `b24–27 0:35–0:41 section
    (0/.436)`; `b28–29 0:41–0:44 section (0/.484)`; `b30–32 0:44–0:49
    section (0/.416)`; `b33–38 0:49–0:58 section (0/.988)`; `b39–40
    0:58–1:01 section (0/.418)`; `b41–42 1:01–1:04 section (0/.474)`.
  * Stayin' Alive remix: `b1–3 0:00–0:07 section (0/.482)`; `b4–5
    0:07–0:12 section (0/.682)`; `b6–12 0:12–0:28 section (0/.574)`;
    `b13–22 0:28–0:51 energy-rise (1/.586, +9.1 dB)`; `b23–28 0:51–1:05
    section (0/.918)`.
  * I Want to Break Free remix: `b1–12 0:00–0:39 section (0/.269)`; `b13–17
    0:39–0:56 section (0/.973)`; `b18–19 0:56–1:02 section (0/.482)`.
  * Blinding Lights remix: `b1–8 0:00–0:11 section (0/.638)`; `b9–12
    0:11–0:16 energy-rise (1/.475, +8.0 dB)`; `b13–17 0:16–0:23 energy-rise
    (.574/1.000, +3.4 dB)`; `b18–19 0:23–0:26 section (0/.671)`; `b20–29
    0:26–0:40 section (0/.514)`; `b30–34 0:40–0:47 section (0/1.000)`;
    `b35–45 0:47–1:02 section (0/.506)`; `b46–46 1:02–1:04 section
    (0/.603)`.
* **What the detector now establishes:** sustained RMS changes marked eight
  dynamic rises on five tracks; the comparatively level Queen excerpt received
  none. The combined rhythm-plus-four-bin-harmony repeat test found no
  qualifying repeated patterns in these excerpts. That is an honest abstention,
  not proof that the full songs lack repeated structures. `energy-rise` is a
  dynamic cue only, never a chorus/verse label or cross-track matching signal.
  Automatic hybrid alignment still accepts only supported semantic roles.
* The section inspector now distinguishes detected boundaries, rhythm repeats,
  combined audio-pattern repeats, and measured energy changes. Compact player,
  visual, and mashup-source labels continue to show weak key/tempo values as
  uncertain; Studio alignment withholds low-confidence tempo/key/beat grids.
  Focused structure, confidence, source-label and remix tests: 29/29 pass; full
  workspace typecheck passes.
* This local analysis does not prove manually verified role recognition,
  persisted analysis of these six tracks, four-stem separation, an audible
  mashup, MIDI export/save/reopen as one user flow, provider inference, or
  hardware listening.
* **Branch preservation:** this branch is still `arena/convergence-2026-11-07`.
  Its previous confidence-UI changes now exist in local commit `22d7fd5`
  (parent `fe1af426`), one commit ahead of the remote; this task's section
  changes remain uncommitted. No push or PR merge occurred. The `replit-agent`
  ref remains at `a5bc2a96`; its recent rhythm-analysis and automatic-remix
  work has equivalents here (`4430b555`, `84bbc553`). Its tip tree equals
  merge-base `b54840f2`, so no net tree change from that ref needed wholesale
  porting.
## Status at `3a782f73` (2026-11-08) — supersedes any conflicting text below

Read this section first; older sections are kept for history and are marked
where they are stale.

### What was fixed in this pass
| Area | Finding | Fix (commit) |
|---|---|---|
| Windows package | `embedded-postgres` `package.json` export error is **resolved**; installer builds, installs, packaged smoke passes (11 checks incl. backup/restore, ffmpeg, capture host). | earlier `desktop/build.mjs` fix |
| Windows update | Previous (base) package could not start on the elevated runner: PostgreSQL refuses `postgres.exe` for admins (`older_package_starts`). | `database.mjs` added to the base-fix list (`1ce31981`) |
| Windows update | Intermittent `current_package_starts`: after an in-place update the window stayed on an empty page (url `""`, loading, renderer idle, `/spaces` already answered). Observed on both events, ~50% of runs. | Clear leftover service-worker/cache storage before loading (`96810e3a`). **Hypothesis-driven** — see evidence below |
| Windows update diagnostics | Failures printed nothing. | log dump, window/process state, Chromium log, bounded cleanup (`59a7c4ec`, `d8bc1430`, `320223b3`) |
| Arcade gate | **Already on `main`** (`imported/arcade/runtime-verification.ts`, used by all three publish paths); the "genuinely missing" claim was stale. Added a uniform-canvas check and 11 tests (all 9 built-in games, blank canvas, no animation loop, obfuscated egress, bad browser path, static-invalid code). | `6fb7a456` |
| Content objects | Storage primitives added: `StorageIntegrityError`, `contentObjectKey`, `putImmutableStream` (hash+count while writing, dedup, replace corrupt copy, temp cleanup), `verifyObject`; 10 tests, in the Windows stack workflow. | `bbeefba1` |
| Waveyard Firefox | Play reported "interrupted" on a working device: first `resume()` settled *running* after 1805 ms, past the 1500 ms bound. Bound raised to 6000 ms with a regression test; no test threshold changed. | `3a782f73` |
| Waveyard WebKit | One confirmed restore-control failure: the `d8bc1430` push run resolved the button, then WebKit reported it unstable and detached. Added probes have not captured a recurrence; root cause **open**. | `17420c42`, `0e9ef2b6`, `77aef143` |

### Waveyard convergence follow-up (2026-11-09)

* Local drum, harmony, and vocal analysis execution is now committed on the
  convergence branch (`47ec26ac`, race guard `9a3a3dcb`). The local desktop
  worker runs versioned DSP jobs against local audio, persists normalized
  results with source provenance, and recovers queued jobs after restart. See
  the dedicated test and limitations below.
* At `9a3a3dcb`, the latest Windows x64 installer workflow completed green on
  the PR run (run `42553704812`): previous package install/start, database and
  migration readiness, record preservation across in-place update, clean
  database shutdown, plus the packaged smoke job's backup/restore checks.
  A second push-triggered package job (`42553701167`) also completed green with
  those same assertions. This is repeatability evidence for the existing
  service-worker/cache-clear mitigation, not proof of its
  underlying renderer lifecycle cause. The installed-package smoke exercises
  startup and packaged services; it does not prove audible real-audio playback.
* The same PR head's cross-browser live-stem timing workflow is green in both
  push and PR runs (`42553701083`, `42553704712`), covering Chromium, WebKit,
  and Firefox on the Linux PulseAudio null-sink harness. Historical WebKit
  restore-control flakiness remains unexplained; current green runs do not
  establish the original race's root cause.
* At `32639378`, the packaged Windows smoke now passed in both push and PR
  package runs (`42556175197`, `42556181034`) with a generated real PCM tone:
  Waveyard project creation, normal `/api/uploads` intake, exact byte retrieval
  from the private `/api/assets` route, and renderer playback after a click
  with media time advancing. Existing install, database, backup/restore, and
  in-place update checks also passed. This proves packaged real-audio decode
  and playback plumbing with generated audio, not human listening, real-song
  quality, or local model inference.
* Local syntax, whitespace, and workspace typecheck passed for the smoke change.
  The full desktop unit suite reported 122 pass / 1 fail / 16 skip: the unrelated
  `arcade-classic.test.mjs` symlink fixture fails with Windows `EPERM` in this
  environment; no assertion was weakened. The Windows CI packaging unit step
  passed on both runs.

* Analysis retries now claim the failed durable row before queue hand-off;
  queue refusal restores the original failure only while the row remains
  queued. Both failed-job retry and stale-analysis refresh paths avoid
  overwriting a fast worker's completed result, and queue handles are closed.
  Commits: `77fa1a6e`, `9ee9e0af`.
* Local API restart now requeues pending source BPM/key/beat and structural
  analyses from their durable rows. Queue refusal is guarded so an analysis
  already advanced by a worker is not marked failed. PGlite restart/retry and
  local DSP tests: 18/18 pass; normalization tests: 6/6 pass. Full workspace
  typecheck passes. These do not constitute browser, external DB, or packaged-
  Windows acceptance.
* PR #29 CI for `9ee9e0af` is running; check the live PR before treating it as
  green. Existing local normalization files and `pnpm-workspace.yaml` remain
  uncommitted and untouched by these retry commits.
* Session mix and transition saves now use a local journal. An unacknowledged
  PATCH survives a tab reload and replays; the visible retry control clears a
  failed queue, and a track's pending save is forgotten only after deletion is
  acknowledged. The journal is per session and does not claim cross-tab locking.
* MIDI download uses the Buffer-returning encoder; its bytes remain covered by
  the format and round-trip unit tests.
* Drum, harmony, and vocal API routes now use their shared versioned
  idempotency-key helpers. The vocal key retains the existing `vocal:` prefix.
* Targeted Waveyard verification: 238/238 tests pass, including real-audio
  source analysis and the original comprehensive live-stem-layer suite; the
  workspace type check passes. These are not database, browser, or packaged
  Windows acceptance runs.
* **Superseded by the current local analysis implementation:** the local worker
  now registers drum, harmony, and vocal queues. Desktop API requests select
  the versioned `arena-js-stem-analysis` provenance and persist the same
  contracts as the remote NumPy jobs. Drums and vocals analyze isolated stems;
  harmony analyzes the source. PGlite plus filesystem-backed storage tests
  execute all three handlers through ffmpeg decode, verify result rows,
  provenance, attempts, failure/retry and restart requeue. DSP tests exercise
  transients, chord windows, pitch frames, silence, and honest unknown classes.
  The expanded Waveyard regression set (including the full live-stem-layer
  suite) passes 161/161; the separation suite passes 53 with one
  platform-specific skip. Workspace typecheck passes. This is synthetic/local
  integration evidence, not real-song listening, hosted-provider evidence, or
  packaged-Windows acceptance. Drum class labels remain unknown because the
  local detector measures transients but does not infer kick/snare/hat identity.
  Analysis cancellation is not currently exposed by these job routes.
* Waveyard → Core project attachment and artifact handoff now validate before
  writing, serialize concurrent first-time attachment with a PostgreSQL
  transaction lock, and persist each artifact plus its handoff record in one
  transaction. The real embedded-PostgreSQL API test proved blank-summary
  requests write no Core rows, two simultaneous attaches produce one project
  link, a forced handoff-row failure rolls back the artifact, and a valid
  handoff persists both rows and appears through both existing Core artifact
  readers. API-server typecheck passes. This verifies local database and API
  reader integration; it does not establish browser navigation or packaged
  Windows acceptance for the handoff flow.
* Desktop restart recovery now expires queued or taken agent-bridge tasks whose
  waiting API request was destroyed with the prior process. Rows and prompt
  provenance remain available for inspection, and late bridge completions are
  rejected instead of becoming stranded or detached answers. The bridge suite
  now runs against an isolated PGlite database with canonical desktop
  migrations (4/4 pass); shared-library and API-server typechecks pass. This
  proves local database lifecycle behavior, not real external-agent inference.
* Research mode previously kept web search local when Local Mode was enabled,
  but failed to pass `localOnly` into model generation; remote provider egress
  remained possible and the response was mislabeled as local. Research now
  propagates the no-egress flag and returns the generator's actual execution
  metadata. Two tests exercise the real model router with a fetch trap: zero
  web/model-provider requests in Local Mode and preserved on-device metadata.
  The shared-library and API-server typechecks pass. The local fallback is the
  deterministic engine, not a local language model.
* At `a66abe83`, the PR-triggered live-stem timing job reproduced WebKit's
  restore-button detachment after a tempo-matched vocals swap. The probe showed
  the button disappeared from the captured current deck; the recipient fixture
  was only 20 seconds long while the timing scenario played through several
  operations. The app correctly advances decks when audio ends. The harness
  change gives only the timing recipient a 90-second audio fixture, leaving the
  comprehensive live-stem regression fixtures unchanged.
  `node --check` passes. This Windows environment has no installed Playwright
  browser binaries, so the WebKit fix still needs CI confirmation before push.
* The same `a66abe83` PR and push package jobs failed while building the previous
  package, before reaching the update check: pinned SDL/SameBoy downloads failed
  (`HTTP 504` / `Could not acquire pinned SDL release`). This is evidence of an
  upstream artifact-fetch failure, not a failed installed-app update assertion.
  The installed-package update workflow therefore remains unverified at this
  head; rerun it when the pinned artifact service is available.
* A bounded retry now handles transient HTTP 408/425/429/5xx responses across
  pinned SDK ZIPs, classic package assets, and the SDL fixture download. Pins,
  exact sizes, digests, and permanent HTTP failure behavior remain enforced.
  Desktop build tests pass 7/7, including retry-on-504 and no-retry-on-404.
  The first post-change Windows run still failed on pinned GBDK/DOSBox 504s
  while compiling the *previous* package: the workflow builds from the base
  worktree and had not copied the new retry helper and recipes there. The
  workflow now explicitly applies those three pinned-download files to that
  baseline build while preserving its prior app source. The next Windows run
  must confirm it reaches installer, install, update, and restart checks.
* The original comprehensive Chromium live-stem run exposed a real status-order
  defect: a tempo-matched donor was reported only as low beat confidence,
  hiding that the tempo stretch had succeeded. The status now distinguishes a
  real stretch from 1.00× native tempo and reports unavailable beat alignment
  separately. Its existing browser
  assertions passed through the tempo, pitch-follow, playhead, and donor
  alignment checks. The Windows WebKit run cannot exercise audio because that
  browser build lacks `AudioContext`; the Chromium full run exits early after
  measuring zero output samples on mirror-tab return, while its context remains
  running. The harness records this as unsupported-environment evidence, so
  this is partial browser evidence, not a full-suite pass.

### Historical test evidence (earlier environment; no PostgreSQL/Redis)
Per-file `tsx --test` runs, branch `bbeefba1` vs pristine `main@33c876a`, same runner:

| | files | tests | pass | fail | skip |
|---|---|---|---|---|
| `main` | 243 | 1678 | 1536 | 108 | 33 |
| branch | 258 | 1813 | 1688 | 91 | 33 |

* +135 tests, +152 passing, **0 regressions**; 15 new files (all green), 2 files
  fixed (`claim`, `retry`).
* All 37 failing files on the branch also fail on `main` (need PostgreSQL, Redis,
  `initdb` or a live service). **Environment-blocked, not fixed, not caused here.**
* The 33 skips are identical on both trees.
* `pnpm run typecheck` passes. Later commits changed only `desktop/`, `scripts/`,
  the resume bound and its test (5/5 pass).

### CI evidence (historical; latest evidence is above)
* Windows recovered-stack acceptance: green on every commit.
* Windows x64 package (build → install → smoke → update): historically flaky.
  `1ce31981` push ✅ / PR ❌; `d8bc1430` PR ✅ / push ❌; `320223b3` both ✅;
  `0e9ef2b6` both ❌ (`current_package_starts`, window url `""`, loading);
  `96810e3a` both ✅ (first runs with the service-worker clear). Two consecutive
  greens are **not** proof the fix works at a ~50% failure rate. Require several
  consecutive greens before calling it fixed.
* Waveyard browser timing: historical logs correct an earlier misattribution.
  On `bbeefba1` (`42429844918`), `17420c42` (`42429724101`), and `96810e3a`
  (`42436016713`), Chromium and WebKit passed; Firefox failed during playback
  setup/resume. The only confirmed WebKit restore-control failure is the
  `d8bc1430` push run `42432274551`: WebKit found the restore button, then
  reported it unstable and detached during a 30-second click. That run predates
  the DOM mutation/geometry probes, so there is no evidence explaining why it
  detached. On `0e9ef2b6`, `77aef143`, `9a3a3dcb`, `32639378`, and `df6f1127`,
  push and PR browser runs passed. Repeated green runs show the failure is not
  currently recurring; they do not prove its root cause or a fix.

### Convergence verification
* Ledger accounting: GitHub currently lists 50 branches = 48 audited + `main` +
  this branch; 28 PRs = 27 audited + #29. Every one of the 48 is named in the
  ledger (abbreviated to the hash prefix or brace group).
* No branch was deleted; history was not rewritten; nothing merged to `main`.

### Remaining and owner decisions
1. **Content-object schema/route/reclamation** (`artifacts.content_object`,
   `object_reclamations`, two-grace reclamation): nothing consumes content
   objects (artifacts are text-only), so wiring would be dead code. Decide whether
   binary artifacts are a product requirement.
2. **PR #19 stricter Arcade gate** (input exercise, visual-change): not ported;
   could reject legitimate games. Also: the gate launches Chromium with
   `--no-sandbox` on Linux unconditionally.
3. **Arrangement/export**: `arrangement-pcm`/`arrangement-preparation` are
   superseded by main's streaming preview (`arrangement-preview-*`); porting
   would create a parallel path. `project-audio` needs DB acceptance first.
4. **Cancellation** (`cancelling` status, PR #26 `recovery.ts`): conflicts with
   main's broker cancel; design decision.
5. Branch protection / required checks on `main`.
6. Untested: real Demucs inference, GPU provisioning, audible playback, code
   signing, auto-update, whole-app shared identity and restart recovery with a
   real database.


## Product goal

One unified Arena OS, built on current `main` (pnpm workspace). Rooms: Core
(AI runtime, agents, missions, memory, governance), Spaces, Arcade, Waveyard
(music), Studio (media generation), Desktop (Windows app), plus Archive,
Congress, Classroom, Orchestrator. **A feature existing somewhere in the repo
is not the same as it working in the unified app.** Every room must correspond
to a working, verified capability.

## Ground rules

1. `main` is the canonical line. Do not merge old integration branches wholesale;
   recover capabilities into the current workspace instead.
2. Never delete branches, rewrite history or force-push shared branches. Old
   branches hold work and evidence.
3. A PR description must match its diff. Production-code changes are never
   "test only".
4. Do not claim something is verified unless a test or CI run proves it.
   Record unverified behaviour explicitly (see "Not verified").
5. Fail closed: invalid input or state must error, not silently fall back.
6. Pinned downloads (FFmpeg, SDL, etc.) must use immutable URLs with SHA-256.
   Do not re-pin to a moving tag.
7. Original Arena code is proprietary (see `LICENSE`). Do not paste it into other
   projects or add code with an incompatible licence.
8. Keep `README.md` and this file accurate. One focused PR per concern.

## Two facts about this repository that invalidate naive git measurements

Read these before drawing any conclusion from `git log` or branch counts.

1. **`main` is a single squashed root commit** (`33c876a`). Commit ancestry
   carries no meaning: every branch shares it as merge-base, so
   `main..branch` reports 100–340 "missing" commits for every branch and
   `git cherry` finds zero patch equivalence. Across the repo that reads as
   6,242 orphaned commits. **It is an artefact. Use content diffs.**
2. **The large branches are the pre-migration layout, not new work.** Every
   branch that looks big is a whole-tree copy of the old Next.js/npm app
   (`src/**`, `next.config.ts`, `electron-builder.yml`). Against today's tree
   they *delete* ~201,600 lines because they do not contain the pnpm
   workspace. The real question is always: *which `src/lib/**` capability has
   no counterpart under `lib/arena/src/lib/**` on `main`?* The union across all
   48 branches is **89 library paths** — that is the true recovery surface.

Full per-ref dispositions: `docs/BRANCH-PR-RECONCILIATION-LEDGER.md`.

## Priorities (in order)

1. **Land PR #28** (mashup fail-closed + Windows CI repairs) once Windows
   packaging and Waveyard browser acceptance are green.
2. **Land the convergence branch** `arena/convergence-2026-11-07` (based on
   PR #28's head). It contains the ported PR #26 capability stack, PR #27's
   recovered test coverage, and two pre-existing `main` defects fixed. Its
   delta versus `main` is measured: +99 tests, +116 passing, 0 regressions.
   It has not run on Windows — see "Not verified".
3. **Close the remaining recovery rows** in the reconciliation ledger §2.4.
   The two biggest are:
   - *artifact content objects + reclamation*: needs an `artifacts.content_object`
     column, an `object_reclamations` table, and two storage primitives
     (`putImmutableStream` with byte+sha binding, `StorageIntegrityError`) that
     `main`'s `StorageProvider` does not have. Do it as one migration + storage
     + route change, with tests, or not at all.
   - *Arcade browser-runtime publication gate*: `games/sandbox.ts` +
     `runtime-validation.ts` + the `validateRuntime`/`onDraft` contract in
     `forgeGameWithAI`. **Stale:** a gate already exists on `main`; see the top
     status section.
4. **Protect `main`**: no branch protection or rulesets exist. Require CI and
   review before merge.
5. **Prove the whole app**: shared identity/projects/storage across rooms,
   persistence, restart recovery, real provider execution, Windows install.

## Current state

- `main` = `33c876a` (5 Nov 2026, single squashed commit).
- **PR #28** `fix/mashup-bed-fail-closed-windows-tests` @ `aec18974`, 34 files
  ahead of `main`, clean descendant (0 main-only commits). Adds fail-closed
  instrumental-bed synthesis (`studio/mashup-bed.ts`), Windows packaging and CI
  repairs, and a capture-device guard.

  **Its Windows CI is `failure`, not green.** Every run on `aec18974` fails, on
  both the `push` and `pull_request` events:
  `installed-package` fails at step 10, *Build previous Windows package for
  update test*; steps 11–12 (*Build Windows x64 installer*, *Install and check
  packaged app*) are then **skipped**, so no PR #28 commit and therefore **no
  convergence-branch commit has ever had its installer installed and smoke
  checked by CI**. Earlier handoff text claiming that run was green was wrong
  and has been removed. See "CI status" below for the diagnosis.
- **`arena/convergence-2026-11-07`** — the convergence candidate. Built on
  `aec18974`, so it inherits PR #28 in full. Contains:
  - the complete `port/26-*` stack, in dependency order
    (`44a9570 → a4f69af → 6afc57e`) plus `port/26-command-process` (`ab99bf0`):
    separation client/modes/selection + Python guardian, resumable locked model
    seeding, `fs-replace`, deep-model provisioning
    (`provision`/`provision-store`/`provision-runtime`), bounded `run_command`
    with Windows tree-kill;
  - PR #27's regression coverage, without its production edits (see below);
  - fixes for two pre-existing `main` defects (see "Known defects on main").
- **`port/26-*` branches**: now superseded by the convergence branch, which
  contains their content. Keep them; do not delete.

## Known defects on `main` (fixed on the convergence branch)

1. **`desktop/runtime/migrate` did not exist**, yet five call sites imported it
   at three different relative depths. `claim.test.ts` and `retry.test.ts`
   failed with `ERR_MODULE_NOT_FOUND`, so **17 tests had never run**.
   `main`'s own harness (`worker-local/separation-fixtures.ts`) states the rule
   they broke: *"Tests must not import the desktop runtime, which is not part of
   the web workspace."* Fixed with
   `worker-local/pglite-migrations.test-helper.ts`. `retry` 0/11 → 11/11,
   `claim` 0/7 → 6 pass + 1 honest skip.
2. **PR #27's test file did not compile** — line 95 closed an object literal
   with `)`. Nothing in that PR had ever run.

## PR #27 — resolved, do not merge as-is

PR #27 (`arena/ed2f88f7`) was labelled test-only but changes
`session-logic.ts` and `mashup.ts`. Findings:

- Its test file does not compile, so none of it ran.
- With **only** that syntax error fixed, all 9 original assertions pass against
  **untouched `main`**. The production edits were unnecessary.
- They were also unsafe: they delete `hasReliableLiveStemTempoEvidence` /
  `hasReliableLiveStemBeatEvidence`, which `LiveStemSwapPicker.tsx` and
  `SessionExperience.tsx` import at 10 sites, and which
  `liveStemTempoStretchRatio` calls itself — the module would throw at import
  time. They also relax evidence thresholds (0.75→0.5, 0.6→0.3) and widen
  auto-stretch (0.8–1.25 → 0.75–1.5) on unverified evidence.

The convergence branch keeps the coverage
(`waveyard/studio/mashup-regression.test.ts`,
`waveyard/library/session-logic-key.test.ts`) and drops the production diff.

## Test evidence standard

Run the suite twice — once on a pristine `origin/main` worktree — and compare
per-file failure counts. Never attribute a failure to your work, or claim one
is fixed, without that comparison.

Current measurement (real `ffmpeg`/`ffprobe` available; no PostgreSQL/Redis):

| | tests | pass | fail | skip |
|---|---|---|---|---|
| `main@33c876a` | 1347 | 1237 | 93 | 17 |
| convergence branch | 1446 | 1353 | 76 | 17 |

The 76 remaining failures are identical per file to the baseline and need
PostgreSQL, Redis, a live browser or `initdb`. `pnpm run typecheck` passes.

## CI status — historical diagnosis, 2026-11-07 (STALE: see "Status at `3a782f73`" above)

Neither required workflow is green. Both failures are **inherited from
`main`**, not introduced by the convergence branch, and both are diagnosed
below from workflow-run and job-step data (not from logs — see the note at the
end of this section).

### `windows-package.yml` / `installed-package`

| run | sha | event | result |
|---|---|---|---|
| 42376054058 | `5fb2f72` | push | **success** (1.4k lines of work recovered, 13:14–13:29) |
| 42362246027 | `720a584` | push | **success** |
| (same commit `720a584`) | | pull_request | **failure** |
| — | `aec18974` | push and pull_request | **failure** |
| — | `b28d938` (this branch) | pull_request | **failure** |

Only **`push`** events have ever passed. On a pull_request run the job dies at
step 10, *Build previous Windows package for update test*, after ~30 s, while
the same step takes **4 minutes** and succeeds on push. Steps 11–12 (build
installer, install and smoke check) are skipped, so pull_request runs have never
validated an installed app.

**Diagnosis.** That step packages the *baseline* revision, chosen as
`pull_request.base.sha` on PR events (`main` → `33c876a`) or `github.event.before`
on push. `main` cannot be packaged by this workflow — two independent proofs:

1. `main` still carries `"esbuild>@esbuild/win32-x64": "-"` and
   `"@tailwindcss/oxide>@tailwindcss/oxide-win32-x64-msvc": "-"` in
   `pnpm-workspace.yaml`. PR #28's commit `2ec27f4` exists specifically to
   un-prune exactly those, so a Windows install from `main` is broken by design.
2. `desktop/native/waveyard-capture-host.cpp` on `main` lacks the Windows SDK
   header fixes made in `36a082c` (`propkeydef.h`) and `b7cd935`
   (`winrt/Windows.Foundation.h`).

So the "previous" build is a build of `main`, which does not build on Windows.
The push-only successes are not evidence of Windows readiness: a push whose
`before` sha is unavailable falls back to `git rev-parse HEAD^`, which on a
single-commit squashed `main` resolves to something other than `main`.

**Status (historical, superseded): the base-packaging causes were later fixed via the workflow base-fix list; see the top status section.** The fix requires a baseline
revision that can actually be packaged, which cannot be expressed from inside
this branch without changing what the update test means. Do not "fix" it by
making the step tolerate failure.

### `windows-recovered-stack.yml` — new, and green

No workflow previously ran `lib/arena` tests at all: the packaging workflow runs
only `desktop/*.test.mjs`, and none of those reference `fs-replace`,
`command-process`, `separation/seed` or `separation/provision`. The recovered
PR #26 stack therefore had **no CI coverage on any platform**.

This branch adds `windows-recovered-stack.yml`, which runs those ten test files
on `windows-latest` and **passes** (run `42378233941`, job `128420170775`,
`f505bd4`, 12 s of test time). To stop a silently skipping suite reading as a
pass, the job fails if the tree-kill test is absent from the output or reports a
skip, and raises a warning if the inference probe skips.

**This is real Windows evidence for the recovered stack's process/filesystem/
seeding/validation behaviour** — the first it has ever had. It is *not* evidence
of real audio inference (no ffmpeg or GPU on the runner) and it is not evidence
that the Windows installer works, because that is the other job.

### `waveyard-browser-timing.yml` / `live-stem-timing`

**RESOLVED — the matrix now passes on all three engines** (run `42386675911`,
`6a0ba64`, job `live-stem-timing` = **success**, every step green including the
new audio-sink step). This section records what was wrong, because two of the
explanations offered earlier in this file were wrong and one of them was wrong in
a way that made the next diagnosis harder.

| run | sha | result |
|---|---|---|
| 42376858283 | `867c538` | fail, 100 s |
| 42377175538 | `b28d938` | fail, exactly 60 s (Vite readiness) |
| 42378234049 | `f505bd4` | fail, 72 s — readiness annotation did **not** fire |
| 42378819685 | `66dba41` | fail — *matrix failed* (so readiness + persistence passed) |
| — | `7af676b` | fail — `LIVE_STEM_TIMING_ENGINE firefox exited with status 1` |
| — | `c75d9df` | fail — `TimeoutError` at `waveyard-live-stems.mjs:2030` |
| — | `675ef64` | fail — `pressed:"false"`, elements `readyState 4`, no media error |
| — | `d204052` | fail — context `suspended`, `playStarts: []`, `playRejections: []` |
| 42381290508 | `b80b368` | fail — `visibleError`: *can't access property "find", next.devices is undefined* |
| 42381843655 | `da56f1e` | fail — probe annotation corrupted by raw audio bytes |
| 42382362100 | `49b0da0` | fail — `contextResumes: []`, still no error |
| 42382740991 | `4e22a86` | fail — `contextResumes: [{outcome:"still-pending", pendingForMs:2999}]` |
| 42385321180 | `3be2a1e` | fail — a **brand-new** context also stays pending; `userActivation.hasBeenActive: true` |
| 42385847628 | `d6132b3` | fail — honest error now shown; sink step silently did nothing |
| 42386286296 | `08f5631` | fail — **Firefox passes**, WebKit `TimeoutError` |
| 42386675911 | `6a0ba64` | **success — chromium, webkit and firefox all pass** |

**The actual cause, in two halves.**

*Environment.* The runner had no audio device. Firefox suspends a Web Audio
graph when there is nowhere to play it; Chromium and WebKit run theirs anyway,
which is precisely why only one engine failed. Proven, not inferred, from a
failure-time probe in the page (`3be2a1e`):

```
directResume   "suspended -> pending-after-1500ms (state now suspended)"
freshResume    "suspended -> pending-after-1500ms (state now suspended)"
userActivation {"isActive": true, "hasBeenActive": true}
workletLoads   [{"outcome":"resolved","settledAfterMs":35}]
```

A **brand-new** `AudioContext` could not resume either, while
`AudioWorklet.addModule` on the same context finished in 35 ms. So it was not an
autoplay refusal (the page had been activated and the Firefox prefs already set
`media.autoplay.default: 0`) and not the app's own context being wedged. The
workflow now installs `pulseaudio` (the *daemon* — installing only
`pulseaudio-utils`, the clients, was a first attempt that reported success and
created no sink), starts it with `-n` and an anonymous-auth unix socket, loads a
`module-null-sink`, and passes `PULSE_SERVER` to the matrix step. The step warns
via `::warning::` if any part of that fails, so it cannot silently no-op again.

*Application.* `await context.current.resume()` was unbounded. A resume promise
is allowed never to settle, and this one did not: Play stopped at the await with
no playback, no error, and a Playing control that never engaged — a dead button.
`resumeWithin()` (`lib/arena/src/lib/waveyard/audio-context-resume.ts`) bounds
the wait; the caller then inspects `state` and reports *"Audio playback was
interrupted. Activate Play stems to resume. If this persists, check that this
device has a working audio output."* That is what the Firefox leg showed at
`d6132b3`, before the sink existed: the failure became legible to a user instead
of a 30 s silence. Four regression tests, and they run in CI.

*Third defect, found on the way.* `AudioCaptureWorkbench` is mounted
unconditionally in `MusicHome`, so it calls `/api/library/audio-capture` on the
session page too. Nothing serves that route in this harness and the SPA fallback
answers with `index.html`, so the body was never capture options. The component
cast it to `CaptureOptions` and called `next.devices.find(...)`, which threw
`can't access property "find", next.devices is undefined` out of a refresh
effect. `parseCaptureOptions` now validates the shape and reports an error
instead. Six tests.

**Corrections to this file's own earlier claims.** It asserted "Chromium and
WebKit pass, Firefox fails" with no evidence, then asserted the throw at
`useStemTransport.ts` L846–849 was the cause (it required `resume()` to *settle*
and leave the state non-running — it never settled at all), then read
`contextResumes: []` as "resume() was never called" when the probe only recorded
settlements and could not distinguish "never called" from "called and never
returned". Each was written down as established fact. They were not. The probe
now records calls synchronously and marks a promise still-pending after 3 s,
which is why the last three rows above are decisive where the earlier ones were
not.

**No timeout, assertion or gate was relaxed.** The 30 s `waitForFunction` is
unchanged; the failure moved from "some engine times out" to "all three engines
pass".

**Latency regression gate.** Each browser now records five independent
native-tempo and five tempo-matched swaps. The gate uses the median of the
browser-observed selection-to-audible timings, so one or two scheduler spikes do
not fail CI; three slow samples do. The 450 ms delayed-download case remains a
separate functional check and is intentionally excluded from the latency budget.

The limits are deliberately above the observed normal range, with additional
room for runner noise:

| Browser engine | Native-tempo median | Tempo-matched median |
|---|---:|---:|
| Chromium | 900 ms | 1,200 ms |
| WebKit | 750 ms | 1,200 ms |
| Firefox | 600 ms | 900 ms |

These are Linux CI guardrails, not claims about hardware latency. In eight
successful recent runs before repeated sampling was added, the observed medians
were 190/479 ms for Chromium, 180/445 ms for WebKit, and 92/296 ms for Firefox
(native/tempo-matched). One Chromium native-tempo run had a 1,469 ms sample;
median-of-five is specifically intended to tolerate isolated runner stalls
while still failing when the majority of swaps slow down. Pure budget tests
cover both that noise case and an injected sustained slowdown.

The first repeated three-engine run (commit `c16b3d54`, run
`43201302988`) passed with five samples per mode. Its observed medians were
203.9/498.4 ms for Chromium, 164/495 ms for WebKit, and 121/384 ms for Firefox
(native/tempo-matched), all below the respective budgets.

### Why the cause is not being quoted from CI logs

Job logs are unreachable from the environment this work ran in:
`productionresultssa*.blob.core.windows.net` and
`results-receiver.actions.githubusercontent.com` are both outside the sandbox's
network allowlist, and check-run annotations contain only
"Process completed with exit code 1." The diagnoses above come from workflow
definitions, step timings, event/result correlation across runs, and local
reproduction of Vite. Re-read the logs when they are reachable; if they
contradict this, they win.

## Not verified (do not claim otherwise)

- **The ported PR #26 slices now run on Windows**, via
  `windows-recovered-stack.yml`, which passes. What that does *not* prove:
  real Demucs inference (no ffmpeg/GPU on the runner — the job emits an
  `::warning::` saying the inference probe was skipped and that real inference is
  therefore NOT proven), and the packaged installer, which is the other, still
  failing job.
- Real Demucs inference on Windows, GPU model provisioning, audible playback via
  hardware, GUI mixer interaction, human-driven Arcade/Spaces flows on Windows,
  code signing, auto-update.
- **The full browser matrix passes only on this harness**, on `ubuntu-22.04`
  with a PulseAudio null sink. That is genuine cross-engine evidence for
  Chromium, WebKit and Firefox playback/timing on Linux. It is not evidence of
  audible playback through real hardware, and not Windows or iOS evidence.
- The Waveyard browser matrix covers the live-stem timing scenarios only; the
  other `waveyard-*.mjs` scripts are not run by this workflow.
- Database/migration acceptance: no PostgreSQL or Redis here.
- PR #26's six green Windows jobs (1,649 tests) are evidence **for the old
  npm/Electron layout only**. Never cite them as proof that ported code works.
- Hosted-runner results are not a substitute for the owner's Windows 11 machine.

## Handoff checklist for each session

1. Read §"Two facts about this repository" before trusting any git metric.
2. Check which of PR #28 / the convergence branch has landed.
3. Pick the highest open priority that you can actually prove.
4. Add a test that fails without your change and passes with it.
5. Measure against a pristine `origin/main` worktree; record both numbers.
6. Update this file and the reconciliation ledger in the same PR.
7. Never delete a branch or force-push.
