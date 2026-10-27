# Arena OS canonical architecture gap analysis

**Repository:** `imlochie/arena-os-canonical`  
**Baseline reviewed:** `c1c1219` (`Initial canonical Arena OS build`)  
**Review date:** 2026-09-12  
**Scope:** Map the canonical repository against the proposed Cognitive Session architecture before implementation changes.

## Executive summary

Arena is not missing its product skeleton. Council, Arena battles, Collab, Projects, Artifacts, Workforce, handoff controls, local generation, and a Command Centre all have concrete implementations. The main gap is that these features are connected through UI conventions, URL parameters, and duplicate tables rather than through one durable domain model.

The most important finding is that **the repository already contains partial implementations of nearly every proposed concept, but the implementations are not yet canonical**:

- `cognitive_sessions` exists, but is a Council-only completion record rather than the durable unit for every mode.
- Council has the four intended processing steps, but no persisted lifecycle; the client advances a timer while one synchronous request runs.
- Artifact generation is narrower than a full transcript dump, but still consumes untyped model prose rather than a validated synthesis payload.
- Workforce has roles and mappings, but Council does not use the Workforce allocator when executing a run.
- Local generation exists, but local persistence does not: the server hard-requires `DATABASE_URL` and PostgreSQL.
- Handoffs and provenance exist at a shallow level, but lineage is passed through URLs and reduced to `sourceType/sourceId`.
- API routes generally emit JSON themselves, but there is no shared error envelope or protection against framework-generated HTML errors.

This supports an incremental build sequence. A rewrite is neither necessary nor advisable.

## Status key

- **Exists:** usable implementation aligned with the target concept.
- **Partial:** meaningful implementation exists, but it is not yet a reliable system boundary.
- **Missing:** no implementation of the architectural requirement was found.

## Architecture map

| Area | Status | What exists now | Critical gap |
|---|---|---|---|
| 1. Cognitive Session foundation | **Partial** | Table, migration, Council write, list API, recent-session UI | Council-only completion metadata; no shared session runtime, events, outputs, handoffs, or universal mode links |
| 2. Council state machine | **Missing** | Four pipeline steps execute in order | No persisted backend state; UI uses 20/45/70-second timers |
| 3. Clean synthesis → artifact | **Partial** | Artifact receives synthesis only, not the complete transcript | Synthesis is unstructured Markdown; no clean typed payload or validation boundary |
| 4. Structured API errors | **Partial** | Most route handlers call `Response.json` with statuses | Flat inconsistent `{ error: string }`; swallowed failures; no global JSON boundary or client parser |
| 5. Workforce / role routing | **Partial** | Role registry, job maps, strategy maps, Elo-informed recommendation API | Runtime Council still chooses random/user models and job-local role prompts directly |
| 6. Online / Offline boundary | **Partial** | Local flag, network detection, local text/image fallback, WebLLM support, service worker | PostgreSQL and `DATABASE_URL` are mandatory; “offline” is not a complete persistence/inference capability contract |
| 7. Handoffs + provenance | **Partial** | Handoff buttons, URLs, project association, `sourceType/sourceId` | No first-class handoff record, parent graph, session linkage, contributor snapshot, or immutable provenance |
| 8. Command Centre orchestration | **Partial** | Intent front door, project pulse, recent intelligence | Static button routing; no interpreted plan or session creation/orchestration |
| 9. Interaction primitives | **Mostly exists** | Copy, retry, continue, artifact save, project memory save, handoff controls | Inconsistent across output types; errors often swallowed; operations are not session-aware |
| 10. Provenance survival | **Partial** | Project IDs and shallow source pointers on several records | Provenance is lossy and not enforced across transformations |

---

## 1. Cognitive Session foundation

### Existing

- `src/db/schema.ts` defines `cognitiveSessions`.
- `drizzle/0008_cognitive_sessions.sql` creates the table.
- `POST /api/council` promotes a completed Council run into a Cognitive Session.
- `GET /api/cognitive-sessions` lists sessions and can filter by project.
- `src/app/command/page.tsx` displays recent sessions.

Current fields cover a useful seed: project, Council run, title, job, source material, three model assignments, two role labels, status, and creation time.

