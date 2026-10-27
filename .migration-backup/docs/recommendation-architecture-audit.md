# Arena recommendation / personalisation architecture audit

> **Date:** 2026-09-19 · **Commit audited:** `45eef2b` (+ docs-only
> `e59255a`) · **Type:** audit-only slice — no application code, schema,
> API, prompt, ranking, or behavioural logic was added or modified.
>
> **Method note:** every claim below names the file/function/route/table
> it was read from. Filenames alone were never used as evidence. Ratings
> vocabulary: `EXISTS` (implemented), `PARTIAL` (some real pieces, named
> gaps), `CONCEPTUAL` (vocabulary/type shapes without a mechanism),
> `ABSENT` (nothing found), `INCOMPATIBLE` (exists but semantically the
> wrong thing).
>
> **Referenced-doc caveat:** the audit brief references
> `docs/personal-media-recommendation-contract.md`. **That file does not
> exist in this repository** (docs/ contains only the archive-assistant
> integration doc, the reasoning evaluation runbook, and lab-001). The
> compatibility matrix in §9 is therefore graded against the seventeen
> requirement rows enumerated in the audit brief itself. When the real
> contract document lands in this repo, the matrix should be regenerated
> against it — the row structure is already in place.

---

## 1. Executive Finding

**Arena has a brain-shaped socket and no recommendation brain.**

There is exactly one implemented, tested pattern for "bounded,
provenance-bearing evidence enters model reasoning under explicit
epistemic rules": the Archive Assistant evidence pack (`client.ts` →
`context.ts` facts → `prompt.ts` rules → `chatRunner.runChat` →
`ai.generate`). It is domain-locked to archive-operations evidence, and
it is precisely the socket a personalisation evidence pack would plug
into. It exists. It works. It is not a recommendation system.

Everything else in Arena that uses the word "recommend" is talking about
**which LLM to use**, not **which media to watch**: a model-selection
recommender (Elo-informed role staffing), a model-quality rating system
(Elo/Bradley-Terry over battle votes), an offline rubric judge, and LLM
prompt phrasing ("give a clear recommendation"). None of it generates
media candidates, ranks media, scores taste, infers preference, or
persists recommendations.

Meanwhile — and this is the audit's most consequential finding — the
Archive Assistant contract *already transports* a full personalisation
vocabulary (`personalAffinity`, `personalRelevance`, watch state,
`suggestedForYou`, briefing `rank`) across the live bridge inside
`/assistant/overview`. Arena validates that payload, carries it in
`ArchiveContext.overview`, and then **drops it on the floor**: the
normalizer builds facts only from workload, reconciliation, refresh, and
lineage. Transport exists end-to-end; the semantic socket for it is
unwired.

Zero Arena persistence exists for media recommendations, candidates,
taste, watch history, or recommendation feedback.

---

## 2. Existing Recommendation Infrastructure

What Arena currently means by "recommendation", item by item:

### 2.1 Workforce model-recommendation — EXISTS (different domain)

- **What:** for each cognitive role (Researcher, Critic, Architect, …),
  recommend the best *model* to staff it.
- **Implementation:** `GET /api/workforce` (`src/app/api/workforce/route.ts`)
  reads `models` + `model_category_ratings` tables, picks the category
  Elo leader if it's on the role's shortlist, else shortlist head, else
  overall Elo leader; returns `recommendedModel`, `recommendedElo`,
  `basis` ("category leader (reasoning)" | "role shortlist").
- **Static data:** `WORKFORCE_ROLES` (`src/lib/workforce.ts`) — roles
  with `preferredModels[]` shortlists and `eloCategory` mappings
  ("Leaderboard category used for Elo-based recommendation", comment
  line 18).
- **Input:** battle-vote-derived Elo per (model, category). **Output:**
  model id per role. **Decision owner:** the OS (auto-staffing).
  **State:** `models`, `model_category_ratings` tables. **Deterministic**:
  yes, given the tables. **Ranks:** yes (Elo order). **Scores:** yes
  (Elo). **Explains:** shallowly (`basis` string). **Persists:** the
  ratings, not the recommendations. **Mutates:** no (read-only route).
