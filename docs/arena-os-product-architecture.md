# Arena OS — Canonical Product Architecture

**Status:** North-star architecture  
**Date:** 2026-09-13  
**Audience:** Product owner, contributors, and future agents working in the canonical or local-first repositories

## 1. Product definition

> **Arena OS is a private, personal AI operating environment where multiple intelligences can work independently and together over long periods, using suitable local or online workers for each job while the user retains control of data, memory, security, and creative work.**

Arena is the user's durable home. Models and providers are replaceable workers. The product is not a model dashboard, a thin multi-chat client, or a provider-owned memory layer.

The primary interaction is a cognitive job or goal:

- “Help me understand this.”
- “Build this with me.”
- “Explore and challenge this idea.”
- “Continue the work we started yesterday.”

The user should not need to begin by selecting a model. Arena resolves an appropriate cognitive workforce within explicit policy.

## 2. Primary user and north star

The primary user is the owner of the Arena environment. Multi-user and organizational concerns must not weaken personal ownership or local-first operation.

### Concrete success condition

> The user can pick up an iPhone, speak to Arena, start or continue complex work, allow multiple suitable AI workers to research, reason, build, test, and critique over an extended period, return later to inspect every decision and artifact, and control exactly what remains local and what may leave the environment.

Success requires continuity across devices without making an external AI provider the system of record.

## 3. Product principles

### 3.1 User ownership

The user owns sessions, memories, artifacts, configuration, and execution history. Data must be inspectable, exportable, editable where semantically appropriate, and deletable.

### 3.2 Local-first, not local-only

Core records live in the Arena environment. Local execution must remain viable for private, offline, long-running, and provider-independent work. Online intelligence is an optional capability invoked through policy.

### 3.3 External by permission

No remote provider call may occur when execution or context policy forbids it. “Offline” is an operating mode, not an error or degraded UI state.

### 3.4 Choose the job, not the model

Product flows request cognitive roles and capabilities. Workforce resolves workers. Explicit model pins remain available as an advanced, authoritative constraint.

### 3.5 Transparent collaboration

Assignments, attempts, retries, fallbacks, handoffs, inputs, outputs, decisions, and artifacts must have visible provenance. Arena must not silently change workers, providers, models, or privacy boundaries.

### 3.6 Model and provider independence

Provider disappearance, policy changes, subscription cancellation, or model retirement must not take the user's archive, memory, or project history with it.

### 3.7 Creative freedom

The environment should support experimentation and long-lived creative work without making one provider's availability or product policy the foundation of the user's intellectual life.

### 3.8 Bounded autonomy

Autonomous work is explicit, observable, interruptible, budgeted, and checkpointed. Agents do not receive unbounded authority, execution time, external access, or recursive task creation.

### 3.9 Canonical conceptual model

Canonical and local-first repositories must share the same domain concepts even where their deployment and implementation differ.

## 4. Canonical product model

```text
User
 └── Arena Environment
      ├── Projects
      ├── Cognitive Sessions
      │    ├── Goal and constraints
      │    ├── Context and memory references
      │    ├── Plan and task graph
      │    ├── Workforce assignments
      │    ├── Worker executions
      │    ├── Decisions and checkpoints
      │    ├── Artifacts
      │    └── Timeline and provenance
      ├── Memory and knowledge
      ├── Workforce registry
      ├── Security and privacy policy
      └── Devices and interfaces
```

A Cognitive Session is the mode-neutral unit of meaningful work. Council, Arena, Collab, personal assistance, and future autonomous workflows specialize it; they do not create competing lifecycle systems.

## 5. Layered architecture

Dependencies should generally flow downward. Interfaces and domain modes consume shared services; provider plumbing must not leak upward into domain cognition.

### Layer 1 — Interfaces

**Responsibilities**

- Text chat and command entry
- Voice input and spoken response
- Mobile and desktop presentation
- Projects, sessions, timelines, artifacts, and controls
- Notifications and checkpoint review
- Accessible offline state

Interfaces render canonical backend state. They do not infer session progress from elapsed time or transfer inherited work through URLs. Navigation carries identity; APIs load authoritative context.

### Layer 2 — Jarvis

**Responsibilities**

- Intent understanding
- Personal assistance
- Context assembly
- Planning requests
- Memory retrieval requests
- Check-in and notification strategy
- Converting human goals into bounded session work

Jarvis is not a privileged super-model. It is an Arena capability built from sessions, memory, policy, and Workforce. It may ask workers for help but cannot bypass execution policy.

### Layer 3 — Cognitive Sessions

**Responsibilities**

- Durable goal and lifecycle
- Mode-neutral status and terminal state
- Inputs and context references
- Events and sequence ordering
- Plans, task graphs, checkpoints, pause/resume, and cancellation
- Assignment and artifact relationships
- Handoffs between modes

The session owns overall lifecycle. Worker executions own attempt-level state. Domain concepts such as Council synthesis remain in their domain layer.

### Layer 4 — Workforce

**Responsibilities**

