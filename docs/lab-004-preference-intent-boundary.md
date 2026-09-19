# Lab-004 — Preference & Intent Boundary (decision record, design-only)

> **Date:** 2026-09-19 · **Status:** DESIGN LAB — decision record.
> No code, no slice, not an implementation specification. Adversarial
> cases are paper-executed against the rules of the current tree
> (`d75c058` era) and the guarantees already proven in
> `docs/e2e-gate7-preference-provenance.md` / the A/B/C/D record in
> `docs/gate7-claim-composition-design.md`. Anything a machine cannot
> truthfully execute today is marked PAPER; nothing here fabricates a
> run.
>
> **Gate discipline:** TW-1/TW-2 remain unratified; this lab adds its
> own decision points (LP-1…LP-4). Nothing below opens them.

## The lab's question

**What does the user control, what does the archive know, and where are
those two allowed to meet?**

Reference stack under test:

```
A  Conclusions        — evidence-derived, licensed statements
B  Composition        — structure over established/evidentiary things (design-held)
C  Interpretation     — explicitly licensed meaning from A/B (design-held)
D  Preference & Intent— user-controlled instruction (this lab's subject)
E  Recommendation     — candidate generation/selection consuming A/B/C/D
```

## Q1 — Is D actually one layer? (DRAFT: one boundary layer, four member kinds)

Candidate instructions observed in the design dialogue:

| Utterance | Kind (draft) | Lifetime | Shape |
|---|---|---|---|
| "Don't recommend horror" | **hard constraint** | standing, until retracted | veto |
| "I like Wong Kar-wai" | **stated disposition** (statement; evidence for D only, see §Epistemic walls) | standing | content |
| "I want more Wong Kar-wai" | **durable preference** | standing | weight, positive |
| "Show me something weird tonight" | **session intent** | session-scoped | episodic request |
| "Prioritize unwatched", sliders | **discovery controls** | profile-scoped | weighting config |

**Draft verdict:** D survives as **one layer** — because its shared
boundary contract with the evidence side is stronger than the internal
differences: every member kind (i) is user-authorized instruction, (ii)
never alters A/B/C, (iii) is consumable only by E at one policy node,
(iv) carries provenance. The *member kinds* matter (veto must beat
weight; session intent must not fossilize into durable preference), but
they are kinds **within** the layer, not four layers. Splitting into
four layers now would create four seams with the evidence side where
one honest seam exists.

**Marker of error to watch:** if a member kind ever starts consuming
or changing A/B/C output, that kind is misclassified and must move.

## Q2 — Does D affect evidence? (DRAFT: NO — tree-enforced)

No. Evidence is frozen transport through the whole chain (capture →
validation → normalize → pack items `Object.isFrozen`). "I don't want
horror anymore" cannot rewrite "14 horror films watched" — there is
currently *no write path at all* from instruction to evidence, and
adding one would violate the standing invariant (preserve ✓ / identify
✓ / upgrade ✗). This one is not awaiting ratification; it is already
how the tree works.

## Q3 — Does D affect C? (DRAFT: NO — D is not evidential for C)

No. Two walls:

