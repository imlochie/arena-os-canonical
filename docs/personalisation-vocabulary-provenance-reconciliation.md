# Personalisation vocabulary & provenance reconciliation

> **Date:** 2026-09-19 · **Type:** read-only upstream investigation —
> zero implementation in either repository. **Trigger:** owner direction
> following `docs/recommendation-architecture-audit.md` — before any
> seventh read, establish whether Arena-facing personalisation vocabulary
> and the newer analytics direction are one system at two maturities, or
> two systems.
>
> **Repositories examined:**
> - `imlochie/arena-os-canonical` (this repo, @ `194145b`)
> - `imlochie/SomeSafePortablesoftware` (Archive Assistant), refs:
>   `main @ 0bea165` (tip, 2026-09-16), `arena/01a0a0d9` (assistant
>   surface; Arena's bridge contract generates from this branch's
>   `lib/api-spec/openapi.yaml`), `arena/01a0b5d9` (usage-intelligence
>   direction, docs-only, 2026-09-18). All 12 remote refs were grepped for
>   both vocabulary generations; results below are exhaustive across refs.
>
> **Evidence discipline:** every semantic claim names branch + file (+
> lines where read). Sections read in full vs scanned by headings are
> distinguished where it matters.

---

## 1. Executive verdict

**They are two systems, not one — and the newer system's accepted design
doc demotes the older system's entire evidence substrate to a lower
evidence class.**

- **Generation 1 (implemented, unmerged):** a working personalisation
  surface on `arena/01a0a0d9` (descends from `main`): `personalAffinity`,
  `personalRelevance`, `suggestedForYou`, `personalizedBriefing`, viewing
  momentum, plus a disciplined read-only external research engine
  (TVMaze v1–v4). Its substrate is **item-level played-state metadata**
  (`viewCount` / `lastViewedAt` / resume offset) read from provider
  inventory rows — with deterministic heuristics emitting labels +
  human-readable reason strings and **no structured provenance**.
- **Generation 2 (accepted direction, docs-only):**
  `arena/01a0b5d9 → docs/usage-intelligence-direction.md` (699 lines) +
  `.agents/memory/usage-observation-boundary.md`, branched directly off
  `main`'s tip. It specifies a provenance-first **usage layer**:
  `watch_observation` (provider claim, not ground truth), append-only
  deduplicated ingestion, scope-as-identity, coverage denominators,
  UNKNOWN ≠ FALSE, four-state ownership relation, recomputable
  derivations with evidence hashes. It self-declares — accurately, of
  `main` — "there is currently no watch, view, session, or usage concept
  anywhere in the schema, services, or contract."
- The direction doc contains **zero occurrences** of any gen-1 term
  (`grep -c` for personalAffinity/personalRelevance/suggestedForYou/
  personalizedBriefing/mediaExperience = 0). It neither references,
  supersedes, nor reconciles the gen-1 vocabulary.
- The consuming question the owner posed — *is the old overview
  vocabulary a presentation materialization of the new evidence layer?* —
  answers as **no**: the derivation path
  `watch_observation → signals → context → overview` **does not exist**.
  Nothing exists for the first three stages; the overview materialization
  exists, over a different well.
- **Main has neither system.** `main @ 0bea165` has no media-experience,
  assistant-overview, or personal-* services in
  `artifacts/api-server/src/services/` (aged acquisition/integrity/
  reconciliation stack only), and no usage concepts.
- **The smoking gun for why direct wiring would be a downgrade:** gen-2's
  own memory file states "Played state and play history are different
  evidence… item-level `viewCount`/`lastViewedAt` read through the owner
  token report the owner, not the viewing user" — i.e., **the accepted
  direction classifies the exact fields gen-1 is built on as
  library-state claims, not observed viewing.** If Arena consumed
  `personalAffinity: high` as an observation today, it would be reasoning
  over library-state claims as though they were observed behaviour —
  precisely the epistemic leakage the bridge was built to prevent.

**Consequence for Arena (current state is already correct by accident):**
the Arena normalizer drops the overview's personalisation fields. This
should be codified as *deliberate* until upstream declares a provenance
class for those fields (§7).

