# Waveyard completion ledger

Status of the master directive, area by area, with the evidence behind each
claim. This is deliberately split three ways — **engine**, **intelligence**,
**proof** — because most of the remaining risk is in the last two and it is
easy to mistake a passing test for a musical result.

**Nothing here is a quality claim.** Listener count is **N=0** everywhere. A
render that passes every assertion is still unjudged.

Verification environment: PostgreSQL 16.2 obtained inside the sandbox (see
`docs/waveyard-route-acceptance-environment.md`), so the route acceptance test
now *executes* rather than skipping.

---

## 1. Evidence inventory

| Suite | Result | What it actually proves |
| --- | --- | --- |
| `mashup.test.ts` | 41/41 | planner behaviour, segments, stretch/pitch decisions |
| `mashup-mix-bus.test.ts` | 13/13 | balance, limiter, gating, tempo-map-faithful donor layering, replacement |
| `donor-stem-integrity.test.ts` | 18/18 | provenance refusal, PCM validation, replacement vs layering, fail-closed composition |
| `mashup-full-length.test.ts` | 4/4 | long-render measurement bounding |
| `mashup-regression.test.ts` | 6/6 | earlier planner regressions |
| `output-peak-limiter.test.ts` | 8/8 | limiter ceiling and true-peak behaviour |
| `route.test.ts` (PostgreSQL + ffmpeg) | 1/1, 0 skipped | full HTTP route, real DB, real WAV export worker |

Several assertions were **mutation-checked**: reverting the underlying fix
makes the suite fail. Those are marked below.

---

## 2. Area by area

### P0 — Audio integrity: **implemented, partially proven**

Engine (done): explicit composition, donor alignment to the planned entry,
`vocalsFromMs` trimming, bounded ±6 dB vocal/bed balance, the true-peak limiter
actually connected to the render path, static-gain-only-when-overshooting,
measurement cost bounded on long renders, `not-measured` reported honestly.

Correctness (done, mutation-checked): replacement fails closed unless both the
donor stem and a separable bed stem are proven; headers describe the rendered
composition, never the requested one.

Proof (partial): every number comes from synthetic fixtures with pure tones.
No real separated material has been through this path.

### P1 — Rhythmic placement: **implemented; map faithfulness now proven at unit level**

The previously unproven claim was "donor layers preserve the local tempo map".
It was not just unproven — it was **false**. `renderMashupWithBus` warped the
vocal through `segment.localTempoMap` but stretched the donor by the constant
`vocalsStretchRatio`, so a layer started together with the vocal and then slid
against it *within* the phrase. Fixed, and pinned by a test measuring click
placement at 1 s, 2 s, 5 s and 7.5 s of donor source time against the map, not
just at the entry. Mutation-checked: reverting the fix fails the test.

Still unproven: behaviour on real material with differing groove. Passage
selection quality, half-time misreads (71.8/43.4 BPM observed earlier) and the
zero-accepted-candidate ground-truth probe all remain open.

**Tempo octave error — found and measured (2026-11-14).** The half-time
misreads were not a tuning issue; the octave is destroyed *inside* the
analyser. `estimateBpm` reports whichever autocorrelation peak scores highest,
and `foldTempoForMixing` then forces it into 70–180 BPM. Because a true tempo
outside that band is *only* reachable through the folded value, the original
octave never reaches the planner. Measured on synthetic onset tracks (hats on
8ths, kick on beats, snare on 2 and 4):

| true BPM | reported | reported confidence | bar length error |
| --- | --- | --- | --- |
| 60 | 120.185 | **1.0** | 0.499× |
| 72 | 143.555 | **1.0** | 0.502× |
| 90 | 178.206 | **1.0** | 0.505× |
| 100 | 99.384 | 0.992 | 1.006× |

The consequence reaches the planner's stretch decision. `warpRatioForTempos`
has no octave knowledge in its signature, so pairing a 72 BPM vocal with a
100 BPM bed yields a ratio of **0.692** where the truth is **1.389**. The
output is half the intended length, i.e. the vocal is compressed twice as hard
and runs at roughly **twice** the intended speed against the bed:

