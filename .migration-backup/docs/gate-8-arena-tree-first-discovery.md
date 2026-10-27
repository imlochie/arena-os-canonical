# Gate 8 Entrance — Arena Tree-First Discovery

> **Date:** 2026-09-20 · **Mission:** owner-issued Gate 8 Arena prompt (discovery /
> decision-preparation). **Read-only. No implementation, no code, no repository
> changes beyond this record.** Companion to the AA-side Gate 8 findings
> (operator-stated; AA tip `07ad2ceab79a36d673d19ec7092f198fdf48a5fc`).
> Ratified architecture: `docs/lab-004-decision-record.md` §13 (@ `8747e57`).
>
> **Categories used throughout:** CURRENT FACT (tree-proven, cited) /
> DESIGN CONSEQUENCE (follows from facts + ratified records, no new semantics) /
> UNRESOLVED PRODUCT DECISION (explicitly product, not architecture) /
> IMPLEMENTATION PREREQUISITE (must exist before code) /
> FORBIDDEN ASSUMPTION (must never be assumed despite plausibility).

---

## 0. Lineage pre-flight

Executed first, before any semantic reading, per the owner prompt and the
three-incident institutional doctrine:

| Check | Result |
|---|---|
| Repository | `/home/user/arena-os-canonical` |
| origin | `https://github.com/imlochie/arena-os-canonical.git` |
| Live remote HEAD (`git ls-remote`) | `8747e57f688e2d53b2620ee07ab00e53f5188abe` |
| Local HEAD | `8747e57f688e2d53b2620ee07ab00e53f5188abe` |
| Tracking ref | `8747e57f688e2d53b2620ee07ab00e53f5188abe` |
| Three-way agreement | **YES — first clean three-way check of this sandbox's history** |
| Ratification commit `8747e57` present | YES — and it *is* HEAD (parent `fa7c78a`, chain back through `7c7d01b`, `e98da31` verified) |
| HEAD tree | `0c881c75811616944c7046d984612fbf46eeb9e0` |
| Worktree | clean |
| Repairs made | none required (none permitted by the prompt in any case) |

**Exact commit SHA inspected: `8747e57f688e2d53b2620ee07ab00e53f5188abe`** —
all line citations below are from this tree.

**Cross-repo verification note.** The AA tip `07ad2ce…` is **operator-stated**:
this sandbox holds no AA clone and cannot verify it. What the Arena tree
*can* prove: Arena's generated personalisation contract pins upstream at
`imlochie/SomeSafePortablesoftware@1a2200bcbb496154f9ed9ede77059d6be9d0a1be`
(`src/lib/personalisation/generated/contract.ts:6,27`, header + machine meta;
the pin is test-enforced at
`src/lib/personalisation/personalisation-adapter.test.ts:107,307`).
The string `07ad2ce` appears nowhere in the tree. **CURRENT FACT: Arena's
transport snapshot precedes AA's Gate-8 tip by definition.** Any future
contract movement is an implementation prerequisite (§6), never an action of
this pass.

---

## 1. Instruction surface

### Search inventory (what was searched, what was found)

- **`explicitPreferences`** — the only user-controlled collection in the
  transport. Positions: contract property `generated/contract.ts:171–176`
  (typed `PersonalisationExplicitPreference`); required-collection list
  `contract.ts:128`; Arena receipt type is *deliberately opaque*
  (`personalisation/types.ts:43`: `readonly Record<string, unknown>[]` —
  preserved rows, not re-typed); verbatim passthrough
  (`personalisation/context.ts:66`); renderer carries a noun label only
  (`archive-reasoning/render.ts:134`); lattice refusal pin
  (`archive-reasoning/lattice.test.ts:252–263`, see §2). **No UI consumer
  exists** (`grep explicitPreferences src/app src/components` → none).
  Consumer = the reasoning seam and the e2e verification script only.
- **`constraints`** — also transported (`contract.ts:177–182`: `string[]`),
  but **semantically different**: declared *"transport constraints, not
  evidence"* (`archive-reasoning/types.ts:40–41`), and the actual payloads are
  producer meta: Arena fixture `["no_action_generation","read_only_transport"]`
  (`personalisation/fixtures.ts:150`); real upstream capture
  *"Signals are observations, not likes or preferences / No universal taste
  score / No recommendation decision is made here"*
  (`scripts/fixtures/real-evidence-upstream-capture.json:511–515`).
  **These are producer statements about the pack, not user-declared
  constraint D-members.**
- **intent / instruction / constraint / exclusion / suppression vocabulary**
  — hits only in unrelated domains: battles judging, collabs iteration,
  council, chat, `cognitiveJobs.ts`, `localEngine.ts`, `models.ts`,
  `projectContext.ts` (LLM-prompt vocabulary), and an auth-header comment
  (`archive-assistant/client.ts:103`). None touch the personalisation seam.