---

## 2. Branch topology (the reconciliation substrate)

```
imlochie/SomeSafePortablesoftware

main @ 0bea165 (2026-09-16)
  │   services: acquisition-*, media-(integrity), plex, reconciliation,
  │   review-*, storage, system …  — no assistant/* routes, no usage
  │   concepts, no personalisation vocabulary
  ├── arena/01a0a0d9  (gen-1, implementation)
  │     adds: /assistant/* surface incl. overview/workload/discovery;
  │     media-experience.ts, media-profile.ts, personal-curation.ts,
  │     personal-reasoning.ts, media-research.ts, source-monitor.ts,
  │     research-synthesis.ts, research-evaluation.ts;
  │     docs/personal-media-research.md; tests incl.
  │     personal-curation.test.ts, assistant-overview.test.ts
  │     → Arena's six-op read contract generates from this branch's spec
  └── arena/01a0b5d9  (gen-2, accepted direction record, 2026-09-18)
        adds: docs/usage-intelligence-direction.md,
        .agents/memory/usage-observation-boundary.md (+README/replit)
        commits: 18a8b19 ownership relation; 7518d2f
        departure_unconfirmed + scope validation contract;
        4f75545 scope-vs-measurement separation, UNKNOWN != FALSE
        → docs only; nothing implemented; authored off main, where
          gen-1 is not present
```

Searched for the audit's referenced contract document:
`personal-media-recommendation-contract.md` does **not** exist in any ref
of either repository. The nearest upstream documents are
`docs/personal-media-research.md` (01a0a0d9) and
`docs/usage-intelligence-direction.md` (01a0b5d9).

## 3. Generation 1 — what the vocabulary actually means

All semantics below from `arena/01a0a0d9:
artifacts/api-server/src/services/assistant-overview.ts` (424 lines,
read in full for the relevant functions) and `media-experience.ts`.

### 3.1 Substrate: played-state projection, not play history

`media-experience.ts` (lines 103–117, 153–156): items are built from
provider inventory metadata — `playCount ← metadata.viewCount`,
`lastWatchedAt ← metadata.lastViewedAt`; `status` = completed /
in_progress(resume offset) / unwatched / unknown; `watchedMinutes` is an
**estimate** (duration × playCount when completed; resume offset when in
progress). Series progress = completed-episode ratio; `isNextEpisode` =
first unwatched after latest watched. No per-play rows, no `accountID`,
no device, no `historyKey`, no collection time, no coverage accounting.
The watchlist shape is hard-coded `{ status: "not_available", items: [] }`
(media-experience.ts line ~211) — honest absence.

### 3.2 `personalAffinity` (on AssistantRecommendation)

`personalAffinityFor(title, seriesTitle)` (assistant-overview.ts
~283–303): **exact title-string match** (lowercased) of the
recommendation's title/series title against the media-experience
projection, then a signal list: `isNextEpisode`, `in_progress`,
`lastWatchedAt` within 30 days, `playCount >= 2`, `seriesProgress > 0`.
Label: **high** if any "currently/next/last-30" signal, **medium** if any
signal, **low** if matched with none, **unknown** if no title match
("No matching provider viewing evidence."). Output is `{ priority,
basedOn: string[] }` — prose reasons only, no handles.

### 3.3 `personalRelevance` (on DiscoveryItem) and `suggestedForYou`

Discovery builder (~95–140): over the same projection.
`upcoming`/`recentlyReleased` = release-date window filters, relevance
"high" if next-episode/in-progress/playCount>0 else "unknown".
`suggestedForYou` = items not already surfaced, filtered to
`isNextEpisode || in_progress || playCount >= 2`, sorted
(next-episode first, then playCount desc, title), capped at 20; section
`status: available|limited` with reason "No strong watch-history signals
are available for a suggestion." when thin; `trending` is pinned
`not_available` with machine reason `no_supported_trending_source`.
Relevance is "high" (next/in-progress) else "medium". **No `low` value is
ever emitted anywhere in the discovery path** — enum admits it, heuristics
don't produce it.

### 3.4 `personalizedBriefing.rank`

