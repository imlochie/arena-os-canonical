# Archive reasoning layer (Gate 7) — the legitimacy calculus

> **Date:** 2026-09-19 · **Type:** design, phase 0 — **no code in this
> document** · **Status:** draft for owner sign-off; implementation slices
> follow it one at a time, tests first (§8).
>
> **Contract authorities:**
> - Upstream evidence contract: `SomeSafePortablesoftware
>   @ arena/01a0b5e9-somesafeportablesoftware / 0a971dd` (Gate 5,
>   re-verified).
> - Gate-6 adapter: `arena-os-canonical @ 882abbd` (owner-verified,
>   untouchable).
> - Upstream design contract: `docs/arena-personalisation-input-adapter-
>   contract.md` at that ref (§10 conflicting evidence, §11 candidate
>   boundary, §14 Arena-owned state, §15 deterministic/model-assisted, §17
>   failure semantics, §20 claim permissions, §21 evidence lifecycle).
> - The adversarial exam this layer must pass:
>   `docs/archive-reasoning-lab-002.md` (traps T1–T8).
> - The register: §9 of
>   `docs/personalisation-vocabulary-provenance-reconciliation.md`.

---

## 0. The question

**What may Arena legitimately conclude when it has a pile of evidence it
is forbidden to pretend is more certain than it actually is?**

"Legitimately" is defined operationally, not aspirationally. A conclusion
is legitimate iff it is emitted **with** all of:

1. **its evidence** — references (signalId / lineage) sufficient to
   re-derive it;
2. **its epistemic ceiling** — computed by rule from its evidence (§2),
   never assigned by taste;
3. **its scope and coverage** — the `scopeIdentity` and window of its
   evidence, unbroadened;
4. **an inspectable derivation path** — a deterministic chain of declared
   rules; no step that requires believing a model.

Anything failing one of the four is not a conclusion; it is decoration,
and this layer does not emit it.

---

## 1. Inputs, and the absolute floor

Reasoning has exactly these inputs and no others:

- the frozen **`PersonalisationEvidenceReception`** (the seventh read,
  via Gate 6): six evidence classes + explicitPreferences + constraints,
  every item carrying its upstream epistemic status and provenance;
- the **ArchiveContext** fact layer (the six-op bridge): archive
  operational facts with observation/refresh handles;
- nothing else. No provider APIs, no web knowledge, no taste database, no
  inferred-preference store, no history beyond what the evidence pack
  carries with it.

The permanent invariant extends one verb at this gate:

```
Gate 6 : preserve → identify → never upgrade
Gate 7 : preserve → identify → never upgrade → CONCLUDE
         └─ conclusions inherit ceilings by rule; they never create certainty
```

**The hard floor:** reasoning cannot manufacture *authority* the inputs
lack. If the evidence pack arrives thin (empty collections, coverage-
limited scopes), the legitimate output is a *small honest answer* — the
thin signal and its limits — never a compensated full answer.

## 2. The epistemic lattice (the ceiling rules)

Statuses form an order (highest certainty first):

```
observed  >  derived  >  coverage-limited  >  unknown
             (computed from observed by      (evidence partial
              declared rules)                 or not backfillable)
```

- **C1 · ceiling.** A conclusion's epistemic status is the **minimum** of
  the statuses of its *load-bearing* evidence items. Supporting two
  `derived` signals with three `observed` facts still yields `derived`.
- **C2 · unknown ground.** If any load-bearing item is `unknown`, the
  question is not answerable positively; the only legitimate emission is
  an **open uncertainty** naming the scope it is open over. Unknown
  cannot be averaged into confidence.
- **C3 · coverage inheritance.** Every conclusion carries the scope +
  window of its evidence. Windows are never merged, and a conclusion's
  scope may never exceed the intersection of its evidence's scopes.
- **C4 · provenance completeness.** Every conclusion carries the lineage
  needed to rederive it (signalIds → eventIds / providerEventIds /
  batchIds). A conclusion that cannot name its derivation path is void.
- **C5 · no new nouns.** Conclusions use only the vocabulary the evidence
  carries. Evidence that says *4 plays in 30 days* licenses the noun
  "activity"; it licenses no noun from the enjoyment/preference family.
  Explicit preferences are the single exception channel — and they are
  facts **about recorded preference statements**, carried as
  `explicitPreferences[]`, never as inference.

## 3. Conclusion taxonomy (five bounded types)

All reasoning output is one of five types. The type declares what it is
allowed to claim.

### 3.1 Restatement (identify, not interpret)
A bounded re-voicing of **one** evidence item, same status, same scope,
same window. *"Four plays of show X were recorded in the 30-day ingested
window (derived from watch observations, batch ing-2026-09-18-01)."*
Forbidden: adjectives of affect ("great", "beloved"), comparative claims
("more than usual") without a second datum, any verb the evidence does
not carry.

### 3.2 Aggregation (bounded synthesis)
A union over **same-class** evidence sharing **identical scope and
window**. Counts and enumerations only. *"Three subjects have recent
activity in scope S over window W."* Forbidden: merging windows (the
provenance-window rule), converting coverage-limited members into full
members, weighting.

