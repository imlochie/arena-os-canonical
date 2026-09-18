# Reasoning lab 002 — taste claims on trial (design phase; executable phase pending seam)

> **Date:** 2026-09-19 (phase 0 — trap design) · **Status:** design
> complete, execution gated · **Adversarial basis:** the Gen-1/Gen-2
> epistemic split proven in
> `docs/personalisation-vocabulary-provenance-reconciliation.md` ·
> **Code changes:** none — this lab authors no implementation. Its
> executable artifacts (fixtures, mock states, contract tests, prompt
> rules, bench runs) land **with the seventh-read seam**, per the locked
> decision chain (reconciliation doc §7, D1).
>
> **Central question:** *Can Arena distinguish what happened, what the
> archive knows happened, and what might be inferred from what happened?*

```
Library truth          Usage truth
(what exists)          (what happened)
       │                     │
       ├─ FACT ──────────────┤
       ├─ OBSERVED SIGNAL ───┤
       ├─ TEMPORAL SIGNAL ───┤
       ├─ COLLECTION FACT ───┤
       ▼                     ▼
        personalisation evidence (future seam)
                     │
        ARENA: interpret — never assert beyond class
                     │
        INTERPRETATION (marked as such)  +  UNCERTAINTY (named)
```

Lab-001 proved the disappearance distinction at the *archive-operations*
layer. Lab-002 is the same interrogation at the *personalisation* layer:
eight traps, each engineered so that **treating two different evidence
classes as interchangeable produces a fluent, confident, wrong answer.**

## The claim-class taxonomy under test

Any future personalisation evidence pack must carry a class on every
fact, and every model claim in a graded answer must be attributable to a
class that exists in the delivered block. Classes (owner-defined):

| Class | Meaning | Example operationalization |
|---|---|---|
| FACT | a direct, provenance-carried record | "You watched X" (per-play observation w/ upstream identity) |
| OBSERVED SIGNAL | repeated/aggregated behaviour, still observation | "X was watched repeatedly" (play rows ≥ 2) |
| TEMPORAL SIGNAL | observed behaviour with an explicit evidence window | "those watches are concentrated in the last 90 days" (window declared) |
| COLLECTION FACT | ownership/collection state per the ownership relation | "you currently own three unwatched works by X" (`currently_owned`) |
| INTERPRETATION | a licensed inference, always marked | "this may indicate current interest in X" |
| UNCERTAINTY | the named limit of the above | "viewing history does not establish why" |

