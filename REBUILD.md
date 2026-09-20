# Arena Rebuild Record

**Status:** Phase 0 complete — evidence captured; no legacy behavior has been silently removed.

**Audited checkout:** `arena/01a0bebf-arena-os-canonical` at `c1c12190692c17fc5c922cb030e8158927716c9c`

**Audit date:** 2026-09-20

**Canonical vision:** Arena is a private, local-first AI creative and reasoning environment where multiple agents can think, argue, collaborate, challenge one another, create artifacts, remember context, and help a human turn ideas into finished work.

This is a continuity rebuild, not a rewrite that discards prior discovery. The current application is retained as an evidence base until every preserved capability has a canonical successor, an export path, or a documented retirement decision.

## 1. Evidence reviewed

| Area | Evidence inspected | What it establishes |
| --- | --- | --- |
| App shell and visual system | `src/app/layout.tsx`, `src/components/Nav.tsx`, `src/app/globals.css` | A dark-first command-room language, strong gradients, compact status chips, project handoffs, and responsive navigation are already established. |
| Interaction surfaces | 18 page routes and 35 API route files | The prior product explored Arena/battles, Council, Collab, chat, command centre, projects, artifacts, assistants, privacy, image generation, model rating, and an unrelated Arcade Forge. |
| Domain persistence | `src/db/schema.ts`, one migration in `drizzle/0008_cognitive_sessions.sql` | PostgreSQL/Drizzle is a viable starting point; relationships and constraints are insufficient for multi-user canonical use. |
| AI integration | `src/lib/ai.ts`, `stream.ts`, `models.ts`, `localEngine.ts`, `webllm.ts` | The app proved parallel model calls, an OpenAI-shaped cloud call, stream UI, BYOK experiments, local WebLLM exploration, and an offline deterministic fallback. |
| Agent and orchestration concepts | `workforce.ts`, `cognitiveJobs.ts`, `strategies.ts`, `collab.ts`, `battleSetup.ts` | Agent roles, intentional disagreement, cross-critique, synthesis, structured cognitive jobs, and configurable prompts are high-value product discoveries. |
| Privacy concepts | `privacy.ts`, `privacyClient.ts`, privacy routes/pages | Explicit local mode, ephemeral mode, export/wipe language, and privacy events are worth preserving, but client flags cannot provide canonical privacy enforcement. |
| Quality and operations | package scripts, schema history, routes, audit | There are no automated tests, no worker, no auth, no Docker, no current docs, and no server-side authorization. Type checking passes; lint and production build are not clean. |

### Baseline command results

| Command | Result on 2026-09-20 | Interpretation |
| --- | --- | --- |
| `npm run typecheck` | pass | The snapshot type-checks after `npm ci`. |
| `npm run lint` | fail: 20 errors, 2 warnings | Existing Next/React lint issues must be cleared before treating the legacy app as a quality baseline. |
| `npm run build` | compile succeeds; fails while collecting API route data because `DATABASE_URL` is required at module evaluation | The current DB initialization prevents configuration-safe build/inspection. |
| `npm audit --omit=dev` | 1 critical, 2 high advisories | The current dependency set is not a release foundation. |

## 2. Inventory and classification

Classification means: **KEEP** is a durable implementation or asset; **ADAPT** keeps the behavior but changes boundaries; **REBUILD** preserves the capability but replaces the implementation; **RETIRE** removes it from the canonical product; **INVESTIGATE** requires a product, legal, or technical decision before commitment.

### Product flows and UI

