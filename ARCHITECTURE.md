# Canonical Arena Architecture

## Status and architectural position

This document defines the target architecture for the canonical rebuild. It is not a description of the preserved legacy application. Where the legacy application differs, [REBUILD.md](./REBUILD.md) and [MIGRATION.md](./MIGRATION.md) are authoritative about the transition.

The first canonical release should start as a **modular TypeScript application**, not a premature distributed system. It needs real ownership boundaries and replaceable adapters from the first slice; separate deployables are introduced where the runtime responsibility demands them (web and worker).

## Product invariants

1. **Human control:** an agent can propose; consequential external or protected-state changes require a human approval record.
2. **Project isolation:** every project-scoped object has an owning project, and every request checks a user membership role server-side.
3. **Provenance by default:** generated material is linked to its response(s), source/evidence, run/session, provider/model, and project when applicable.
4. **No silent egress:** execution policy declares local/cloud/hybrid before a job starts; local mode may not route prompts, embeddings, moderation, or files to cloud services.
5. **No fake success:** provider failure, unavailable capability, and unavailable local runtime are first-class states. A template/demo result is never represented as an AI result.
6. **Inspectable memory:** memory has scope, source, confidence, lifecycle, and a deletion path.
7. **Worker ownership:** long-running generation and processing are jobs, not hidden work inside web request handlers.
8. **A response is structured:** text is one field of a response object, not the whole data model.

## Logical modules

The exact folders may evolve, but these boundaries are intentional:

```text
apps/
  web/                 authenticated UI, resource API, stream gateway
  worker/              durable AI/file/export workflows
packages/
  core/                domain types, validation schemas, result/error contracts
  db/                  schema, migrations, repositories, transaction helpers
  auth/                sessions, identity, membership authorization
  ai/                  provider adapters, model registry, routing, streaming
  agents/              agent templates/configurations and execution permissions
  arena/               sessions, rounds, participants, responses, challenges/diffs
  council/             synthesis policy, typed conclusions, artifact creation
  projects/            projects, files, tasks, decisions, activity, retrieval
  memory/              scoped memory, sources, retrieval contracts
  tools/               tool manifests, grants, execution contracts
  privacy/             privacy policy, audit events, export/deletion workflows
  storage/             blob storage abstraction and file processing contracts
  jobs/                queue contracts, idempotency and cancellation
  ui/                  design tokens and reusable accessible components
```

A short-term implementation may retain `src/` while these boundaries are extracted. It must not create packages that simply re-export the same coupled global module.

## Deployment topology

```text
Browser
  │ relative HTTPS/SSE/WebSocket requests
  ▼
Web application
  ├── Auth/session + authorization middleware
  ├── Resource API and stream gateway
  ├── PostgreSQL (metadata and relational state)
  ├── Object storage (project files and export bundles)
  └── Queue/Redis (job dispatch and event fan-out)
          │
          ▼
      Worker
        ├── Provider adapters ──► configured cloud providers
        ├── OpenAI-compatible/Ollama adapter ──► explicitly configured local runtime
        ├── file extraction/indexing
        └── export/deletion processing
```

The browser must use relative application URLs. A browser-local provider (such as WebLLM) is a distinct adapter with explicit capability and availability reporting; it is not a server fallback.

## Canonical domain model

### Identity and access

| Entity | Purpose | Key relations |
| --- | --- | --- |
| `User` | Authenticated human identity | owns projects, agents, providers, exports |
| `Session` | Revocable authenticated session | belongs to User |
| `Project` | Long-lived work container | owner User; has memberships and project objects |
| `ProjectMembership` | Server-enforced Owner/Editor/Contributor/Viewer role | User ↔ Project, unique pair |

### Provider and agent configuration

| Entity | Purpose | Key relations |
| --- | --- | --- |
| `ProviderConnection` | User-owned provider configuration, encrypted credential reference, endpoint, allowed use | belongs to User; references ProviderDefinition |
| `ProviderDefinition` | Built-in/custom provider adapter identity | has Models/capabilities |
| `Model` | Provider model registry entry | has provider, model ID, display name, context/cost/locality/capabilities |
| `Agent` | Saved configurable agent | owned by User or Project; chooses a Model and policy |
| `AgentToolGrant` | Explicit grant of tool capability and scope | Agent ↔ ToolDefinition |
| `AgentMemoryPolicy` | Allowed memory scope/retrieval policy | Agent → Memory scopes |
| `AgentTemplate` | Library starter such as Researcher/Critic/Engineer | cloneable into Agent |
| `ToolDefinition` | Versioned tool contract and capability | has executions and policy requirements |

