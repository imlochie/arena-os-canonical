# Lab-004 — Decision Record: user-controlled input domain (D) and the E boundary

> **Date:** 2026-09-19 · **Authority exercise:** Arena semantic authority,
> asked to RESOLVE (not enumerate). **Hold: no implementation, no code,
> no repository changes beyond this record.**
> **Current-state anchors:** arena-os-canonical @ `7c7d01b`; upstream
> Archive Assistant @ `1a2200bcbb496154f9ed9ede77059d6be9d0a1be`.
> Predecessor records: `docs/lab-004-preference-intent-investigation.md`
> (tree findings), `docs/lab-004-preference-intent-boundary.md`
> (design dialogue), `docs/gate7-claim-composition-design.md` (A/B/C/D stack).

## 1. Accepted semantic principles

**P1 — Three sentences, three meanings.**
"The user stated X", "The user prefers X", "The user wants X
recommended" name three different things. They live in different
places: (i) stated — a record fact (utterance event); (ii) prefers — a
mental attitude Arena does not observe; (iii) wants recommended — an
instruction about system behaviour. **None of them licences another.**

**P2 — User control is an orthogonal input domain (D), not a layer of reasoning.**
A, B, C reason ABOUT evidence. D is not evidence about the archive; it
is the user's authority exercised over the system. Nothing in D
competes with A/B/C because nothing in D is the same *kind* of thing.

**P3 — Statements-at-rest vs instructions.**
The one user-controlled artifact the tree already carries
(`1a2200b`-shape records) is a *statement-at-rest*: present, preserved,
questionless. Instructions differ in kind: they *bind future system
behaviour* (an utterance plus an act). The existence of a statement
record does not make it an instruction; treating one as the other is a
category error the architecture must refuse by construction.

**P4 — One-way authority.**
D → E is the only D-arrow in the system. D → {evidence, A, B, C} is a
closed door in both directions (nothing in D changes evidence; nothing
in A/B/C changes D; if a user says something TRUE about their history
("I watched horror constantly") that fact lands via upstream evidence,
not via D).

**P5 — Attribution, always.**
Any output shaped by D must name that D shaped it. Any output shaped by
A/B/C must name those layers. Fusion into an opaque weight IS the
laundering shape at full production scale (see §7, prohibitions).

**P6 — The statement/provenance model already proven is the D substrate.**
Where D members exist, they carry the closed provenance shape AND the
legacy discipline VERIFIED at `1a2200b` (`preferenceId / source /
observedAt / scopeIdentity`, `additionalProperties: false`,
authoritative-vs-legacy, legacy→never upgraded). One rule, all member
kinds. (Decision LP-4 resolves: reuse, not re-invent.)

## 2. Rejected alternatives (with reason)

| Alternative | Verdict | Why |
|---|---|---|
| D as part of the evidence pack (D members as evidence rows consumed by A/B/C) | **REJECTED** (partially: statements already ride the pack *at rest*, but with zero reasoning consumption) | First laundering hole: statement rows would become floor inputs |
| D as a fourth reasoning layer (same lattice rules as A/B/C) | **REJECTED** | D does not argue; it instructs. Its "truth" is the record (statement-of-record), not membership conclusions |
| One homogeneous "Preference/Intent" record type for all four member kinds | **REJECTED** | Lifetime/class are load-bearing: veto ("don't") vs weighting ("more") vs session ("tonight") vs config (sliders) are non-interchangeable; collapsing erases the very distinctions the domain exists to preserve |
| D authored at E-time from recommendation feedback ("you didn't click — therefore..." ) | **REJECTED** | Reverse-flow inference — E-action → "preference" — with NO provenance the user ever authorized |
| Ordering preferences by arbitrary scores (numerical priority, recency weights) | **REJECTED** | Arbitrary numerics are product weighting in epistemic clothing; precedence must be class-shaped (see §6) |
| E with fused decision (one opaque weighting node) | **REJECTED** | Attribution becomes archaeology; the abuse case is identical to every laundering path already sealed |
| Reinterpreting C when D is said aloud ("the user really means they don't like it") | **REJECTED** | That is preference-inference from instruction latency — forbidden transformation FT-2/FT-4 |

