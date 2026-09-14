# Arena OS — Canonical Tool Runtime Architecture

**Status:** Proposed core architecture  
**Date:** 2026-09-13  
**Parent:** `docs/arena-os-product-architecture.md`

## 1. Definition

The Tool Runtime is Arena’s shared, policy-governed execution boundary for non-cognitive capabilities.

> **Workers reason. Tools perform bounded actions.**

A model, local inference engine, or cognitive role is a Workforce worker. GitHub, a filesystem, terminal, web search, Notion, image generation, media software, and project storage are tools. A service may contain both, but Arena must retain the conceptual boundary.

```text
Cognitive Session
 ├── Workforce
 │    └── reasoning workers
 └── Tool Runtime
      └── bounded external capabilities
```

Council, Arena, Collab, Direct Chat/Jarvis, and future Missions consume the same Tool Runtime. Mode-specific routes must not build private integration systems.

## 2. Product goals

The runtime must:

- register a tool once and make it available across session modes;
- resolve requested capabilities to eligible tool adapters;
- enforce privacy, execution, project, and user-approval policy before invocation;
- distinguish read, write, destructive, external-egress, and local-compute permissions;
- validate bounded inputs and outputs;
- record every durable invocation and actual route;
- support explicit user checkpoints for sensitive actions;
- make retries and recovery safe through idempotency declarations;
- return results into shared session context without silently turning all output into memory;
- isolate credentials from models, prompts, browsers, and artifacts.

It must not give an agent ambient access to every configured account or API key.

## 3. Canonical model

```text
Tool Definition
 ├── identity and version
 ├── declared capabilities
 ├── input/output schemas
 ├── effects and risk class
 ├── execution location
 └── adapter reference

Tool Grant
 ├── user/project/session scope
 ├── permitted operations
 ├── context classifications
 ├── resource bounds
 └── expiry/revocation

Tool Request
 ├── session/task identity
 ├── requesting worker/actor
 ├── requested capability
 ├── bounded arguments
 ├── context references
 └── idempotency key

Tool Assignment
 ├── selected tool definition
 ├── policy decision
 ├── selection rationale
 └── required approval

Tool Invocation
 ├── assignment identity
 ├── attempt and operation identity
 ├── sanitized arguments/provenance
 ├── status and timestamps
 ├── actual adapter/route
 ├── result references
 ├── effect summary
 └── typed error
```

Tool requests express capability, not a hard-coded vendor, unless the user explicitly pins an integration.

## 4. Capability vocabulary

Initial cross-mode capabilities should remain small and concrete:

- `repository.read`
- `repository.write`
- `repository.commit`
- `repository.pull_request`
- `filesystem.read`
- `filesystem.write`
- `terminal.execute`
- `web.search`
- `web.fetch`
- `knowledge.read`
- `knowledge.write`
- `image.generate`
- `media.catalog.read`
- `artifact.read`
- `artifact.write`

Provider-specific features can be declared as additional capabilities without replacing the stable vocabulary.

## 5. Effect and risk classes

Every operation declares one effect class:

| Class | Meaning | Default handling |
|---|---|---|
| `read_local` | Reads local Arena-controlled data | Policy check; bounded scope |
| `read_external` | Reads an external service | Egress and credential check |
| `write_local` | Changes local data | Durable audit; task-scoped permission |
| `write_external` | Changes an external service | Explicit grant; often approval |
| `execute_local` | Runs local computation or commands | Sandbox and resource limits |
| `destructive` | Deletes, publishes, deploys, pays, or irreversibly changes state | Mandatory user approval |

A tool cannot classify its own request at runtime. The registered operation definition supplies the minimum risk; policy may raise it.

## 6. Policy evaluation

Tool policy and worker policy share privacy/security inputs but remain separate evaluators because their risks differ.

```text
Tool request
 → validate session/task state
 → classify referenced context
 → verify tool grant
 → filter by execution location and egress policy
 → filter by capability and availability
 → evaluate effect/risk
 → require approval if necessary
 → deterministic selection
 → invoke strict adapter route
 → persist result and audit events
```