### Partial or misleading

- A session is created **after all Council work succeeds**. It cannot represent queued/running/failed/cancelled work.
- It has a hard `councilRunId` and Council-specific A/B/synthesis columns, so it is not mode-neutral.
- The status default is `completed`, with a comment describing only `running|completed|failed|archived`.
- Arena battles and Collab runs do not create sessions.
- There are no session inputs, participants, role assignments, results, artifacts, handoffs, provenance records, event history, timestamps per stage, or failure details.
- “Resume” in Command Centre reconstructs a new Council URL from old material; it does not reopen or continue the durable session.

### Required foundation

Use a mode-neutral session root and normalized child records. At minimum:

```text
cognitive_sessions
- id
- project_id
- parent_session_id
- intent
- mode                 council | arena | collab | ...
- title
- status
- current_stage
- created_at
- started_at
- completed_at
- failed_at
- cancelled_at
- error_code
- error_message
- metadata

session_inputs
session_participants
session_role_assignments
session_events
session_outputs
session_artifacts
handoffs
```

Mode-specific execution tables such as `council_runs`, `battles`, and `collabs` can remain, but they should reference `session_id`. The session must be created before execution begins.

**Verdict:** The naming and first table exist; the durable abstraction does not yet.

---

## 2. Council state machine

### Existing

`src/app/api/council/route.ts` performs the intended stages:

1. two perspectives in parallel;
2. two cross-critiques in parallel;
3. synthesis;
4. artifact generation.

`COUNCIL_STAGES` in `src/lib/cognitiveJobs.ts` defines matching display labels.

### Missing

`src/components/CouncilLab.tsx` advances the display with client timers:

```ts
setTimeout(() => setStage(1), 20000)
setTimeout(() => setStage(2), 45000)
setTimeout(() => setStage(3), 70000)
```

Meanwhile, `POST /api/council` is one synchronous request. No state is written until all model calls and both database inserts finish. This exactly permits the reported “backend complete, UI still buffering” class of bug.

There is also no cancellation endpoint, failure state persistence, stage retry/idempotency, heartbeat, or recovery after page refresh.

### Required

Adopt one canonical lifecycle, for example:

```text
created
→ running
→ collecting_perspectives
→ cross_critique
→ synthesizing
→ artifact_generation
→ complete
```

with `failed` and `cancelled` terminal branches. Prefer stable machine values (for example `cross_critique`, not display punctuation).

Implementation should:

- create the session before starting work;
- transition status server-side at each boundary;
- append transition events rather than only overwriting current state;
- expose state via polling, SSE, or both;
- make terminal transitions idempotent;
- record structured failure data;
- have the UI render only reported backend state.

**Verdict:** Highest-priority functional gap.

---

## 3. Clean synthesis → artifact boundary

### Existing

The current implementation is better than a complete transcript dump. The artifact call receives:

```text
Based on this synthesis, produce the artifact.

SYNTHESIS:
{synth.text}
```

It does not directly receive original prompts, perspectives, and critiques. This limits contamination.

### Partial

The synthesis itself is free-form Markdown generated from raw material, perspectives, and critiques. The artifact transformer then receives that unvalidated prose. There is no guarantee that it contains only source facts rather than prompt fragments, model commentary, or instruction-like content.

The persistence model stores only `synthesis: text` and artifact `body: text`. There are no reusable semantic fields.

### Required

Introduce a validated `StructuredSynthesis` contract:

```ts
interface StructuredSynthesis {
  title: string;
  thesis: string;
  keyInsights: string[];
  disagreements: Array<{
    topic: string;
    positions: string[];
    resolution?: string;
  }>;
  decisions: string[];
  openQuestions: string[];
  recommendations: string[];
  provenance: ProvenanceRef[];
}
```

The synthesis stage should produce this payload, validate it, and persist it. Artifact rendering should receive only an allowlisted artifact DTO derived from it. Raw transcripts can remain available for audit, but must not cross the transformer boundary implicitly.

**Verdict:** Input narrowing exists; the actual data boundary is still missing.

---

## 4. Machine-readable API failures

### Existing

Most route code explicitly uses `Response.json` and appropriate 4xx/5xx statuses. The battle stream serializes SSE events as JSON.