## 3. D taxonomy decision

**D exists.** It is a single **authority domain** (one seam against
evidence) containing **four distinct member kinds** — kinds are not
layers. Records are per-kind typed; each carries: the closed
provenance shape (per P6), kind, lifetime, scope, and content.

| Kind | Example | Lifetime | Scope | Declarative | Authority class |
|---|---|---|---|---|---|
| **Stated preference** | "I like Wong Kar-wai" | standing until retracted-after-observed | subject/scopeIdentity | YES (content) | advisory (no act) |
| **Durable preference (instruction)** | "show me more of this kind of thing" | standing until retracted | system-visible scope only | NO (operational) | weighting (positive) |
| **Hard constraint** | "don't recommend horror", "nothing over 2 hours" | standing until retracted | whole system | NO (operational) | veto |
| **Session intent** | "something weird tonight" | session-bounded, expires declared | session | NO (operational) | episodic direction |
| **Discovery control** | familiarity/strange slider, "prioritize unwatched" | profile-scoped until changed | profile | NO (operational) | weighting (tunable) |

Epistemic status for every member: **statement-of-record** — "the user
instructed/stated this, with this provenance, at this time". There is no
deeper epistemic claim to license (and no lattice floor to compute):
the record does not assert "user likes X" or "user dislikes X" — it
asserts "record X exists". Retraction is **additive lineage** (a
retraction record, never deletion — mirroring the tree's everything-
additive doctrine); intent **lifetime declared on the record** (`expiresAt`
or `session`-bounded) — expiry is retirement-of-effort, never loss of
history. Scope is either `scopeIdentity`-equal to evidence scopes (when
talking about archive content) or explicitly `session`-/`profile`-scoped
(never treated as archive evidence scope).

## 4. Relationship to A/B/C (precise)

- **A (conclusions):** D members NEVER stand as evidence refs. A may
  quote a preference-record's *statement* only as "the user stated S"
  via the carried statement record (present today, lineage_incomplete
  as behaviour — tree-pinned); every other D member is invisible to A.
- **B (composition):** under TW-1's draft (bundles of evidence-typed
  entries), D may **never** be a bundle member in the evidence sense —
  because B is a structure *about the archive*. A presentation layer
  may *position* D members adjacent to A/B/C content (clearly labelled
  "you instructed"), but B membership with a D record inside is a
  category error and remains gated until owner review under a future
  composition rule (currently: forbidden).
- **C (interpretation):** D members are **not** floor inputs and
  **not** quotable inside interpretation claims, period. A
  presentation may sit an interpretation "adjacent to acknowledgement
  of D" (see E explanation), but C authored-about-D is laundering
  (§7/FT-4).

## 5. E policy boundary

**E is a bounded policy + orchestration subsystem — never reasoning,
never interpretation, never a fourth evidence-authoring lane.**

Legitimate operations for E:

| Operation | Definition under E | Yes/No |
|---|---|---|
| candidate generation | produce candidates from archive metadata + A/B/C outputs (facts, compositions, interpretations rendered honest) | YES |
| filtering | remove candidates by D-constraint / scope / metadata | YES |
| suppression | visible removal due to D-constraint (attribution mandatory) | YES |
| prioritisation | presentation ordering by D-instruction classes (declared weights) | YES |
| ranking | **prohibited when it means taste-ordering**; presentation-ordering by DECLARED D controls = allowed prioritisation above | CONDITIONAL |
| explanation | narrating attribution (see §8 grammar) | YES (mandatory) |
| interpretation | — | **NO** (C owns all meaning) |
| conclusion | — | **NO** |
| evidence authoring | — | **NO** |
| feedback/write-back into evidence, A/B/C, or D records | — | **NO** |

## 6. Authority & precedence model (semantic necessities vs product decisions)

**Semantic necessities (hard-coded in the record):**