Policy inputs include:

- environment and device policy;
- project and session scope;
- context privacy classification;
- requesting actor and task;
- tool operation and effect class;
- local versus external execution;
- provider/integration allowlist;
- user grant and expiration;
- data volume and resource budgets;
- approval state.

An offline session excludes external tools. A local-only context can never be included in an external invocation. Tool fallback cannot route around these decisions.

## 7. Privacy and context handling

Tool arguments should contain bounded values and references, not an unreviewed session transcript. Context assembly must resolve references immediately before execution and apply field-level redaction.

Privacy classifications follow the product architecture:

- `local_only`
- `private`
- `shareable`
- `public`

Each invocation records classifications considered, policy decision, data destinations, and a safe effect summary. Sensitive payloads and secrets are not copied into event logs.

### Credentials

- Credentials live in a server-side secret store.
- Models receive capability names and safe tool schemas, never raw credentials.
- Browser clients never receive provider secrets.
- Adapters request credential handles scoped to one integration and operation.
- Revocation takes effect before the next invocation.
- Logs identify the credential grant, not the secret value.

## 8. Invocation lifecycle

```text
proposed
 → policy_checking
 → awaiting_approval (optional)
 → assigned
 → running
 → completed | failed | cancelled | indeterminate
```

`indeterminate` is required when an external write may have occurred but confirmation was lost. Arena must not blindly retry such operations.

Suggested events:

- `tool_requested`
- `tool_policy_evaluated`
- `tool_approval_requested`
- `tool_approved` / `tool_rejected`
- `tool_assigned`
- `tool_invocation_started`
- `tool_invocation_completed`
- `tool_invocation_failed`
- `tool_effect_indeterminate`
- `tool_retry_scheduled`

Events contain metadata and references, not secrets or unrestricted content.

## 9. Retry, fallback, and idempotency

Tool resilience cannot simply copy model retry behavior.

Each operation declares:

- `read_only` — generally retryable within policy;
- `idempotent_write` — retryable with a durable idempotency key;
- `non_idempotent_write` — no automatic retry after dispatch;
- `destructive` — no automatic retry without renewed approval.

A retry preserves the same tool assignment and operation identity while creating a distinct invocation attempt. Tool fallback creates a new tool assignment and is permitted only when equivalent effects, schemas, policy, and idempotency semantics are explicit.

Examples:

- Web search timeout before response: retry may be safe.
- GitHub commit with a known tree/commit idempotency check: reconciliation before retry.
- “Publish video” connection loss: mark indeterminate and ask the user; never publish again blindly.

## 10. Worker interaction

A worker may:

1. request a declared capability;
2. supply schema-valid bounded arguments;
3. explain why the tool is needed;
4. consume validated results;
5. propose follow-up work.

A worker may not:

- select an ineligible adapter;
- expand its own grants;
- approve its own sensitive request;
- access credentials;
- claim an effect succeeded without a completed invocation record;
- turn tool output into durable memory without memory policy;
- recursively invoke arbitrary tools outside the orchestrator’s task budget.

The orchestrator, not the worker, authorizes and persists task/tool transitions.

## 11. Result boundaries

Tool output enters Arena through validated result contracts:

```text
Tool result
 ├── structured result
 ├── bounded human-readable summary
 ├── external resource identities/URLs
 ├── created or changed resource references
 ├── evidence and timestamps
 └── safe raw-result reference when retention permits
```

A result can become:

- task context;
- a project artifact;
- a proposed memory;
- evidence for a decision;
- input to another worker or tool.

Those transitions are explicit and attributable.

## 12. Adapter boundary

A tool adapter implements a narrow contract:

```text
manifest
validate configuration
check availability
prepare bounded invocation
execute or reconcile
normalize result
classify failure
summarize effects
```

Adapters do not make Workforce decisions, change session lifecycle directly, or write arbitrary memories/artifacts. The Tool Runtime owns invocation records and emits canonical events.

## 13. Initial integrations

### Repository workspace

Start with repository operations because they exercise local reads, writes, command execution, diffs, tests, and durable effects.