Provider capability flags are explicit: `chat`, `streaming`, `vision`, `tool_calling`, `structured_output`, `embeddings`, and `reasoning`. The router rejects a requested capability it cannot satisfy rather than changing provider without disclosure.

### Work, reasoning, and provenance

| Entity | Purpose | Key relations |
| --- | --- | --- |
| `Conversation` | Normal chat container | Project optional; has Messages |
| `Message` | Human or agent message | identifies author/model, linked Response optional |
| `ArenaSession` | Multi-agent work session | belongs to Project; has Participants/Rounds/Responses |
| `ArenaParticipant` | Agent/model selection for a session | belongs to ArenaSession; snapshots config at run time |
| `ArenaRound` | Ordered stage of work | belongs to ArenaSession |
| `Response` | Structured meaningful AI contribution | belongs to round/session; parent/challenge links; has claims, evidence, tools, artifacts |
| `ResponseClaim` | Extracted claim with classification | belongs to Response; classified Fact/Claim/Interpretation/Proposal/Decision/OpenQuestion |
| `EvidenceLink` | Source/retrieval/citation reference | links Response/Claim/Artifact to File/Memory/URL/other Response |
| `Challenge` | A visible response-to-response challenge | source Response, target Response, type/status |
| `ResponseComparison` | Cached or user-created diff analysis | response set + agreements/disagreements/unknowns, never a score-only reduction |
| `Battle` | Structured disagreement workflow | is an ArenaSession specialization or links one; has mode/rules/human review |
| `CouncilSession` | Synthesis session | consumes a set of Responses; creates typed conclusions/artifacts |
| `CouncilConclusion` | Explicit Council output classification | Fact/Claim/Interpretation/Proposal/Decision/OpenQuestion with source references |

### Project work objects

| Entity | Purpose | Key relations |
| --- | --- | --- |
| `Artifact` | Editable persistent document/code/structured output | belongs to Project; source links; has Versions |
| `ArtifactVersion` | Lightweight immutable version snapshot | belongs to Artifact; actor/source/change summary |
| `File` | Uploaded project file metadata | belongs to Project; object storage reference; extraction state |
| `FileChunk` | Extracted/indexed searchable content | belongs to File; retrieval references |
| `MemoryEntry` | Inspectable scoped memory | scope global/project/session/agent; source/confidence/timestamps |
| `MemorySource` | Provenance link for memory | MemoryEntry ↔ source object |
| `Task` | Persistent project work | source/assignee/approval/status fields |
| `Decision` | Durable human-reviewable decision record | alternatives/evidence/status/revisions |
| `ActivityEvent` | Project-aware activity feed | actor/object/event metadata |
| `LibraryItem` | Reusable agent/prompt/template/workflow/artifact | owner/visibility/version metadata |

### Operations, privacy, and lifecycle

| Entity | Purpose | Key relations |
| --- | --- | --- |
| `Job` | Durable asynchronous execution | type/status/idempotency key/requested-by/project |
| `JobStep` | Observable job stage | Job → provider/tool activity summaries |
| `ToolExecution` | Permissioned agent tool invocation | Response/Job/Tool, policy decision, status, redacted summary |
| `Approval` | Human authorization for consequential action | Project/User, action/request/evidence/status |
| `PrivacyEvent` | Auditable metadata-only privacy event | User/Project/actor/provider/environment/action |
| `ExportRequest` | Durable export workflow | User/Project/status/file reference |
| `DeletionRequest` | Durable deletion workflow and retention status | User/object/scope/completion evidence |

## Response object contract

A meaningful model contribution should carry, at minimum:

```ts
type Response = {
  id: string;
  projectId: string | null;
  arenaSessionId: string | null;
  roundId: string | null;
  agentSnapshotId: string | null;
  providerId: string;
  modelId: string;
  inferenceEnvironment: "local" | "cloud" | "browser-local";
  status: "queued" | "streaming" | "complete" | "failed" | "cancelled";
  content: string;
  confidence: number | null;
  parentResponseId: string | null;
  challengeTargetResponseId: string | null;
  createdAt: Date;
  completedAt: Date | null;
};
```

Claims, evidence, tool executions, citations, artifacts, and error summaries use normalized related tables. Raw provider payloads and private chain-of-thought are not exposed as a response field.

## Authorization policy

Every repository/API operation receives an authenticated actor and performs a resource-specific check:

```text
actor → membership(project) → required role → resource action
```

Minimum project role matrix:

| Action | Owner | Editor | Contributor | Viewer |
| --- | ---: | ---: | ---: | ---: |
| View project work | ✓ | ✓ | ✓ | ✓ |
| Create conversations / responses | ✓ | ✓ | ✓ | — |
| Edit artifacts / project memory | ✓ | ✓ | permitted scope only | — |
| Create/delete agents or provider access | ✓ | project agent only | — | — |
| Manage collaborators / export / delete project | ✓ | — | — | — |
| Approve consequential actions | ✓ | explicitly delegated only | — | — |

Database IDs identify objects; they never authorize access. Bulk reads/searches are scoped by memberships before pagination.

## Provider abstraction and execution policy

```ts
interface AIProvider {
  definition: ProviderDefinition;
  listModels(connection: ProviderConnection): Promise<ModelDescriptor[]>;
  capabilities(model: ModelDescriptor): ModelCapabilities;
  generate(request: GenerationRequest, signal: AbortSignal): AsyncIterable<ProviderEvent>;
  embed?(request: EmbeddingRequest, signal: AbortSignal): Promise<EmbeddingResult>;
  health?(connection: ProviderConnection): Promise<ProviderHealth>;
}
```

A `GenerationRequest` contains a resolved, auditable routing decision: requested model, connection, environment, capabilities, local-only policy, project, response/job IDs, and permitted tool scope. The routing decision is persisted before generation. Cloud fallback is opt-in and shown to the user; local-only prevents it.

First adapters: OpenAI-compatible local endpoint/Ollama, OpenAI-compatible cloud endpoint, and one first-class cloud adapter. Additional providers are added only through this interface.

## Job and real-time event model

The web app creates a `Job` inside a transaction with its target Session/Response records and enqueues it after commit. The worker owns execution. Every job has a deterministic idempotency key from its parent action and round/stage. Retrying a job continues/reconciles its existing response rather than creating duplicate artifacts or rounds.

Core events are a single versioned stream contract:

```text
job.created
job.stage_changed
response.delta
response.status_changed
response.completed
response.failed
response.cancelled
tool.started
tool.completed
tool.failed
artifact.created
activity.created
```

Events contain IDs and concise safe summaries, never hidden reasoning traces or sensitive prompt dumps. Clients reconnect with a cursor; REST remains the source of truth.

Cancellation transitions a job to `cancelling`, aborts provider/tool work where supported, preserves completed response text/artifacts, and concludes as `cancelled` or `completed` with a clear status.

## Storage, retrieval, and files

Object storage is replaceable through a storage interface. PostgreSQL stores metadata and references, not arbitrary file bytes. Files remain project-scoped and are only passed to an agent/tool when an explicit tool grant and run policy permit it.

Retrieval returns source descriptors (file/version/chunk, memory entry, artifact, conversation message, decision) that become `EvidenceLink` records. It does not inject unbounded project memory into prompts.

## Privacy and deletion

Privacy events capture metadata such as actor, project, action, provider/environment, object type/id, and timestamp; they never need prompt payloads. Deletion is a worker workflow that cascades or tombstones according to documented retention, deletes object storage assets, and creates a completion event. Export is also a worker workflow that emits a versioned data bundle with provenance.

Full data policy is in [PRIVACY.md](./PRIVACY.md).

## Schema and migration rules

- PostgreSQL is the canonical relational store.
- Foreign keys, indexes, unique constraints, and check constraints are deliberate, not optional.
- UUID/ULID values are identifiers only; authorization is always checked independently.
- JSON is allowed for bounded provider-specific snapshots/configuration, not as a substitute for entities such as participants, claims, grants, or source links.
- Every schema change ships as a versioned, repeatable migration and is tested on an empty database plus a legacy-import fixture.
- Audit/event records use redacted metadata and a declared retention policy.

## Initial vertical slice acceptance

Before adding Battle visualization or dashboards, the foundation/conversation slice must demonstrate:

1. a user signs in;
2. the user creates a project;
3. an owner-only provider/model configuration is selected explicitly;
4. the user creates an agent with a granted tool set (possibly empty);
5. a conversation creates a real provider-backed response through a durable job;
6. the response shows provider/model/environment and durable status;
7. a second user receives `404`/`403` for the project and every nested resource;
8. the response may be stopped; completed content remains inspectable;
9. an activity and privacy event are recorded without raw prompt payload; and
10. tests prove all of the above against a real local-provider path and mocks.