### Partial

Error shapes are mostly flat and inconsistent:

```json
{ "error": "not found" }
```

Some GET failures return successful empty collections, making “no records” indistinguishable from “database failed.” Several client calls swallow errors with empty `catch` blocks. Council assumes every response can be parsed with `r.json()`, so an HTML framework/proxy response becomes a JSON parse failure rather than a useful domain error.

There is no shared error code taxonomy, request ID, details field, retryability indicator, or content-type-safe client helper.

### Required

Create shared server and client primitives around:

```json
{
  "error": {
    "code": "MODEL_UNAVAILABLE",
    "message": "The selected model is unavailable.",
    "retryable": true,
    "details": {},
    "requestId": "..."
  }
}
```

Also add a JSON-safe top-level error boundary/middleware where feasible, and a client fetch helper that checks status and content type before parsing. SSE errors should use the same nested error object.

**Verdict:** JSON is customary, not guaranteed as an API contract.

---

## 5. Workforce and role routing

### Existing

`src/lib/workforce.ts` is a strong conceptual start:

- eight cognitive roles;
- role prompt fragments;
- preferred model lists;
- role-to-job capability declarations;
- `JOB_ROLE_MAP` and `STRATEGY_ROLE_MAP`;
- Elo category per role.

`GET /api/workforce` combines these definitions with model/category ratings and returns recommendations. The Command Centre displays those recommendations.

### Partial

Council execution does not call `rolesForJob`, use role prompt fragments, or consume Workforce recommendations. It uses role definitions embedded in each Cognitive Job and selects random/user-selected model IDs. Thus Workforce currently describes the product but does not allocate its execution.

The recommendation API also does not fully check availability/capability. Its fallback can recommend a preferred ID that is absent from the database, and overall Elo is not a provider-health signal.

### Required

Add an allocator with explicit inputs and persisted output:

```text
intent + mode + task requirements + availability + policy
→ required roles
→ candidate workers
→ scored allocation
→ assignment snapshot on session
```

Selection should account for role capability, current availability, online/offline mode, provider health, cost/privacy policy, model context limits, and ratings. The resulting assignment must be immutable session provenance even if rankings later change.

**Verdict:** The ontology exists; operational routing is not wired into execution.

---

## 6. Online / Offline boundary

### Existing

- `privacyFlags()` combines a persisted Local Mode setting with `navigator.onLine`.
- AI routes accept `localOnly` and suppress BYOK keys/network calls when it is true.
- `src/lib/ai.ts` provides local text and procedural image paths plus offline fallback.
- `src/lib/webllm.ts` supports cached browser inference.
- A service worker and offline UI indicators exist.

### Critical gap

`src/db/index.ts` throws immediately without `DATABASE_URL` and supports only PostgreSQL via `pg`:

```ts
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}
```

Therefore the canonical app is not independently operable offline and does not implement the proposed `No DATABASE_URL → PGlite → .arena-data` path. Browser network state is also being used as a proxy for operating mode; it is not a complete statement of model and persistence capabilities.

### Required

Define an application-level runtime capability contract, for example:

```ts
interface RuntimeCapabilities {
  mode: "online" | "offline";
  persistence: "postgres" | "pglite";
  inference: Array<"remote" | "webllm" | "local-fallback">;
  externalNetworkAllowed: boolean;
  durable: boolean;
}
```

Both canonical and local-first implementations should satisfy the same interfaces and schema semantics. Provider adapters may differ; the domain model must not.

**Verdict:** Local inference is meaningful, but offline is not yet a full system boundary.

---

## 7. Handoffs and provenance

### Existing

- `src/lib/handoffs.ts` builds Council/Arena/Collab URLs carrying text, project ID, and a source token.
- `HandoffButtons` saves artifacts and project memory.
- Unified artifacts retain `sourceType` and `sourceId`.
- Council dual-writes a Council artifact and a unified artifact.

### Partial

A handoff is not persisted. Its payload is placed in query parameters and truncated to 4,000–8,000 characters. The destination generally receives material and a `source` string but does not persist that source on its execution record. There is no state such as offered/accepted/executed/failed, no parent-child session link, and no typed transformation record.