Initial operations:

- inspect status/tree/diff;
- read bounded files;
- apply bounded patches;
- run allowlisted project commands in a sandbox;
- create a commit after approval/policy;
- open a pull request through a separate external-write operation.

Do not begin with unrestricted shell access.

### Web research

Separate public query/search from fetching arbitrary authenticated pages. Record query, sources, retrieval time, and citations. Prevent private context from being interpolated into public queries without permission.

### Knowledge providers such as Notion

Begin read-only and project-scoped. Page/database writes require explicit grants and effect summaries. Imported content retains source identity and privacy classification.

### Creative and media tools

ComfyUI/local image generation is primarily local compute with file effects. FL Studio, CapCut, PicsArt, Stem, Apple Music, and Plex require adapter-specific capabilities; many may initially support project generation or catalog control rather than direct automation. Never imply an integration exists until its adapter and permissions are real.

## 14. Direct Chat and Jarvis

Direct Chat becomes an interface to the same session, Workforce, memory, and Tool Runtime substrate. It should not become a privileged route that directly calls providers or tools.

```text
User message
 → intent and session context
 → worker assignment
 → optional bounded tool requests
 → worker response/artifact
 → session timeline
```

One-shot ephemeral chat may remain available, but it must be clearly classified: no durable memory, no durable provenance, one worker attempt, and no sensitive or state-changing tools.

## 15. Delivery sequence

“Unified Intelligence + Tool Runtime” is a product chapter, not one giant rewrite. Deliver it in bounded increments:

### 15A — Close execution audit gaps

- durable operation identity for retries;
- Direct Chat through assigned workers or explicit ephemeral classification;
- selected-versus-actual worker presentation;
- shared execution configuration parsing;
- active-assignment database invariant.

### 15B — Tool contracts and read-only local runtime

- tool definitions, capabilities, policy decisions, assignments, and invocations;
- schema validation and typed errors;
- session events and provenance;
- one read-only local repository/filesystem adapter;
- no arbitrary shell and no external writes.

### 15C — Grants, approvals, and safe effects

- project/session grants;
- approval checkpoints;
- idempotency and indeterminate effects;
- bounded local writes and allowlisted test execution;
- cancellation and budgets.

### 15D — External read integrations

- web research;
- read-only GitHub and knowledge-provider adapters;
- privacy-aware context redaction and egress audit.

### 15E — External writes and composable workflows

- GitHub commits/pull requests and selected knowledge writes;
- explicit approval and reconciliation;
- task graph orchestration across workers and tools.

### 15F — Creative/media adapters

- local creative pipelines first;
- provider-specific integrations only where stable APIs and clear grants exist;
- artifact and project integration without coupling domain cognition to vendors.

## 16. Acceptance criteria for the foundation

The Tool Runtime foundation is complete only when:

1. Council, Arena, Collab, and Jarvis can request the same registered capability.
2. A tool invocation cannot occur without a policy decision and assignment.
3. Offline policy blocks every external adapter.
4. Local-only context cannot cross an external boundary.
5. Inputs and outputs are schema-validated and bounded.
6. Durable invocations expose requesting actor, session/task, adapter, route, effect, and result provenance.
7. Credentials never enter model context, client responses, or event payloads.
8. Sensitive/destructive effects require explicit approval.
9. Retry behavior follows declared idempotency semantics.
10. Process interruption can be reconciled without blindly duplicating effects.
11. Tool output enters memory/artifacts only through explicit domain boundaries.
12. Adding an adapter does not require mode-specific integration code.

## 17. Non-goals for the first Tool Runtime slice

- unrestricted terminal access;
- dozens of integrations;
- browser automation with ambient credentials;
- autonomous publishing/deployment/payment;
- workers granting themselves permissions;
- hidden chains of tool calls;
- dynamic plugin code downloaded and executed without review;
- replacing existing creative or organizational applications;
- treating tools as Workforce models;
- building long-running autonomy before pause, approval, budgets, and recovery exist.

Arena coordinates the user's digital environment. It does not seize uncontrolled authority over it.