| bed | vocal | true ratio | planned ratio | error |
| --- | --- | --- | --- | --- |
| 72 | 100 | 1.389 | 0.692 | 50.2% |
| 60 | 100 | 1.667 | 0.827 | 50.4% |
| 68 | 92 | 1.353 | 0.679 | 49.8% |
| 90 | 128 | 1.422 | 0.725 | 49.0% |
| 85 | 100 | 1.176 | 1.173 | 0.3% |

Planning the same 72 BPM bed both ways confirms this is not cosmetic — the
whole plan changes shape:

| | corrected 72 BPM | reported 143.555 BPM |
| --- | --- | --- |
| master BPM | 72 | 143.555 |
| stretch ratio | 1.389 | **0.697** |
| segment count | 1 | **2** |

The error is pattern-dependent, which is why it has been so hard to pin down:
the *same* 72 BPM pulse read 71.78 (correct) when the track had no 8th-note
hats and 143.56 when it did. The confidence score does not drop when this
happens — all three folding cases report 1.0 — so "trusted BPM" gates let the
wrong octave straight through. This is confident-and-wrong, the failure mode
the directives single out, and it is the highest-damage defect found so far.

### P2 — Stem compatibility intelligence: **partially implemented, no decisions made**

Implemented: harmonic/key analysis with confidence gates, drum-transient and
bass-attack detection, vocal activity, passage fingerprints, compatibility
ranking.

Not implemented: any decision about whether a donor's drums *belong* under a
given bed. Replacement/layering is currently a user choice carried out
faithfully. Nothing verifies groove, energy or transient character. This is the
largest genuine intelligence gap and it is still untouched.

### P3 — Arrangement intelligence: **foundation only; explicitly deferred**

Form inference, phrase detection, vocal chops and continuity exist. No evidence
that entry/exit/drop decisions improved. The owner deferred this (P2 in their
numbering) until real-audio P0 acceptance; that deferral still stands.

### P4 — Candidate generation and comparison: **infrastructure done, never run on real songs**

The A/B/C/D harness exists and has already earned its keep by exposing three
defects in my own work (C identical to A, reported-but-unapplied gain, wrong
donor anchor). It has still only been run on synthetic fixtures.

### P5 — Real musical validation: **not started**

No real stems in this checkout, no renders, no matched-loudness comparison
files, no listeners. This is the binding constraint on every other claim.

### P6 — STEM.FM parity: **significant implementation, parity unproven**

Mute/solo/isolate, prepared swaps, quantised actions that refuse honestly,
session persistence and Studio handoff exist. No side-by-side acceptance
comparison against STEM.FM has been performed.

---

## 3. Work completed in this pass

1. **Donor layers follow the accepted local tempo map** (P1, above) — a real
   bug, not a validation gap.
2. **Export parity for donor clips.** Donor clips were saved with
   `tempoSyncEnabled: false` regardless of what the render did, so a 140 BPM
   donor over a 100 BPM bed was warped 1.4× in the render and played at its
   native rate in the export. They are now tempo-synced when the donor's tempo
   is verified, with a reported warning when it is not. Mutation-checked, and
   the stretched session is exported through the real worker.
3. **Route acceptance extended** with the tempo-parity cases and a real export
   of a stretched session.

---

## 4. The ordering that remains

The sequence the directive set is still correct; what has changed is that the
engine layer is now trustworthy enough to build on.

1. **Real songs, same harness.** Obtain Queen/September separated stems; run
   A/B/C/D; produce loudness-matched files; get N≥1 listeners. Until this
   happens, nothing above can be called an improvement in music.
2. **P0 acceptance on that material** — specifically the intermittent whistle,
   which is still unexplained and must be traced on real separated stems, not
   notched away.
3. **P2 intelligence** — turn existing analysis into an explained
   retain/replace/layer/reject decision for drums and bass, with measured
   compatibility separate from any score.
4. **P3 arrangement** — only after the above, and only judged by listeners.

Each step should carry the same rule used here: if a claim cannot be
mutation-checked or heard, it is not finished.

---

## 5. Mashup generation parity V1 — audit pass (2026-11-14)

