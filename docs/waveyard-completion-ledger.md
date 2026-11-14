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

---

## 7. Real-audio acceptance benchmark — first run (2026-11-14)

Step 2 of the directive. The corpus is sourced, reproducible and real.

**Corpus.** 13 instrumental recordings released **CC0 1.0** (public domain) by
AERIS MUSIC, pinned to upstream commit `51ab767`. Audio is not committed
(36 MB); `scripts/waveyard-real-audio-corpus.ts` refetches it and verifies every
file against a sha256 manifest (`scripts/fixtures/waveyard-real-audio/corpus.json`)
into the git-ignored `generated-artifacts/waveyard-real-audio/`. 13/13 verified.
No commercial recording is used, and no listening test has been performed.

**Runner.** `scripts/waveyard-real-audio-acceptance.ts` decodes each track with
ffmpeg, runs the production `analysePcm` and `planMashup`, and records what the
engine actually decided for all 156 ordered pairs. Sections are synthesised
deterministically (the DB normally supplies them) — this is stated because it
means structure evidence here is **not** real, so arrangement behaviour on this
run is indicative only.

**Measured results (N=0 listeners, no quality claim):**

| Measure | Result |
| --- | --- |
| Tracks analysed | 13 |
| Pairs planned / refused | **156 / 0** |
| Tracks with trusted tempo (conf ≥ 0.5) | 11 / 13 |
| Tracks with trusted key (conf ≥ 0.5) | **0 / 13** |
| Distinct keys reported across 13 tracks | **2** (C major, C minor) |
| Pairs where the octave was resolved | 54 |
| Pairs where the octave was genuinely ambiguous | 110 |
| Vocal pitch shifts applied | **0 — all 156 pairs** |
| Key relationships | `unknown` — all 156 pairs |
| Segments per plan | 1–2 |
| Full-track arrangements produced | **0 / 156** |
| Pairs needing >25% tempo warp | 44 / 156 |

**What this establishes.**

1. **The octave fix engages on real music**: 54 of 156 pairs resolved an octave
   the raw readings would have got wrong. But **110 pairs remain flagged
   ambiguous**, so on real material the ambiguity is the common case, not the
   exception. The warning is honest, but two thirds of pairs still rest on a
   warp-cost heuristic rather than musical evidence. This is the fix's limit and
   is not presented as more.
2. **Harmonic intelligence is entirely inactive on real audio.** Zero trusted
   keys ⇒ zero trusted key relationships ⇒ zero pitch shifts. Nothing is damaged
   (the safe failure), but the compatibility layer does nothing. Every pair is
   planned as if the keys were unknown, because to the engine they are.
3. **Arrangement does not happen.** 0/156 produced a full-track arrangement;
   plans fall back to 1–2 whole-body segments. Some of this is the synthesised
   section data, so it is not yet a proven arrangement defect — but the fallback
   path is what real pairs would hit whenever section or passage evidence is
   thin, and it is the least musical output the planner can produce.
4. **Tempo is the healthiest layer.** 11/13 trusted, 12/13 agreeing with
   librosa within an octave, and 112/156 pairs within ±20% so a light or no warp
   is chosen.

**Defect priority, revised by measurement.** The directive's ordering was
compatibility → tempo → key → composition → arrangement → audio quality. Real
audio moves key to the top: it is the one layer that is entirely inert, and it
blocks both harmonic compatibility and pitch decisions for every pair. Tempo
sinks below it — the octave defect is fixed and the remaining weakness is
honest. Arrangement is the next suspect but needs true section data before it
can be called broken.

**Not claimed.** These are measurements of internal decisions. They say nothing
about whether any pair sounds good, and none was heard by a human. Automated
planning success is explicitly not evidence of musical quality.

---

## 8. P1 key detection — investigation result (2026-11-14)

**Outcome: one real defect fixed (fabricated confidence). The C-bias itself is
not fixed, and the evidence says it should not be claimed as fixed. Read the
negative result before the positive one.**

### What was reproduced

The reported symptoms reproduce exactly: two distinct keys across 13 tracks,
0/13 trusted, 0/156 pitch shifts. The chroma peaks on C with a 3–5× spread.

But the pipeline is **not** simply broken. Three independent checks:

| Check | Result |
| --- | --- |
| Key by construction, realistic timbre + bass + drums, all 12 roots × major/minor | **24/24 exact** |
| Same, with harmonic rolloff from 1/h to 1/h³ (dark/muffled production) | **24/24 at every rolloff** |
| Twelve single sinusoids C4–B4 through the chroma | 12/12 correct pitch class, no bias |

