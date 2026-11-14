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

---

## 9. Validation corpus + generation resilience (2026-11-14)

Two deliverables this pass: the corpus infrastructure the previous milestone was
blocked on, and the resilience guarantee that stops key detection blocking the
parity milestone.

### 9.1 The corpus that is reachable, and the one that is not

**Environment limit, verified.** This sandbox reaches `github.com`, `api.github.com`,
`codeload.github.com`, `pypi.org` and `registry.npmjs.org` only. Zenodo,
HuggingFace, archive.org, FMA, sigsep.github.io, medleydb and every other audio
or dataset host return `000` (connection refused). So **no annotated audio
dataset can be downloaded here**, and the *audio* half of this milestone cannot be
completed by the agent alone. That is a hard environmental constraint, not a
choice.

**What was obtained instead: 604 independently annotated keys, with no audio.**

| Property | Value |
| --- | --- |
| Source | GiantSteps key dataset (Knees et al., ISMIR 2015) |
| Tracks | **604** |
| Distinct key classes | **24 / 24** — every major and minor |
| Missing classes | **none** |
| Label method | professional annotation correcting automated estimates |
| Annotation distribution | 511 minor / 93 major; F minor 73 … C# major 1 |
| Modulating tracks | 0 (each preview carries one label) |
| Audio | **not included, by design** |

