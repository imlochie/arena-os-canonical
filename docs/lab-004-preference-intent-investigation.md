# Lab-004 — Preference & Intent: tree-first semantic investigation (discovery report)

> **Date:** 2026-09-19 · **Tree:** arena-os-canonical @ lineage tip
> (`e98da31` + report) · **Upstream:** `1a2200bcbb496154f9ed9ede77059d6be9d0a1be`
> (Archive Assistant personalisation contract, verified last slice).
> **Method:** every finding cites the file:line it was read from in the
> current tree. This report supersedes no prior record; it *grounds* the
> earlier design dialogue (`docs/lab-004-preference-intent-boundary.md`)
> in tree facts. **Nothing here implements anything. Implementation
> hold at the bottom is a hard gate.**

## 1. Findings from the tree (what preference/intention-like concepts actually exist)

| # | Surface | Where | Classification |
|---|---------|-------|----------------|
| 1 | **Typed explicit-preference record** — the only living preference semantic | `src/lib/personalisation/generated/contract.ts` (`PersonalisationExplicitPreference`, 8 required fields) + `scripts/fixtures/real-evidence-upstream-capture.json` (real producer rows, canonical + legacy) | **Semantic construct** (transport-carried, provenance-typed, verbatim-preserved) |
| 2 | **project_memory `kind=preference`** — Arena's OWN chat-domain statement store | `src/db/schema.ts:197` (kind enum `fact\|decision\|preference\|…`), injected into Council/Collab/Battle prompts (`src/lib/projectContext.ts`, audit doc §3.1 verified call sites); **not** consumed by `runChat` (`src/lib/chatRunner.ts` assembles from `system` + archive pack only) | **Semantic construct, different domain** (project assistance, not media/archive; user-authored text, no provenance shape, no epistemic treatment) |
| 3 | **Gen-1-era briefing vocabulary** — `discovery.{upcoming, recentlyReleased, trending, suggestedForYou}`, `watchlist`, `personalizedBriefing`, `blocked` counts | `src/lib/archive-assistant/generated/contract.ts` (`DiscoverySections` schema incl. `suggestedForYou`), `src/lib/archive-assistant/fixtures.ts:150-162` (all emitted `not_available`, empty items), `src/lib/archive-assistant/context.ts` (workload-state enum contains `blocked` — a workload triage state, not a preference) | **Presentation vocabulary held as absence** — contract-kept, never computed, `not_available` + `[]` everywhere. The only "recommendation-shaped" mechanism in the older AA subtree is this *inert* shape. Gen-1 rule: held, never revived |
| 4 | **Recommendation-shaped language, wrong domains** | workforce model routing (`src/app/api/workforce/route.ts` — Elo-informed model choice), template prose (`/api/templates/route.ts` — "give me a clear recommendation"), `localEngine.ts:203` ("intent, constraints, next step" — generic chat signal list) | **Unrelated recommendation-shaped language** — none of it media/archive semantics; none of it instruction-bearing |
| 5 | **Producer-declared seam constraints** | `scripts/fixtures/real-evidence-upstream-capture.json` `constraints`: `"Signals are observations, not likes or preferences"`, `"No universal taste score"`, `"No recommendation decision is made here"` — carried verbatim through normalization (driver row asserts) | **Transport-level constraint declarations** — the producer itself forbids preference semantics on its behavioural channels |
| 6 | **Intent / discovery controls / exclusion / suppression / prioritisation vocabulary** | none | **ABSENT from the tree entirely** (grep across `src/` non-test: zero intent/discovery-control/instruction semantics). Nothing in Arena can currently *receive* "don't recommend horror", "surprise me tonight", "prioritize unwatched", sliders, or any instruction of any kind |

**Tree summary:** Arena currently has **no instruction semantics at
all**. It has (i) one provenance-typed *statement record* arriving from
upstream (surface 1), (ii) one unrelated project-domain preference text
store (surface 2), and (iii) inert Gen-1 presentation vocabulary held
as absence (surface 3).

## 2. What Arena receives from Archive Assistant about explicit preferences