So the FFT, harmonic summation, per-frame normalisation, pitch-class mapping and
Krumhansl matcher are all sound on material with real harmonic structure.

### What was investigated and rejected

Every hypothesis below was implemented and measured. None removed the bias, and
each is recorded so it is not retried:

| Hypothesis | Result |
| --- | --- |
| Sub-bass/DC contamination | Removing DC and high-passing at 60/100/150/200 Hz changed the reported key on at most 1 of 7 tracks |
| Magnitude is a 1/f artefact (each pitch class anchored at a different frequency) | Real: fundamentals C:23.3 → B:3.1 — but **whitening the local spectral level made it worse**, flattening chroma to a near-uniform 8–9% |
| Per-octave normalisation / equal octave weighting | No effect on the reported keys at default settings |
| Spectral whitening (local moving average) | Over-corrected: destroyed musical evidence, chroma variation fell to 0.03–0.09 |
| Log-magnitude compression | Fitted the C-ramp perfectly rather than removing it |
| Tuning offset (A440 deviation) | No effect |
| Analysis window / aggregation bias | Per-frame top pitch class is already C in 57–84% of frames, so it is not an averaging artefact |
| Complete-octave coverage | The existing MIDI 36–95 range is already exactly octaves 2–6, one of each pitch class per octave — there was never an incomplete-octave bug |

### The actual finding: the chroma carries almost no key evidence

Measured pitch-class variation (coefficient of variation across the 12 classes):

| Material | Variation |
| --- | --- |
| Known key, synthetic, realistic | **0.79–0.92** |
| The 13 real CC0 tracks | **0.03–0.09** |

The real recordings produce a nearly uniform chroma. The reported key is
therefore not a mis-read of a real key — it is the matcher picking the least-bad
fit from noise-like input. Recovering the real key is not a bias-correction
problem; the pitch-class evidence is not there to recover.

**The independent comparison agrees.** librosa's CQT chroma on the same files
correlates with ours at **−0.28 to 0.19** and reports "A" for 13/13. That looked
like a reference finding a real key until high-passing at 150 Hz made librosa go
flat too (A:11, A#:9, B:9). librosa's confidence on this corpus is therefore the
same artefact from the other end of the spectrum: one low-frequency peak
dominating every track. **Neither engine has trustworthy key evidence here, so
these files cannot serve as a key-accuracy benchmark** — the "0/13 vs librosa"
figure in section 7 measured agreement between two unreliable estimators and
must not be used as an accuracy score.

### The defect that is real: fabricated confidence

Profile correlation is scale-free, so a near-uniform chroma still correlates
well with *some* key and reported high confidence. Measured before the fix, the
**least** key-like track in the corpus (variation 0.036) reported the
equal-highest confidence of **0.77**, while the most key-like (0.090) reported
0.19. Confidence was uncorrelated with evidence, and several tracks would have
cleared the 0.5 trust threshold and caused a wrong automatic transposition.

Fixed by gating confidence on the pitch-class evidence present, so that a chroma
without structure cannot buy confidence through a lucky profile fit. Measured
after: real tracks 0.04–0.31 (**0/13 trusted**, unchanged coverage, so no
transposition — the safe behaviour), while known-key material is unaffected at
0.40–0.92 with keys still 24/24 exact.

This is a genuine improvement — it removes fabricated confidence and prevents a
wrong transposition — but it does **not** improve key *accuracy*, which is
unchanged because the evidence is unchanged.

### Where the real key evidence would have to come from

The remaining gap is the chroma itself, and the corpus points at why: the mean
spectrum of every track peaks at 54 Hz (near A1) with 40–53% of energy below
60 Hz, on material that is otherwise dense and percussive. That is sub-bass and
broadband content swamping pitch salience, not a matcher error. Fixing it needs
a salience method that is robust to that (e.g. a proper constant-Q transform with
per-band normalisation, or a spectral-peak-picking front end with
inharmonicity rejection) — a substantial DSP project that was **not** attempted
here, because the current corpus cannot validate it: every reference available
is itself unreliable on these files.

### Honest status

- **Fixed:** fabricated key confidence. Mutation-checked; three new tests.
- **Not fixed:** key accuracy on real broadband material. Unchanged.
- **Blocked:** validating a fix needs a corpus with *independently verified*
  keys. The CC0 set has none (its README table disagrees with both engines), and
  neither engine can serve as its own reference.
- **Unchanged and correct:** automatic transposition stays withheld. 0/13 keys
  are trusted, so the planner applies no pitch shift — no damage, no false
  confidence.

No STEM.FM comparison is made. Listener count is N=0.
