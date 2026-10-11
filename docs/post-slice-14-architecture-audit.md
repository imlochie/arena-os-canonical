# Post–Slice 14 Architecture Audit

Date: 2026-09-13

## Scope

Static audit after the shared execution lifecycle reached selection, policy filtering, execution provenance, typed errors, retries, and controlled fallback. The audit searched for direct provider/model execution, execution outside Cognitive Sessions, legacy navigation payloads, unstructured API failures, duplicate authoritative models, and non-transactional persistence boundaries.

## Executive result

The Council, Arena, and Collab primary execution paths use durable Cognitive Sessions, Workforce assignments, Execution Policy, worker executions, retry chains, and explicit fallback reassignment. The largest remaining bypass is the legacy direct-chat subsystem, which still selects models and invokes `generate()` without Workforce assignments or worker-execution provenance.

## Findings

### P0 — Direct chat bypasses Workforce and worker execution provenance

Affected paths:

- `src/app/api/chat/route.ts`
- `src/app/api/chats/route.ts`

These routes import and invoke `generate()` directly, accept/default a model (`openai`), and do not create Cognitive Sessions, Workforce assignments, or worker-execution records. They therefore bypass Execution Policy, availability/capability filtering, retries, controlled fallback, and route provenance.

Recommended correction: migrate durable chats to mode-neutral Cognitive Sessions and assigned-worker execution. Decide explicitly whether one-shot `/api/chat` is ephemeral; if it is, document the privacy/provenance tradeoff and retain single-attempt/no-fallback semantics.

### P1 — Retry budget is assignment-global while some assignments are reused

`workerExecutor` allocates monotonically increasing attempt numbers per assignment and compares that number with the session attempt limit. Council critiques, Collab iterations, and Arena follow-ups can reuse a slot assignment for more than one logical invocation. A later invocation can therefore begin above the retry limit and receive no retry budget.

Recommended correction: add a durable execution-operation/run identity. Attempt numbers should be unique and bounded within that operation while retaining a global assignment execution sequence for ordering. Do not reset or overwrite prior attempts.

### P1 — Domain summaries can retain the original model after fallback

Battle/Collab/Council domain rows and in-memory assignment objects can continue to identify the initially selected model while `worker_executions` records the actual fallback model. The Cognitive Session endpoint exposes the authoritative chain, but mode-specific summary endpoints may be misleading if they present the selected model as the performer.

Recommended correction: expose selected assignment and actual completing assignment as separate fields. Never overwrite the original selection decision.

### P1 — Fallback configuration is only first-class on Cognitive Session creation

`POST /api/cognitive-sessions` validates and persists `fallbackPolicy` and `maxExecutionAttempts`. Direct Arena/Collab/Council creation routes default to `none` unless they continue a pre-created session. This is safe but makes controlled fallback unavailable through some entry points.

Recommended correction: use one shared parser for execution mode, retry limit, fallback policy, and pin-relaxation policy across all session-producing endpoints.

### P2 — Legacy URL context readers remain

Components still inspect URL query parameters:

- `src/components/BattleArena.tsx`
- `src/components/CollabLab.tsx`
- `src/components/CouncilLab.tsx`

Current handoff navigation uses identity-only session references, but these readers should be reviewed to ensure they accept only identifiers and harmless UI state, not inherited prompts or generated content.

### P2 — Persistence remains route-distributed

API routes contain many direct Drizzle writes. This is not automatically incorrect, but authoritative multi-row updates need review for transaction boundaries, especially mode summaries written after worker execution and fallback completion.

Recommended correction: inventory each multi-record completion path and require a transaction or an explicitly compensating lifecycle failure. Do not add a generic repository abstraction solely for style.

### P2 — Assignment supersession integrity is application-enforced

Fallback uses an atomic conditional update before inserting a replacement and has unique per-slot assignment sequences. PostgreSQL does not currently enforce “only one active assignment per session slot.”

Recommended correction: add a partial unique index on `(session_id, slot) WHERE status = 'active'` after verifying migration compatibility.

## Confirmed invariants

- Controlled fallback creates a new assignment and resets its attempt chain.
- Failed assignments remain durable and become `superseded` rather than being overwritten.
- `same_provider` and `eligible_worker` both pass through Execution Policy, capability filtering, availability filtering, and Workforce ranking.
- Offline/local-only policy remains authoritative during fallback.
- The failed worker is excluded from fallback candidates.
- Explicit pins do not relax automatically.
- Only one fallback reassignment is permitted per execution chain.
- Streaming fallback is prohibited after output begins.
- Ephemeral execution has neither retries nor fallback.
- Fallback selection failures remain structured and emit `fallback_rejected`.

## Recommended next sequence

1. Correct assignment-global retry budgeting with a durable operation identity.
2. Migrate direct chat or explicitly classify its one-shot path as ephemeral.
3. Separate selected-vs-actual worker fields in mode-specific APIs.
4. Centralize execution configuration parsing across session entry points.
5. Audit transaction boundaries and identity-only navigation readers.
6. Add the active-assignment partial uniqueness constraint.

No provider automation, adaptive routing, health polling, cost optimization, or pin relaxation should begin before these findings are resolved.