From the verified contract + real capture (`1a2200b`), per item:
`preferenceId` (numeric row id), `subjectType`, `subjectIdentity`,
`statement` (operator's own words), `scopeIdentity`, `observedAt`,
`provenanceStatus` ∈ {authoritative, legacy}, `provenance` ∈ {closed
4-key shape `{preferenceId, source: operator_statement, observedAt,
scopeIdentity}` when authoritative; `null` when legacy}.
Normalization: **verbatim passthrough** into the frozen pack
(`src/lib/personalisation/context.ts`: `explicitPreferences:
wire.explicitPreferences` — no reshaping, no class added).

**What survives at the boundary (provenance + epistemic):** all eight
public fields byte-verbatim; the closed provenance shape;
authoritative-vs-legacy classification; *what does not survive —
because it was never shipped*: any behavioural lineage handle
(observation ids, event ids, batch ids), any epistemic status field
(preference rows carry **no `epistemicStatus`** — lattice test comment
at `lattice.test.ts:252` documents exactly this: "no status and no
lineage in the current contract"), any preference *semantics beyond the
statement itself*.

## 3. Legitimate recommendation semantics today?

**None.** The inventory shows: one inert Gen-1 schema (held absent),
two unrelated-domain "recommendation" strings, zero candidate/ranking/
selection/filtering machinery, zero preference→output paths. The
producer additionally **declares** ("No recommendation decision is made
here") that its seam carries none. The audit doc (§2.1–2.4, file-cited)
reaches the same verdict: recommendation *vocabulary* exists in three
unrelated corners; recommendation **semantics ABSENT**.

## 4. Semantic classification: what is an explicit preference, under this tree?

Determination (tree-grounded):

- **It is evidence at transport level** — `explicitPreferences` is a
  load-bearing evidence collection (`types.ts:48`, `EVIDENCE_COLLECTION_KEYS`).
- **It is NOT conclusion-bearing** — items carry no `epistemicStatus`
  and no lineage handles; the lattice refuses any restatement with
  `lineage_incomplete` (`lattice.test.ts:252-263`, e2e VOID row in the
  real-evidence battery). This is *designed*, not broken (preference
  verification ledger §epistemic).
- **It is NOT behaviour** — the provenance shape explicitly contains no
  event handles (upstream code-tree at `1a2200b`; Arena tripwire row:
  "no event/batch ids substitute for preferenceId").
- **It is NOT an instruction** — nothing in the tree consumes it; an
  instruction is only meaningful where mechanism may act on it, and no
  mechanism exists.
- **It IS an identified statement with source, observation time, and
  scope** (exactly the seam's verified claim).

So: **evidence-carried operator statement; conclusion-blocked by
design; instruction-shaped semantics absent; recommendation void.**

5–8‑series answers compressed for the table: (7) *current intent should
never be treated as 'archive evidence'* — if intent ever gets a surface,
its provenance must live in the intent record (user-authored), never
migrate into behavioural channels; (8) whether it participates in A/B/C:
under **this** tree the preference collection is addressable but always
refused; B (design-held) may carry it as an evidence-typed member with
status adjacent (TW-1 draft); whether it enters C's licensing is the
Q3 wall (never as floor input — the floor belongs to A/B members).

## 5. Arrow legitimacy (tested against the tree, not prose)

| Arrow | Legitimate? | Tree anchor |
|---|---|---|
| behaviour → preference | **Forbidden** | producer constraint "not likes or preferences"; lattice refusals on any preference-typed conclusion |
| preference → behaviour | **Forbidden** | preference provenance is not behavioural lineage (verification ledger row) |
| interpretation → preference | n/a today (no interpretation channel populated upstream; would inherit the same wall: an interpretation does not establish preference) | `interpretations: []` in real capture |
| preference → recommendation | **No channel exists** | §3 (no recommendation semantics in tree) |
| recommendation → preference | n/a | same |
| other layers → user instruction | **No write path** | frozen transport; no mutation api |

Only one arrow exists today at all, and it is transport-only: upstream
statement → Arena evidence preservation.

## 6. The semantics that must never collapse (preservation rules, tree-backed)

"The user likes X" ⇎ "The user wants more X" ⇎ "Recommend X." Distinct:
the tree carries the FIRST only (statement records). It carries NO
commitment that the user wants more (no want-channel), and NO mechanism
to recommend. "Do not recommend X" ⇎ "The user does not like X": under
this tree the second is never derivable (behaviour→preference wall from
the producer's own constraint line). A night-scoped utterance ("something
weird tonight") has zero vocabulary in-tree — if it ever lands, its
record must say session-scoped by construction (lifetime is part of the
instruction's own shape, never inferred).

## 7. Adversarial grid (13 cases × the 8 required questions)

Legend: E=evidence; C=includes a conclusion today?; I=instruction,
licensed?=needs epistemic licensing to act on; A/B/C=can participate;
GEN=affects candidate generation; RANK=affects ranking/filtering;
KEEP=what stays unchanged. All answers reference the tree state at this
commit; "design-held" marks the B/C/D membership questions pending
owner ratification.

| # | Case | E? | C? | I? | licensed? | A/B/C? | GEN? | RANK? | KEEP unchanged |
|---|---|---|---|---|---|---|---|---|---|
| 1 | preference contradicts observation ("no horror" vs 14 horror watches) | statement ✓ (carried) | ✗ by design | ✗ (nothing acts) | n/a — no mechanism | addressable→refused (A); design-held B/C | ✗ | ✗ | observation rows; C-floor inputs |
| 2 | preference with no behavioural evidence | statement ✓ | ✗ | ✗ | n/a | same as 1 | ✗ | ✗ | everything (void elsewhere stays void) |
| 3 | temp intent contradicts long-term behaviour | intent rows: **absent from tree** | — | — | — | — | ✗ | ✗ | history frozen in any case (no write path) |
| 4 | temp intent expiring | absent | — | — | — | — | ✗ | ✗ | expiry is a shape question if a surface ever lands; standing history never edits |
| 5 | session-scoped preference | absent | — | — | — | — | ✗ | ✗ | lifetime must be declared on the record itself, not inferred |
| 6 | archive-scoped preference | statement ✓ | ✗ | ✗ | n/a | as 1 | ✗ | ✗ | n/a |
| 7 | exclusion vs negative preference | exclusions absent; "blocked" occurs only as workload-triage state enum in the other subtree (`archive-assistant/context.ts` state for queue triage) | ✗ | ✗ | n/a | ✗ | ✗ | ✗ | distinction: exclusion is an *action veto* (E-side), negative preference an *instruction content*; tree has neither |
| 8 | "surprise me" | absent | — | — | — | — | ✗ | ✗ | must not collapse into "has no constraints" — it is a positive instruction |
| 9 | "more like this" | absent | — | — | — | — | ✗ | ✗ | the referent (this) may have evidence; the instruction itself is D-shaped only |
| 10 | "nothing I've already watched" | absent | — | — | — | — | ✗ | ✗ | watch history CAN filter a candidate space (A-derived fact); the *instruction* is still not evidence of taste |
| 11 | instruction about an entity with no evidence | absent | — | — | — | — | ✗ | ✗ | void on evidence side must not fabricate (if D ever queries evidence, "not watched" reports void) |
| 12 | instruction with incomplete provenance | legacy-case analogous ✓ (mirrors the seam's provenanceStatus=legacy) | ✗ | ✗ | if it ever lands: conserve + never upgrade (already the seam's verified rule) | ✗ | ✗ | ✗ | null stays null — surfaces 1's exact discipline must hold for any D member |
| 13 | instruction with identity but no behavioural lineage | statement ✓ (this is every preference today) | ✗ | ✗ | n/a | addressable→refused | ✗ | ✗ | provenance of statement ≠ provenance of behaviour (the verified split) |

**Pattern the grid forces:** every current-tree answer in the GEN and
RANK columns is ✗, because *nothing exists to affect* — and every case
preserves the evidence side *unchanged* because there is structurally
no write path. The grid's real content is what it proves about a future
D surface: it must answer these eight questions with closed shapes
**before** any mechanism can exist.

## 8. Epistemic treatment (draft, tree-constrained)

- User-authored instruction records, if added, are **user-authored by
  provenance** (same class as the operator-statement provenance at
  `1a2200b`): they carry *who said it, when, scope* — and no claim of
  behavioural support. Their truth-status is *statement-of-record*
  (the user did instruct this), never *preference-of-user* (the user
  likes/wants anything).
- They require **no epistemic licensing to hold** (like the preference
  record today); they require **mechanism-level authority** only where
  they would act (E-side): authority = attribution + class algebra
  (constraint > intent > preference > controls), not epistemic status.
- Interpretation of behaviour NEVER consumes them (Q3 wall, lab-004
  draft — tree-consistent: C floors come from A/B members only).

## 9. Authority & recommendation boundary (draft, tree-constrained)

- **Authority boundary:** D's authority is exactly "what the user asked
  the system to do" — exercised only at a downstream policy node in E
  (attributable). D never overrides, edits, or annotates A/B/C rows
  (tree: no write paths exist; this must remain true by design).
- **Recommendation boundary:** E accepts A (licensed statements)
  + B (structures) + C (licensed interpretations) + D (policy) as
  SEPARATE inputs and must attribute every candidate/suppression to
  named layers. Current tree has no E at all — this boundary is a
  rule ready so that the day E starts, the attribution question ("why
  is horror suppressed?") is answerable by construction rather than by
  weight archaeology. Mechanically: candidates come from archive
  metadata + evidence classes, policy comes from D; policy may hide,
  never launder.

## 10. Refusals — what Arena must explicitly refuse to infer from preference/intent

1. A user's *like/dislike* of anything (behaviour→preference + preference→behaviour walls);
2. that an instruction predicts behaviour (instruction → behaviour);
3. that observed behaviour validates or refutes an instruction;
4. that "did not recommend X" implies anything about taste (E-action ⇏ taste);
5. that session intent carries taste information beyond its session;
6. that legacy/unverifiable instruction rows carry verified status (mirror: legacy provenance stays null, may inform, never veto);
7. that any D member may upgrade/suppress differences in A/B/C rows (no cross-layer editing — including not "noting" inside interpretations);
8. that E's selections carry epistemic claims about the archive (selections are answers to D + A/B/C, not evidence).

## 11. Smallest future seam (if D is justified) — determinations

- **Adapter sufficiency for preferences: PROVEN** — the current contract
  already carries the typed preference shape verbatim (verification
  ledger 21/21). No work.
- **For instruction/intent/controls: an UPSTREAM surface is the
  smallest seam, and it is not yet decided to be opened.** The current
  personalisation contract has no instruction collection; upstream owns
  it (same producer discipline: closed provenance, typed record,
  legacy classification). Arena-side, the smallest downstream delta is
  one registered evidence-collection passthrough in
  `normalizePersonalisationContext` (same pattern as
  `explicitPreferences: wire.explicitPreferences`) **only when and if**
  such a contract lands. That registration is a receipt, not an
  instruction semantics — semantics belongs to E's policy node (§9).
- **The E policy node itself is the only genuinely new mechanism**
  the current architecture would need — and it must be its own gate,
  separate from any evidence seam.

## 12. Unresolved decisions (enumerated)

1. LP-1 (from lab-004): D one layer with member kinds vs separate layers. **This investigation's evidence slightly favours the one-layer + kinds framing** (kinds differ only in lifetime/class, not in their boundary contract against evidence).
2. LP-2: serial downstream policy node vs fused decision — held, draft-lean serial for attribution.
3. LP-3: class algebra (constraint > intent > standing preference > controls) + session override rule — held.
4. LP-4: provenance shape for D members — stack's lean: reuse the closed 4-key shape from `1a2200b` verbatim.
5. Whether D members ever enter C **as non-floor supporting-mentions** (remarked, not licensed) — unresolved; Q3 wall remains hard for floors.
6. Whether session-intent expiry is a stored shape (expiresAt) or computed by read-time scope — unresolved.
7. Whether E ever queries evidence to answer an instruction ("have I watched X?") — the *query* is fine (A stays A); the **interpretive framing** of the answer is a renderer-lane question — unresolved.
8. Divider between D-instruction and explicit-preference statements — the `1a2200b` record is statement-of-record about content; an instruction is about action. Possibly the same physical record carries both with a `mode` — or two records. Unresolved (upstream question when a surface exists).

## 13. Implementation hold (hard)

**No implementation of any kind is authorized by this report.** The
gaps the tree shows (no instruction surface, no E machinery, no
A/B/C/D/E scaffolding beyond A and the design-held B) are the gate:
they are *not* loopholes to patch but loaded questions for the owner.
Any future work begins with LP-1…LP-8, never with code. Gen-1 lesson:
a convenient field is not architecture; a clean report is not a slice.

## 14. Cross-references (tree)

- `docs/e2e-gate7-preference-provenance.md` — the verified seam this
  investigation inherits (21/21).
- `docs/lab-004-preference-intent-boundary.md` — the owner's design
  dialogue this report grounds (Q1–Q4 drafts; LP gates).
- `docs/gate7-claim-composition-design.md` — A/B/C/D stack, TW-1/TW-2.
- `docs/recommendation-architecture-audit.md` — prior file-cited repo
  audit this report's §1/§3 align with and spot-verified.
- `src/lib/archive-reasoning/lattice.test.ts:252`; `src/lib/personalisation/context.ts`;
  `src/lib/personalisation/generated/contract.ts`;
  `scripts/fixtures/real-evidence-upstream-capture.json`;
  `src/lib/archive-assistant/fixtures.ts:150-162`;
  `src/db/schema.ts:197`; `src/lib/projectContext.ts`.
