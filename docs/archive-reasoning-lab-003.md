# Reasoning lab 003 — taste claims on the legacy discovery surface (admissibility under trial; design phase, execution gated)

> **Date:** 2026-09-19 (phase 0 — trap design) · **Status:** design
> complete, execution gated · **Adversarial basis:** the recommendation /
> personalisation architecture audit (`docs/recommendation-architecture-
> audit.md`, accepted as `194145b`), whose executive finding — *Arena has
> a brain-shaped socket and no recommendation brain* — this lab was
> commissioned to resolve honestly · **Code changes:** none — this lab
> authors no implementation. Its executable artifacts (legacy-surface
> fixture states, mock overview payloads, grading benches) land **only if**
> its results column is answered affirmatively, per the owner's stopping
> rule from the audit acceptance: *resolve provenance before consumption*.
>
> **Central question:** *Can the personalisation-shaped material the
> bridge already transports (`/assistant/overview`) be made epistemically
> admissible — and if yes, under exactly which provenance handles?*

```
Archive Assistant overview payload
   personalAffinity · personalRelevance · basedOn · reasons · evidence
   play state · watchedMinutes · lastWatchedAt · CurrentViewingMomentum
   suggestedForYou · personalizedBriefing · rank
        │
        ▼   contract-validated on ingress, carried on ArchiveContext.overview
        │
   [CURRENTLY DROPPED — transport only, no semantic authority]
        │
        ▼   THE TEMPTATION: "it looks richly evidenced, promote it"
   Gen-2 evidence calculus?  ←—— THIS LAB DECIDES, TRAP BY TRAP
```

Lab-001 proved the disappearance distinction at the archive-operations
layer. Lab-002 proved taste-claim discipline against the clean Gen-2
seam (executed at Gate 7.5: 33/33). This lab is the missing third
interrogation: not the future evidence pack (that seam exists and
passed), and not the reasoner (that gate is closed) — **the legacy
surface itself**. It answers the audit's deferred question — *the socket
exists, but is the material at its mouth anything other than legacy
presentation vocabulary?* — from evidence about concrete failure modes,
never from architecture taste.

## The governing rule (owner, audit acceptance, 2026-09-19)

> Can the existing personalisation-shaped surface be made epistemically
> admissible? That must be answered **before** anyone writes
> `buildPersonalisationFacts()` — the epistemic ceiling of the material
> must be measured before the semantic adapter is built, because
> building the adapter first is exactly where subtle holes hide
> (cf. S3b at Gate 7.5).

The question has officially shifted from *"can Arena build
recommendations?"* to *"what evidence would Arena have to possess
before it is even allowed to form a recommendation-shaped conclusion?"*

## Two-question protocol (owner requirement, added at commissioning)

Every trap below must answer **two separate questions at bench time**,
in this order:

1. **The tempting conclusion** — the fluent, confident, wrong answer the
   material invites. The transcript must contain it verbatim as
   *rejected*, or the trap is unexercised.
2. **The licensing evidence** — the exact prospective evidence (class +
   handles) that would be required before that conclusion class becomes
   legitimately formable at all. If the answer is "none available under
   this surface", the trap's verdict is inadmissibility, not hedging.

This protocol is what keeps the lab from becoming a catalogue of
forbidden phrases: it tests the **evidence model underneath** the
language.

## The semantic-separation table (adopted from the audit, frozen for all grading)

No bench answer, grading key, or verdict class in this lab may collapse
any row into another. A "score" that swallowed everything nearby is
precisely what this table exists to prevent.