`scripts/waveyard-key-corpus-annotations.ts` scrapes the annotations to a pinned
commit into the git-ignored `generated-artifacts/waveyard-key-annotations/`. A
parser bug initially dropped 78 tracks (78 unparsed, and C#/F# missing): the
dataset spells those keys enharmonically as `Db`/`Bb`/`Eb`, and the first version
mangled the flat sign. Fixed with a proper enharmonic map — now 604/604 parse and
all 24 classes are present.

**Why the audio is absent and will stay absent.** The dataset ships 2-minute
Beatport previews of commercial releases. Committing or redistributing that audio
breaches Beatport's terms and the dataset's own licence. The repo therefore holds
annotations only, and the audio is a local, user-supplied input. This is the same
rule the earlier CC0 corpus respected, for the same reason.

**The evaluation harness refuses to fake a score.**
`scripts/waveyard-key-evaluation.ts` has two explicit states. Without audio it
prints `scored: false` with a reason and the statement *"an accuracy figure
without audio would be fabricated"*. With audio it reports exact accuracy,
relative major/minor confusion, perfect-fifth confusion, a pitch-class confusion
matrix, confidence calibration (mean confidence on correct vs incorrect), and
trusted-coverage accuracy.

*Scoring path verified end to end* by generating 24 audio files with keys known by
construction, named with real annotation track IDs: result **24/24 exact, 20/24
trusted, trusted accuracy 1.0, relative confusion 0, fifth confusion 0**. That
proves the harness measures what it claims. It is **not** a key-detection accuracy
result — the audio was synthesised, so it is the same evidence class as the
existing synthetic tests and must not be reported as real-music performance.

### 9.2 Generation resilience — measured on real audio

The strategic risk was that a missing key quietly degrades generation. It does
not. Three real CC0 beds (full 44.1 kHz stereo) mashed with a pitched vocal line,
with both keys forced below the trust threshold — the exact real-world condition:

| measure | result |
| --- | --- |
| plans refused | 0 / 3 |
| output length | 60.0 s each — complete |
| peak sample | 0.84 (all three) |
| clipped samples | **0** |
| transposition | withheld, 0 semitones, and explained in the warnings |

So a missing key costs the transposition and nothing else: the render is complete,
level-safe and honest about why it made no pitch move. This is the "a missing key
estimate must not mean a missing mashup" requirement, now pinned by two
regression tests (a complete non-clipping render with untrusted keys, and the
distinction between *key analysis missing* and *key confidence too low*).

### 9.3 Status against the requested milestone

| Requested | Status |
| --- | --- |
| Build a defensible evaluation corpus | **done for annotations** (604 tracks, 24/24 classes); **blocked for audio** by the network limit |
| Validate key detection against it | **blocked** — needs audio only the user can supply |
| Improve harmonic analysis only where measurable | **not attempted** — nothing measurable until the corpus has audio, which is the honest answer rather than another unvalidated DSP change |
| Generation remains useful without key confidence | **done and measured** — section 9.2 |
| Test complete outputs with actual listening | **not done** — N=0. Needs either the user to listen, or an audio deliverable the user can play |

Still open: listener count is N=0 everywhere; no STEM.FM comparison is made; the
key-accuracy defect from section 8 is unchanged.

## 10. Listening pack — real mashups you can actually play (2026-11-14)

The owner's directive superseded the key-detection order: stop building
infrastructure around a dataset that cannot be accessed, and produce a small
reproducible pack of real outputs plus a separate human-assessment record. This
section is that pack and its honest limits. **No claim of musical quality is
made here. N = 0 listeners.**

### 10.1 What was blocked, and what unblocked it

Every annotated-audio dataset (Zenodo, SIGSEP MUS, MedleyDB, MoisesDB,
Mixing Secrets, Beatport previews) is unreachable from this environment — the
network allowlist is GitHub/PyPI/npm only, verified with 000 responses. So the
pack does not use a benchmark corpus. It uses two **licensed, reachable** sources:

| Role | Source | Licence | Verification |
|---|---|---|---|
| Vocals | `MTG/turkish-makam-acapella-sections-dataset` | **CC BY 4.0** | `LICENSE` read directly; attribution embedded in both manifests |
| Beds | `farmmer938-lgtm/aeris-cc0-music`, 13 tracks | **CC0 1.0** | licence file verified earlier |

100 a-cappella sections, 375 MB. Because the singing is *unaccompanied*, the
vocal side is genuinely isolated without running a separation model. **No
separation stage ran in any render here** — the inputs are pre-separated, and
both manifests say so. Separation models are not obtainable in this environment
(`onnxruntime-node` is installed but no weights can be downloaded).

Only downloadable via `git clone --depth 1 --filter=blob:none --sparse` +
`git sparse-checkout set goekhan idil`. The `contents` API, `download_url` and
`curl` all returned nothing for the large WAVs.

### 10.2 The finding that matters: the first pack was not synced

`scripts/waveyard-listening-pack.ts` renders 10 pairs labelled by condition
(similar tempo, different tempo, long vocal, full-song vocal, uncertain tempo,
different style, slow bed, lo-fi bed, dense bed, leftover pair). All 10 rendered
complete, peak 0.88–0.911, **0 clipped samples**, RMS −13.3 … −17.4 dB, 57–104 s.

But **every one used `stretch × 1.000` and pitch 0**. Nothing was synced.

This is *not* a bug. Rubato a-cappella singing yields `bpmConfidence`
0.132–0.245, far below the 0.5 gate, so the planner withheld stretching on every
pair — exactly the fail-safe behaviour the previous milestone pinned as a
regression test. It is correct, and it means pack v1 demonstrates **honesty, not
mashup competence**. Lowering the 0.5 threshold to make the pack *look* synced
would have been the wrong fix and was not done.

### 10.3 Pack v2 — declared evidence, for listening only

To let a human judge arrangement, transitions and rhythmic stability at all, the
sync has to be exercised. `scripts/waveyard-listening-pack-synced.ts` supplies
**tempo (and in two cases key) confidence as declared input** and leaves
everything else to production code: stretching, beat grids, entry placement,
arrangement, pitch decisions and the mix bus are untouched.

| Case | Sources | Declared | Result | Peak | Clipped |
|---|---|---|---|---|---|
| 11-synced-close | Gel_2_zemin / horizon-monolith | 100 vs 112 BPM | ×0.893 | 0.911 | 0 |
| 12-synced-half-time | Gel_4_nakarat / ash | 70 vs 140 BPM | **×1.000** (half-time lock) | 0.911 | 0 |
| 13-synced-large-warp | Hicran_Part1 / overdrive | 96 vs 128 BPM | ×0.750 | 0.911 | 0 |
| 14-control-dry | Gel_2_zemin / horizon-monolith | **real** analysis | ×1.000 (withheld) | 0.883 | 0 |
| 15-hostile-untrusted-keys | Gel_6_meyan / quiet-room | 92 vs 84 BPM, keys 3 st apart | ×1.095, **0 st** | 0.911 | 0 |

Every ratio matches the intended arithmetic exactly (100/112 = 0.893, 96/128 =
0.750, 92/84 = 1.095). 12 correctly resolves 70/140 as a **half-time lock rather
than halving the vocal**. 15 confirms that keys 3 semitones apart with untrusted
evidence still produce **0 semitones** of pitch move. `14-control-dry` is the
same pair as case 11 with the real confidence, so the cost of *not* syncing is
audible A/B.

Two bugs in the harness were found and fixed while doing this, and both were
real rather than cosmetic:

1. `bpmCandidates` was taken from the *measured* analysis while the declared BPM
   said something else, so the planner's (correct) octave resolution silently
   overrode the case under test — 11 and 13 both collapsed to ×0.920. Candidates
   now derive from the declared tempo.
2. `mix.limiterApplied` does not exist; the field is `mix.limiter.applied`. The
   manifest had been writing `undefined` for every entry.

The stretch claim itself was then verified independently of the plan object:
`timeStretch` at 0.893/0.75/1.095 turns 4.000 s into 3.572/3.000/4.380 s and
**holds the 440 Hz fundamental at 440 Hz**, so the rationale's "pitch preserved
by WSOLA" is true rather than assumed.

### 10.4 The biggest weakness visible in the measurements

> **Corrected in section 11.0.** The coverage figures below came from 10–20 s
> extracted sections, not complete performances, so they describe the inputs
> rather than the engine. Measured on a genuinely complete 214.2 s vocal the
> engine reaches 91 %. The paragraph is kept for the record; the conclusion
> drawn from it at the time was not supported.

Vocal coverage is low. In three of the five synced cases the vocal is audible for
only **13–21 % of the runtime** — 9.9 s of 68.6 s in case 11. Case 13 (a
214 s full-song vocal) reaches 91 %. A 69 s bed with a 10 s vocal cameo is a
different musical object from a duet, and no amount of correct bar arithmetic
fixes that; it is an arrangement-selection problem, and it is the single most
likely reason a listener would rate these poorly.

Mix balance is also weaker than it looks. `planMashupBalance` measures
**whole source files**, not the placed material, so a vocal that plays on 14 % of
the timeline is balanced as if it filled the track. The correction hit the
**±6 dB clamp in 6 of the 15 rendered cases**, which the bus itself reports as
"this pair needs a different arrangement, not a bigger gain". This is a known,
documented limitation of the measurement window, not a new bug — but it means
the manifests' gain numbers are not evidence that the finished mix is balanced.

### 10.5 Human assessment, kept strictly separate

`docs/waveyard-listening-assessment-sheet.md` is the blank record: five
dimensions (arrangement, vocal clarity, transitions, rhythmic stability, audio
quality) plus free text. It is **deliberately empty**. The measurement context is
placed *after* the listening instructions, and the sheet says not to read the
manifests first, because knowing the stretch ratio biases the ear.

The owner asked for **the five biggest musical weaknesses**, not a score. The
sheet instructs collecting the free-text "biggest single weakness" lines and
counting them, rather than averaging ratings and calling that a finding.

### 10.6 What this does and does not establish

| Claim | Status |
|---|---|
| 15 complete mashup renders exist and are playable | **done** — 188 MB in `generated-artifacts/listening-pack/`, git-ignored |
| Tempo stretching works and preserves pitch | **done and measured** — arithmetic exact, 440 Hz verified |
| The planner refuses to fabricate sync from untrusted evidence | **done** — 10/10 withheld, by design |
| Half-time locks instead of halving the vocal | **done** — case 12 |
| Untrusted keys never trigger a pitch move | **done** — case 15 |
| The mixes are good | **unknown — N = 0 listeners** |
| Waveyard matches STEM.FM | **not claimed, no comparison made** |
| Works on arbitrary songs | **not claimed** — 2 small, stylistically narrow corpora |
| Separation is exercised | **no** — inputs are pre-separated, models unobtainable |

Reproduce with:

```
ARENA_FFMPEG_PATH=<ffmpeg> tsx scripts/waveyard-listening-pack.ts \
  --vocals generated-artifacts/listening-pack-inputs/vocals \
  --beds generated-artifacts/waveyard-real-audio \
  --out generated-artifacts/listening-pack
# and the same flags with scripts/waveyard-listening-pack-synced.ts
```

Both manifests are git-ignored along with the audio: the pack is reproducible
from the scripts and the two licensed sources, and 188 MB of WAVs does not
belong in Git.

Regression suites after these changes: mashup 46, mix-bus 13, regression 8,
donor-integrity 18, full-length 4, peak-limiter 8, analysis-confidence 4 — all
pass, 0 fail. `analysis-engine` 28 pass / 1 fail, the pre-existing bundled-ffmpeg
decode test. Both pack scripts and the two key scripts typecheck under a config
that was verified to reject a deliberate type error.

## 11. STEM.FM Full Length + Adaptive Stem Swap Parity — milestone definition (2026-11-14)

The owner redefined the target. This section defines the milestone in **observable
behaviours** and records what was measured before any code changed.

### 11.0 Correction accepted: section 10.4 overreached

Section 10.4 reported 13–21 % vocal coverage and called it "the biggest weakness".
**That conclusion was not supported.** Those figures came from 10–20 s extracted
sections, not from complete song-length stems. Measuring a 10 s section against a
104 s bed can only produce ~10 % coverage — that describes the input, not the
engine. The correction is recorded here rather than quietly deleted.

Measured on a genuinely complete 214.2 s vocal (`02_Kimseye.wav`) the engine
reaches **91 % coverage**, not 21 %. The engine is not truncating by default.

### 11.1 Corpus limit that blocks the primary spec case

The owner's primary example is *vocal shorter than instrumental → loop the vocal
from its beginning*. **That case cannot be built from real audio in this
environment.** The only complete performance available is 214.2 s; every CC0 bed
is ≤ 103.8 s. The inverse case (vocal longer than bed) is what the corpus can
actually exercise. Constructing the shorter-vocal case would require a complete
vocal shorter than the bed, i.e. a different corpus. Stated so the gap is not
mistaken for a passing test.

### 11.2 Defect A — the vocal ending is not preserved when the bed outlasts it

Measured, 19.9 s vocal over a 103.8 s bed:

```
seg0 timeline   8.9 -  28.8s | source 0.0 - 19.9s   (the complete body)
seg1 timeline  51.5 -  53.1s | source 18.3 - 19.9s   (a 1.6s tail echo)
COVERAGE 21.5s of 103.8s = 21%
```

The second placement re-uses only the **last 1.6 s** of the performance. That is
the existing `chooseGroundedReprise` closing-echo design, which deliberately
avoids replaying the opening ("never replay the identical window"). The owner's
spec requires the opposite: **repeat the complete vocal from its beginning at a
suitable musical boundary.** The failure is not that a loop is missing — it is
that the loop takes the wrong material and is far too short to be a loop at all.
81 s of bed runs with no vocal over a corpus where the vocal is complete.

### 11.3 Defect B — a segment can claim more source than the timeline can hold

Measured, 214.2 s vocal over a 103.8 s bed:

```
seg0 timeline  8.9 - 103.8s  (94.9s on the timeline) | source 0.0 - 214.2s
```

The segment declares 214.2 s of source in 94.9 s of timeline at `stretch × 1.000`.
That is internally inconsistent — either the stretch is unreported or the source
range is. The *audible* result is acceptable (the vocal plays 94.9 s and fades at
the bed's end, and the renderer clamps to the timeline), but the plan object
cannot be trusted as a description of the output, and any consumer reading
`vocalsToMs` would compute the wrong thing. This matters directly for defect A:
a loop built on top of these ranges would inherit the inconsistency.

### 11.4 Defect C — stem swaps do not reach the planner (requirement 2)

This is the structural finding, and it is the one the owner called "arguably more
important". In `artifacts/api-server/src/imported/waveyard/projects/[id]/mashup/route.ts`:

| Line | Action |
|---|---|
| 1167 | `planMashup(vocals, bed, …)` — **plan is decided here** |
| 1551 | `resolveStemComposition(...)` — replacement/layer decided here |
| 1558 | `loadInstrumentalBed(..., replacedBedStemTypes)` — replacement bed loaded here |
| 1588 | `renderMashupWithBus(planned.plan, …)` — new audio substituted under the old plan |

The arrangement is planned against the **original** bed, and a replacement stem is
loaded **afterwards** and dropped into a plan that was never recomputed. Beat grid,
entry point, bars, `masterBpm`, passage ranking and the vocal's phrase placement
are all inherited from the pre-swap analysis. Requirement 2 asks for the opposite:
the swapped stem must become the new input to planning.

This is exactly "insert new drums into the existing arrangement" rather than
"reconsider whether the bass still complements the drums".

### 11.5 Acceptance criteria — observable behaviours

Each criterion is stated so it can be settled by measuring the plan object or by
listening. No criterion is a claim of quality, and none may be satisfied by a
synthetic fixture alone.

**Full Length mode**

| # | Criterion | How it is observed |
|---|---|---|
| FL-1 | When the vocal is shorter than the bed, the **complete** vocal is placed, not a fragment | sum of distinct source ranges spans ≥ 95 % of the vocal body |
| FL-2 | The performance **starts at its natural beginning** | first segment `vocalsFromMs` is the body start, not a later passage |
| FL-3 | The performance **ends at its natural ending** | some segment reaches the body end and is not cut by the bed's end |
| FL-4 | When the bed outlasts the vocal, the vocal is **looped from its beginning** at a bar boundary | a later segment repeats the body start; loop count ≥ 1 when room allows |
| FL-5 | A loop is **never forced** when it would produce an awkward transition | no loop shorter than a minimum musical unit; a disclosed warning instead of a broken edit |
| FL-6 | Stretching preserves the vocal's duration faithfully | `stretch × 1.0` ⇒ source span ≈ timeline span (defect B invariant) |
| FL-7 | The bed finishes naturally | render length equals bed length; no vocal tail cut mid-phrase |

**Adaptive stem swap**

| # | Criterion | How it is observed |
|---|---|---|
| AS-1 | A stem swap **re-plans** the arrangement against the new stem | planned `masterBpm`/entry/bars derived from post-swap analysis, not pre-swap |
| AS-2 | A swapped drum stem's beat grid **drives** the vocal placement | vocal entry tracks the new grid |
| AS-3 | Gains are **re-measured** after the swap | mix-bus balance computed post-swap |
| AS-4 | The render is reproducible and honest when re-planning is not possible | disclosed refusal, never a silent substitution |
| AS-5 | Existing replace/layer distinction is preserved | no merge of the two operations |

### 11.6 What this milestone is not

Not a new philosophy of mashup creation, per the owner. Not an AI critic, not
autonomous refinement, not preference learning. It is two engineering behaviours
plus the tests that pin them.

### 11.7 Full Length mode — implemented and measured

A `full-length` alignment strategy now exists. It is reachable through the
existing route with no contract change, because the route validates against
`MASHUP_ALIGNMENT_CANDIDATES` and the new id is in that list.

**What it does.** Places the complete vocal body once, then repeats *that same
complete body from its beginning* — bar-aligned from the entry's phase, not from
zero — while the bed has room for at least one full pass. Only complete passes are
placed; a partial pass would cut the performance mid-phrase, which is the awkward
transition FL-5 forbids, so the bed finishes naturally instead and the reason is
recorded.

**Measured on real audio** (19.9 s vocal over a 103.8 s bed, identical inputs):

| Strategy | Segments | Vocal coverage | Length | Peak | Clipped |
|---|---|---|---|---|---|
| `phrase-aware` (before) | 2 | 21.5 s = **21 %** | 103.8 s | 0.902 | 0 |
| `full-length` (after) | 4 | 79.5 s = **77 %** | 103.8 s | 0.911 | 0 |

Also measured on a second pair, 21.3 s vocal over an 87.3 s bed: **73 %** coverage,
3 passes, ending preserved. Coverage rose because the loop is now the whole
performance rather than a 1.6 s closing echo.

**Defect B fixed for this mode only.** In `full-length`, a segment's declared source
range is clamped to what its timeline can carry at the planned ratio, so
`vocalsToMs` describes what is actually rendered. The clamp is deliberately **not**
applied to the other strategies: they intentionally declare the selected source
window and disclose bed-end truncation in a warning, which their own tests pin.
Applying it globally broke three existing tests — including a real `RangeError`
where clamping desynchronised a WSOLA time map from the audio buffers — so the
invariant was scoped rather than forced.

**Ten regression tests** in `mashup-full-length-mode.test.ts` cover FL-1…FL-6 and
the honesty case. Each was confirmed to fail when its fix is disabled: neutralising
the loop planner fails 2 tests, neutralising the clamp fails the FL-6 test.

### 11.8 Requirement 2 (adaptive stem swap) — diagnosed, NOT implemented

No fix is claimed. The defect in 11.4 stands as written. The change needed is a
route restructure, not a planner tweak:

1. resolve the stem composition **before** loading the source profiles, so the bed
   profile is built from the post-swap stems rather than the original mix;
2. re-analyse the replacement bed's beat grid and re-derive `masterBpm` from it;
3. then plan, so entry, bars and phrase placement follow the new grid (AS-1/AS-2);
4. the mix bus already re-measures balance per render, so AS-3 follows once 1–3
   are in place.

This touches `artifacts/api-server/src/imported/waveyard/projects/[id]/mashup/route.ts`
and the PostgreSQL-backed acceptance test, and was not attempted here rather than
landed unverified. AS-1…AS-5 remain open acceptance criteria.

### 11.9 Corpus gap (unchanged)

The primary spec case — a complete vocal *shorter* than the bed — still cannot be
built from real audio in this environment (11.1). The loop behaviour is therefore
verified on real audio only through extracted 20 s sections plus synthetic
complete-pass fixtures. That is a real limit on the evidence, not a formality.

## 12. Adaptive Stem Swap Parity — implemented (2026-11-14)

The owner assigned this as the next milestone and said it is "the difference
between a mashup generator that swaps audio files and one that actually
understands that changing a musical part changes the mix". This section records
what changed, what is proven, and what still is not.

### 12.0 Full Length was reachable but not selectable — the owner's check was right

The owner asked to verify that choosing Full Length in the UI actually invokes
the new strategy, noting "being reachable through an API does not necessarily mean
the interface uses it". That suspicion was correct, and the defect was real:

| Layer | State before |
|---|---|
| Planner `MASHUP_ALIGNMENT_CANDIDATES` | contained `full-length` |
| Route validation | accepted `full-length` |
| `CandidateAlignmentLab.tsx` | **hardcoded union omitting `full-length`** |
| `MashupStudio.tsx` auto-select list | **`["phrase-aware","paired-grid","downbeat","continuous"]`, no `full-length`** |
| Any UI control offering Full Length | **none existed** |

So the strategy could be requested over HTTP and could never be chosen in the
product. Two fixes:

1. `CandidateAlignmentId` is now **derived from `MASHUP_ALIGNMENT_CANDIDATES`**
   rather than a hand-written union, so the UI cannot drift out of sync with the
   planner again.
2. An explicit **Arrangement mode** selector offers Full Length first. The chosen
   mode is honoured when candidates are planned; if Full Length is genuinely
   unavailable for a pair the UI says so and names the reason and the fallback,
   instead of silently using a different strategy.
3. A composition change (stem swap) does not reset the mode — the user's
   arrangement intent survives the swap, per the owner's "preserve the user's
   selected Full Length arrangement mode".

### 12.1 The pipeline order was the bug — now corrected

The owner asked for this exact order: resolve composition → load retained and
replacement stems → construct the resulting composition → analyse it →
recalculate evidence → plan → render → persist → reproduce. The route now does
that.

**Before:** `planMashup(vocals, bed)` ran against the original bed at line 1167;
`resolveStemComposition` ran at 1551 and `loadInstrumentalBed(..., replaced)`
at 1558, so a replacement was substituted underneath a plan that was never
recomputed.

**After:** composition resolution and composition-derived analysis happen
**before** `planMashup` for `compare`, `plan`, `render` and `save`. The replace
path loads the composed bed and re-measures tempo, key, beat grid, downbeats and
duration from the **summed retained-plus-replacement stems**.
`loadInstrumentalBed` already sums retained stems while omitting the replaced
roles, so its PCM *is* the resulting composition — the replacement is never
analysed in isolation, which is exactly the distinction the owner drew.

The render path now **reuses** that pre-plan composition instead of resolving a
second time. Resolving twice would have reintroduced the same class of bug: the
render could use a different composition than the plan was built for.

### 12.2 What is recomputed vs preserved

Per "recompute what is affected and preserve what remains valid":

| Evidence | After a replacement |
|---|---|
| Tempo (`bpm`, confidence, candidates) | **re-measured** from the composition |
| Beat grid, downbeat grid | **re-measured**; the old grid is kept only when the new measurement is empty, and then labelled unverified |
| Key | **re-measured** |
| Duration | **re-measured** from the composed PCM |
| Sections, harmony events | preserved (not changed by a role swap) |
| Retained stems | untouched; only the replaced role is omitted |

Honest fallback: if the composed bed cannot be loaded or analysed, the original
profile is kept **with an explicit warning that the timing is unverified** — the
route does not fabricate a grid, and does not silently claim recomposition.

### 12.3 Provenance is observable, not inferred

The route now reports which analysis drove planning, so a test can prove the
order rather than infer it from audio after the fact:

- `x-waveyard-planned-against: composition | original-bed`
- `x-waveyard-planned-bpm`, `x-waveyard-planned-beat-grid-points`
- `plan` responses carry `plannedAgainst`
- `save` responses carry `plannedAgainst` and `replacedBedStemTypes`

### 12.4 Acceptance tests — and the one that initially proved nothing

Seven route-level acceptance criteria are asserted against real handler output in
`route.test.ts`, including: the replacement reaches the planner before planning;
composition-derived analysis supplies tempo and a beat grid; planning **without**
a replacement still reports `original-bed` (otherwise the header proves nothing);
retained stems survive; replaced stems are not duplicated; unhonourable
replacements fail closed; and the persisted plan records that it was planned
against the composition, in both the `plan` action and the saved snapshot.

**A first attempt at these tests passed even with the old behaviour.** They only
asserted response headers describing the composition, which the old code also
produced — the swap changed the audio but the assertions never touched *which
analysis the planner used*. The provenance headers were added specifically to
close that hole. The tests were then re-run against a deliberately reverted route
(`plannedAgainstComposition` disabled) and **failed**, confirming they detect the
real defect. This is recorded because a test that passes against the bug is worse
than no test.

Save/reopen/export parity was already covered by the existing test and still
passes: the saved bed has drums, bass and other minus the replaced role, the
donor's drum stem is a real clip at the renderer's source offset and timeline
position, bed drums do not return on reopen, and the persisted snapshot records
the composition.

### 12.5 What is still not proven

| Claim | Status |
|---|---|
| A replacement re-plans against the resulting composition | **proven** — provenance headers + audio assertions |
| Old plan is not reused | **proven** — `plan` action re-plans against composition |
| Retained stems intact, replacements not duplicated | **proven** |
| Honest fallback when audio/analysis is unavailable | **proven** — fail-closed plus labelled unverified grid |
| Save/reopen/export preserve the composition | **proven** — existing test still green |
| The result *sounds* better than substituting after planning | **unknown — N = 0 listeners.** No audio was rendered for listening in this milestone. |
| Works on real separated stems | **not yet** — acceptance ran on synthetic tone fixtures and the PG harness. The real-audio path runs only when `WAVEYARD_MASHUP_REAL_FIXTURE_MANIFEST` is supplied, which is not available here. |
| STEM.FM parity | **not claimed** — no comparative output evidence exists |

The owner asked for real-audio tests "wherever the available licensed material
permits". The licensed material is a-cappella vocals plus CC0 instrumental beds,
which arrive **pre-separated and without per-role stem sets** for a bed. A real
stem swap needs a bed whose drums/bass/other exist as separate licensed stems;
that data is not downloadable in this environment (same constraint as section 11.1).
This is a genuine evidence gap and is recorded rather than papered over.

### 12.6 Regression

mashup 46/46, full-length-mode 10/10, full-length 4/4, regression 8/8, mix-bus
13/13, donor-stem-integrity 18/18, peak-limiter 8/8, analysis-confidence 4/4,
PG route acceptance 1/1 (0 skipped, includes the new swap assertions).
`analysis-engine` 28/29, the pre-existing bundled-ffmpeg decode failure.
Monorepo `tsc --build --force` clean.

## 13. Real-audio validation (2026-11-14)

The owner's instruction: establish whether the mechanics produce music that
sounds intentional. This section records what was validated on real audio, what
could not be, and the exact reason in each case.

### 13.1 Git check (requested)

`8cf14cf` is on `arena/669984d8-arena-os-canonical`, which is the head of PR #31.
Zero divergence against origin. No competing agent has started real-audio
validation: the only similar-titled open work is PR #27 (Nov 6, branch
`arena/ed2f88f7-…`) which touches `mashup.ts` and a regression test file and is
on a different lineage — it was inspected and does not contain stem fixtures.

### 13.2 The Studio interaction check the owner asked for — it found a second defect

The owner said typechecking and route tests do not prove the complete UI
interaction, and asked for a manual verification that selecting Full Length in
the Studio keeps the selector on Full Length and still reports that strategy.

Rather than assert this by inspection, `scripts/verify-full-length-ui.ts` renders
the **unmodified** `MashupStudio` component in jsdom and drives it with real DOM
events (select the mode, compare, render the candidate, save), asserting on the
fetch bodies the component actually sends.

**First run: 7/8.** The failure was real: `arrangementMode` influenced only the
plan preview, while initial candidate selection still ran off a hardcoded
preference list. A user who chose Full Length and pressed Compare got
phrase-aware anyway — the same defect class as the original, one layer deeper.

My own first version of the test **missed it**, because it explicitly re-selected
Full Length after comparing and so never exercised the auto-select path. That is
recorded because it is the same trap as section 12.4.

Fixed by defaulting `arrangementMode` to `full-length` and making the
auto-select path honour the chosen mode. The decisive check is *"with no manual
selection, comparing lands on Full Length by default"*; it was verified to FAIL
with the preference disabled (10/11) and pass when restored (**11/11**).

### 13.3 Full Length looping, on real audio

This was the owner's outstanding evidence gap: "the critical case of a complete
vocal shorter than its instrumental".

The corpus cannot supply that directly — one complete vocal (214.2 s) and every
CC0 bed ≤ 103.8 s — so the bed is made genuinely longer using Waveyard's own
`planSongExtension`/`renderSongExtension` (bar-aligned repeats of a measured
section). That is a real feature output, not a fabricated length.

Measured, real audio, 103.6 s complete a-cappella performance over a 227.4 s
instrumental:

| Render | Segments | Passes | Timeline | Source | Coverage |
|---|---|---|---|---|---|
| `01-full-length-looped` | 2 | **2 complete** | 18.6–122.2 s, **122.6–226.3 s** | 0.0–103.6 s **both** | 91 % |
| `02-full-length-unextended` | 1 | 1 | 8.9–103.8 s | 0.0–94.9 s | 91 % |

Both passes start at **0.0 s**, so the loop restarts at the performance's
beginning rather than echoing its tail. The second pass was verified to carry
audio rather than silence: RMS 0.1938 in pass 1 versus **0.1895** in pass 2, with
0.1256 between passes (bed only). 0 clipped samples, peak 0.911.

Before this milestone the second pass did not exist at all.

### 13.4 Composition-first planning, on real audio

Three further renders build a *different resulting composition* from the real
bed, re-analyse that composition, and only then plan — the corrected order:

- `03-swap-drum-context` (drum band reduced to 35 %, bass retained)
- `04-swap-bass-context` (bass band reduced to 30 %, drums retained)
- `05-original-composition` (control, same vocal and strategy, unswapped)

All render completely, 0 clipped. `04` peaks at 0.685 versus 0.911 for the others
because removing the bass band removes most of the low-frequency energy — a real,
measurable difference in the resulting mix.

### 13.5 What this does NOT establish

| Claim | Status |
|---|---|
| Full Length loops the complete performance from its beginning on real audio | **proven** — 2 passes, both from 0.0 s, audible |
| Planning follows the resulting composition | **proven for ordering** — renders 03/04 differ measurably |
| Real stem-swap with separated drums/bass/other stems | **NOT DONE — no licensed multitrack obtainable** |
| That any of it sounds intentional | **UNKNOWN — N = 0 listeners** |
| STEM.FM parity | **not claimed** |

The multitrack gap was closed by exhaustive search, not assumption. Every avenue
was tested and failed:

- **Git LFS is unusable**: `github-cloud.s3.amazonaws.com` and `lfs.github.com`
  both return 000. Every promising repo (`0x3lau/deep-house-techno`,
  `wigglytendrils/yfree`, `mikeng-io/nora`, `ankita-m-john/Pitch-Perfect`,
  `ken-arthur005/annie`, `Creative-AI-Research-Group/dream_app`) stores its audio
  as 132-byte LFS pointers.
- **Separation weights are unbuildable**: `dl.fbaipublicfiles.com`,
  `huggingface.co` and `cdn-lfs.huggingface.co` all return 000; the demucs pypi
  wheel is 100 KB and the npm wrappers ship no weights.
- **GitHub Releases remain impossible**: `uploads.github.com` and
  `objects.githubusercontent.com` return 000.
- **Playwright browsers are undownloadable**: `playwright.azureedge.net` and
  `cdn.playwright.dev` return 000, which is why the UI check uses jsdom.

So the swap renders are labelled honestly in their own manifest: the differing
composition is produced by a crossover filter, not a separation model. They
validate the planning *order* and produce an audible result; they are not
evidence of demucs-quality separation, and the manifest says so on the page a
listener sees before pressing play.

### 13.6 Deliverables

`docs/real-audio-validation/` — five MP3s (192 kbps), `manifest.json` with full
plan provenance per render, `index.html` player, and the assessment sheet. Served
with byte-range support so iOS Safari can play and seek. Lossless WAVs stay in
`generated-artifacts/` (git-ignored, 160 MB).

### 13.7 Regression

Studio UI harness 11/11 (10/11 when the fix is reverted). PG route acceptance
1/1, 0 skipped. mashup 46, full-length-mode 10, full-length 4, regression 8,
mix-bus 13, donor-integrity 18, peak-limiter 8, analysis-confidence 4.
`analysis-engine` 28/29 (pre-existing ffmpeg failure). arenaforge and
repo-wide `tsc --build --force` clean.