Provenance is only one shallow pointer. It does not preserve source session, source artifact, parent output, model/role contributors, decision that initiated the transformation, or transformation version.

### Required

Persist handoffs as first-class records and pass a handoff ID through navigation. On acceptance, create the destination session with parent/session/output links. Never use copied text as the identity of transferred work.

**Verdict:** Good interaction prototype; not durable connective tissue.

---

## 8. Command Centre orchestration

### Existing

`src/app/command/page.tsx` is already framed around “What are you trying to do?” It exposes intent choices, routes into Council/Arena/Collab, shows projects and intelligence, and surfaces Workforce recommendations.

### Partial

Routing is a static `INTENTS` lookup. Free text is inserted into a destination URL. No command plan is generated or persisted, and the `/api/command` route is read-only aggregation. The system does not infer project, required roles, mode constraints, workforce assignments, expected output, or privacy boundary.

### Required

Add a planner that returns a reviewable execution plan:

```text
intent → mode → project → roles → allocation → session → expected outputs
```

The plan should be deterministic where possible, explain why a mode was chosen, permit user correction, and create the Cognitive Session before navigation/execution.

**Verdict:** Correct front-door UX exists; orchestration does not.

---

## 9. Interaction primitives

### Existing

The repository already has more than a prototype viewer:

- Council: copy synthesis/artifact, download artifact, save template, hand off, save artifact/memory.
- Arena: per-response copy, retry, multi-turn continuation, prompt templates, handoffs.
- Collab: copy synthesis, iterate, save template, handoffs.
- Artifact library: copy and editing flows.

### Partial

Coverage and behavior are inconsistent. Many mutations silently ignore failures, copy fallbacks do not always actually copy, and “continue” or “retry” usually operates on an execution table rather than a Cognitive Session. Save/handoff actions do not create complete provenance.

**Verdict:** Do not prioritize broad UI redesign. Normalize these controls after the session, error, and provenance contracts exist.

---

## 10. Provenance survival

### Existing

Project ownership and source pointers appear across battles, collabs, Council runs, artifacts, chats, and arcade records. Council records model IDs and role labels. This is enough for basic display and manual tracing.

### Missing from the canonical contract

There is no enforced provenance snapshot containing:

- creator/actor;
- source and parent session;
- source and parent artifact/output;
- project at creation time;
- mode and job;
- role-to-model assignments;
- provider/inference route actually used;
- transformation/version;
- initiating decision/handoff.

The `generate()` result has a `via` field, but Council does not persist it for any stage. Consequently even model execution provenance is lost after the response.

**Verdict:** Provenance is scattered metadata, not a surviving graph.

---

## Cross-cutting repository risks

### Schema and migration reliability

Only `drizzle/0008_cognitive_sessions.sql` is present, although `src/db/schema.ts` defines the entire application schema. A fresh database cannot be reconstructed from the checked-in migration set alone unless schema setup is performed elsewhere. This should be resolved before expanding the durable session model.

The schema also declares relationships as plain UUID/text columns without database foreign keys. That permits orphaned runs, sessions, artifacts, and projects and makes provenance integrity best-effort.

### Duplicate artifact concepts

`council_artifacts` and `artifacts` are dual-written, with errors on the unified write swallowed. This can produce a successful Council result that is absent from the canonical library. A single canonical artifact record plus typed session-output links would be safer.

### Transaction boundaries

Council persists the run, Council artifact, session, and unified artifact in separate operations without a transaction. Partial persistence is possible. The unified artifact failure is intentionally ignored.

### Long synchronous request

The full Council pipeline runs inside one request with `maxDuration = 180`. This makes browser disconnects, deployment timeouts, cancellation, recovery, and backend-driven progress difficult. A state machine should be paired with a resumable worker/job boundary, not merely additional status labels.

### Silent degradation

Several read APIs convert database exceptions into HTTP 200 empty arrays. `generate()` also guarantees an offline fallback, which is useful for resilience but can conceal provider outages unless the `via` route is surfaced and persisted. Resilience should remain, but degraded operation must be observable.

---

## Recommended implementation sequence

### Phase 0 — Contract decisions and migration safety

Before feature changes:

