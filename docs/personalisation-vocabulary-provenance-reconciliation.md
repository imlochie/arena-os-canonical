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

## 7. Decisions this creates (owner's call — recorded, none made here)

1. **Codify Arena's current drop as deliberate.** The normalizer ignoring
   overview personalisation fields is today the *correct* behaviour; it
   should be written into the integration doc as a decision with this
   report as rationale, so nobody "fixes the gap" casually.
2. **Upstream: declare the provenance class of the overview personal
   fields** (interpretation-over-played-state), ideally in the OpenAPI
   descriptions — cheap honesty that survives any consumer.
3. **Upstream: reconcile the two generations on the record.** The
   direction doc was authored where gen-1 is not visible. Either gen-1
   merges and is re-derived over the usage layer when it lands, or it's
   explicitly scoped as a legacy presentation heuristic. Both are
   defensible; silence is not.
4. **Arena's contract pin.** The bridge generates from
   `arena/01a0a0d9`'s spec. If the assistant surface's long-term home
   changes (merge to main, or not), the generator pin needs to track
   that decision.
5. **Sequencing (owner's own rule, preserved):** reconcile → decide the
   seventh read → lab-002 taste traps. This report completes step one.
   Lab-002's traps are now better aimed: *played state ≠ observed watch*;
   *`not_available` ≠ nothing to recommend*; *high playCount ≠ enjoyed*;
   *briefing rank is acquisition ordering, not taste ranking*; *UNKNOWN
   ≠ FALSE*.

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