| Existing area | Evidence | Classification | Canonical disposition |
| --- | --- | --- | --- |
| Command Centre / intent launcher | `src/app/command`, `/api/command` | **ADAPT** | Keep the large “What are we working on?” launch interaction, but replace optimistic intelligence counters with project-scoped Activity, Tasks, Decisions, and real job state. |
| Blind two-way model Arena | `BattleArena.tsx`, battle routes, Elo/statistics | **ADAPT** | Preserve side-by-side comparison, blind evaluation, vote history, and follow-ups as a **Model Evaluation** mode. It is not the signature multi-agent Arena on its own. |
| Multi-agent Collab Lab | `CollabLab.tsx`, collab routes | **REBUILD** | Preserve draft → critique → synthesis and human iteration. Replace serialized collaborator JSON, fixed rounds, sequential request handling, and no authorization with Battle/Response/Participant records and worker jobs. |
| Council Lab | `CouncilLab.tsx`, council routes | **ADAPT** | Preserve perspectives → cross-critique → synthesis → artifact as the canonical Council workflow. Replace fixed two-role columns, opaque text-only fields, and dual artifact stores with structured response/provenance records. |
| Direct Chat | `DirectChat.tsx`, chats routes | **ADAPT** | Keep as the simplest entry route, with canonical conversations, messages, project association, model identity, streaming, and source-aware retrieval. |
| Projects | project pages/routes | **REBUILD** | Preserve long-lived containers and the overview interaction. Add owner, collaboration, scoped resources, files, tasks, decisions, activity, permissions, and deletion policy. |
| Artifact library and handoffs | artifacts routes, `HandoffButtons.tsx`, `handoffs.ts` | **ADAPT** | Preserve handoff momentum and reusable artifacts. Add editor, versions, source links, typed provenance, export, and access checks. |
| Assistant builder | assistants routes, `AssistantsManager.tsx` | **REBUILD** | Preserve custom name/avatar/instructions/model/temperature. Replace globally accessible assistant rows with user/project-owned configurable agents, tool grants, memory scope, and model capabilities. |
| Prompt templates | templates routes | **ADAPT** | Move to Library prompt assets with ownership, variables, versioning, and project duplication. |
| Privacy centre | privacy page/routes | **REBUILD** | Preserve the inspectable privacy posture, event language, exports, wipe intent, local mode, and ephemeral sessions. Enforce all controls server-side per account/project and show actual provider egress. |
| Leaderboard / ratings | leaderboard, stats, `ratings.ts` | **KEEP** for evaluation module | Preserve the transparent personal-evaluation math as an optional model-evaluation capability, clearly isolated from agent quality claims and workforce routing. |
| Image Arena | `/image`, image path in `ai.ts` | **INVESTIGATE** | Vision/image capability belongs in the provider interface, but image-specific evaluation is not a core Phase 1–6 product surface. Preserve only behind a capability flag. |
| Guide, standards, market, principles pages | static routes | **ADAPT** | Mine written product insights; replace marketing claims and legacy naming with canonical documentation and honest capability status. |
| Arcade Forge + games | `ArcadeForge.tsx`, `src/lib/games/*`, arcade routes | **RETIRE from core** | It is a substantial offline/WebLLM experiment but does not serve the canonical work loop. Preserve code in history or a future optional example package; do not carry it into the core shell or schema. |

### Reusable implementation assets

| Asset | Classification | Rationale and canonical successor |
| --- | --- | --- |
| `src/lib/ratings.ts`, `elo.ts` | **KEEP** | Independent, testable rating code with transparent assumptions. Move to an evaluation package and add tests before reuse. |
| `src/lib/cognitiveJobs.ts` and `workforce.ts` | **ADAPT** | Strong reusable starter-role vocabulary and workflow prompts. Store starter templates as seed data rather than code-bound product policy. |
| `src/lib/strategies.ts`, `collab.ts` | **ADAPT** | Useful collaboration strategy patterns. Represent as workflow templates and participant setup rules. |
| `src/lib/battleSetup.ts` | **ADAPT** | Preserve explicit fighter resolution and randomized display position. Replace `FREE_MODELS` dependency with provider/model registry lookup and permission checks. |
| `src/lib/handoffs.ts` | **ADAPT** | The explicit workflow handoff concept is worth preserving. Use server-created provenance references, not only query-string text. |
| `src/lib/projectContext.ts` | **REBUILD** | Project context injection is a useful discovery, but concatenating memory into prompts is not retrieval, lacks provenance, and risks context contamination. Replace with scoped retrieval citations. |
| `src/lib/stream.ts` | **ADAPT** | SSE is a workable delivery mechanism. Put a single event contract on top of job and response events, with resume/cancellation semantics. |
| `src/lib/models.ts` | **REBUILD** | It is a static free-model catalog coupled to Pollinations aliases. Replace with provider/model/configuration tables and capability metadata. |
| `src/lib/ai.ts` | **REBUILD** | It proves a call shape but mixes provider selection, cloud fallbacks, image generation, local procedural output, and BYOK in one function. Replace with provider adapters and explicit routing. |
| `src/lib/webllm.ts` | **ADAPT / INVESTIGATE** | Browser-local inference is strategically valuable; current code only serves Arcade code generation. Validate browser compatibility and memory constraints before canonical provider support. |
| `src/lib/localEngine.ts` | **RETIRE as AI fallback** | Deterministic text/image replies and heuristic Council content are honest only when labelled as templates. They must never be used as a silent “AI succeeded” fallback. Retain test fixtures/procedural demo utilities only. |
| `src/lib/privacy.ts` | **ADAPT** | Metadata-only privacy event discipline and sealed ephemeral reveal are useful. Replace environment-derived signing and request-body privacy assertions with account-level policy enforcement. |
| `src/lib/games/*` | **RETIRE from core** | Independent optional experiment; outside product scope. |

### Persistence and API inventory