1. Choose canonical status names (`complete` vs `completed`) and transition rules.
2. Define mode-neutral Session, Event, Output, Assignment, Provenance, and Handoff contracts.
3. Establish a complete migration baseline and migration test for a fresh database.
4. Decide the shared persistence adapter contract that PostgreSQL and PGlite must satisfy.

### Phase 1 — Durable Cognitive Session

- Replace Council-specific session columns with mode-neutral session fields and normalized assignment/input/output records.
- Add `session_id` to Council, Arena, and Collab executions.
- Create sessions before execution.
- Migrate/backfill existing Council records.
- Add create/get/list/update APIs with validated transitions.

**Exit criterion:** Council, Arena, and Collab executions can all be traced to one session root.

### Phase 2 — Council state machine

- Move the pipeline into a resumable service/job.
- Persist every transition and terminal error.
- Expose session state through polling or SSE.
- Remove all elapsed-time stage simulation from `CouncilLab`.
- Add cancellation and idempotent retry semantics.

**Exit criterion:** Reloading the page shows the true current stage and completed work never appears as running.

### Phase 3 — Structured synthesis and artifact pipeline

- Add the validated synthesis schema.
- Persist structured synthesis as a session output.
- Derive a minimal artifact DTO.
- Generate the canonical artifact once, in a transaction with links/provenance.
- Add contamination regression fixtures.

**Exit criterion:** Artifact generation cannot access raw transcript/prompt fields by construction.

### Phase 4 — Error contract

- Add shared `ApiError`, response helpers, and safe client fetch.
- Convert all HTTP and SSE endpoints.
- Stop returning empty success payloads for infrastructure failure.
- Include request IDs and persist session failure codes.

**Exit criterion:** Every API failure is parseable and actionable even when upstream infrastructure fails.

### Phase 5 — Operational Workforce

- Add capability/availability-aware allocation.
- Use it in Council first, then Collab/Arena where applicable.
- Persist role and model assignment snapshots on sessions.

**Exit criterion:** Runtime assignments can be explained from required roles and current capabilities.

### Phase 6 — Real Online / Offline boundary

- Introduce persistence and inference adapters.
- Add PGlite/`.arena-data` fallback when `DATABASE_URL` is absent.
- Report explicit runtime capabilities.
- Test feature behavior with network disabled and no external database.

**Exit criterion:** Offline mode can create, execute, persist, reload, and hand off a session without remote dependencies.

### Phase 7 — Handoffs and provenance

- Persist handoffs and lineage.
- Link destination sessions to source sessions/outputs/artifacts.
- Persist actual model provider route (`via`) per generated output.
- Make provenance visible and exportable.

**Exit criterion:** Any artifact can answer where, why, and by whom it was produced across multiple transformations.

### Phase 8 — Command Centre orchestration

- Add intent planning and project/mode/role recommendations.
- Create session plans before routing.
- Allow user review and correction.

### Phase 9 — UI normalization

- Standardize copy/save/retry/continue/handoff controls.
- Route all errors through the shared parser.
- Add state and provenance displays.
- Polish only after backend contracts are stable.

---

## First implementation slice

The safest first coding slice is deliberately narrow:

1. Define canonical session status and transition types in a shared domain module.
2. Add mode, current stage, lifecycle timestamps, and structured failure fields to `cognitive_sessions`.
3. Add append-only `cognitive_session_events`.
4. Create the Council session before stage 1 and update it around each existing stage.
5. Add a session detail/status endpoint.
6. Replace Council's timers with backend state polling or SSE.
7. Persist `failed` on all caught Council pipeline errors.

This fixes the observed functional bug while establishing the abstraction needed by every later phase. It does not require rewriting model generation, projects, artifacts, or the existing Council prompt definitions.

## Architectural rule for canonical and local-first

Both repositories should share the same domain contracts, lifecycle semantics, structured payloads, provenance model, and migration intent. They may use different adapters:

```text
Canonical:   domain → PostgreSQL adapter → remote/local inference adapters
Local-first: domain → PGlite adapter     → local-first inference adapters
```

Do not copy business rules into adapter-specific implementations. The state machine and data contracts are the product architecture; storage and provider selection are deployment choices.
