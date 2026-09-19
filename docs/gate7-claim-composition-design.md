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
Layer B can only bundle what Layer A concluded. Preferences are,
deliberately, lineage-incomplete under the lattice (2026-09-19
verification: provenance proves the statement's identity, not
behavioural lineage — refusal recorded as the correct void). So today
there is no preference conclusion for B to bundle. Options:
1. B admits *identified-but-unconcluded* items as bundle members carrying
   explicit state `unconcluded` (a new member state; no lattice change —
   bundle-side vocabulary only);
2. preference restatement gets a statement-level floor rule (a calculus
   change — owner-gated);
3. upstream attaches behavioural lineage to preferences (*rejected*:
   producer already decided statement provenance is NOT event lineage).
Stack's lean: **option 1** keeps the enforced split intact (nothing
upgrades; B carries class-typed members, some of which are
transport-preserved statements).

**TW-2 — C as a claim, not a kind-smuggling channel.**
C needs (i) a conclusion kind (or strict bundle-with-license) carrying
status `interpretation`-shaped floor + explicit `not_established` list;
(ii) its refs may include conclusion handles (A/B), which means the
addressing space must admit conclusion references WITHOUT letting them
re-enter the lattice as members (one-way); (iii) renderer lane: phrasing
like "consistent with current interest" must pass the vocabulary guard
*only inside interpretation claims* — guard stays hard for A/B. All
owner-gated additions; none required for a Layer A/B lab.

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

## Owner decision points (open, enumerated)

1. **B's member vocabulary**: does a bundle admit `unconcluded`
   transport-preserved statements (option 1), or only certified
   conclusion handles? (affects whether preferences can appear in B at
   all under current lattice rules)
2. **B's identity**: composition structure with per-member floors shown
   adjacently (no own status) vs a conclusion carrying `minStatus` — the
   note's lean is the former (a bundle with ITS OWN floor would dilute
   strong members; adjacency preserves the knife-edge).
3. **C's status**: new closed status `interpretation` vs reusing
   `coverage-limited`/`unknown`-style floors with a new kind. (New status
   is semantically cleaner; new kinds are explicitly owner-gated.)
4. **Renderer lane for C**: allow-listed interpretation phrasing ("may
   be consistent with…", "signals are consistent with…") that is
   *forbidden* in A/B utterances — the current one-liner guard gains a
   second lane rather than a relaxation.
5. **Replay division of labour**: which stats are computed upstream
   (sessions/facts — already producer-side) vs which lines Arena may
   render (verdict lines only, all certified) — so Replay never renders
   from raw values.

## Out of scope here (standing constraints)

No recommendation, ranking, scoring, taste, embeddings, model calls;
no weakening of provenance handling, unknown/void semantics, the
7.3 knife-edge, §10 closure, or the renderer vocabulary guard; no new
conclusion kind without an owner gate; no upstream edits from Arena.