- **novelty / familiarity / surprise / prioritisation** — one hit:
  `strategies.ts:71` ("The Prioritizer") — a content-strategy persona name.
  Unrelated.
- **project_memory `kind: "preference"`** — `src/db/schema.ts:194–197`:
  Arena's own project-conversation memory domain
  (`fact|decision|preference|open_question|rejected_idea|source`).
  **Unrelated domain: conversational memory about Arena projects, not archive
  user control. Must never be conflated or repurposed.**

### Per-surface profile of the one surface that exists

| Property | `explicitPreferences` (as transported at `8747e57`) |
|---|---|
| source | AA (upstream-authored rows) |
| authority | AA (Arena holds no authority; GET-only client, §7) |
| lifetime | **no lifetime fields present in Arena's view** |
| scope | `scopeIdentity` string (opaque, upstream-scoped) |
| provenance | closed `PreferenceProvenance` + `provenanceStatus` (§2) |
| consumer | reasoning seam (Gate-7 lattice/renderer), e2e script |
| write path | **NONE — client refuses non-GET at runtime** |
| read path | `fetch → validate (generated snapshot) → normalize verbatim` |

### What Arena actually has — and does not have

- **CURRENT FACT:** the one typed user-control surface transports
  *statements-at-rest* (fixture exemplar `fixtures.ts:147–148`:
  `subjectType:"subject"`, `statement:"block this subject"`,
  `provenanceStatus:"authoritative"` + closed provenance). This maps onto
  exactly **one** of the ratified D kinds: *stated preference*.
- **CURRENT FACT:** durable instruction, hard constraint, session intent, and
  discovery control have **no transport presence** at `8747e57` — no
  collection, no field, no enum value. They exist only as architecture
  (decision record §3), not as tree.
- **FORBIDDEN ASSUMPTION:** vocabulary is not implementation. The words
  "constraint", "intent", "prioriti*" appearing elsewhere in the repo are
  unrelated domains; none license treating those mechanisms as D.

### Required decision (Q1)

**Arena currently has no authoritative instruction surface of its own.**
What Arena can consume from AA without inventing a new source: the typed
`explicitPreferences[]` collection (statement-of-record rows) and the declared
transport `constraints[]` (producer meta — to be respected as transport terms,
never read as user instructions). Every other D member kind requires an
upstream surface that does not yet exist (ratified record §11 Q1).

---

## 2. Provenance mandate

### What Arena preserves today (tree-verified)

- The transported preference row carries `preferenceId, subjectType,
  subjectIdentity, statement, scopeIdentity, observedAt, provenanceStatus,
  provenance` (`contract.ts:188–195`); `provenanceStatus ∈
  {authoritative, legacy}` (`contract.ts:218–224`); `provenance` is nullable
  (`contract.ts:226–231`) — **legacy rows carry `null`, and null is preserved
  as null**.
- `PreferenceProvenance` is **closed**:
  `preferenceId / source / observedAt / scopeIdentity`,
  `source ∈ {operator_statement}` (sole value),
  `additionalProperties: false` (`contract.ts:385–410`).