1. **Floor wall:** C's ceiling derives from its A/B members only. D
   membership is not a floor input, even when D is truthful ("the user
   suppressed horror" says something about the user's *instruction*, not
   about the archive's evidence).
2. **Laundering wall:** D must not be quotable inside C. "The viewer
   stopped watching horror — consistent with declining interest" is the
   exact laundering path (instruction disguised as behavioural signal)
   that every prior seam was built to seal. D can be *acknowledged
   alongside* C (see E's explanation duty), never *inside* C.

## Q4 — Does D affect suggestions? (DRAFT: YES — at one explicit policy node, downstream of reasoning)

**Yes — via an explicit recommendation policy boundary; never by
contaminating reasoning layers.** Candidate architectures:

(i) **Serial** (serial-policy):
`candidates → policy(D) → presentation` — D filters/boosts after
candidate generation.

(ii) **Parallel**: `Evidence+Reasoning (A/B/C)` and `D` enter one
decision node; decision := f(candidates, D-policy) in a single
auditable step.

**Draft lean — serial, auditable:** a D-authored policy node downstream
of candidate generation makes every suppression/boost *attributable by
construction*: the candidate existed (A/B/C-visible) and was suppressed
by policy P (D-visible). A fused decision node (ii) hides attribution
inside f's weighting, which is precisely the laundering hole.
(Counter-consideration recorded: serial can leak suppressed candidates
upstream of the policy node if the presentation layer is careless —
attribution and leak-safety are the same audit.)

## Adversarial battery (paper-executed against current rules)

**AC-1 — observed horror exposure + standing suppression**
A: ✓ says it (observed behaviour stands, unembellished).
C: ✓ may still interpret (uncoupled from D), status `interpretation`,
not-established list intact.
D: ✓ records the constraint.
E: ✗ horror absent; ⊕ **and must be able to say why** — attribution is
D, not "the evidence suggests you've moved past horror".
*Pass condition:* evidence unchanged, C unchanged, suppression visible
and D-attributed, no affect-fact vocabulary anywhere.

**AC-2 — animation exploration with thin history**
A: unchanged ("rarely watches animation" stands).
C: **not reinterpreted** — exploring ≠ historical evidence; C about the
past must not be back-edited by D.
E: ✓ alters discovery behaviour (boost animation candidates);
attribution = session intent.
*Pass condition:* no historical claim moves; boost is visible as
intent-authored.

**AC-3 — cold-start intent, zero archive**
("weird 90-minute movies", no behavioural evidence.)
A/C: silent — nothing observed, nothing interpreted (correct void).
D: full payload alone.
E: ✓ **recommendation may proceed** — candidates sourced from library
metadata alone under intent constraint; the output is D-authored end to
end. This case is the load-bearing proof that **D is a semantic layer
independent of personalisation evidence**.
*Pass condition:* E runs, explanation cites only D + metadata, never
implies any evidence or interest.

**AC-4 — D-vs-D conflict** (derived case, stack-authored)
"never horror" (hard constraint) + "surprise me tonight" (intent).
Draft rule: **constraint class beats weight/  intent class**, and E's
explanation names both instructions. Veto is not a stronger weight; it
is a different class (see Q1).
*Pass condition:* conflict resolution is rule-based, deterministic,
explainable — never a coin flip.

**AC-5 — legacy/unverifiable D member** (derived case, stack-authored)
Modelled on the provenance seam's `legacy`: an instruction row whose
provenance can't be verified (came from an older surface). Draft rule:
legacy D members are **conserved, never upgraded**, and at E must be
treated as *unverified standing* — they may advise, never veto.
*Pass condition:* `provenanceStatus: "legacy"` semantics mirror the
preference seam's exactly.

**AC-6 — standing D vs immediate intent** (derived case, stack-authored)
"Don't recommend horror" (standing) + "show horror tonight" (current
intent). Draft rule: **current intent preempts standing instruction for
that session**, recorded as a session-scope override (the standing
instruction is not edited — overrides are additive evidence in D's own
store, with their own provenance).
*Pass condition:* the standing instruction survives intact; the session
reads "intent overrides standing for tonight".

## The pointer to E (recommendation boundary, DRAFT)

E consumes: A (licensed statements) + B (structure) + C (licensed
interpretations) + D (policy inputs at the one policy node). E's own
honesty rules, drafted:

1. Every surfaced or suppressed candidate is attributable to named
   source layers (A/B/C/D) — never a merged opaque weight.
2. E may render A/B/C content only through the existing renderer lanes
   (A/B lane: current vocabulary guard; C lane: interpretation-phrasing
   only — TW-2 draft). D-authored explanations cite D's provenance.
3. E never writes back: no candidate generation mutates evidence,
   composition, interpretation, or instruction.
4. Empty-archive operation (AC-3) is a declared mode, not a fallback
   hack.

## Record of answers (draft summary)

| Question | Answer (draft) | Basis |
|---|---|---|
| Is D one layer? | One boundary layer, four member kinds (constraint / preference / intent / controls); kinds are not layers | this lab, Q1 |
| Does D affect evidence? | No | tree-enforced today |
| Does D affect C? | No — not evidential, not quotable inside C | this lab, Q3 |
| Does D affect suggestions? | Yes — at one explicit downstream policy node; serial, attributable | this lab, Q4 lean |
| Does preference/intent depend on personalisation evidence? | No — AC-3 is the proof-shape | this lab, AC-3 |

## What this lab must still decide (decision points, owner-gated)

- **LP-1:** ratify "D = one layer, four member kinds" vs split into
  Preference / Intent / Constraints / Discovery-Controls layers.
- **LP-2:** ratify the serial downstream policy node (vs fused decision).
- **LP-3:** strength-class algebra: constraint > intent > standing
  preference > controls (draft); session override rule (AC-6).
- **LP-4:** D's provenance reuse: extend the `1a2200b`
  explicit-preference provenance shape verbatim to all D member kinds
  (stack's lean: yes — same closed 4-key shape, same legacy handling)
  vs a distinct instruction-provenance shape.

**Next step when (and only when) LP-1…LP-4 are ratified:** a synthetic
probe battery mirroring AC-1…AC-6 against the composition structures
from TW-1, built evidence-side only — never touching E or the live app
without a separate gate.

## Standing constraints (unchanged)

No recommendation machinery, ranking, scoring, taste, embeddings, model
calls introduced by this record; no weakening of provenance, unknown /
void semantics, or renderer guards; no upstream edits from Arena; E
remains a design surface like B, C, D. Gen-1 lesson stands: a
convenient field is not architecture.