`rankPersonalizedBriefing` (~140–170): filters operational
recommendations to `type === "download"` **that carry a personalAffinity**,
availability bucket ← state (available/uncertain/blocked), sorts by
`availability : archivePriority : affinity : title`, `rank = index + 1`
(capped 20). So `rank` is a **presentation ordering of affinity-tagged
acquisition recommendations** — personal relevance, riding on
acquisition deficiency as the candidate pool. The audit's forbidden
conflation ("needs acquisition" ≠ "personally relevant") is upstream-
encoded here as a merge: briefing = acquisitions × affinity ordering.

### 3.5 The research engine (the genuinely careful part of gen-1)

`docs/personal-media-research.md` (read in full): TVMaze read-only
explicit search (v1); **bounded one-hop** relationship expansion from
watched seeds — exact title+compatible-year, direct `same_cast` /
`same_creator` only, uncertain seeds not expanded, 20 seeds / 100
candidates bound (v2); contextual evaluation exposing `personalRelevance`,
`confidence`, `whyYou`, `whyThis`, `whyNow`, `recommendationEvidence`,
`unknowns` — **"No numeric score or ranking is produced"** (v3);
multi-source synthesis vs an **official-API-gated** IMDb boundary,
missing metrics become unknown not negative, "no universal score or
ranking" (v4). Stated plainly: *"A research recommendation is not an
acquisition recommendation."* `personal-curation.ts` adds
`approvalState: "not_created"` — approval-gated by design. This layer is
epistemically aligned with Arena's culture and is the part of gen-1 most
worth preserving.

### 3.6 Structured provenance exists — one layer deeper than Arena receives

`personal-reasoning.ts` emits `evidenceReferences: [{ source,
sourceItemId, field, category }]` and multi-axis `perspectives`
(personal/current/longTerm/archiveValue/archiveGap/relationship/
external/novelty/temporal/availability/identity/counterEvidence/unknowns)
for **research candidates**. But the `/assistant/overview` payload Arena
receives carries only `evidence: string[]` / `reasons: string[]` /
`basedOn: string[]` — the structured refs do not survive to the boundary.

## 4. Generation 2 — what the accepted direction actually says

Read in full: `docs/usage-intelligence-direction.md` sections Decision
through Departure evidence, plus `.agents/memory/usage-observation-
boundary.md` (complete). Sequencing / differentiation-caveat / parked-
questions sections were heading-scanned only; nothing below relies on
their unseen content.

- **Usage as third observational layer** beside Library (implemented) and
  Health (implemented); Arena above all three, owns interpretation —
  the role split is reaffirmed for this layer too.
- **`watch_observation`, not `watch_event`:** AA never plays media; every
  watch record is a provider claim carrying provider, collection time,
  and upstream record identity. Sits **beside** `plex_item`, not above.
- **Provider reality:** Plex per-play rows (`/status/sessions/history/
  all`, `viewedAt>=` paging) are years-deep and backfillable — including
  for deleted media; Jellyfin natively stores only current state
  (`UserDatas`), per-play needs a plugin that trims by default. Adapters
  must report *which grade* of history they supply.
- **Event truth vs session truth:** history rows prove *that* a play
  happened (what/when/who/device); duration/completion/abandonment exist
  only in live sessions or pre-aggregated buckets — **not backfillable**.
  Two metric classes result, and accruing metrics must show a
  "collecting since" date.
- **Provenance-window rule:** every metric declares the window its
  evidence covers; backfilled and instrumented windows are never merged
  ("average session length since 2019" computed from 2026 instrumentation
  is the canonical lie to prevent).
- **Scope is an ingestion contract:** account / media type / library /
  Live-TV exclusion / event types validated at ingest; the dataset
  **carries its scope definition as identity**; scope definition and
  measurement result are separate objects joined by an immutable
  `scope_id` (never edit in place).
- **UNKNOWN ≠ FALSE:** four-state ownership relation —
  KNOWN{currently_owned, previously_owned}, UNKNOWN{departure_unconfirmed,
  never_matched}; `missing` scan status is a read failure →
  departure_unconfirmed, never a departure; no
  `missing for N days → previously_owned` rule is permitted; aggregates
  may only count KNOWN states. Departure evidence has two grades: exact
  (archive_operation) and bounded (snapshot interval — an interval, never
  rendered as a date).