### 3.3 Temporal synthesis
Claims **strictly bounded to declared windows**, inheriting `derived`
status at best. Recency claims are time-relative to the evidence's
`derivedAt`/window, not to "now" silently — the claim states its
as-of. A trend claim requires **two or more non-overlapping windows of
the same scope**; otherwise only the single-window restatement is
legitimate. *recent ≠ preferred*: no temporal wording may drift into
preference vocabulary.

### 3.4 Contradiction surfacing (never resolution)
When evidence items conflict **under overlapping scope and window**, the
legitimate output is an **explicit uncertainty object** naming both
items, both lineages, and the conflicting field(s) — it is never a
silent winner. Arena does not resolve by recency, majority, or provider
prestige. When conflicts have **non-overlapping windows**, both stand,
each stated per its own window (conflict is a signal, not noise).
Derived evidence and its own underlying observations are not conflicts —
they are one lineage, stated once with its chain.

### 3.5 Absence-qualified claims
The layer may state *"no X evidence exists in scope S within coverage
C"* — with the qualifier always attached. It may never state *"no X"*.
`uncertainties: []` means "upstream recorded no open uncertainties in
this delivery", not "there are none".

## 4. The reject rules (the five distinctions, executable)

A conclusion is **void** — the layer refuses to emit it, and lab-002
grades the refusal — if its support requires any forbidden bridge:

| # | Forbidden bridge | Lab-002 trap |
|---|---|---|
| R1 | played state → observed watch (item-level `viewCount` semantics never re-enter as watch evidence) | T1 |
| R2 | unavailable watchlist source → "nothing to recommend" | T2 |
| R3 | play count / completion → enjoyed, liked, preferred | T3, T6 |
| R4 | briefing/acquisition ordering → taste ranking | T4 |
| R5 | UNKNOWN scope → FALSE claim ("not in library" from a failed read) | T5 |
| R6 | ownership → wanted | T7 |
| R7 | rewatch within one window → universal preference | T8 |

The reject rule is structural: the builder checks the derivation chain
against the bridge table and *throws* rather than emitting. Wording
review is the second line (§5), not the first.

## 5. Deterministic first, model-assisted later

- The calculus core is **pure deterministic functions** over the frozen
  evidence: no calls out, no clocks beyond the evidence's own times, no
  ambient state. Re-running it over the same evidence pack yields
  byte-identical conclusions (minus transport timestamps).
- Model-assisted *phrasing* — a later slice, if ever — may only render
  conclusions the calculus already produced. It receives the conclusion
  objects, not the raw pile; it may add no facts; every output still
  carries ceiling/scope/lineage (the lab-001 r18 rule: wording never
  upgrades what the fact layer built).
- There are no embeddings, no similarity scores, no learned parameters,
  anywhere in Gate 7. If a future need genuinely requires one, it is a
  new gate with its own acceptance — not an edit to this layer.

## 6. Acceptance: lab-002 is the exam

`docs/archive-reasoning-lab-002.md` phases 1+ executes against this
layer: real-shaped evidence packs through the verified adapter →
reasoning → scored answers. The bench scores class-attribution,
window/scope preservation, and trap refusals (T1–T8). Behavioural
reasoning is not "done" when it produces pleasant answers; it is done
when it **produces the bounded answer or the honest uncertainty, under
adversarial fixtures**, with every conclusion carrying ceiling, scope,
window, and lineage.

## 7. Explicitly out of scope (the frozen sequence behind Gate 7)

In order, each its own future acceptance: personal candidates →
explainable taste claims. Acquisition integration: never Arena's. The
upstream contract's candidate/acquisition boundaries (§12–§13 of the
adapter contract) bind every later step already: reasoning output is not
a recommendation until those gates make it one, deliberately.

## 8. Implementation slices (proposed; one at a time, tests first)

- **7.1** Types + epistemic lattice: `Conclusion`/evidence-ref types,
  status ordering, C1–C2 engine, structural bridge checks (R1–R7
  scaffolding). Pure. Tests: lattice laws, ceiling arithmetic, void
  verdicts.
- **7.2** Restatement + aggregation synthesizers over the Gate-6 frozen
  model. Tests: single-item fidelity, same-scope/window unions,
  window-merge refusal, coverage-limited membership rules.
- **7.3** Contradiction surfacing + temporal synthesis. Tests:
  overlapping-window conflict → uncertainty object; non-overlapping →
  per-window claims; recency as-of wording; trend requires ≥2 windows.
- **7.4** Conclusion renderer contract (deterministic templates; wording
  rules from §3/R-table; no model calls). Tests: forbidden-vocabulary
  scans, lineage/ceiling present on every rendered conclusion.
- **7.5** Lab-002 phase 1 wiring: T1–T8 as executable adversarial suite
  over Gate-6 fixtures + scorecard; bench rows update.

Each slice lands with its tests, docs, and register update — and stops.

## 9. Status

2026-09-19 · Gate 6 verified authoritative by owner inspection of
`882abbd`; Gate 7 unlocked and opened with this design. No reasoning code
exists yet. Next: owner sign-off on §1–§8, then slice 7.1.