Audited at `7c4057a`, from the code, by executing the analyser rather than
reading it. Four areas were examined this pass.

| Area | Verdict | Basis |
| --- | --- | --- |
| Tempo estimation / octave | **works modulo octave; octave loss was real** | synthetic: 50% stretch error at confidence 1.0. Real audio (13 CC0 tracks): 12/13 octave-equivalent agreement with librosa, now fixed in section 6 |
| Key detection | **fails on real music** | synthetic: 7/7 correct at 0.87–0.97. Real audio: **0/13** agree with librosa (4/13 only relative), and it reports C major/minor for 13/13 tracks |
| Key-relationship logic | **works** | relative major/minor ⇒ 0 semitones by design; unknown keys ⇒ 0 semitones, `relationship: "unknown"` |
| Passage compatibility / phrase alignment | **implemented, unvalidated** | real scoring (`comparePassageCompatibility`, `rankPassagePair`, chord-tone fit, transient scoring), but never run on real stems |
| Fallback tempo | **honest** | always `confidence: 0.0` (`source: "default"` ⇒ 120 BPM); only used when no analysis exists, always with a warning, and never treated as verified by `trustedAnalysisBpm` |

Key findings:

1. **Confidently-wrong tempo (P0).** Detailed above. This is the dominant cause
   of unusable mashups on real material and it is invisible to every existing
   test: the tests assert that reported BPM *relates* to the true tempo via
   `bpm*2`/`bpm/2` (see `analysis-engine.test.ts:115`), which accepts exactly
   the wrong answer. Synthetic fixtures cannot detect it because they were
   built from the same assumption.
2. **Half/double folding happens before any pairwise decision.** The planner
   receives one folded number and cannot recover the octave. Fixing this in
   `warpRatioForTempos` alone is impossible — the information is already gone.
3. **No real audio exists in the checkout.** `find` for `*.wav|*.mp3|*.flac|
   *.m4a` returns nothing and no fixture manifests are present, so the directive's
   real-song benchmark cannot be run against in-repo material.
4. **The reported whistle remains unexplained** and cannot be reproduced from
   synthetic fixtures; `waveyard-mashup-mix-diagnostic.ts` says so itself.

Still not established after this pass: N=0 listeners; synthetic material only;
P2 makes no compatibility *decisions*; P3 arrangement intelligence untouched;
the A/B/C/D harness has still never been run on real songs.

### Real-audio addendum (same day, 13 CC0 tracks)

Synthetic material alone was misleading in both directions, so the analyser was
run on real recordings: 13 instrumental tracks released **CC0 / public domain**
by AERIS MUSIC (`farmmer938-lgtm/aeris-cc0-music`), decoded through ffmpeg at
22,050 Hz mono and passed straight to `analysePcm`. The repo's own metadata was
**not** trusted as ground truth — see below.

**Tempo is better than the synthetic results suggested.** Against librosa
(`beat_track`, an independent implementation) the local analyser agrees within
an octave on **12/13** tracks and exactly on 2/13; every reading was
0.48–0.76 confidence. The single disagreement (`overdrive-signal-lost`, 127.6 vs
86.1 BPM, factor 1.48) is not an octave relation, so it is a genuine tempo
disagreement rather than a folding artefact. The earlier "fails on real music"
wording was too strong and is corrected above: the octave defect was real and is
now fixed, but tempo estimation on real material is broadly sound.

**Key detection is the real defect.** It reports **C major for six tracks and
C minor for four** — 13/13 land on C. Against librosa: 0/13 exact, 4/13
relative major/minor, 9/13 unrelated. Confidences were 0.04–0.31, i.e. every
one below the 0.5 mixing threshold, which has two consequences:

1. **Harmless but useless.** `trustedAnalysisKey` returns null, so no pitch
   shift is ever applied. Mashups render un-transposed, which is the safe
   failure — no needless pitch damage, and no fabricated confidence.
2. **Harmonic compatibility can never engage.** A key signal that is never
   trustworthy means the "compatible keys" half of compatibility decisions is
   dead on real material. That is a functional gap, not a cosmetic one.