| Current data/API group | Classification | Why it cannot be canonical unchanged |
| --- | --- | --- |
| `models`, `modelCategoryRatings` | **REBUILD** | Models have no provider entity, capabilities, local/cloud identity, availability, ownership, or cost data. |
| `assistants` | **REBUILD** | No owner/project scope, tool grants, memory scope, provider policy, or versions. |
| `battles`, `battleMessages` | **ADAPT** | Useful transcript records but only two sides, text columns for outcomes, no participants/rounds/response objects/citations/provenance or job state. |
| `collabs`, `collabContributions` | **REBUILD** | `collaborators` is serialized JSON and contribution metadata is incomplete; use normalized participant, round, response, and challenge relationships. |
| `councilRuns`, `councilArtifacts`, `cognitiveSessions` | **REBUILD** | Valuable concepts but overlapping lifecycle models and dual artifact persistence create ambiguity. Normalize around sessions, responses, Council sessions, artifacts, and source links. |
| `projects`, `artifacts`, `projectMemory` | **REBUILD** | Good first cut, but no owner, access control, update/version fields, files, source relationships, confidence/scope, or activity. |
| `chats`, `chatMessages` | **ADAPT** | Preserve content with mapping; move to conversation/message with user/project ownership, model/provider metadata, structured response links, and delete/export semantics. |
| `privacyEvents` | **REBUILD** | Preserve intent; events lack actor/project/provider/retention context and are globally readable. |
| arcade tables | **RETIRE from core** | Exportable legacy data only. |
| all current route handlers | **REBUILD** | They have no authentication, authorization, rate limiting, validation schema, CSRF policy, centralized error model, pagination guarantees, or consistent resource shape. |

## 3. What the previous Arena taught us

1. **Tension is a feature.** The best existing flows explicitly request competing drafts, critique, and synthesis. The canonical Arena must preserve visible disagreement rather than flattening everything into one answer.
2. **Work needs an object model.** The prior app began moving from transcript-only outputs toward Projects, Artifacts, Memory, Cognitive Sessions, and handoffs. The rebuild should complete this move rather than add more screens around chat.
3. **Human choices matter.** Blind voting, crowning a contribution, choosing a Council job, and providing iteration instructions are meaningful interaction patterns. Canonical automation must retain the human approval points.
4. **Local-first must be legible.** The local/ephemeral controls show a valid product instinct. The technical promise must become enforceable: no client checkbox may be the sole privacy boundary.
5. **Model identity needs transparency.** Anonymous evaluation is useful for a deliberate vote, but ordinary project work needs provider/model/environment metadata on responses.
6. **Design language is an asset.** The dark, typographic, restrained “command room” feel should continue. The dense legacy navigation and neon/emoji accumulation should be simplified in favor of the canonical information architecture.
7. **Fallbacks must be honest.** The current deterministic local engine kept demos responsive but conflates a template fallback with model inference in some paths. Canonical Arena will show unavailable/failed states rather than silently substituting generated-looking content.

## 4. Non-negotiable gaps before any public canonical release

- Authentication and server-side authorization for every resource.
- Per-user and per-project data isolation; no global list/read/delete API behavior.
- Input validation, rate limiting, secure session handling, safe file design, security headers, and CSRF strategy.
- A real provider abstraction; no implicit provider switch or unlabelled deterministic fallback.
- A normalized response/provenance model and artifact version history.
- A worker/queue with durable job status, cancellation, retry, and idempotency.
- Real migration chain, database constraints/foreign keys/indexes, and test coverage.
- Actual local-provider support (Ollama/OpenAI-compatible endpoint first), with egress controls demonstrably enforced.
- Privacy deletion/export semantics that include all related records.
- Dependency remediation and clean quality gates.

## 5. Canonical build sequence

The rebuild proceeds through usable vertical slices, not a broad UI rewrite:

1. **Foundation:** secure configuration, modular boundaries, database baseline, auth/authorization, application shell, providers, local + cloud adapter, response streaming.
2. **Conversation:** persisted, project-associated conversations with provenance and search.
3. **Agents:** configurable owned agents, registry, tool grants, inspectable scoped memory.
4. **Arena:** multi-agent session, structured rounds/responses, visible states, stop/redirect.
5. **Battles:** challenge links, response diff, modes, history, human review.
6. **Council:** typed synthesis, decisions, durable artifacts, full provenance.
7. **Projects:** files, retrieval, memory, tasks, activity, decisions.
8. **Workforce and approvals:** proposed plans, task assignment, explicit approval gates.
9. **Collaboration:** invitations and server-enforced roles.
10. **Library and privacy:** reusable assets, export/deletion/audit dashboard.

The first implementation slice must establish an authenticated project, an explicit provider/model selection, a persisted real response with provenance, and a server-enforced owner check. It must not imitate a full dashboard before those invariants exist.

## 6. Continuity acceptance ledger

| Prior discovery | Canonical home | Status |
| --- | --- | --- |
| Blind side-by-side model comparison and user vote | Optional Model Evaluation mode | Planned |
| Diverse agents and roles | Agent template + configuration model | Planned |
| Draft → critique → synthesis | Arena rounds + Council pipeline | Planned |
| Projects as durable workspaces | Project aggregate | Planned |
| Artifact handoff | Artifact provenance/source links | Planned |
| Memory as reusable project knowledge | Scoped, inspectable Memory entries | Planned |
| Local mode and ephemeral use | Privacy policy + session execution mode | Planned |
| Model transparency and ratings | Provider/model registry + optional evaluation module | Planned |
| Dark command-room visual language | Canonical shell/design tokens | Planned |
| Arcade/WebLLM experiment | Optional future example, outside core | Retired from core |

No legacy product area may be deleted from this record without adding either (a) its canonical successor, (b) an export path, or (c) a reasoned retirement decision.