- **Semantics classification:** operational priority **for model
  staffing** — not recommendation relevance, not user taste. The word
  "recommendation" here is a collision waiting to happen (§11).

### 2.2 "Recommendation" as LLM output content — EXISTS (not a mechanism)

- `COGNITIVE_JOBS[].synthesisInstruction` (`src/lib/cognitiveJobs.ts`,
  e.g. `simulation_partner`: "give a clear RECOMMENDATION with
  reasoning"; artifact kind `"recommendation"`), `STRATEGIES[]`
  (`src/lib/strategies.ts`, `scenarios`/`second-brain` synthesizers),
  and default `promptTemplates` (`src/app/api/templates/route.ts`,
  "Decision helper": "…then a clear recommendation with reasoning") all
  ask models to *emit* recommendations as prose/artifacts. There is no
  machinery behind the word: no candidates, no scoring, no
  persistence of the recommendation as a decision object (artifacts
  persist as text documents).
- **Semantics:** model-generated advice content.

### 2.3 Local-mode rubric judge — EXISTS (operational scoring)

- `localJudge` (`src/lib/localEngine.ts`): transparent heuristic rubric
  (length, structure, code blocks, key-term coverage → 1–10 per side →
  suggestion a/b/tie/both-bad + `reasoning` string). Used as the offline
  battle judge. **Semantics:** model-response quality heuristic —
  INCOMPATIBLE with recommendation relevance; explicitly a different
  axis.

### 2.4 Archive Assistant operational recommendations — EXISTS upstream, transport-only in Arena

- The generated contract (`src/lib/archive-assistant/generated/types.ts`)
  defines `AssistantRecommendation` (types download | integrity |
  rename | duplicate | identity | quality; priority critical→info;
  `recommendedAction`; `evidence[]`; `confidence`) and
  `AssistantBriefingItem` (`rank`, `recommendationId`, `archivePriority`,
  `personalAffinity`, `availability`, `confidence`, `reasons[]`,
  `blockedReason`). These are **Archive Assistant's** operational
  triage records — "this item needs acquisition/repair/review", the
  exact thing the audit brief warns is not equivalent to "personally
  relevant". Arena's contract surface includes `overview.attention /
  recommendations / blocked / uncertain / personalizedBriefing` arrays,
  all validated on ingress (`generated/contract.ts`) and **none
  consumed** into facts or prompts (verified: `buildWorkloadFacts`,
  `buildRefreshFacts`, `buildReconciliationFact`,
  `buildFindingLineageFacts` in `src/lib/archive-assistant/context.ts`
  are the only fact builders; `buildArchiveContext` fetches overview and
  stores it in `ArchiveContext.overview` where nothing reads it).

---

## 3. Existing Personalisation Infrastructure

### 3.1 User-authored preference statements — EXISTS (narrow)

- `project_memory` table (`src/db/schema.ts`): `kind:
  fact|decision|preference|open_question|rejected_idea|source`,
  `content` (≤2000 chars, `src/app/api/projects/[id]/memory/route.ts`,
  POST validated against the kind enum).
- `getProjectContext` (`src/lib/projectContext.ts`) groups memory by
  kind under a "Preferences:" heading and injects up to ~6000 chars into
  Council/Collab/Battle prompts via `withProjectContext` (verified call
  sites: `src/app/api/council/route.ts:63-64`,
  `src/app/api/collabs/route.ts:83-84`,
  `src/app/api/battles/route.ts:54-55`).
- **Notable gap:** the chat reasoning path does **not** consume project
  memory — `runChat` (`src/lib/chatRunner.ts`) assembles system prompts
  only from the request's `system` field plus the archive pack.
- **Epistemic status:** explicitly user-authored statements (the UI and
  API treat them as the owner's own words). **Not** observed behaviour,
  **not** model inference. Provenance: kind string + createdAt only — no
  evidence handles, no validity window, no link to any observation.
- Scope: per-project, free text, nothing media-shaped.

### 3.2 Custom assistants (personas) — EXISTS (voice, not taste)

- `assistants` table + `src/app/api/assistants/route.ts`: user-created
  personas (name, `systemPrompt`, `baseModel`, temperature, avatar).
  Personalises *how the model speaks*, carries zero preference or
  behavioural state. **Semantics:** user-authored persona configuration.

### 3.3 Client-side model preferences — EXISTS (incidental)

- `localStorage` keys: `af_arcade_model` / `af_arcade_model_ready`
  (`src/lib/webllm.ts` get/setPreferredModel), BYOK keys
  (`src/components/KeysBar.tsx`), privacy flags
  (`src/lib/privacyClient.ts`). User-authored settings, never aggregated,
  never fed to reasoning.

### 3.4 Behavioural personalisation state — ABSENT in Arena

- No watch history, play counts, likes/dislikes, ratings, search
  history, or dwell/impression data anywhere in `src/db/schema.ts` or
  the API surface (verified by full-term grep sweep: `watch`,
  `viewing`, `like`, `dislike`, `favourite/favorite`, `profile`,
  `similar` — zero application hits outside the archive-assistant
  contract; `src/app/market/page.tsx` mentions embeddings/pgvector only
  as a *competitor-comparison roadmap cell*, `CONCEPTUAL ONLY` roadmap
  text in a marketing page, no implementation).
- The only behavioural-adjacent persistence is `privacy_events`
  (`{action, detail}` — schema comment: "metadata only — never
  content"), an audit log for privacy operations, not a behaviour
  stream.

---

## 4. Candidate Generation

| Candidate source | Status | Evidence |
|---|---|---|
| archive | PARTIAL (transport only) | `/assistant/overview` → `mediaExperience.items/completed/inProgress` (contract-validated, carried, unconsumed) |
| provider | CONCEPTUAL upstream, ABSENT in Arena | `DiscoverySections {upcoming, recentlyReleased, trending, suggestedForYou}`; section `status` supports `not_available` — fixtures serve empty sections with `"no provider metadata"` (`src/lib/archive-assistant/fixtures.ts` OVERVIEW) |
| metadata | ABSENT | — |
| watch history | ABSENT in Arena; transport exists | watch-state fields exist only inside `MediaExperienceItem`/`personalContext` contract types |
| behaviour | ABSENT | §3.4 |
| explicit preference | PARTIAL (non-media) | `project_memory` kind=preference (project-scoped text) |
| conversation | ABSENT | chats/chatMessages are stored but never mined for candidates |
| external catalogue | ABSENT | no external API surface except Pollinations (text/image inference only, `src/lib/ai.ts`) |
| manual input | PARTIAL (non-media) | memory/artifacts UIs allow free-text entries |

**The "candidate" collision, flagged:** `ReconciliationResult.
candidateCount` / `ambiguityCandidates` (generated types) are
*identity-matching* candidates in reconciliation — "these Plex rows might
be the same movie as this file" — completely unrelated to recommendation
candidates. Any future work must not read these as media suggestions.

**Acquisition-deficiency independence:** nothing in Arena can currently
produce a media candidate at all; the only media-adjacent items that
arrive (workload facts, e.g. "Movie (2020) waiting on download") are
explicitly acquisition/triage-shaped — `source:
assistant|download|review|health`, `state: needs_you|waiting|…`. The
distinction the brief demands ("needs acquisition" ≠ "personally
relevant") is currently preserved **by absence**: Arena has no mechanism
that could conflate them yet.

---

## 5. Ranking / Scoring

| Mechanism | Location | Inputs | Output | Semantics | Persisted | Tests |
|---|---|---|---|---|---|---|
| Online Elo (K=32) | `src/lib/elo.ts` `newElos` | two model ratings + vote | updated pair | **model quality** from human votes | yes (`models.elo`, `model_category_ratings`) | yes (indirect via route tests) |
| Bradley-Terry MLE + bootstrap CIs | `src/lib/ratings.ts` `fitBradleyTerry`, `btConfidenceIntervals` | full vote history | strength/Elo + CI per model | **model quality**, LMArena-method | computed on read (`/api/stats`) | — |
| Provisional/CI helpers | `ratings.ts` `isProvisional`, `eloCIHalfWidth` | battle counts | flags | uncertainty over **model ratings** | — | — |
| Category leaderboards | `src/app/api/leaderboard/route.ts` | per-category Elo | ranked models | model quality per task type | yes | — |
| Workforce staffing pick | `src/app/api/workforce/route.ts` | Elo tables + role shortlists | one model id per role | **operational priority** | no | — |
| Local rubric judge | `src/lib/localEngine.ts` `localJudge`/`scoreText` | two texts | 1–10 scores + suggestion | response-quality heuristic | `battles.judgeResult` JSON | — |
| Workload triage sort | `src/lib/archive-assistant/context.ts` `WORKLOAD_STATE_PRIORITY` | AA workload state enum | fact ordering | **operational triage** (needs_you first) | no | yes (`context.test.ts`) |
| Relevance ranking of media | — | — | — | — | — | **ABSENT** |
| Taste/affinity scoring | — | — | — | — | — | **ABSENT** (upstream types `personalAffinity`/`personalRelevance` exist, transport-only, no Arena mechanism behind them) |
| Embeddings/similarity | — | — | — | — | — | **ABSENT** (grep-verified; `market/page.tsx` roadmap text only) |
| Model confidence | AA contract `confidence: string` fields | upstream | strings | upstream-asserted, semantics opaque from Arena | — | CONCEPTUAL at Arena layer |

Meanings deliberately not collapsed: Elo = model quality; localJudge
score = rubric quality; workforce pick = staffing priority; AA
confidence/affinity/relevance = upstream opaque labels; recommendation
relevance = **does not exist**.

---

## 6. Model / Reasoning Infrastructure

**Single model abstraction — EXISTS, reusable:**
`generate(opts)` (`src/lib/ai.ts`) — one entry point behind `modelId`
catalog (`src/lib/models.ts`), with a disciplined fallback chain (BYOK →
Pollinations OpenAI-compat → Pollinations GET → openai-fallback →
deterministic `localTextReply`), zero-egress Local Mode
(`localOnly`), `via` provenance on every response. A personal
recommendation answer could flow through this unchanged — no new model
subsystem needed.

**The reasoning socket (evidence-pack pattern) — EXISTS, tested:
the audit's central positive finding.**

```
body.archiveContext === true            (opt-in, off by default)
  → getArchiveAssistantConfig           src/lib/archive-assistant/config.ts
  → resolveRequestAuth (user token fwd) src/lib/archive-assistant/client.ts
  → six read-only GETs, contract-validated  client.ts + generated/contract.ts
  → buildArchiveContext → facts w/ evidence handles  context.ts
  → buildArchiveContextSystemPrompt (bounded, path-redacted,
     11 non-negotiable epistemic rules)   prompt.ts
  → system prompt concat in runChat      src/lib/chatRunner.ts
  → generate()                            ai.ts
  → response meta {included, factCount, generatedAt}
```

Failure modes are engineered, not hoped-for: unconfigured bridge →
`ARCHIVE_CONTEXT_UNAVAILABLE_NOTE` instead of invented facts; Local Mode
→ archive never contacted; internal service leg → forwarding refused.
Locked by 70 contract/route/compat tests
(`src/lib/archive-assistant/*.test.ts`, `src/app/api/**/route.test.ts`).

**Orchestration beyond single-shot chat — EXISTS:**
Council (`src/app/api/council/route.ts`,
`COUNCIL_STAGES` perspectives→critique→synthesis→artifact),
Collab strategies (1–2 rounds), Battles with judge/followup/vote.
`withProjectContext` injects project memory into those three paths.
These are *deliberation* pipelines, not candidate pipelines — but they
demonstrate multi-model context assembly is routine here.

**On-device inference — EXISTS (siloed):** WebLLM/WebGPU client
(`src/lib/webllm.ts`), arcade-scoped, streams code generation; not wired
to chat or to any evidence pack.

**UI gap — PARTIAL:** no browser surface sends `archiveContext: true`
today (verified: zero `archiveContext` hits in `src/components`); the
reasoning socket is exercised only by API callers and tests.

---

## 7. Explanation / Provenance

- **Fact-with-evidence-handles model — EXISTS** (`ArchiveContextFact`:
  `source/subjectId/classification/statement/evidence{observationId,
  refreshId, evidenceKey, observedAt}`), rendered into prompts with
  citations (`renderFactForPrompt`, `prompt.ts`).
- **Epistemic classification — EXISTS, domain-locked:** refresh facts
  classified `complete|in_progress|incomplete|failed|never_attempted`;
  lineage facts distinguish current vs `superseded_observation`; prompt
  rules force distinguishing "current authoritative truth; an incomplete
  observation; a failed observation; uncertainty; and historical
  (superseded) evidence" and "If evidence is missing, say so explicitly
  instead of guessing." **The FACT / OBSERVED SIGNAL / UNCERTAINTY /
  HISTORICAL distinction is implemented — but only for archive
  operations evidence.**
- **INTERPRETATION as a distinct class — ABSENT:** nothing types a
  model's own inference as inference; today that lives only in prompt
  rule text, not in data structures.
- **Upstream explanation payloads — EXISTS, transport-only:**
  `AssistantRecommendation.explanation` + `evidence[]`,
  `AssistantBriefingItem.reasons[]`, `DiscoveryItem.reasons[]` +
  `evidence[]` cross the boundary validated and unconsumed.
- **Other explanation stores:** `battles.judgeResult` JSON `{suggestion,
  reasoning, raw, at}` (model-judge rationale, no provenance typing);
  `artifacts.sourceType/sourceId` + `handoffs.ts` source lineage
  (document-level lineage, not claim-level); `project_memory` kinds
  decision/rejected_idea/source (kind strings, no handles).

---

## 8. Persistence / Feedback

**Recommendation/candidate/taste persistence — ABSENT.** Verified in
`src/db/schema.ts` (14 tables): models, model_category_ratings,
assistants, battles, battle_messages, prompt_templates, collabs,
collab_contributions, council_runs, council_artifacts,
cognitive_sessions, projects, artifacts, project_memory,
privacy_events, arcade_games, chats, chat_messages. Nothing media-,
suggestion-, or taste-shaped.

**Feedback loops that do exist:**

| Loop | Where | Kind per brief's taxonomy | Records about |
|---|---|---|---|
| Battle votes (`winner: a|b|tie|both-bad`) | `src/app/api/battles/[id]/vote/route.ts` → `battles`, Elo updates | **operator feedback** (explicit human judgment) | model response quality |
| Judge results | `battles/[id]/judge` → `judgeResult` | system outcome (or model-judged) | model response quality |
| Workload dismissal/superseded states | read-only from AA (`AssistantWorkloadItem.state`) | **observed upstream operator state** (not recorded by Arena) | archive triage items |
| Accepted/rejected/watched/rated on recommendations | — | — | **ABSENT** |

Correctly distinguishing the brief's warning: the battle vote loop is a
real preference-feedback mechanism *about models*. Reusing its shape for
media feedback later is conceivable; reusing its *semantics*
(winner-loser pairwise) would be a category error for taste.

---

## 9. Contract Compatibility Matrix

Graded against the audit brief's §11 rows (see header caveat — the
referenced contract document is absent from this repo).

| Contract requirement | Existing Arena support | Location | Gap |
|---|---|---|---|
| Behavioural evidence input | PARTIAL (transport only) | contract types `MediaExperience`, `personalContext`; validated in `generated/contract.ts`; fetched by `buildArchiveContext`; **unconsumed** | no fact builder, no prompt surface, no Arena-side storage |
| Recent behaviour | PARTIAL (transport only) | `CurrentViewingMomentum` (activeSeriesCount, recentlyWatchedCount, windowDays=30) | same |
| Long-term behaviour | PARTIAL (transport only) | `MediaExperienceItem.playCount/watchedMinutes/lastWatchedAt/progressPercent` | same |
| Rewatch evidence | PARTIAL (transport only) | per-item `playCount` in contract | same; also semantics unverified from Arena side |
| Collection relationship | PARTIAL | reconciliation consumed as ONE aggregate fact (`buildReconciliationFact`); item-level `seriesProgress/isNextEpisode/seriesTitle` transport-only | item-level relationship facts absent |
| Explicit preferences | PARTIAL | `project_memory` kind=preference (user-authored, project-scoped) | not media-scoped; no handles; not consumed by `/api/chat` |
| Scope | ABSENT in Arena; upstream hints | `DiscoverySection.status: available|limited|not_available` + `reason` | personalisation scope concept unknown (contract doc absent) |
| Coverage | ABSENT | — | entire concept missing |
| Provenance | EXISTS (domain-locked) | `ArchiveContextFact.evidence` handles + citation rules | not generalised beyond archive-ops facts |
| Epistemic status | EXISTS (domain-locked) | `RefreshObservationClass`; prompt rules 4,6,7,8,9,10 | no OBSERVED-vs-INTERPRETATION data-level split yet |
| Candidate discovery | ABSENT in Arena; CONCEPTUAL upstream | `suggestedForYou` etc.; fixtures serve `not_available` | no Arena mechanism; upstream implementation unknown from here |
| Recommendation reasoning | ABSENT as mechanism; socket EXISTS | `runChat` evidence-pack pattern + `generate()` | no personalisation pack, no rules |
| Ranking | ABSENT for media | — | existing rankings are model-quality only (§5) |
| Explanation | PARTIAL | archive fact/citation infra; upstream `reasons[]`/`evidence[]` transport-only | no INTERPRETATION class; reasons unconsumed |
| Uncertainty | EXISTS (domain-locked) | incomplete/failed/uncertain classes + prompt rules; BT CIs are model-rating CIs | no personalisation uncertainty semantics |
| Operator feedback | PARTIAL (wrong domain) | battle votes (about models); AA dismissals read-only | nothing about recommendations |
| Acquisition separation | EXISTS | `ArchiveContextClient` = six GETs, no mutation methods (types.ts); prompt rule 2,3,11; verified §12 | must be preserved through any future seam |

---

## 10. Reuse Map

**REUSE DIRECTLY**
- `src/lib/ai.ts` `generate()` — the model abstraction; recommendation
  answers flow through it unchanged.
- The evidence-pack architecture itself: config → auth resolution →
  contract-validated read client (`client.ts` + `generated/`) →
  normalizer facts with evidence handles (`context.ts`) → bounded
  redacted prompt + epistemic rules (`prompt.ts`) → `runChat` system
  concat → response meta. This *pattern* is the reuse; it is proven and
  CI-locked.
- `ARCHIVE_CONTEXT_UNAVAILABLE_NOTE`-style explicit-absence behaviour
  (fail-soft honesty) as the template for "no personalisation evidence
  was consulted."
- The lab/harness pattern (`reasoning-contract.test.ts`,
  lab-001 doc + transcript template) for interrogating any future taste
  claim before shipping it.

**ADAPT LATER**
- `project_memory` kind=preference — right idea (user-authored, kind-
  typed statements), wrong scope (project-only) and missing
  provenance/validity fields for media taste.
- `withProjectContext`-style prompt injection — shows a second,
  separate context-injection path exists; a personalisation pack should
  follow the *archive* pattern (validated, normalized, ruled), not this
  raw-text one.
- Battle feedback loop shape (explicit operator judgment persisted with
  timestamps) as inspiration for future recommendation feedback —
  different semantics, similar skeleton.

**INSUFFICIENT**
- `DirectChat` persona system prompts — personalises voice only; no
  evidence channel.
- `assistantBriefing`/discovery contract data **as currently delivered**:
  it lacks the observation-level handles (refreshId/observationId) that
  Arena's epistemic rules demand of facts — adaptation would need
  upstream provenance, not just consumption.
- Local-mode `localTextReply` — deterministic template text; excluded
  from any reasoning-quality path by design.

**DO NOT REUSE**
- Elo / Bradley-Terry (`elo.ts`, `ratings.ts`) — model-quality
  estimation from pairwise human judgment. Wrong axis entirely for taste.
- `localJudge` rubric scoring — response-quality heuristic.
- Workforce staffing shortlists — operational model selection.
- `AssistantRecommendation`/`recommendedAction` semantics as a taste
  model — acquisition/triage records, the exact conflation the brief
  forbids.
- `ReconciliationResult.candidateCount/ambiguityCandidates` — identity-
  matching candidates; name collision only.

---

## 11. Redundancy / Boundary Risks

1. **"Recommendation" tri-collision.** Arena workforce (model staffing),
   AA operational records (acquisition/repair triage), and any future
   personal media recommendations would be three domains sharing one
   word. Documented here; not reconciled in code per the brief.
2. **`assistants` naming collision.** Arena's user-persona table is
   called `assistants`; the archive product is *Archive Assistant* with
   `/assistant/*` endpoints. Already survivable today (different
   layers); would become confusing in conversation-level reasoning.
3. **`interesting` collision.** AA workload state enum includes
   `interesting`; "interest" as a preference signal is a different
   concept. The normalizer's `WORKLOAD_STATE_PRIORITY` sort is triage,
   not taste.
4. **PersonalBriefing `rank`.** `AssistantBriefingItem.rank` is AA-computed
   briefing order. If consumed naively it would look like "Arena's
   ranking"; it is upstream ranking — provenance must survive any
   future normalizer.
5. **Duplicate-concept check results:**
   - personalisation-context: **no duplicate in Arena** (no behaviour
     store, no taste model) — clean.
   - acquisition-intelligence: Arena holds reconciliation *summary*
     only; no duplicated acquisition logic. The risk is future —
     briefing/discovery data overlapping workload facts about the same
     item (e.g. a_needed_download appearing in both `personalizedBriefing`
     and workload facts with different states).
   - review/workload: already single-sourced from AA; Arena builds
     facts, no second triage brain.
   - Archive Assistant authority: intact; see §12.

**Authority & safety check (brief §15) — PASS, by construction:**
- `ArchiveContextClient` (`src/lib/archive-assistant/types.ts`) exposes
  six GET methods and nothing else — no mutation surface exists to call.
- No AA database access (HTTP-only, bearer or server-side local mode;
  `config.ts` bans implicit localhost fallback — tested).
- No provider credentials in Arena (none cross the contract; prompts are
  path-redacted in `prompt.ts`; verified live in lab-001).
- No filesystem access, provider mutation, archive mutation, acquisition
  approval, or automatic acquisition anywhere in the Arena API surface
  (44 routes audited).
- `internal/chat` truth table is exact (503/401/401/allow) with no
  identity confusion; the internal credential is never forwarded
  upstream; `x-test-owner-id` is not honoured on the service leg.
- The existing recommendation-adjacent machinery (battles, Elo,
  workforce) touches only Arena-owned tables. Nothing in it can reach
  across the boundary.

---

## 12. Smallest Future Integration Seam

Based strictly on existing components, the smallest plausible seam for
`GET /api/assistant/personalisation-context` is **the seventh read** —
same shape as the existing six, same socket:

```
GET /api/assistant/personalisation-context        (upstream; not yet in
        ↓                                          Arena's contract)
one new method on ArchiveContextClient            (types.ts — mirrors
        ↓                                          getOverview exactly;
generated contract types regenerated               contract.ts/types.ts
        ↓                                          via the existing
normalizer: personalisation payload                npm run generate:*)
        → ArchiveContextFact-shaped facts          context.ts — new
        (source:"personalisation", evidence        builder beside
         handles, classification carrying          buildWorkloadFacts
         observed/derived/unknown)
        ↓
buildArchiveContextSystemPrompt sibling            prompt.ts — same
(+ epistemic rules for taste claims:               bounded/redacted/ruled
 watched≠liked, observed≠explicit≠inferred)        pattern
        ↓
runChat system concat (existing opt-in flag       chatRunner.ts — no
pattern; e.g. archiveContext/personalContext)      structural change
        ↓
generate() → cited, non-persisted answer           ai.ts — unchanged
```

Every arrow except the first is an existing code pattern with existing
tests to imitate. What **cannot** come from existing code: the upstream
endpoint itself, its provenance semantics (do its claims carry
observation handles?), and the epistemic rules for behavioural
interpretation. If the upstream payload ships without observation-level
handles, the honest seam is to classify those facts as upstream-asserted
interpretations, not observations — the same way the bridge treats
upstream `confidence` today.

No existing Arena component can substitute for the normalizer step;
there is no alternate candidate generator or ranker waiting in the wings.

---

## 13. Missing Infrastructure

Genuine gaps only:

1. **The contract document itself** — `docs/personal-media-recommendation-
   contract.md` is referenced and absent. The matrix in §9 is graded
   against the brief's row list, not the real contract.
2. **Upstream personalisation evidence** — no endpoint, no payload, no
   provenance semantics (`/assistant/personalisation-context` does not
   exist in the six-operation contract).
3. **A normalizer fact-builder for personalisation data** — the
   overview's personalisation fields are validated then dropped; there
   is no `buildPersonalisationFacts`.
4. **Epistemic classes for behavioural claims** — no
   observed-signal/derived-interpretation/user-stated-preference
   distinction at data level (the observed ≠ explicit ≠ inferred rule
   exists in Arena only as archive-domain prompt wording).
5. **Candidate objects / persistence for recommendations** — no table,
   no lifecycle, no feedback schema (only needed once 1–4 exist; the
   lab pattern says earn it first).
6. **Browser opt-in surface for evidence packs** — the socket is
   API-only; no UI sends `archiveContext: true` (minor, but real).

Explicitly **not** gaps: ranking algorithms (no candidates to rank),
embeddings (no requirement established), a new model subsystem
(`generate()` suffices), acquisition integration (forbidden).

---

## 14. Recommended Next Slice

**One narrowly-scoped slice: bring the contract document into this repo
and interrogate it before any code — "reasoning lab-002: taste claims
on trial."**

Concretely (docs + tests-of-docs only, zero application code):

1. Add `docs/personal-media-recommendation-contract.md` (or a copy/summary
   of the canonical version) so the compatibility matrix has a real
   grading target.
2. Author lab-002 the way lab-001 was authored: define 2–3 **trap
   states** for personalisation claims before any implementation exists —
   e.g. (a) `suggestedForYou.status=not_available` (does Arena confuse
   "no discovery feed" with "nothing to recommend"?); (b) high
   `playCount` present-but-never-liked (does Arena confuse watched with
   enjoyed?); (c) explicit preference statement contradicting observed
   behaviour (which wins, and is the conflict surfaced?).
3. Define bench-authored grading keys per state, the transcript template
   reuse, and the parked watch items.

This produces the requirement spec for the seventh read and its fact
classes from *evidence about reasoning failure modes*, rather than from
architecture taste — the same discipline that made lab-001 decide watch
items instead of guessing them. Implementation of the seventh read is
the slice *after*, and only if lab-002's traps show the socket pattern
insufficient.

> **Sequencing update (owner direction, 2026-09-19):** before lab-002, the
> upstream vocabulary question had to be answered first — see
> `docs/personalisation-vocabulary-provenance-reconciliation.md`, which
> established that Arena-facing personalisation vocabulary and the newer
> usage-layer direction are two systems (different substrate, different
> epistemic standard), neither on upstream main. Lab-002 now inherits
> better-aimed traps; the seventh read additionally waits on upstream
> assigning a provenance class to the overview personal fields.
