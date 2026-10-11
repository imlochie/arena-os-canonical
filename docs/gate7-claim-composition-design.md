# Gate 7 — claim-composition design note (A/B/C layers + Replay)

> **Date:** 2026-09-19 · **Status:** DESIGN NOTE ONLY. No implementation
> slice opened. All code references verified against the tree at the
> commit carrying `docs/e2e-gate7-preference-provenance.md` (post-c5d0ba0).
> Everything below the "owner decision points" line is owner-gated.

## The model (owner's, 2026-09-19)

```
                 CANONICAL EVIDENCE
                        │
         ┌──────────────┼──────────────┐
         ▼              ▼              ▼
   LAYER A          LAYER A        LAYER A
   per-class        per-class      per-class
   conclusions      conclusions    conclusions
         │              │              │
         └──────────────┼──────────────┘
                        ▼
              LAYER B — composition
        (structured bundle of independently
         typed, independently licensed claims)
                        │
                        ▼
              LAYER C — interpretation
   (a semantic claim ABOUT A/B members, with its
    own floor, its own licensing, never upgrading)
```

**The invariant (owner):** *Evidence can compose upward. Certainty cannot
flow downward.* `A → B`, `A → C`, `B → C` are one-way references: an
interpretation can never retroactively raise the status of the evidence
or conclusions it consumed. Layer C never inherits the epistemic status
of Layer A/B members; it gets its own licensing rules and keeps its own
inferential status.

- **A** answers: *what can I say about this evidence?* (what exists, what
  was observed, what compares) — per-class, independently typed.
  A preference conclusion doesn't become behavioural because behavioural
  evidence is nearby.
- **B** answers: *what independently established things are simultaneously
  true?* — a structured relationship between conclusions; grouping does
  **not** create a new fact. Not necessarily a "conclusion kind": better
  modelled as a *composition structure containing independently typed
  conclusions* (owner).
- **C** answers: *what might this mean?* — genuinely a new semantic
  claim, with its own floor ("interpretation"), explicit support list,
  and an explicit not-established list (e.g. enjoyment, liking,
  universal preference).

## What the tree already provides (verified, per layer)

| Layer | State at `c5d0ba0` |
|---|---|
| **A** | Closed positive kinds (`restatement`, `aggregation`, `temporal_synthesis`) + uncertainty-shaped kinds; floors computed by the lattice from member lineage, never supplied (`lattice.ts`); real certified examples on producer evidence: bounded as-of + two-window comparison (34/34→37/37 battery). Status set today: `observed · derived · coverage-limited · unknown` — **there is no "interpretation" status**; `interpretation` is an evidence CLASS (`evidenceClass: "interpretation"`) whose upstream channel is currently **empty**. |
| **B** | `mixed_class` exists as a rejection kind — the calculus already refuses blending evidence classes inside ONE positive conclusion (adversarial battery). But `EvidenceRef` addresses evidence items (collection+index) only; nothing references *conclusions* — a bundle in the owner's sense is a new structure (below). |
| **C** | Nothing yet needs building for the boundary case: anything attempting C today has no kind and fails closed. The renderer vocabulary guard already refuses affect-fact phrasing ("enjoyment", "favourite") on certified output. |

## Pre-registered tripwires (must be decided BEFORE a lab opens)

**TW-1 — A-layer admission for the preference class.**
Owner draft resolution (2026-09-19, **pending ratification**):
**B admits evidence without A-conclusions — as evidence composition,
not conclusion composition.** The bundle member type is not "certified
conclusion" but "evidence-class-typed entry": a preference participates
as itself (`⚠ evidence exists, lineage_incomplete`), alongside
certified members. Bundle membership does not require, and never
confers, an A-conclusion. The governing rule the owner attached to it:
**"a missing A-conclusion does not erase evidence from B, and B
membership does not automatically license C."** This keeps "not
currently conclusion-formable" from accidentally meaning "not usable
anywhere", while the member carries its status adjacently — nothing
upgrades. Fall-back options (2/3) stand in reserve; the draft favours
composition-of-evidence over any calculus floor change.

**TW-2 — C as a claim, not a kind-smuggling channel.**
Owner draft resolution (2026-09-19, **pending ratification**): **C is
genuinely a new claim kind** — A says what evidence establishes, B how
established things relate, C what those relationships *may mean* — a
new proposition, not a prettier bundle. It therefore needs its own:
claim kind, licensing rule, epistemic ceiling, lineage, scope/window,
renderer lane. Crucial property the owner attached: **C may say LESS
than the evidence tempts** — "consistent with current interest" is an
interpretation; "the user likes X" is a disguised behavioural fact and
stays forbidden. Nothing in the draft weakens the existing guards; the
renderer gains a second lane for interpretation-phrasing rather than a
relaxation of the first.

## Replay / "archive wrap" product alignment (owner sketch, mapped)

- **Monthly Replay** = mostly an **upstream analytics product** (sessions
  engine, counts/hours/days over caller-declared calendar-window
  identities — window identities are already caller-declared under C3;
  month-vs-month = existing `compareWindows` arithmetic over bounded
  windows). Arena's role: at most the rendered verdict lines that are
  already licensed ("12 more films than last month" — arithmetic, not
  interpretation). The tripwire guardrail is the existing refusal: the
  calculus says *greater by 1*, never *became more interested*.