- **Boring pipeline:** ingest → normalise → scope → resolve → persist →
  derive → expose; interpretation layers only over trustworthy
  measurement. Usage findings advisory; never shorten the path to
  mutation; watch history treated as the most sensitive data class
  (owner-isolated, excluded from logs, explicit retention).
- The "behavioural_signal / explicit_preference / watch_event /
  watch_session / personalisation-context" nouns from the audit brief do
  **not** appear here either; the direction's vocabulary is:
  usage layer, `watch_observation`, ownership relation, scope definition
  (`scope_id`), coverage denominator, evidence grades. No API endpoint is
  named anywhere (`personalisation-context` exists in no repository/ref).

## 5. The fourteen questions, answered

| # | Question | Answer |
|---|---|---|
| 1 | Where are personalAffinity / personalRelevance generated? | `assistant-overview.ts` on `arena/01a0a0d9` (unmerged) — per-request deterministic heuristics |
| 2 | What source produces them? | Played-state projection in the AA DB built from provider item metadata (`viewCount`, `lastViewedAt`, resume offsets) |
| 3 | Do they derive from behavioral_signal? | **No — `behavioral_signal` exists in no code or doc in either repo** |
| 4 | Or directly from Plex/watch history? | Directly from **item-level played state**, not per-play history rows — the weaker evidence class per gen-2 |
| 5 | Exact meaning of personalRelevance? | Discovery-item label from watched-signal heuristics: high (next/in-progress), medium (rewatch), else unknown; "low" never emitted |
| 6 | Exact meaning of personalAffinity? | Operational-recommendation label from title-match + recency/progress/rewatch signals {high,medium,low,unknown} + prose `basedOn` |
| 7 | Exact meaning of suggestedForYou? | Filter+sort of the projection (next-episode / in-progress / playCount≥2, ≤20) with section-level availability status + reason |
| 8 | Exact meaning of personalizedBriefing.rank? | Presentation index (1-based) over **affinity-tagged acquisition recommendations**, sorted availability→archive priority→affinity→title |
| 9 | Facts, derived signals, or interpretations? | **Interpretations** — labels + prose computed at read time; no stored derived-signal objects with evidence hashes |
| 10 | What provenance do they carry? | None structured at the boundary: `string[]` reasons/evidence/basedOn only. Structured refs exist one layer down (research reasoning: source/sourceItemId/field/category) but do not reach `/assistant/overview` |
| 11 | Authoritative AA facts? | No authority concept attaches to them (authority exists for refreshes only); they are upstream read-time interpretations |
| 12 | Presentation artifacts? | Substantially — AA's own UI (discover.tsx) consumes the same payload directly |
| 13 | Duplicate the new behavioural layer? | **No derivation link in either direction.** Two systems: different substrate (played-state vs per-play observations), different standard (labels vs scope+coverage+grades) |
| 14 | Safely mappable into the new personalisation context? | The **API shapes** can survive as the materialization layer (DiscoverySection status/reason, briefing items); the **semantics must be re-derived** over watch_observation (recency from history rows, not `lastViewedAt`; rewatch from play rows, not `viewCount`). Mapping current labels in as observed signals would violate played-state ≠ play-history and UNKNOWN ≠ FALSE |

## 6. What Arena's epistemic contract needs vs what exists

| Handle Arena expects of facts | Gen-1 overview fields | Gen-2 (designed) |
|---|---|---|
| observationId / upstream record identity | ✗ | ✓ upstream record identity |
| refreshId / collection time | ✗ (only `lastViewedAt` semantics, owner-token) | ✓ provider + collection time |
| evidenceKey | ✗ (prose only) | ◐ evidence grades + evidence-hashed derivations |
| observedAt (of the evidence) | ✗ | ✓ |
| coverage | ✗ | ✓ coverage denominator, retained unresolved observations |
| scope | ✗ | ✓ immutable `scope_id` |
| observed vs derived vs interpretation class | ✗ (labels are interpretations presented bare) | ✓ observed/derived distinction (media-profile.ts does have `kind: observed|derived` locally — but not at the boundary) |