- The adapter crosses everything verbatim and adds **only transport
  labeling wrapping the evidence, never inside it** (`context.ts:21–25, 48–69`;
  transport meta marked *"deliberately NOT an epistemic field of any evidence
  item"* — `types.ts:47–57`).
- The seam never upgrades epistemic status: *"upstream `derived` stays
  `derived`; a missing optional field stays missing"* (`context.ts:16–18`).
- **Second wall**: the reasoning lattice refuses a preference row as
  load-bearing with `lineage_incomplete` — the pin comment states *"no status
  and no lineage in the current contract"* — and refuses provenance-less
  evidence generally (`lattice.test.ts:252–263`, `:267–290`). The renderer
  adds a vocabulary firewall (`render.ts:46–47`, §8).
- The preference-provenance seam is e2e-pinned (21 cases,
  `scripts/e2e-gate7-preference-provenance.mjs`).

**CURRENT FACT: nothing in the transported preference content is converted
into archive evidence anywhere.** The only reasoning-layer touch is refusal.

### User-control provenance ≠ watch-event provenance

This distinction is **structurally enforced**, not a style rule: the two
schemas cannot parse as each other. `PreferenceProvenance` = four closed
fields above; watch-side provenance (`SignalProvenance`,
`contract.ts:414+`) requires `derivedFrom, observationIds, eventIds,
evidenceKeys, providerEventIds, ingestionBatchIds, batchIds,
eventOccurredAt, observedAt, scopeIdentity` — an entirely different, open
shape. **CURRENT FACT: Arena cannot confuse them mechanically.**

### What Arena would require per future D member (DESIGN CONSEQUENCE, not new semantics)

Per the ratified P6, **all** D kinds inherit the closed four-field
provenance shape + `provenanceStatus` + legacy-never-upgraded discipline.
Per kind:

| D member | Minimum provenance (ratified P6 shape) | Delta vs today |
|---|---|---|
| stated preference | 4-field closed shape, `source: operator_statement` | **none — transportable today** |
| durable instruction | same shape + a `source` enum value for instructions | needs AA enum extension (§11 Q2) |
| hard constraint | same shape + constraint-typed `source` value | needs AA enum extension |
| session intent | same shape **+ session/request identity + declared expiry** | **no session, request, or expiry fields exist anywhere in the seam today** (grep: none) |
| discovery control | same shape + control-typed `source` value | needs AA enum extension |

- **FORBIDDEN ASSUMPTION:** watch-event provenance must never be applied to,
  or required of, D members; and D provenance must never be applied to watch
  evidence. They are authority and observation respectively.
- **FORBIDDEN ASSUMPTION:** `provenanceStatus` is a property of the *record*,
  never a preference strength, recency score, or weight.

### Required decision (Q2)

**Minimum provenance to safely consume each D subtype: the P6 closed shape,
per-kind `source` values, plus — for session intent only — producer-declared
session identity + expiry.** Request/session identity and expiry are
represented **nowhere** today; their definition is an AA contract question
(ratified §11 Q2/Q4), not an Arena invention. *(IMPLEMENTATION PREREQUISITE.)*

---

## 3. Retraction + expiry

### What the tree contains (search results)

- Lifecycle vocabulary in `src/lib/personalisation`, `src/lib/archive-reasoning`,
  and the e2e script: **ABSENT**. The single `expired` hit is a bearer-token
  auth test (`personalisation-adapter.test.ts:275`) — authentication, not
  D lifecycle.
- The eight required preference fields contain **no lifecycle field**, and the
  closed provenance shape cannot carry one (`additionalProperties:false`).
- Request/session lifecycle infrastructure in the seam: **none** (grep for
  `session`, `requestId`, `expiresAt` in `src/lib/personalisation` → nothing).
- **CURRENT FACT about transport semantics:** the single GET is a
  *snapshot*. From Arena's seat, a row absent from a later fetch is
  **indistinguishable** between withdrawn / deleted / expired. Arena has no
  basis to choose, and any choice would be invention.

### The distinctions the owner required, stated against this tree

| Pair | Arena's current ability |
|---|---|
| withdrawal ≠ deletion | **cannot represent either** — absence is undifferentiated |
| supersession ≠ mutation | cannot represent supersession; rows are verbatim-per-snapshot |
| expiration ≠ deletion | cannot represent expiration — no expiry fields exist |
| ignored ≠ withdrawn | "ignored" is a policy act; no policy layer exists (§8) |
| conflicted ≠ expired | no conflict semantics exist anywhere in the seam |

**FORBIDDEN ASSUMPTION:** inferring withdrawal, expiry, or supersession from
row disappearance or row change. Absence carries no lifecycle meaning in this
transport.

### Required decision (Q3)

**Arena can currently consume safely: presence and absence of
authoritative-vs-legacy rows *within one snapshot* — nothing more.** Safe
consumption of withdrawn / expired / superseded / deleted states requires
producer-declared lifecycle representation (additive retraction records;
producer-declared expiry — both per the ratified record's leans) delivered
through the contract **before** implementation. *(IMPLEMENTATION PREREQUISITE;
AA Q3/Q4.)*

---

## 4. Scope vocabulary

### Inventory (every scope concept in the tree that could interact with D)

| Concept | Status at `8747e57` |
|---|---|
| `scopeIdentity` (transport) | plain `string`, **no enum** (`contract.ts:212–214`); observed values are upstream-scoped strings: `"plex:movies-v1"` (×13 in the real capture), `"jellyfin:account-main:all"` (`fixtures.ts:141`); local fixture constant `SCOPE_TV` (`fixtures.ts:147`) |
| lattice reasoning scope | `"archive"` (used in lattice tests); a reasoning-scope marker, not a transport vocabulary |
| owner | enforced **upstream** — the endpoint *"is owner-scoped upstream from the forwarded server-to-server"* auth (client header doc, `client.ts:11–16,103`); Arena holds **no owner parameter** (cannot address any other owner) |
| project / conversation | Arena domain (`schema.ts` project tables); **unrelated to D** |
| UI scope surfaces for D | **none** (no UI consumer of preferences) |
| session / request | **absent** (§3) |

### Compatibility rules

- **CURRENT FACT:** there is **no** scope enum, no containment relation, no
  narrowing/widening semantics, and **no D-scope ↔ A/B/C-scope compatibility
  rule** anywhere in the tree.
- Scope strings from different vocabularies coexist with no algebra:
  `"plex:movies-v1"` (provider:library), `"movie:example"` (subject identity),
  `"archive"` (reasoning marker).

**FORBIDDEN ASSUMPTION:** `scopeIdentity` string equality (or prefix match)
means semantic scope containment. Provider-prefixed strings and subject
strings are different vocabularies; **same subject identity ≠ same semantic
scope**.

### Required decision (Q4)

**Minimum scope compatibility information before D may influence E:**
(i) a scope-domain tag on every D row (whole-archive / library / media-type /
subject / session / profile), (ii) a declared relation between a D row's
scope and the evidence scopes it may govern (containment, or
declared-orthogonal), (iii) a named owner of the mapping (AA Q5 — the ratified
record routes this upstream). None of this exists today; none may be invented
Arena-side. *(IMPLEMENTATION PREREQUISITE.)*

---

## 5. Entity resolution

### Inventory of resolution mechanisms

| Reference kind | Tree status |
|---|---|
| operator-declared subject | exists as **opaque strings** only — `subjectType`/`subjectIdentity` (`contract.ts:203–211`; fixture `"subject"` / `"movie:example"`). No resolution, matching, or alias machinery. |
| archive identity | upstream-owned; Arena never mints or rewrites it |
| provider identity | visible only inside scope strings (`"plex:…"`, `"jellyfin:…"`); no provider registry Arena-side |
| candidate identity | **does not exist** — no candidates exist (§8) |
| semantic category ("horror") | **no genre/category taxonomy anywhere** — `horror` appears nowhere in `src/` |
| duration class ("short movies") | runtime may exist upstream as evidence facts; Arena holds **no classifier** |
| natural-language reference ("something weird", "this director") | **no parser, no resolver**; and the renderer's forbidden-vocabulary guard actively bans affect/second-person language from claims (`render.ts:46–47`) |

**CURRENT FACT:** existing candidate-ish machinery elsewhere in the repo
(battles judging, model staffing, strategy personas) is not media-entity
resolution and is explicitly not counted.

**FORBIDDEN ASSUMPTIONS:** identity matching is not preference
interpretation; and no existing matching mechanism — if reused — becomes
recommendation policy by that reuse.

### Required decision (Q5)

**Entity resolution siting is genuinely unresolved** — a product/architecture
decision, not derivable from this tree. What the ratified architecture *does*
fix: resolution must not happen ad hoc **inside E**; the binding a D row
carries must arrive typed (from the producer, per AA Q6) or through a
dedicated resolution contract. Whether the resolver is AA-side, a shared
contract, or a separate service is **UNRESOLVED PRODUCT DECISION** (joins
PD-list; Arena invents nothing).

---

## 6. Transport shape

### What Arena receives today (tree-verified)

- **Single operation:** `GET /assistant/personalisation-context`
  (`contract.ts:30` `personalisationOperations`; the client throws on any
  non-GET operation — `client.ts:73–76`).
- **Eight collections cross verbatim** (+`domain`): `facts, observedSignals,
  temporalSignals, collectionFacts, interpretations, uncertainties,
  explicitPreferences, constraints` (`context.ts:59–67`), deep-frozen, order
  and identity untouched.
- Ingress validation against the generated snapshot (`validate.ts`; the
  snapshot is byte-reproducible from the pinned upstream spec).
- **CURRENT FACT:** for user-controlled state the transport is exactly
  `explicitPreferences[]`. There is **no** `requestIntent`, no user
  `constraints` channel, no `discoveryControls`, no session channel. The
  existing `constraints[]` string array is producer transport meta (§1) and
  must stay non-input to policy.

### The two candidate shapes, compared without choosing for symmetry

- **Per-kind collections** (today's pattern, extended): `explicitPreferences`,
  `requestIntent`, `constraints`, `discoveryControls` as distinct typed
  collections. Matches the existing eight-collection transport idiom; kind is
  positional (collection name); per-kind schemas can be independently closed.
- **Single discriminated D envelope**: one collection, closed `kind` enum,
  per-kind payloads. One seam instead of four; kind is a field.

**DESIGN CONSEQUENCE (from ratified §11 Q7, not a new decision):** the choice
between these is a **cross-repo contract question**, routed to AA. What is
*not* acceptable on either shape: a homogeneous `Record<string, unknown>` bag
as the *consumption* form. Today's opacity (`types.ts:43`) is preservation-
honest for a statement surface; a D surface that feeds policy **must become
typed per kind at contract level** — typing is contract work, never adapter
invention.

### Member classification (required)

| Transport member | Classification | Why |
|---|---|---|
| `facts, observedSignals, temporalSignals, collectionFacts, interpretations, uncertainties` | **evidence** (A-side; B members, C inputs) | object-bearing collections with evidence-class structure; the seven load-bearing keys (`archive-reasoning/types.ts:43–50`) |
| `explicitPreferences` | **user-control** (D, stated-preference kind) | user-authored statements with closed provenance; transported but never digested as evidence |
| future `requestIntent` / user `constraints` / `discoveryControls` | **user-control** (D kinds) — policy-*reachable* but never evidence | D's only arrow is D→E (ratified) |
| `constraints[]` (existing) | **transport metadata** — neither evidence nor user control nor policy input | producer terms about the pack itself ("no_action_generation", etc.) |
| `transport` meta (`endpoint/contractRef/receivedAt`) | **presentation/audit data** | wraps evidence; deliberately non-epistemic (`types.ts:47–57`) |
| `domain` | **label** | declared non-evidence (`types.ts:40`) |

- **IMPLEMENTATION PREREQUISITE:** before any D extension, the contract must
  be regenerated against a **ratified** upstream tip (the current snapshot
  pins `1a2200b`, pre-dating AA's Gate-8 findings at `07ad2ce…`), with the
  existing test-pins (`personalisation-adapter.test.ts:107,307`) updated in
  the same commit. Regeneration against an unratified or unverifiable
  upstream is forbidden work.

### Required decision (Q6)

**Smallest transport that preserves D kind distinctions:** either per-kind
typed collections or a single discriminated envelope with a closed kind enum —
chosen **cross-repo** (AA Q7). Arena's non-negotiables either way: kinds stay
distinguishable at transport; every kind carries the P6 provenance shape;
producer `constraints[]` remain transport meta; the client stays read-only.

---

## 7. Audit authority

### What Arena records today (inventory)

- **Privacy audit log** — `schema.ts:202` *"(metadata only — never content)"*;
  `privacy.ts:65–71`: metadata-only, best-effort, never breaks the request.
  **Arena-domain request metadata** (its own product surface), not archive
  evidence and not user-control state.
- **Transport meta** (`types.ts:47–57`): endpoint, contractRef, receivedAt —
  the **only** archive-adjacent audit trail; wraps evidence, never enters it.
- Nothing records reasoning *decisions*, policy outcomes, recommendations,
  suppressions, rankings, model outputs about the archive, or user feedback.
  (`cognitiveJobs.ts:82` "audit" is unrelated LLM prose.)

### The six forbidden transformations — status at `8747e57`

The personalisation client **throws on any non-GET operation**
(`client.ts:73–76`); Arena holds **no write path to AA at all**. Therefore:

| Forbidden transformation | Structural status |
|---|---|
| Arena policy result → AA preference | **mechanically impossible** (no write path; no policy) |
| Arena recommendation → preference | **mechanically impossible** (no write path; no recommendations) |
| Arena suppression → dislike | **mechanically impossible** (no write path; no suppression) |
| Arena ranking → taste | **mechanically impossible** (no write path; no ranking) |
| Arena feedback → durable preference | **mechanically impossible** (no write path; no feedback channel) |
| Arena interpretation → archive fact | **mechanically impossible** (no write path); C claims are Arena-side renderings with their own discipline |

**CURRENT FACT:** these are not merely prohibited; the tree lacks the
machinery. Gate 8 must keep it that way — any future feedback channel must
arrive upstream with its own provenance (ratified FT-6), never as Arena
write-back.

- **FORBIDDEN ASSUMPTION:** the privacy audit log (or transport meta) must
  never become authority for D state. Audit metadata observes transport; it
  does not constitute user-control truth.

### Authority table (required)

| Object | AA authority | Arena authority | E/policy authority |
|---|---|---|---|
| source state (D rows) | **YES — sole** | none (consume verbatim) | none |
| interpretation of evidence (A/B/C) | none Arena-side | **Arena (Gate-7 calculus + lanes)** | none |
| interpretation of intent | none delegate-able | **nobody — forbidden (E NO-list)** | **forbidden** |
| candidate generation | none | none today | **nobody — E absent** |
| filtering / suppression / prioritisation | none | none today | **nobody — E absent** |
| recommendation explanation | none | renderer lanes for A/B/C only | **nobody — E absent** |
| policy outcome | none | none today | **nobody — E absent** |
| audit record of D lifecycle | **AA** (per Gate-8 AA findings; Arena receives) | transport-meta only | none |

**Policy is currently absent — stated explicitly.**

### Required decision (Q7)

**Audit authority for user-controlled state is AA's; Arena's audit obligation
is to (a) keep transport attribution, (b) attribute any future policy act to
its inputs (ratified §8 grammar), and (c) never let Arena-side logs become
D authority.** The conflict/withdrawal/expiry ledger is upstream (AA Q8).
Arena adds no new authority by logging.

---

## 8. Policy boundary

### Does E exist in this tree?

**No. Evidence:**

1. The seam's own doc-block: the evidence reception *"is the end of Gate 6 —
   the STOP point. Anything derived from this body (ranking, candidates,
   scores, taste) is Gate-7 territory and does not exist yet."*
   (`personalisation/types.ts:58–64`).
2. No candidate / filtering / suppression / prioritisation machinery exists
   in `src/lib/personalisation` or `src/lib/archive-reasoning` (grep: the
   words occur only in comments and in the renderer's ban-list).
3. The renderer's forbidden-vocabulary guard bans
   `love|like|enjoy|prefer|taste|recommend|suggest|interest|score|rank|best|
   trending|you|your` (and more) from all produced claims
   (`render.ts:46–47`) — the renderer is structurally prevented from
   *sounding* like a policy.
4. Prior audit on record: `docs/recommendation-architecture-audit.md`
   — 19 `ABSENT` verdicts across the recommendation-semantics surface
   (vocabulary present, machinery absent).
5. Gen-1 legacy rows are held `not_available`, never interpreted:
   `archive-assistant/fixtures.ts:153–159` (`watchlist`, `upcoming`,
   `recentlyReleased`, `trending`, `suggestedForYou` all
   `not_available`/`items: []`).
6. **Explicitly not counted** (owner's exclusion list): battles/Elo judging,
   Bradley-Terry/staffing under `models.ts`, the "Prioritizer" strategy
   persona, and generic `RECOMMENDATION:` prose in LLM prompts. None consume
   archive evidence or user control; none are media recommendation policy.

**CURRENT FACT: no actual recommendation policy consumes archive evidence or
user control anywhere in this tree.**

### Required decision (Q8)

**E is currently: not anywhere. It is architectural intent only** — defined
semantically by the ratified record (§5, §8) and physically absent from both
repositories as far as this one can prove. Per the hold: this pass does not
implement it.

---

## Cross-repository adversarial matrix (12 cases)

Columns per owner spec. "May C speak?" means: may Arena's interpretation
calculus speak **about the evidence** (never about D). "May E act?" is
answered for the tree at `8747e57`, i.e. against an absent E. Product
precedence is resolved **nowhere** unless the tree establishes it — it does
not.

| # | Case | AA state (today) | Arena representation (today) | A/B/C evidence status | May C speak? | May E act? | Must not infer | Missing contract |
|---|---|---|---|---|---|---|---|---|
| 1 | watches horror constantly; "do not recommend horror" | watch evidence + (representable) statement row | watches as evidence; **constraint kind NOT transportable** (only a statement can cross — fixture `:147` shape) | evidence intact, uncoupled | yes, independently | **no — E absent** | "moved past horror" / dislike / statement→constraint upgrade | hard-constraint channel, veto semantics, suppression + attribution |
| 2 | rarely watches animation; "animation this month" | thin rows; **no month-scoped intent surface** (no expiry anywhere) | session intent inexpressible | thin rows stand | yes, uncoupled | no — E absent | appetite from thin history | session-intent kind, session identity, expiry shape |
| 3 | "surprise me tonight" | no surprise/novelty vocabulary upstream or locally | nothing representable | nothing new | C silent | no — E absent | absence as permission (FT-5) | discovery-control channel; diversification policy (PD-5) |
| 4 | "I like Wong Kar-wai" | representable **today** as a statement row | verbatim statement row, opaque | watch rows (if any) stand | yes, about evidence | no — E absent | statement→"preference fact" (FT-3) | none for representation; E-side advisory handling deferred |
| 5 | "never recommend anything I've watched" | **no constraint channel**; watch-history membership is A-describable | constraint inexpressible | history intact | n/a (evidence-only) | no — E absent | taste from the filter | constraint channel + binding to evidence-derived sets |
| 6 | "more of what I watch" | **no durable-instruction channel**; pattern is A-describable | instruction inexpressible | pattern stands as evidence | yes, uncoupled | no — E absent | pattern-match = preference-verified (FT-1) | durable-instruction kind + weighting semantics (PD-2) |
| 7 | "nothing over two hours" | **no constraint channel**; runtime may exist as evidence facts | constraint inexpressible | runtime facts stand | n/a | no — E absent | "dislikes slow cinema" (FT-2/-3) | constraint channel + metadata-quality handling |
| 8 | durable X vs session not-X | **neither kind transportable** | both inexpressible | both would stand | n/a | no — E absent | silent cancellation of either | both channels + lifetimes + precedence (PD-1/PD-3, product) |
| 9 | intent expires | **no expiry representation**; absence ≠ expiry provable | expiry inexpressible | stands | n/a | no — E absent | expiry = retraction = changed-mind evidence | producer-declared expiry (AA Q4); grace rules (PD-4) |
| 10 | preference withdrawn; history remains | **no withdrawal representation**; history stands | row disappearance is undifferentiated absence | history intact, truthful | yes, uncoupled | no — E absent | disappearance = deletion of history / behaviour rebutting withdrawal | additive retraction representation (AA Q3) |
| 11 | D scope ≠ evidence scope | scopes are opaque strings (§4) | no compatibility rule | stands scoped | n/a | no — E absent | string-equality → containment; silent generalization | scope vocabulary + declared relation (AA Q5, PD-6) |
| 12 | two constraints conflict | **no constraint channel, no conflict semantics** | both inexpressible | stands | n/a | no — E absent | silent merge/rank; conflict as expiry of either | conflict detection + resolution authority (AA Q8; PD, product) |

**Uniform bottom line of the matrix:** Arena can *represent* exactly one D
kind today (stated preference, verbatim); it can *act* on none; and in every
case the evidence side is untouched and C's discipline is uncoupled from D —
which is precisely the ratified firewall, currently guaranteed by absence of
machinery rather than by implemented constraint.

---

## Arena-side current truth

Only facts proven by the inspected tree `8747e57`:

1. Three-way lineage agreement (remote = HEAD = tracking = `8747e57`);
   ratification commit present and current; worktree clean.
2. User-controlled state crosses as exactly one typed collection,
   `explicitPreferences[]`, inside an eight-collection read from a single GET;
   rows preserved verbatim and opaque; transport meta wraps, never enters.
3. Preference provenance is closed (4 fields, `additionalProperties:false`),
   `source ∈ {operator_statement}`, `provenanceStatus ∈ {authoritative,legacy}`,
   legacy carries null provenance and is never upgraded.
4. User-control provenance and watch-event provenance are distinct,
   non-interconvertible schemas.
5. The lattice refuses preference rows as load-bearing (`lineage_incomplete`)
   and provenance-less evidence generally; the renderer bans recommendation
   and affect vocabulary from claims.
6. `constraints[]` exists in transport as **producer meta**, declared
   non-evidence; payload examples are transport terms, not user instructions.
7. No lifecycle fields, no session/request identity, no expiry
   representation exist anywhere in the seam; transport is snapshot-only, so
   absence is semantically undifferentiated.
8. Scope vocabulary is unenumerated opaque strings; no containment or
   compatibility algebra exists; owner isolation is enforced upstream.
9. No entity-resolution machinery (opaque subject strings only; no taxonomy;
   no classifier; no parser).
10. The client is GET-only with a runtime refusal; Arena has no write path
    to AA and no owner parameter.
11. Arena's audit trail adjacent to archive state is transport meta only;
    the privacy audit log is Arena-domain metadata.
12. **E (policy + orchestration) does not exist** in this tree; no candidate,
    filtering, suppression, prioritisation, or recommendation-consumption
    machinery exists; Gen-1 suggestion rows sit `not_available`.
13. Arena's contract snapshot pins upstream `1a2200b…`; AA's Gate-8 tip
    (`07ad2ce…`, operator-stated) post-dates it.

## Cross-repo consequences

What the AA findings (operator-stated) require Arena to respect:

- **AA owns D state, identity, owner isolation, scope, provenance, lifecycle,
  legacy distinction, and typed transport.** Arena must consume, never
  author, mutate, backfill, or re-derive any of these.
- **AA does not own policy, ranking, suppression, novelty, intent
  interpretation, conflict resolution, or taste inference.** None of these may
  arrive from upstream disguised as contract content (e.g., "preferences"
  that are actually rankings); ingress typing + P6 provenance are the tripwire.
- Arena must hold the one-way direction: **D→E only, never D→A/B/C, never
  E→upstream**; the GET-only client is today's structural guarantee and any
  future surface must preserve it.
- The pin gap (`1a2200b` vs `07ad2ce…`) means **the current generated
  contract predates Gate-8 semantics**; reconciliation requires regeneration
  against a ratified upstream (with test pins moved in the same commit),
  never hand-edits.
- Neither repository invents semantics in the gap: every delta Arena needs
  (kinds, sources, lifecycle, scope vocabulary, entity resolution, transport
  shape, audit ledger) is a **cross-repo contract question first**.

## Resolved decisions

Only decisions already established by authoritative records (no new ones made
here):

1. P1–P6 accepted; D as one authority domain with distinct member kinds;
   statement-of-record status; additive retraction; declared expiry
   (`lab-004-decision-record.md` §1–3, §13 ratified).
2. One-way authority **D→E**; forbidden arrows enumerated (§4, §13 tripwire:
   *the normative arrow rules govern; diagram layout is illustrative*).
3. E = bounded policy + orchestration; NO-list for interpretation/conclusion/
   evidence authoring/write-back (§5).
4. FT-1…FT-8 forbidden transformations, including the permanent
   recommendation→preference closure (§7).
5. Explanation grammar with mandatory attribution (§8).
6. Read-only client constraint; preservation-not-interpretation adapter
   discipline (tree: `client.ts:73–76`, `context.ts`).
7. `constraints[]` = transport meta, not user control (tree +
   `archive-reasoning/types.ts:40–41`).
8. Provenance substrate reuse for D (closed `1a2200b` shape; LP-4 resolved).
9. This gate is decision/discovery-only (owner, this prompt).

## Unresolved product decisions

Genuine product decisions only — none disguised as architecture gaps:

1. **PD-1…PD-7** from the ratified record (§10) — carried forward untouched:
   session-vs-durable precedence; discovery-control weighting shapes;
   session-scope override semantics for vetoes; expiry grace rules;
   diversification policy; user-visible scope taxonomy; C rendering over
   pre- vs post-policy sets.
2. **Entity-resolution siting** (this pass §5): AA vs Arena-side resolver vs
   separate service — product/architecture decision; mechanism must not live
   inside E.
3. **Transport envelope choice** (§6): per-kind collections vs discriminated
   envelope — cross-repo contract question (AA Q7); not Arena's to settle alone.
4. **Precedence within D for conflicting constraints** (matrix case 12):
   resolution authority and quiet-conflict presentation are product, routed
   with AA Q8.
5. Explanations' wording/verbosity for suppression and expiry boundary
   displays (product UX; grammar fixed, wording open).

*Gate 8 Arena-side discovery adds no product decisions beyond these; it
confirms the ratified list is complete for what this tree can inform.*

## Implementation prerequisites

Concrete contracts/semantics that must exist before any code is allowed:

1. **Upstream instruction surface** carrying the four additional D member
   kinds, per-kind typed (AA Q1).
2. **Closed provenance mandate per kind**, with new `source` enum values for
   operational kinds (AA Q2); legacy discipline preserved.
3. **Producer-declared lifecycle**: additive retraction representation and
   declared expiry shape (AA Q3/Q4); Arena-side consumption rules for
   withdrawn/expired/superseded rows defined contract-first.
4. **Scope vocabulary + declared D↔evidence scope relation** (AA Q5) with a
   named mapping owner.
5. **Entity-resolution surface** decision + typed references in D rows
   (AA Q6).
6. **Session/request identity representation** for intent kinds (today:
   absent everywhere).
7. **Transport shape decision + contract regeneration** against the ratified
   upstream tip, test pins moved in the same commit, `--check` green (§6).
8. **Audit/attribution contract** for E outputs (who logs what; ratified §8
   grammar becomes schema obligation).
9. **Conflict-detection semantics** for D rows (matrix case 12).
10. Only after 1–9: an **E gate** of its own. No E code before it.

## Forbidden implementation

This gate does **NOT** authorize:

- any code, schema, contract, fixture, test, prompt, OpenAPI, or generated-file change;
- re-typing opaque preference rows into interpreted structures Arena-side;
- inventing lifecycle semantics, or reading lifecycle into row presence/absence;
- inferring scope containment from string equality/prefix;
- entity resolution inside any future E, or natural-language parsing of statements;
- treating producer `constraints[]` as user control or policy input;
- repurposing `project_memory` (or any Arena-domain store) as D state;
- any write-back channel to AA for any purpose (all six FT rows stay
  structurally impossible);
- candidate/ranking/suppression/prioritisation machinery of any kind;
- relaxing the renderer's forbidden-vocabulary guard, or new conclusion kinds;
- contract regeneration against unratified/unverifiable upstream;
- any claim that "D beyond stated preferences", "E", or "Gate 8 contract"
  now exists.

## Gate 8 Arena status

**COMPLETE**

The Arena tree was inspected authoritatively at `8747e57` (three-way lineage
agreement, clean worktree, all eight questions answered at discovery/
decision-preparation depth from tree evidence, matrix and synthesis
delivered). Arena has answered its side: consumption discipline proven, E
proven absent, and the exact contract deltas routed upstream. **No code
changes are authorized by this pass.** The two Gate-8 records (AA-side,
Arena-side) are now ready for cross-repo reconciliation into the Gate-8
decision set — by the owner, on ratified evidence, in that order.