- Role ontology
- Worker and provider registry
- Declared capabilities
- Runtime availability
- Policy-filtered eligibility
- Deterministic ranking
- Assignment rationale

Execution Policy decides what is eligible. Capability and availability filters establish what can perform the task. Workforce ranks those candidates. Ranking must not become an opaque autonomous optimizer.

### Layer 5 — Execution

**Responsibilities**

- Strict provider/model routes
- Local and remote adapters
- Structured input and output contracts
- Durable execution attempts
- Timeouts and typed failures
- Explicit retries under one assignment
- Explicit fallback through a new assignment
- Streaming safety
- Actual-route provenance

Fallback is reassignment, not retry. Ephemeral runs remain non-durable, single-attempt, and fallback-free unless their semantics are deliberately changed.

### Layer 6 — Knowledge and Memory

**Responsibilities**

- Personal, project, conversation, knowledge, and temporary scopes
- Source provenance and citations
- Retention and expiration
- User inspection, correction, export, and deletion
- Retrieval with privacy and project boundaries
- File and artifact indexing
- Derived knowledge with links back to source records

Memory is not an uninspectable model feature. A memory record must explain its source, scope, classification, creation method, confidence, and retention policy.

Suggested canonical shape:

```text
Memory Record
 ├── scope: personal | project | conversation | knowledge | temporary
 ├── source: manual | session | artifact | file | research
 ├── source identity
 ├── privacy classification
 ├── content or content reference
 ├── provenance
 ├── confidence / verification state
 ├── retention policy
 └── created, updated, expires, deleted timestamps
```

### Layer 7 — Security and Privacy

**Responsibilities**

- Context-level data classification
- Provider permissions
- Local/remote egress decisions
- Secret isolation
- Encryption and device authentication
- Audit events
- Export, deletion, and retention enforcement
- Least-authority tools and agents

Initial classification vocabulary:

- `local_only` — never leaves the Arena host
- `private` — external processing denied unless a narrowly scoped explicit grant exists
- `shareable` — may be sent to approved providers under policy
- `public` — safe for approved external use

Classification belongs to data/context, not only to a session toggle. Effective execution must honor the strictest classification among all included context.

### Layer 8 — Infrastructure

**Responsibilities**

- PostgreSQL and local storage
- Local inference runtimes
- Provider connectors
- Background execution workers
- Scheduling and queues
- Device access and secure sync
- Backups and restoration
- Observability and maintenance

Infrastructure must preserve domain invariants rather than invent parallel lifecycle concepts.

## 5.1 Tool Runtime

The Tool Runtime is a first-class capability parallel to Workforce. Workers reason; tools perform bounded actions. Cognitive Sessions coordinate both through shared policy, provenance, privacy classification, and task context.

```text
Cognitive Session
 ├── Workforce → AI workers
 └── Tool Runtime → repositories, files, web, knowledge, creative and media tools
```

Tools are registered once and reused by Council, Arena, Collab, Jarvis/Direct Chat, and future Missions. Tool access is capability-based, grant-scoped, schema-validated, and auditable. Credentials never enter model context. Write, destructive, and external effects require stronger policy and approval than ordinary model execution.

The canonical design and bounded delivery sequence are defined in `docs/tool-runtime-architecture.md`.

## 6. Long-running collaboration

Long-running autonomous collaboration is the major product capability not yet supplied by the execution substrate.

### 6.1 Session task model

```text
Goal
 └── Plan version
      ├── Task A [ready → running → completed]
      ├── Task B [blocked by A]
      ├── Task C [parallel with A]
      └── Checkpoint [requires user approval]
```

A task should include:

- stable identity and session identity
- objective and bounded input references
- requested Workforce role and capabilities
- dependencies
- status and terminal reason
- assignment chain and execution chain
- produced result/artifact references
- creation source: user, planner, or worker proposal
- budget and deadline
- approval requirement

### 6.2 Orchestration loop

```text
Observe canonical session state
 → identify ready tasks
 → enforce budgets and permissions
 → allocate Workforce
 → execute
 → validate result
 → add result to shared session context
 → unblock tasks or propose plan changes
 → checkpoint or continue
```

Workers may propose tasks. Only the orchestrator may authorize and persist them according to session policy. Plan changes are versioned and reconstructable.

### 6.3 Required controls

- Pause, resume, cancel, and terminate
- Maximum wall-clock duration
- Maximum task and execution counts
- Local/remote and provider budgets
- Tool permissions
- Context privacy limits
- User-required checkpoints
- Failure and partial-completion states
- Idempotent recovery after process restart
- Notification frequency and quiet hours

### 6.4 Human relationship

Arena works with the user, not around them. It should summarize changes, surface uncertainty and disagreements, request decisions at meaningful checkpoints, and permit direct inspection of worker outputs without forcing the user to read raw operational noise.

## 7. Privacy and egress model

Every execution request should resolve an effective policy from:

1. environment defaults;
2. user and project policy;
3. session execution mode;
4. context privacy classifications;
5. requested capabilities;
6. explicit per-run grants;
7. provider-specific permissions.