## 7. Decisions — locked by the owner, 2026-09-19

Proposed in this report's original §7 ("recorded, none made"), these are
now **locked** — recording-only, not implemented, each with its
implementation point named.

### D1 — Codify the drop ✅ recorded

Arena's normalizer intentionally does not normalize the overview's
personalisation fields. Recorded as a decision section in
`docs/archive-assistant-integration.md` ("Personalisation fields:
intentionally not normalized"), so no future developer mistakes the
omission for an unused-field oversight and "just adds it." Lifting it is
gated: provenance class declared upstream (or re-derivation over the
usage layer) → lab-002 pass → explicit owner decision.

### D2 — Annotate Gen-1's provenance class upstream 🔒 locked (application point: upstream OpenAPI descriptions on the assistant branch)

The goal is not to delete Gen-1; it is to **stop it masquerading as
behavioural evidence**. Classification table locked for upstream
annotation:

| Field | Classification |
|---|---|
| personalAffinity | heuristic presentation signal |
| personalRelevance | heuristic presentation signal |
| suggestedForYou | presentation/discovery output |
| personalizedBriefing | presentation composition |
| personalizedBriefing.rank | acquisition/presentation ordering |
| viewCount | library-state claim under current identity limitations |
| lastViewedAt | library-state claim under current identity limitations |
| resume offset | playback-state claim, not enjoyment |
| watchedMinutes | estimated presentation value — must never be annotated as, or re-derived into, a single undifferentiated "duration" primitive |

**Tightening (owner, 2026-09-19):** upstream's duration model must keep
three epistemic objects distinct — *observed duration* (measured by live
capture), *derived watched duration* (computed by declared rules over
observations), *estimated watched duration* (modelled from incomplete
evidence, e.g. duration × playCount). Gen-1's `watchedMinutes` is the
third. The same non-collapse rule governs the usage primitives:
`play_event` ≠ `session` ≠ `completion` ≠ `rewatch` — a play records
that something happened, a session describes temporal behaviour, a
completion requires an additional derivation rule, a rewatch is repeated
behaviour. None of them, alone or together, entail liked / enjoyed /
preferred / wanted / would-recommend.

### D3 — Both generations on the record ✅ recorded (this report is the record)

The lineage answer to "why don't we just use the existing
personalAffinity?":

```
Gen-1  heuristic personalisation  ── legacy / presentation substrate
           │   (semantic incompatibility, not continuity)
           ▼
Gen-2  behavioural evidence architecture
           ├── observed behaviour
           ├── explicit preference
           ├── collection relationship
           ├── temporal coverage
           └── provenance
           ▼
    Arena personalisation reasoning
```

Gen-1 does not represent the same thing. D1 and D2 make this record
load-bearing in both repos.

### D4 — Contract-generation branch stays pinned until the seam reconciles ✅ recorded in the integration doc's generator section

The bridge generates from `arena/01a0a0d9` (Gen-1 + Arena contract
surface); the accepted direction lives on `arena/01a0b5d9` off `main`.
Before any seventh read, the contract source and the Gen-2 direction must
converge deliberately — otherwise a generated contract marries Gen-2
semantics to legacy Gen-1 assumptions and bakes in months of "why does
this type exist?" archaeology.

## 8. One-paragraph history-safe summary

As of 2026-09-19: Archive Assistant has an unmerged, working
personalisation *presentation* layer (`arena/01a0a0d9`, source of Arena's
current contract) built on played-state provider metadata with prose-only
provenance, alongside a genuinely careful read-only research/candidate
engine on the same branch; and a newer, accepted-but-unbuilt usage-layer
*direction* (`arena/01a0b5d9` docs) whose evidence standards reclassify
the presentation layer's substrate as a weaker evidence class. The two
were authored without reference to each other. Arena currently receives
the presentation layer and deliberately does not reason over it. No
seventh read should exist until upstream assigns a provenance class to
those fields — at which point the socket identified in
`docs/recommendation-architecture-audit.md` §12 is the integration path.

**Status, 2026-09-19:** decisions D1–D4 locked by the owner (§7). The
adversarial exam for the future seam is designed in
`docs/archive-reasoning-lab-002.md`.

## 9. Freeze register (owner direction, 2026-09-19)

The architecture is now treated as **gated**, not merely documented.

**Arena-side freeze:** no seventh read, no adapter implementation, no
normalizer changes, no "temporary" use of `personalAffinity` (or any
Gen-1 field), no taste score. The next meaningful work is upstream in
Archive Assistant — the evidence substrate must become real before Arena
receives another byte of semantic authority.

| Gate | State |
|---|---|
| 1 · Gen-1 / Gen-2 semantics reconciled | ✅ this document |
| 2 · epistemic adversarial lab specified | ✅ lab-002, phase 0 |
| 3 · behavioural usage layer authoritative | ✗ **anticipatory** — the gate-5 report claimed done; verified 2026-09-19 against the GitHub source of truth (owner + independent sweep): **not landed** |
| 4 · upstream provenance annotation (D2 applied) | ✗ **anticipatory** — claimed with gate 5, likewise absent from git |
| 5 · seventh read (`GET /api/assistant/personalisation-context`) | ✗ **anticipatory — retracted (owner, 2026-09-19).** Directive relayed for the upstream session: recover the actual implementation from the current working session and push it to `imlochie/SomeSafePortablesoftware` on the intended branch/base. Arena does **not** start Gate 6. Lesson of record: a claimed artifact that is not in the GitHub source of truth does not exist for engineering purposes — the sweep (all 13 refs, no endpoint/schema hits) was the verification that mattered |
| 6 · Arena evidence adapter | 🔒 brief received — strictly blocked until the Gate-5 commit is **verifiably visible in GitHub** and Arena can fetch the real OpenAPI. D4 discipline unchanged: generate from it, never hand-author a schema |
| 7 · behavioural reasoning | terminal gate |

**Re-verification protocol (owner, 2026-09-19):** the retraction of
gates 3–5 is a **provenance verdict, not necessarily an implementation
verdict** — the underlying engineering may be sound; it simply was never
verified as landed. When the upstream session reports the recovered
push, Gate 5 is **re-earned, not restored**: Arena must not trust the
report. Verification means fetching the specific commit/ref named and
checking the actual tree — the
`GET /api/assistant/personalisation-context` endpoint exists; the
schemas carry the six evidence classes and the full provenance shape
(`signalId`, `signalType`, `subjectIdentity`, `value`,
`epistemicStatus`, `scopeIdentity`, coverage, provenance,
provider/event/batch lineage); and the generated contract derives from
the real OpenAPI at that ref. Only then does the gate flip.
Institutional memory of record: **truth isn't what the worker reports —
truth is what the authoritative artifact can prove.**

**Gate-5 principle preserved from the (retracted) report:** `signalId`
is a **provenance handle, not an immutable semantic identity** — derived
signals can be regenerated or replaced; the durable truth is the
underlying observations and their provenance. Recorded here so the Gate-6
adapter (when genuinely unblocked) cannot later canonify it.

Gate 6, when unblocked, is the first point Arena touches this evidence —
and is boring by design: server-to-server client → generated/validated
contract → ArchiveContext → evidence preserved (signal, epistemicStatus,
scope, coverage, event/provider/batch lineage, the six classes). No
recommendations, candidates, ranking, scores, taste profiles, inference,
embeddings, model calls, acquisition integration, actions, or feedback
learning. Gen-1 fields stay absent from the Gen-2 representation unless
they independently arrive contract-valid with documented semantics. Seven
adapter tests, then full suite/typecheck/build — and stop before
behavioural reasoning.

Gates 3 and 4 are not implementation chores; they are what make the
future adapter **legitimate**. The dependency rule of record:

**Arena doesn't get to become more intelligent until Archive Assistant
becomes more certain.**

The legitimacy chain this protects — any future recommendation claim must
be auditable all the way down:

```
recommendation claim
  → interpretation
    → behavioural signal
      → watch event(s)
        → scope + coverage
          → provider observation
            → archive truth
```