Partial validation: on clean synthetic chords the same code is correct and
unbiased — C major triad, A minor triad, and all twelve single sinusoids
(C4–B4) map to the right pitch class. So the chroma pipeline is not
structurally broken; the failure is specific to real, broadband, bass-heavy
material.

**The corpus metadata is unverified, and that matters.** The repository's
README publishes a BPM and key per track, but it disagrees with both our
analyser and librosa, and the two engines disagree with each other in different
directions (ours peaks at C, librosa at A). Since two independent implementations
reject the published table and agree with each other on tempo, the README values
cannot be used as ground truth. No key claim in this document rests on them.

---

## 6. Tempo octave ambiguity — fixed (2026-11-14)

The P0 defect from section 5 is fixed. Nothing here is a listening claim (N=0);
all measurements are synthetic and the musical verdict on the result is still
unmade.

**What changed, and why in this shape.** The octave is destroyed inside
`estimateBpm`, so no planner-side fix could recover it. Three attempts were
measured before choosing:

1. *Rank octaves by autocorrelation strength* — **rejected.** At 72 BPM with
   8th-note hats the doubled lag scores *higher* (0.761 vs 0.732), so this
   makes the error worse.
2. *Rank octaves by grid accent (do beat slots carry stronger onsets than
   subdivisions?)* — **rejected.** Every octave's grid lands on onsets
   (median-slot strength 1.000 for all three), so the envelope genuinely cannot
   distinguish them.
3. *Report the pulse family and choose the pairing needing the least warp* —
   **adopted.** Least warp is the smallest audible artefact and preserves the
   legitimate 2:1 half-time lock instead of refusing it.

Because the ambiguity is real rather than a tuning problem, the fix does **not**
claim to know the answer. It exposes `bpmCandidates` from the analyser
(`bpm` stays first, so existing consumers are unchanged), carries the family
through the production loader as a pure function of the stored tempo, picks the
cheapest pairing in the planner, and moves `masterBpm` with the resolved bed
octave so bar/entry decisions cannot disagree with the vocal warp. Genuinely
tied octaves are reported as **ambiguous** rather than presented as measured.

**Measured effect** — nine synthetic bed/vocal pairs, pulse error in semitones
of tempo after warping (a locked pair is < 0.6):

| bed | vocal | before | after |
| --- | --- | --- | --- |
| 72 | 100 | 5.6 off | **0.05 locked** |
| 60 | 100 | 5.6 off | **0.13 locked** |
| 85 | 100 | off | **0.05 locked** |
| 68 | 92 | off | **0.05 locked** |
| 90 | 128 | off | **0.33 locked** |
| 100 | 128 | off | **0.27 locked** |
| 128 | 174 | off | **0.33 locked** |
| 90 | 140 | off | **0.13 locked** |
| 72 | 96 | off | **0.00 locked** |

**Tests added (all mutation-checked).** `mashup.test.ts` 41 → 46:
folded-bed warp, unchanged behaviour without candidates, never-more-stretch
than the raw readings, octave resolution reaching the plan, and the ambiguity
warning. `analysis-engine.test.ts` 24 → 26: the family exposes the lost octave
and rejects degenerate readings. `route.test.ts` gains a production-path
assertion that the persisted-tempo profile still carries its pulse family.

Mutation checks: passing `null` families to the candidate selector fails tests
45/46; removing the loader's `bpmCandidates` fails the route assertion with
*"the persisted-tempo profile must expose its pulse family"*.

**Suites at this commit:** mashup 46/46, mix-bus 13/13, donor-stem-integrity
18/18, full-length 4/4, regression 6/6, peak-limiter 8/8, analysis-engine 25/26
(the one failure is the pre-existing `decodeMonoPcm` ffmpeg-environment test,
unrelated to this change), route acceptance 1/1 with 0 skipped against real
PostgreSQL + ffmpeg.

**Still open.** The alternative octave is still chosen by warp cost, not by
musical evidence, so a track whose true tempo is the *higher* octave will be
placed a half-time low. That is a defensible default, not a solved problem, and
it needs real recordings to evaluate. No real audio has been analysed yet; the
corpus is CC-licensed material to be sourced next. Listener count remains N=0.