- **"Things You Left Behind"** maps onto `absence_qualified`-shaped
  reporting (uncertainty-shaped kind — *reports* not-known/limited
  visibility) rather than a positive rewatch claim; exact phrasing a
  renderer-lane decision.
- **Deeper interpretation lines** (e.g. "signals consistent with
  psychological thrillers becoming prominent") = pure Layer C material:
  support list from A/B + explicit not-established list. **Never**
  "your favourite genre".
- Division of responsibility per owner: Archive Assistant = *what
  happened*; analytics = *what the numbers show*; Arena = *relationships
  and interpretations the evidence can legitimately support*; Replay =
  *the story of the year without pretending certainty the evidence
  didn't earn*. The current machinery already enforces this on single
  claims; the design above extends the same rule to composition.

## Owner decision points (updated 2026-09-19)

Drafts recorded under the tripwires above (TW-1: composition-of-evidence
with adjacent status — DRAFT pending ratification; TW-2: C as a new
claim kind with its own licensing/floor/lineage/lane — DRAFT pending
ratification). What remains open for ratification before any lab opens:

1. **TW-1 ratification**: confirm "bundle member = evidence-class-typed
   entry, status adjacent, never conferring a conclusion" as the
   admitted vocabulary (vs certified-handles-only).
2. **B's identity**: composition structure with per-member floors shown
   adjacently (no own status) vs a conclusion carrying `minStatus` — the
   note's lean is the former (a bundle with ITS OWN floor would dilute
   strong members; adjacency preserves the knife-edge).
3. **TW-2 ratification**: confirm Layer C as a new claim kind with its
   own licensing rule, epistemic ceiling, lineage, scope/window, and
   dedicated renderer lane ("C may say less than the evidence tempts" —
   affect-fact phrasing stays forbidden even inside C).
4. **Renderer lane for C**: allow-listed interpretation phrasing ("may
   be consistent with…", "signals are consistent with…") that is
   *forbidden* in A/B utterances — the current one-liner guard gains a
   second lane rather than a relaxation.
5. **Replay division of labour**: which stats are computed upstream
   (sessions/facts — already producer-side) vs which lines Arena may
   render (verdict lines only, all certified) — so Replay never renders
   from raw values.

## Layer D — preference & intent (owner addition, 2026-09-19, same gating)

The stack extends with a fourth layer that is deliberately **not** a
reasoning layer:

```
                 ARCHIVE
                    │
             canonical evidence
                    │
          ┌─────────┴─────────┐
          ▼                   ▼
     A. CONCLUSIONS      user-controlled
          │              D. PREFERENCE /
          ▼                  INTENT
     B. COMPOSITION          │
          │                  │
          ▼                  │
     C. INTERPRETATION       │
          └────────┬─────────┘
                   ▼
             SUGGESTION ENGINE
                   ▼
             candidates/output
```

D describes the user's **chosen relationship with the system**, never
the archive. Two subtypes:

1. **Explicit preference** — statements the user makes ("I want more
   experimental cinema", "don't show me superhero movies", "prioritize
   what I haven't seen"). This is the seam already proven at
   `1a2200b` (`docs/e2e-gate7-preference-provenance.md`): `preferenceId
   / source / statement / scope / observedAt` — the foundations exist,
   verified; D consumes them *as control inputs*, not A-layer evidence.
2. **Preference configuration** — deliberate product controls
   (discovery priorities, familiarity/novelty sliders, library/
   outside-library weighting). Not a claim about the user at all:
   "use this operating preference when generating suggestions."

Two load-bearing properties:

- **D does not wait for A/B/C.** A user can request "weird 90-minute
  movies tonight" with an empty archive — intent is immediate. That is
  what makes D a genuinely separate semantic layer rather than another
  flavour of personalisation evidence.
- **D can override what behavioural evidence suggests without making
  the evidence false.** The owner's horror example: A observes horror
  watched frequently; C provisionally says "possible current interest";
  D records "deprioritize horror"; suggestion output silences horror
  without any layer pretending "the user doesn't like horror anymore."
  Evidence remains true. Interpretation remains provisional. Preference
  remains user-controlled.

Layer D also makes the recommendation engine's eventual honesty
boundary explicit: `Given { established things (A), relationships (B),
interpretations (C), currently selected controls (D) } → candidates`.
Suggestions are authored by all four layers TOGETHER and answerable to
each of them distinctly. Nothing downstream may launder a behavioural
signal into a recommendation unpunished — every layer it passed through
stays named.

## Institutional lessons (running)

1. **2026-09-19 — tree-integrity event.** Never trust branch continuity
   from the worktree: verify tree AND ancestry before declaring lineage
   (`git rev-parse HEAD^{tree}`, `git merge-base --is-ancestor`). The
   session caught an empty-tree root commit, recovered read-only from
   the single intact object, reconciled byte-identical against the
   pushed lineage, merged non-destructively, and re-ran the full wall
   on the merged tree before declaring it whole. No force-push, no
   main, outsiders parked in the stash. `c5d0ba0` remains the verified
   provenance boundary; `9ece4c3` is reconciled lineage, not
   replacement history.

## Out of scope here (standing constraints)

No recommendation, ranking, scoring, taste, embeddings, model calls;
no weakening of provenance handling, unknown/void semantics, the
7.3 knife-edge, §10 closure, or the renderer vocabulary guard; no new
conclusion kind without an owner gate; no upstream edits from Arena.