```text
Context assembly
 → determine strictest classification
 → determine eligible execution locations/providers
 → capability and availability filtering
 → Workforce ranking
 → assignment
 → strict route execution
 → audit actual egress
```

An online session does not imply all context is shareable. A remote worker must receive only the bounded context approved for that execution.

## 8. Device architecture

Arena's server is authoritative. Desktop and mobile clients are interfaces to the same durable environment.

```text
iPhone / Desktop / Future client
             │
       authenticated API
             │
       Arena personal server
       ├── sessions and memory
       ├── local inference
       ├── background workers
       ├── encrypted storage
       └── approved provider egress
```

Mobile clients should support:

- starting and continuing sessions
- voice interaction
- reviewing plans and checkpoints
- approving sensitive actions
- viewing worker status and artifacts
- receiving bounded notifications
- operating safely across intermittent connectivity

Sync must not create multiple authoritative sessions or expose secrets/provider credentials to browser clients.

## 9. Artifact and knowledge boundaries

```text
Cognition → normalized domain result → artifact request → artifact
```

Artifacts consume validated contracts, not raw transcripts. Artifacts are presentation and durable outputs; memory is selective retained context; knowledge is source-linked reusable understanding. One record may reference another, but these concepts must not collapse into one generic content table.

## 10. Current repository position

### Substantially established

- Mode-neutral Cognitive Sessions
- Atomic session event ordering
- Council lifecycle and validated synthesis boundary
- Shared Workforce role requests and deterministic resolution
- Execution Policy with online/offline/local-only eligibility
- Capability and availability filtering
- Durable assignments and actual execution routes
- Typed machine-readable errors
- Explicit execution attempts and retry policy
- Controlled fallback through linked replacement assignments
- Persistent identity-only handoffs
- Session provenance APIs

### Partial

- Project memory and artifact systems
- Privacy controls, audit summaries, export, and deletion
- Mobile-responsive web interface
- Local inference abstraction
- Session continuation across existing mode-specific flows

### Missing or not yet canonical

- Jarvis intent/planning layer
- Durable task graph and plan versions
- Background orchestration and restart recovery
- Pause/resume/cancel
- User checkpoints and agent budgets
- Inspectable scoped memory with full provenance
- Context-level privacy classification and egress grants
- Secure personal-server/device authentication and sync
- Voice interface
- Notifications
- Unified selected-versus-actual worker presentation

## 11. Known architecture gaps

The companion audit is `docs/post-slice-14-architecture-audit.md`. Its immediate findings remain binding:

1. Direct chat routes bypass Workforce and worker-execution provenance.
2. Retry budgets are assignment-global although some assignments are reused across logical operations.
3. Mode summaries can confuse initially selected and actually completing workers.
4. Execution configuration parsing is not shared by every entry point.
5. Legacy URL readers and distributed transaction boundaries require review.
6. Active assignment uniqueness is not yet enforced by a partial database index.

These are substrate correctness issues and should be addressed before autonomous orchestration.

## 12. Recommended product phases

### Phase A — Close execution substrate gaps

Resolve the six audit findings. Add a durable operation identity for retry budgeting. Migrate or explicitly classify direct chat. Establish one execution-configuration parser and complete selected/actual provenance views.

### Phase B — Privacy and memory foundation

Define source-linked memory records, scopes, retention, context classification, provider permissions, and an inspect/edit/export/delete experience. Egress policy must precede broad autonomous context use.

### Phase C — Durable plans and task graphs

Add plan versions, bounded tasks, dependencies, checkpoints, budgets, and task-level context/result references without yet adding unbounded background autonomy.

### Phase D — Recoverable orchestration

Introduce a database-backed scheduler/worker model, leases, idempotency, pause/resume/cancel, restart recovery, and bounded notifications.

### Phase E — Jarvis and mobile interaction

Build intent-to-session planning, voice, mobile checkpoints, session continuation, and personal assistance on the canonical session/task/memory systems.

### Phase F — Expanded tools and creative workflows

Add narrowly permissioned tools, richer local inference, file workflows, and domain-specific creative systems. Every tool action remains attributable, policy-checked, and auditable.

## 13. Non-goals until the foundation is ready

- Autonomous cost or latency optimization
- Model benchmark tournaments as routing logic
- Automatic provider failover outside explicit fallback policy
- Unbounded recursive agents
- Hidden memory extraction
- Provider-owned canonical history
- Silent privacy classification changes
- A second session/task lifecycle for Jarvis
- UI simulations of backend progress
- A knowledge graph without source provenance and deletion semantics

## 14. Decision test for future work

A proposed feature belongs in Arena when it strengthens at least one product principle without bypassing another. Before implementation, ask:

1. What canonical record owns this state?
2. Is it inspectable and attributable?
3. Can it operate locally or fail explicitly when it cannot?
4. What context may leave the environment, and why?
5. Does it request cognitive capability rather than hard-code a provider?
6. Can it resume safely after interruption?
7. Can the user pause, correct, export, and delete it?
8. Does canonical backend state—not UI timing—describe progress?

If those questions do not have concrete answers, the feature is not ready to become part of Arena OS.
