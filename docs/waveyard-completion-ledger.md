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
100 BPM bed yields a ratio of **0.692** where the truth is **1.389** — a 50%
error, i.e. the vocal plays at half the intended speed against the bed:

| bed | vocal | true ratio | planned ratio | error |
| --- | --- | --- | --- | --- |
| 72 | 100 | 1.389 | 0.692 | 50.2% |
| 60 | 100 | 1.667 | 0.827 | 50.4% |
| 68 | 92 | 1.353 | 0.679 | 49.8% |
| 90 | 128 | 1.422 | 0.725 | 49.0% |
| 85 | 100 | 1.176 | 1.173 | 0.3% |

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
| Tempo estimation / octave | **fails on real music** | measured above; 50% stretch error, confidence 1.0 |
| Key detection | **works** | 7/7 synthetic progressions correct (C, Dm, G, Am, F, Em, B), confidence 0.87–0.97 |
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