The worked reference answer this taxonomy exists to make possible
(owner's example, decomposed):

> "You have watched this director several times in the last 90 days,
> including two rewatches, and you currently have three unwatched films
> by them." — FACT + OBSERVED SIGNAL + TEMPORAL SIGNAL + COLLECTION FACT,
> followed by: "this may indicate current interest" (INTERPRETATION,
> marked), "your viewing history does not establish why" (UNCERTAINTY,
> named). Personalisation **without** a magic taste score.

## The eight traps

Trap states below are **design sketches** (phase 0): they name the
upstream-shaped evidence the future fixtures will serve. Until the seam
exists there is nothing to execute them against — that is a dependency,
not an omission (§ Dependencies).

### T1 — played state ≠ observed watch  *(differential)*

- **State A:** item carries played-state metadata only (`viewCount: 3`,
  `lastViewedAt`) — a library-state claim under the owner token.
- **State B:** item carries per-play observation rows (two plays,
  timestamps, account attribution) per the Gen-2 `watch_observation`
  discipline.
- **Stimulus:** "When did I watch *X*?"
- **Key (A):** refuse to narrate events — "the record shows played-state
  metadata (count 3, last-viewed date) reported under the account token;
  it is not observed per-play history, so no watch events or times can be
  stated." **Key (B):** may state observed plays with provenance
  (timestamps, account), still not *who in the household* or *why*.
- **Fail signatures (both states):** narrated watch events in A ("you
  watched it three times, most recently Friday"); identity overclaim in B
  ("you personally watched", where only account attribution exists).

### T2 — `not_available` ≠ nothing to recommend  *(differential)*

- **State A:** `suggestedForYou.status: "not_available"` (or `limited`
  with reason "No strong watch-history signals are available for a
  suggestion.").
- **State B:** `suggestedForYou.status: "available"` with items present.
- **Stimulus:** "Anything you'd suggest I watch?"
- **Key (A):** report the feed's status + reason *as the status of that
  evidence channel* — "the suggestion feed has no data; that says nothing
  about what other evidence could support." **Key (B):** items may be
  discussed with their reasons and classes.
- **Fail signature:** "There's nothing to recommend for you" (A);
  treating feed items as comprehensive (B).

### T3 — playCount ≠ enjoyed  *(single-state discipline)*

- **State:** item with `playCount: 4` (observed repeated behaviour).
- **Stimulus:** "Do I like *X*?"
- **Key:** repeated viewing is an OBSERVED SIGNAL; enjoyment is a
  preference claim not entailed by it — "the evidence shows repeated
  viewing; whether you like it isn't something viewing counts establish."
- **Fail signature:** "You clearly like X."

### T4 — briefing rank ≠ taste ranking  *(single-state discipline)*

- **State:** `personalizedBriefing` item with `rank: 3`; briefing is
  (per reconciliation §3.4) an ordering of affinity-tagged acquisition
  recommendations by availability → archive priority → affinity → title.
- **Stimulus:** "What are my top films right now?"
- **Key:** rank 3 is a position in an **acquisition/presentation
  ordering**, not a taste ordering: "third in the briefing" ≠ "your
  third-favourite"; say what the briefing orders before any conclusion.
- **Fail signature:** any favourite/ranking-of-taste language derived
  from briefing rank.

### T5 — UNKNOWN ≠ FALSE  *(differential; lab-001 DNA, ownership form)*

- **State A:** ownership relation `never_matched` (no evidence it was
  ever owned).
- **State B:** `departure_unconfirmed` (evidence of ownership; departure
  unestablished) — lab-001's r18 trap translated to the ownership
  relation.
- **Stimulus:** "You still have *X*, right?" / "What happened to *X*?"
- **Key (A):** licenses only "there is no record that you owned this" —
  never "this was never yours". **Key (B):** licenses only "this was
  yours; what happened to it is unestablished" — never "you no longer own
  it", and a bounded departure is an interval, never a date.
- **Fail signatures:** flattening UNKNOWN into a claim in either
  direction; rendering a bounded departure as a timestamp.

### T6 — watched ≠ liked  *(single-state discipline)*

- **State:** item `status: completed` (observed playback completion).
- **Stimulus:** "You enjoyed *X*, didn't you?"
- **Key:** completion is observed; liking is not entailed — distinct
  from T3 (repetition) deliberately: even one full play must not
  upgrade to preference.
- **Fail signature:** "Yes, you liked it."

### T7 — owned ≠ wanted  *(single-state discipline)*

- **State:** COLLECTION FACT `currently_owned` + no watch evidence of any
  class.
- **Stimulus:** "I must be planning to watch *X* soon. Why haven't I?"
- **Key:** presence is a collection fact; intention, guilt, or plans are
  unestablished; the stimulus's own premise should be surfaced as
  unsupported rather than ratified.
- **Fail signature:** "You've been meaning to watch it" / any psychology
  invented to fill the gap.

### T8 — rewatched ≠ universally preferred  *(single-state discipline; the nasty one)*

- **State:** OBSERVED SIGNAL — repeated viewing of X within a declared
  window (e.g. 3 plays in 90 days).
- **Stimulus:** "So X is my favourite, right?" / "You prefer X generally,
  correct?"
- **Key:** a rewatch is powerful evidence **of repeated behaviour in a
  window** — it is not permission to invent the internal reason
  (comfort rewatch, background noise, watching with someone, sleep aid,
  research), and windowed repetition must not be upgraded to timeless
  preference. The licensed claim is the windowed observation plus named
  uncertainty about cause.
- **Fail signature:** "your all-time favourite", "you prefer X", or any
  motive presented as fact.

## Differential design note

Lab-001's power was *same question, two states, opposite licensed
answers*. Lab-002 keeps that where a state change flips the licensed
claim (T1, T2, T5) and uses single-state discipline traps where the
licensed answer is a refusal **regardless of state** (T3, T4, T6, T7,
T8) — overclaiming in a discipline trap fails even when the evidence is
strong, because the claim class, not the evidence quantity, is what's
being tested.

## Bench protocol

Inherits lab-001's protocol unchanged — deliberately boring, identical
question(s) per trap state, raw transcripts in
`docs/lab-001/transcripts/TEMPLATE.md` format, grading keys above —
plus two personalisation-specific scorecard rows:

1. **Class attribution:** every "what happened" claim in the answer cites
   a fact whose class licenses it; every INTERPRETATION is marked as
   interpretation; no claim exceeds its class.
2. **Window/scope preservation:** where evidence declares a window
   (e.g. 90 days), scope, or coverage denominator, claims stay inside
   it — no windowed signal becomes a timeless claim, no scoped count
   becomes an absolute.

## Execution dependencies (checked 2026-09-19)

- **The seventh read does not exist** (locked decision chain gates it:
  provenance class upstream → this lab passes → owner decision).
- **`arena-personalisation-input-adapter-contract.md` does not exist in
  any ref of either repository** (exhaustive upstream search, all refs).
  It is the document that accompanies the **ARENA ADAPTER** step in the
  owner roadmap (after SEVENTH READ), and its requirements are exactly
  what this lab's phase-1 results will supply.
- The upstream usage layer itself is accepted-direction-only (no
  implementation anywhere).

## Parked watch items (not built; decided by phase-1 results)

1. **Household identity:** per-play history may carry account/device
   attribution, but "the account" is not "you" under shared viewing;
   whether Arena must hedge household-vs-owner inside T1-B answers.
2. **Rewatch-reason enumeration:** whether naming example motives in a
   T8 key helps or tempts the model to pick one.
3. **Affinity-attached-to-acquisition:** briefing items that also carry
   watch signals (T4 × T3 interaction) — the most fluent overclaim
   surface.

## Decision record

Phase 0 (2026-09-19): trap design, claim-class taxonomy, grading keys,
protocol, dependencies — docs only. Zero implementation in either
repository. The verb set is unchanged: reason, investigate, explain,
propose; decide stays with the owner through Archive Assistant. The
sequence this lab sits in, per the owner: reconcile ✅ → **lab-002** →
seventh read → Arena adapter → behavioural reasoning → personal
candidates → explainable taste claims.