1. **Evidence permanence:** behaviour-evidence never changes because of
   any D record (§1/P4 + the tree's frozen-transport rule).
2. **Statement permanence:** a retraction ADDS a record; the original
   keeps provenance (history is additive).
3. **Intent lifetime is declared**: cannot be inferred; expired intent
   retires inert, it does not prove anything.
4. **Constraint class = veto class**: a "no / never / don't" instruction
   is a different class from negative weighting. Breaking a veto to
   satisfy a weight is a **promise-breaking** failure, not a tuning
   choice. (Constraint > everything else is therefore semantic.)
5. **Attribution non-optional**: any E output that D touched must say D.

**Product decisions (explicitly NOT resolved here):**

1. Session intent vs durable preference when both are weighted-nature
   choices (my lean, marked product: current-intent first for its
   session, *without* hiding the durable member from attribution).
2. Discovery-control weighting curves and defaults.
3. Whether scope widening can be requested explicitly in-session
   ("ignore my horror block just tonight") — this touches veto
   honesty; owner decision required before any product-level choice
   (my lean: explicit per-session overrides allowed if highest-
   provenance (typed, authoritative) records and attribution shows the
   override, never the constraint's edit).
4. Cross-kind lifetime promotions (whether "I liked it tonight"
   eventually "fossilizes" into durable preference — my lean: NEVER
   automatic).

## 7. Forbidden transformations (FT list)

| # | Transformation | Status | What licence WOULD make it legitimate (if any) |
|---|---|---|---|
| FT-1 | behaviour → preference ("you watched X, so you like X") | forbidden (tree: producer constraint; lattice refuses) | none today; would require a certified interpretation class (C) *plus* an owner-natural-language rule and an owner-authorized renderer lane |
| FT-2 | preference → behaviour ("you stated X, so you watch X") | forbidden (P3: statement is instruction/content, not action-evidence) | none — statement never becomes behaviour-evidence |
| FT-3 | preference → enjoyment ("stated interest → enjoyment") | forbidden (lab-004 refusals, held) | none |
| FT-4 | interpretation → preference ("C says 'consistent with interest' → 'the user prefers'") | forbidden (meaning ≠ attitude) | TW-2 would need to ratify a *preference-derived interpretation* rule — no such rule exists |
| FT-5 | absence of instruction → "surprise me" | forbidden (absence is not an instruction; "surprise" is positive content) | none |
| FT-6 | recommendation choice → evidence ("we showed X → you watched it → you liked it") | forbidden (post-hoc laundering; user-action after suggestion is **feedback signal**, not evidence; if feedback evidence EVER exists it must arrive as its own provenance-backed channel via AA, never as retroactive assertion) | upstream feedback-evidence channel with own provenance — AA-gated; not decided |
| FT-7 | D member → edit/delete other layers' rows | forbidden (no write paths; frozen transport) | none (permanent architectural constraint) |
| FT-8 | E's selections → epistemic claims ("since we surfaced X, X is relevant") | forbidden (selection is response to instruction under evidence, not evidence of relevance) | none |

## 8. Recommendation explanation requirements (grammar, not engine)

Any rendered suggestion carries a **per-candidate attribution set**,
rendered through existing lanes, in this grammar:

- "**because** archive evidence supports X" — A refs (traceable to the
  certified conclusion chain);
- "**because** these things co-occur" — B members (evidence-typed entries);
- "**because** evidence is consistent with…" — C claims (own lane,
  own status word, not-established list visible on demand);
- "**because** you asked for X" — D statement/intention record id +
  provenance badge;
- "**because** you excluded Y" — constraint record id + provenance badge;
- "**because** the current session prioritised Z" — intent record
  + expiry context;
- "**because** policy selected candidate Q" — optional rule id for any
  remaining policy choice (auditable order, not opaque weight).

A suggestion that cannot produce this set in full is a defect of E,
not a tuning matter.

## 9. Adversarial resolutions (12 cases)

Columns: Evi = what is evidence; D = what is user control; C-ok = may C
speak?; E-yes = what E may potentially do; E-no = must not do; prod =
product-decision surface remaining.

| # | Case | Evi | D | C-ok | E-yes | E-no | prod |
|---|---|---|---|---|---|---|---|
| 1 | horror exposure + suppression | 14 horror watches (unchanged) | hard constraint "don't recommend horror" | yes, independently (uncoupled) | filter/suppress horror; render explanation citing constraint | infer "user moved past horror"; hide horror from *evidence* | wording of suppression explanations |
| 2 | animation exploration vs thin history | thin animation rows (unchanged) | session intent ("exploring") | yes (uncoupled from D) | boost animation candidates; attribute to session intent; expire the intent session-end | reinterpret history; add "animation appetite inferred" fact | boost strength; expiry grace rules |
| 3 | cold-start weird request | nothing (correct void) | session intent only | nothing to interpret — C silent | generate from library metadata under intent; explain D-only attribution | imply evidence; hallucinate "trend" from nothing | candidate source-quality questions |
| 4 | "I like Wong Kar-wai" | nothing new from the statement; watch rows (if any) stand as-is | stated preference (advisory) | yes (about evidence, uncoupled) | surface attribution "user stated"; tie no commentary to it | convert statement into "preference fact"; pad C with it | display wording |
| 5 | "nothing already watched" | watch history intact | hard constraint (scope: watch-history membership) | n/a | filter by history (history = A-derived fact, usage permitted) | infer taste from the filter; drop history queries invisibly | none on A side; query UX |
| 6 | "surprise me" | evidence stands | positive discovery-control instruction (novelty bias) | n/a | diversify candidate selection; attribute the instruction | treat absence-of-constraint as permission | diversification policy is product |
| 7 | "more of what I've been watching" | watch pattern (A-describable) | durable preference instruction | yes, uncoupled | weight toward current-patterns; attribute | equate pattern-match with preference-verified | weighting rule choice |
| 8 | "nothing longer than 2h" | runtime metadata rows | hard constraint | n/a | filter by metadata (∀ runtime>2h out); attribute | interpret as "dislikes slow cinema" | metadata quality caveats |
| 9 | durable X vs temp not-X | both records stand | conflict: durable preference intent-inverted by session intent | n/a | apply precedence (constraint rule free of weights → product choice, lean: current intent governs **for the session**, durable member still attributed as "on hold, not edited") | silently cancel; keep durable invisible | the session-vs-standing weight call IS product-shaped (§6 PD-1) |
| 10 | intent expires, preference remains | all records stand, intent inert | lifetime transition only | n/a | revert to durable-only policy; attribution may show expiry boundary | treat intent's expiry as retraction of intent OR as evidence the user "changed their mind" | expiry windows |
| 11 | preference retracted, history intact | history (unchanged); statement record + retraction record (both additive) | retraction event | yes, uncoupled | apply retraction's effect at E (no weight forward); history queries still truthful | delete statement record; treat behaviour as rebutting the retraction | n/a |
| 12 | scope mismatch (limited scope) | evidence scoped accordingly | scoped instruction | n/a | apply instruction only within its scope; outside scope, instruction is absent (not extended) | silently generalize; fabricate "preference applies everywhere" | how scopes are user-visible |

## 10. Unresolved product decisions (enumerated)

PD-1 session-intent precedence vs durable members (§6 PD-1);
PD-2 discovery-control weighting shapes/defaults;
PD-3 session-scope override semantics for veto-class instructions;
PD-4 expiry grace rules (e.g., "weekend" ambiguous spans);
PD-5 diversification policy for "surprise me";
PD-6 user-visible scope taxonomy (what scopes CAN a user address);
PD-7 presentation of C content in suggestions where D suppressed some
evidence — does C render over the full evidence set or the post-
policy candidate set? (lean post-policy, marked clearly — product).

## 11. Questions Archive Assistant must answer BEFORE any future implementation gate

1. Will AA provide an **instruction surface** (new contract collection)
   for D members, per-kind typed (statement / durable / constraint /
   session-intent / controls)? If not, the entire D side remains
   product-local, and E's lineage dies at the device boundary.
2. For each kind, will the **closed provenance shape** (per P6 —
   reusing the `1a2200b` PreferenceProvenance pattern) be mandated?
   With what source values (e.g., `operator_statement` for statements;
   `operator_instruction` for operational kinds)?
3. **Retraction semantics:** additive records (preferred) vs deletion?
4. **Expiry shape:** `expiresAt`/session token stored by the producer,
   or declared by the consumer? (Stack lean: producer declares, the
   consumer never invents expiry times.)
5. **Scope vocabulary:** how would target scopes map onto archive
   scopeIdentity domains (media / genre / entity / profile / session)?
6. **Entity reference resolution:** for "more like this" / "exclude
   that director", how does the "this/that" entity identity resolve
   unambiguously (subjectIdentity keys)?
7. **Cross-repo transport**: does the personalisation-context contract
   grow a new typed collection, or a separate narrow endpoint?
8. **Audit authority:** which side owns the retraction/expiry ledger —
   must be visible through the same verified-provenance-standard
   discipline as the preference seam (same guarantee: no silent
   upgrades, legacy stays legacy).

## 12. Implementation hold (hard, stated twice on purpose)

This record RESOLVES semantics. It does not license any code. Nothing
in this document authorizes: runtime edits, contract edits, new types,
fixture edits, prompt edits, E scaffolding, policy code, upstream
edits, or any claim that "D/E now exist." The next legitimate action
is owner ratification of LP-1…LP-8 (investigation doc) plus answers to
the eight AA questions above — in that order; only then does any
implementation conversation start. Gen-1 lesson stands on the door.

## Cross-references

- `docs/lab-004-preference-intent-investigation.md` (tree findings + adversarial grid);
- `docs/lab-004-preference-intent-boundary.md` (owner dialogue drafts);
- `docs/gate7-claim-composition-design.md` (stack + TW-1/TW-2);
- `docs/e2e-gate7-preference-provenance.md` (verified provenance substrate);
- `src/lib/personalisation/generated/contract.ts`, `src/lib/archive-reasoning/lattice.test.ts`, `scripts/fixtures/real-evidence-upstream-capture.json`, `src/lib/archive-assistant/fixtures.ts` (tree anchors for all current-state claims).

---

## 13. Owner ratification and close-out (append-only; 2026-09-20)

This section is **append-only**. It records *that* the analysis above was ratified and *when*; it modifies, extends, or reinterprets **nothing** in sections 1–12. The distinction is deliberate and must be preserved: sections 1–12 record **what was decided**; this section records **when and how it became ratified**.

1. **The owner reviewed and accepted the resolved architecture.** On 2026-09-20 the status of this artifact changed from *Arena-side resolved analysis* to **owner-ratified cross-repo architecture**.
2. **The normative arrow rules govern; diagram layout is illustrative.** The forbidden-arrow list and the E/D direction defined in sections 4, 5 and 7 are the authority. Any architecture diagram — including the owner's own — is a rendering. If a diagram appears to show D feeding A, B, or C, or E feeding the epistemic layers, **the diagram is wrong, not the arrows**. Future readers who conclude "surely D feeds C here" from a picture must be pointed to this sentence.
3. **A/B/C and D→E remain orthogonal axes.** A/B/C is the epistemic axis (*what is true?*); D→E is the authority axis (*what may we do?*). Authority carries no epistemic strength; epistemic support carries no authority. Neither axis borrows from the other.
4. **Architecture is resolved; the implementation contract is not.** Lab-004 is closed at the architecture level. The runtime contract — shape, transport, provenance mandate, scope vocabulary, entity resolution, audit authority — remains uninvented and must not be inferred from this record.
5. **Everything recorded as open remains open, exactly as recorded.** Nothing here narrows, merges, or advances any open item: product decisions **PD-1…PD-7** (§10), the **eight Archive-Assistant questions** (§11), and **TW-1 / TW-2** (outside Lab-004 scope; owner draft positions, still unratified).
6. **The hard implementation hold (§12) is unchanged.** This ratification opens no build gate. The eight AA questions of §11 are the entrance to the next gate, whenever the owner chooses to open it — and nothing builds before that gate.
7. **Ratification date: 2026-09-20.**

*Lab-004 is closed at the architecture level. The next gate begins at the eight AA questions, not here.*