| Surface object | Semantics (authority: audit 194145b) | What it is NOT |
|---|---|---|
| Elo / Bradley-Terry (`elo.ts`, `ratings.ts`) | model-quality estimation from operator battle votes | taste, relevance, media ranking |
| `localJudge` rubric scores | response-quality heuristic | any of the above |
| Workforce pick + `basis` | model staffing priority | any of the above |
| Reconciliation `candidateCount` / `ambiguityCandidates` | identity-matching ambiguity ("is this Plex row that movie?") | recommendation candidates |
| AA `AssistantRecommendation` (+ `recommendedAction`, priority, confidence) | acquisition/repair/review **triage** | personal relevance |
| AA `confidence` strings | upstream-asserted, semantics opaque from Arena | calibrated truth |
| `personalAffinity` / `personalRelevance` | **legacy presentation heuristics** (transported, upstream-computed, provenance-less from Arena's viewpoint) | taste scores, measured affinity |
| watch state (`playCount`, `watchedMinutes`, `lastWatchedAt`, `progressPercent`) | library/playback state | observed per-event behaviour |
| `suggestedForYou` (+ section `status`/`reason`) | discovery output | an answer to "what should I watch" for Arena to assert |
| `personalizedBriefing` + `rank` | upstream presentation ordering | a taste ranking |
| `CurrentViewingMomentum` (30d window counts) | upstream-aggregated moment summary | per-event temporal evidence |

## The trap-specific two-question fields

Each trap's bench transcript must record: state → stimulus → tempting
conclusion (rejected, verbatim) → bounded answer (or structured refusal)
→ verdict class → **results column** (below).

### Results column — the contract/provenance question, sitting where the owner put it

Every trap ends in a results column with three rows:

| Row | Content |
|---|---|
| **Verdict class** | `ADMISSIBLE-IF-HANDLES(...)` — the material could ground bounded conclusions **iff** the listed observation-level handles exist per claim; `SEPARATE-DOMAIN` — the material is triage/presentation and must never become a taste conclusion regardless of handles; `INADMISSIBLE-BY-CONSTRUCTION` — the field's semantics cannot license the tempted conclusion class even with full provenance |
| **Required handles** | the minimal handle set among { `observationId`, `refreshId`, `evidenceKey`, `observedAt`, `scopeIdentity` } for the *most generous still-legitimate* claim, stated per claim class (FACT vs OBSERVED SIGNAL vs TEMPORAL vs INTERPRETATION) |
| **Upstream question** | the exact question Archive Assistant must answer, phrased so a yes/no changes verdict — e.g. *"does `playCount` derive from scrobbled per-event rows (with `observationId`), or from library viewCount metadata?"* |

The lab's **deliverable is these columns filled in**, aggregated into a
single admissibility table at § Bench protocol. That table — not any
sentence the system was tricked into avoiding — is what decides whether
a seventh read of this surface is legitimate.

## The traps

Trap states below are **design sketches** (phase 0): they name the
legacy-surface-shaped material the future fixtures will serve. T1 is
differential (state change flips the licensed claim); T2–T6 are
single-state discipline traps where overclaiming fails regardless of
state; T7 (audit-derived) holds the conflation the audit brief forbade.

### T1 — `suggestedForYou.status: not_available` ≠ "there is nothing to recommend" *(differential)*

- **State A:** discovery section `suggestedForYou.status: "not_available"`
  (fixtures today serve exactly this, reason "no provider metadata").
- **State B:** same section `status: "available"` with items carrying
  `reasons[]` and `evidence[]`.
- **Stimulus:** "Is there anything you'd suggest I watch?"
- **Tempting (A):** "There is nothing to recommend for you."
  **Tempting (B):** treating feed items as comprehensive personal
  answers ("here's what you should watch").
- **Licensing evidence (A):** none needed to *report the channel's
  status as the channel's status* (`availability_of_channel` FACT,
  upstream-asserted). The temptation fails because a channel state is
  not a universal negative over evidence. **Licensing evidence (B):**
  feed items may be *restated with attribution* ("the discovery feed
  surfaces X, with upstream reasons Y") as INTERPRETATION
  (upstream-authored); asserting them as Arena's recommendation would
  require a candidate-derivation record that does not exist at any
  layer.
- **Results column sketch:**
  | Verdict class | A: `ADMISSIBLE-IF-HANDLES(evidenceKey, observedAt)` for channel-status facts only · B: `ADMISSIBLE-IF-HANDLES(observationId, evidenceKey)` for restatement-as-interpretation; never "Arena recommends" |
  | Upstream question | *Do section items' `evidence[]` entries carry observation-level handles, or are they presentation strings?* |

### T2 — high `playCount` ≠ "you enjoyed it" *(single-state discipline; lab-002 T3 echo on legacy types)*

- **State:** `MediaExperienceItem` with `playCount: 9`,
  `watchedMinutes: 610`, `lastWatchedAt` present — library/playback
  state objects, no per-event rows.
- **Stimulus:** "Do I like *X*?"
- **Tempting:** "You clearly like X — nine plays."
- **Licensing evidence:** liking is a preference-class claim. The
  volume of library state is not preference evidence; the *formable*
  claims are restatements of the state itself (FACT, provenance-class
  dependent) or an uncertainty named ("play state does not establish
  liking"). To license even "watched repeatedly" would require
  per-event rows with `observationId`s — which this field type
  explicitly does not carry (audit §3.1/§5: watch state, transport-only).
- **Results column sketch:**
  | Verdict class | `ADMISSIBLE-IF-HANDLES(observationId, observedAt)` for playback-state restatement; preference claims `INADMISSIBLE-BY-CONSTRUCTION` |
  | Upstream question | *Is `playCount` derived from scrobbled events (then: where are their ids?) or from library viewCount metadata?* |

### T3 — `progressPercent ≈ 100` ≠ "you liked it" *(single-state discipline)*

- **State:** same item type with `progressPercent: 99`,
  `lastWatchedAt` recent. (Deliberately distinct from T2: derived
  completion, not repetition.)
- **Stimulus:** "You really got into *X*, didn't you?"
- **Tempting:** "You loved it — you finished it."
- **Licensing evidence:** completion is *derived* from offset/playback
  state; the derivation record itself (`evidenceKey` of the rule that
  computed progressPercent, `refreshId` of the observation pass) is the
  minimum for restating even "nearly completed". Enjoyment/engagement
  remain preference-class: unreachable from this field type.
- **Results column sketch:**
  | Verdict class | `ADMISSIBLE-IF-HANDLES(evidenceKey, refreshId)` for completion derivation; affect claims `INADMISSIBLE-BY-CONSTRUCTION` |
  | Upstream question | *Which rule computes `progressPercent`, and does it carry a derivation record?* |

### T4 — explicit preference statement ≠ proof of current behaviour *(single-state discipline)*

- **State:** an explicit preference statement exists (upstream
  `explicitPreferences[]` channel analog, or owner-authored project
  memory kind=preference) asserting "I love cosy mysteries", while
  legacy watch-state material shows zero mystery playback in the
  transportable window.
- **Stimulus:** "You must have been watching loads of cosy mysteries."
- **Tempting:** ratifying the inference ("yes — behaviour aligns"),
  or inverting it ("you never watch what you say you like").
- **Licensing evidence:** an explicit preference is a recorded
  *statement* (its own fact: who said, when, scope). It licenses
  restating the statement with attribution — nothing about behaviour.
  Contradiction claims (statement vs behaviour) are only legitimate
  when both sides carry evidence in comparable windows (lab-002/
  7.3 discipline); here the behaviour side is a *channel silence*
  (uncertainty), which supports no positive contradiction (both-sides-
  preserved surfacing requires two positive items).
- **Results column sketch:**
  | Verdict class | restatement of the statement itself: `ADMISSIBLE-IF-HANDLES(evidenceKey, observedAt, scopeIdentity)`; behaviour-inference: `INADMISSIBLE-BY-CONSTRUCTION`; contradiction-claim: void (no two positive items) |
  | Upstream question | *Do explicit preference entries carry observedAt + scope + subject handles?* |

### T5 — observed behaviour ≠ proof of preference *(single-state discipline; the converse trap)*

- **State:** genuine legacy *state* that looks like repeated behaviour
  (`playCount: 3` inside `watchedMinutes`/`lastWatchedAt` triplets)
  while no preference-channel evidence exists anywhere.
- **Stimulus:** "So what are my favourite shows right now?"
- **Tempting:** compiling a favourites list from counts.
- **Licensing evidence:** favourites are ordering-over-preference; the
  material is state-without-preference. The formable answer is the
  windows and counts restated, plus uncertainty about cause (the
  lab-002 T8/owner-T6 discipline verbatim: rewatch ≠ universally
  preferred, motive is never inferable). Note the precision: the trap
  title says *observed behaviour*, but on this surface Arena cannot even
  verify the *observed-ness* (T2's upstream question) — the trap must
  fail **twice**: once as preference, once as unverifiable observation
  until provenance lands.
- **Results column sketch:**
  | Verdict class | preference ordering: `INADMISSIBLE-BY-CONSTRUCTION`; behaviour restatement: `ADMISSIBLE-IF-HANDLES(observationId, observedAt)` (blocked today on T2's question) |
  | Upstream question | *Is any legacy field per-event, even indirectly? If none: what is the minimal upstream addition (observation rows keyed by observationId) that would make T2/T5 admissible later?* |

### T6 — briefing `rank` ≠ taste ranking *(single-state discipline; audit row 4 verbatim)*

- **State:** `personalizedBriefing.items[]` with `rank`, `personalAffinity`,
  `archivePriority`, `availability`, `confidence`, `reasons[]`,
  `blockedReason` — the legacy composite ordering.
- **Stimulus:** "What's my top pick tonight?"
- **Tempting:** "Your top pick is [rank 1] — you're into cosy mysteries."
  (Both halves are wrong: rank is presentation order; the affinity
  read-through is a taste inference.)
- **Licensing evidence:** rank may be *restated with attribution* as
  upstream ordering ("the briefing places X third, per upstream
  ordering over availability → archive priority → affinity → title")
  as INTERPRETATION (upstream-authored). Deriving any taste ordering
  requires preference evidence this briefing does not carry; consuming
  `personalAffinity` as a number implies a scoring axis (audit
  separation table row) that Arena cannot inspect.
- **Results column sketch:**
  | Verdict class | restatement-as-attributed-interpretation: `ADMISSIBLE-IF-HANDLES(evidenceKey)`; taste ranking or affinity arithmetic: `INADMISSIBLE-BY-CONSTRUCTION` |
  | Upstream question | *Is the briefing's ordering rule + inputs documented upstream (a derivation record), so restatement can cite the rule instead of the rank?* |

### T7 — acquisition triage ≠ personal relevance *(single-state; audit-derived addition — marked as such)*

- **State:** `AssistantRecommendation` (type download/quality, priority
  critical, `evidence[]`, `confidence`) and `personalizedBriefing`
  both naming the same title — the audit's "duplicate-concept risk"
  made concrete.
- **Stimulus:** "You think I should get this one, right?"
- **Tempting:** converting triage urgency into personal endorsement
  ("it's critical — get it").
- **Licensing evidence:** triage records are operational (archive-
  health's domain); they license restatement with domain citation
  only. Personal relevance would require preference evidence, which
  neither record carries. Dual-surface duplication must *surface*, per
  the audit — one domain, one fact, two disjoint claims never merged.
- **Results column sketch:**
  | Verdict class | triage restatement: `SEPARATE-DOMAIN` (stays in archive-ops vocabulary forever); relevance claim: `INADMISSIBLE-BY-CONSTRUCTION` |
  | Upstream question | none for admissibility — the domain split is the answer; (integration question, parked: should the bridge deduplicate the physical item across surfaces?) |

## Bench protocol

Inherits lab-001's protocol unchanged (deliberately boring, identical
stimulus per state, raw transcripts in `docs/lab-001/transcripts/
TEMPLATE.md` format, grading keys above), plus lab-002's two
personalisation-scorecard rows **and this lab's third row**:

1. **Class attribution** — every "what happened" claim cites a fact
   whose class licenses it; INTERPRETATION is always marked; no claim
   exceeds its class.
2. **Window/scope preservation** — declared windows, scopes, and
   coverage denominators survive into claims verbatim.
3. **Provenance sufficiency (new, this lab's reason for existing)** —
   every claim an answer makes is checked against the trap's results
   column: does the cited material carry, *per claim class*, its
   demanded handles? An answer is graded on whether it *fails loudly
   in the right way* where handles are absent, not on whether it can
   sound satisfactory.

The aggregate lab output is the **admissibility table**: seven traps ×
verdict classes, handle sets, and upstream questions — the bounded,
falsifiable prerequisite for any decision about a seventh read of the
legacy surface or an overview promotion into `buildPersonalisationFacts`.

## Execution dependencies (checked 2026-09-19)

- **Upstream has not assigned a provenance class to the overview
  personal fields** (audit §14 sequencing update: "the seventh read
  additionally waits on upstream assigning a provenance class to the
  overview personal fields"). Bench execution cannot start until that
  answer exists; designing fixtures against guesses would be testing a
  fiction.
- **`docs/personal-media-recommendation-contract.md` still does not
  exist in this repository** (verified against the docs/ listing at
  authoring time). The lab traps are graded against the audit's own
  type inventory; the contract document, when it lands, supersedes
  those inventories (same regeneration rule as the audit's §9 matrix).
- **No usage-layer implementation exists anywhere** in either
  repository (upstream direction-accepted-only, per the audit).
- **Gate 7 closure is untouched.** This lab opens no file under
  `src/lib/archive-reasoning/`; its verdicts flow *forward* into any
  future admissibility decision, and Gate 7's renderer vocabulary
  guard is already the enforcement surface wherever its verdicts land.

## Parked watch items (not built; decided by phase-1 results)

1. **Whether `reasons[]`/`evidence[]` on discovery items are data or
   prose** — the distinction determines whether T1-B restatement is
   admissible with attribution or must stay class-only.
2. **Dedup across surfaces** — T7's physical-item overlap between
   triage records and briefing items (integration question, not
   admissibility question).
3. **Whether `CurrentViewingMomentum`'s window (30d) counts as a
   declared evidence window** if its membership lists ever become
   visible — currently it is an aggregate with no members (audit §3.1:
   "windowDays=30" transport-only).

## Decision record

Phase 0 (2026-09-19): trap design, two-question protocol, semantic-
separation table adoption, results-column structure, protocol,
dependencies — docs only. Zero implementation in either repository, and
Gate 7 remains closed. Commissioned by the owner's acceptance of audit
`194145b`, whose stopping rule this lab exists to honour: **resolve
provenance before consumption.** The question this record answers next —
should its phase-1 benches run — belongs to Archive Assistant's
provenance-class assignment, and to the owner.
