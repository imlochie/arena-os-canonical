# Arena archive synthesis ledger

## Purpose and evidence boundary

This is the selection ledger for reconstructing one canonical Arena from two
historical implementations. It is **not** a merge plan.

The user inspected the supplied archives and provided the concrete source
inventory recorded below. The archive bytes are not mounted in this workspace,
so paths and contents are recorded as *user-supplied recovered evidence* rather
than pretending they were copied directly here. When an archive or a specific
commit becomes readable, append its immutable source reference to the relevant
port record before transplanting code.

## Archive inventory

| | Option A | Option B |
| --- | --- | --- |
| Files / approximate TS(X) lines | 108 / 12,951 | 68 / 13,708 |
| Main shape | Distributed operational Arena OS with independently addressable resource routes | Consolidated cognitive/provider engine with larger implementation modules |
| Principal tables | models, category ratings, assistants, battles/messages, templates, collabs/contributions, council runs/artifacts, projects, artifacts, project memory, privacy events, arcade games, chats/messages | projects, artifacts, project memories, models, personas, battles/messages, cognitive sessions, collab messages, chats/messages, arcade games, privacy events, templates, user settings |
| Strongest evidence | Cognitive jobs, workforce, strategies, handoffs, project context, battle lifecycle, Council/Collab persistence, privacy/resource routes | Cognitive engine, intelligence layer, provider interface, simulation/reference engine, richer persisted cognitive-session and model metadata |

Option A and Option B are overlapping attempts at Arena, not a linear version
history. Neither archive is automatically canonical.

## Recovered implementation evidence

### Option A — retain the operational/domain mechanisms

**Resource lifecycle pattern.** A decomposes operations into explicit routes,
including battle retrieval, vote, judge, reveal, follow-up, and stream routes;
project-specific artifact and memory routes; individual Collab routes with
iterate/crown actions; Council retrieval/artifact routes; and privacy
summary/events/wipe routes. This is evidence that major cognitive operations
need identifiable lifecycles rather than one collection endpoint.

**Cognitive jobs.** `src/lib/cognitiveJobs.ts` defines seven executable job
recipes:

```text
creative_workshop       second_brain        thinking_instrument
deep_research           systems_designer    simulation_partner
thought_editor
```

Each recipe carries the job question/description, two roles, critique and
synthesis instructions, artifact kinds/instructions, and examples. The
meaningful execution order is:

```text
raw material → perspectives → cross-critique → synthesis → artifact
```

The roles and job prompts are evidence, not immutable product copy. Preserve
the role architecture and version the configuration rather than creating a
second parallel job system.

**Workforce and strategy.** `src/lib/workforce.ts` separates model, role, and
job. Its roles (Researcher, Critic, Architect, Engineer, Creative Director,
Strategist, Editor, Operator) specify preferred model *archetypes* and ELO
categories. `src/lib/strategies.ts` encodes Council, Debate, Brainstorm,
Second Brain, Systems, Scenarios, and Signal collaboration strategies.
Canonical routing therefore starts from job requirements and roles, never a
hard-coded model name.

**Project continuity.** `src/lib/projectContext.ts` retrieves project, recent
typed memory, and artifacts and injects a bounded context block into future
operations. `src/lib/handoffs.ts` carries text, project, source, job, and
strategy between Arena, Council, and Collab. A useful handoff must become a
source-linked operation or project object, not only a query-string payload.

**Battle methodology.** A persists battles and generic role/content battle
messages, supports A/B randomization, blind reveal, `a`/`b`/`tie`/`both-bad`
votes, follow-ups, judging, streaming, historical records, relational category
ratings, and rating diagnostics. The historical vote record is authoritative;
leaderboards are derived measurement views.

**Privacy and offline evidence.** A contains `privacy.ts`, `privacyClient.ts`,
`localEngine.ts`, `webllm.ts`, `stream.ts`, privacy events/summary/wipe,
optional BYOK routing, local execution, and an arcade isolated from the
cognitive core. Those mechanisms are evidence for an actual provider-layer
local-only boundary, not a decorative privacy screen.

### Option B — retain the consolidated execution mechanisms

**Cognitive configuration.** `src/lib/cognitiveEngine.ts` defines seven
layers (workshop, second brain, thinking instrument, research, systems design,
simulation, thought editor), with two roles, a synthesis role, prompts,
presentation metadata, and sample inputs. `intelligenceLayer.ts` formalizes:

```text
cognitive job → role requirements → model selection → synthesis
```

This is complementary to A's job/workforce structure. The canonical system
will use one versioned `CognitiveJobDefinition`, with A's execution and
artifact fields plus B's explicit synthesis-role and presentation metadata.

**Provider and reference execution.** `providers.ts` normalizes Ollama, Groq,
OpenRouter, Gemini, Pollinations, and simulated execution with text, reasoning
when genuinely supplied, token counts/estimates, latency, throughput, and
provider identity. `simulation.ts` also contains generic `TaskConfig`,
`TaskProcessor`, `Result`, `executePipeline`, `RateLimiter`, and
`StateManager` utilities. Retain the provider contract and only the utilities
that solve a concrete worker/routing problem.

A simulation/reference response is valuable for deterministic development,
demos, and failure testing. It must be a distinct execution environment and
provider kind in durable data and API results; it is never model evidence and
never silently substitutes for a real provider.

**Richer metadata.** B contributes useful candidate fields: provider model ID,
context length, local status, badges, user notes, explicit blind status,
rating deltas, artifact summary/metadata/update timestamp, memory importance
and active state, invariants, persona classification, and user settings.
These are inputs to a single canonical migration, not parallel schemas.

## Canonical resolution decisions

| Domain | Canonical decision | Why |
| --- | --- | --- |
| IDs | UUID identifiers | Existing Arena and the private Stem Lab use UUIDs; they suit distributed workers and do not expose serial ordering. IDs never authorize access. |
| Projects | One `projects` table: UUID, name, description, status, timestamps, and one intentional visual identity representation | A's project continuity is the stronger domain model. Do not retain competing emoji versus color/icon models without a user-facing need and migration decision. |
| Artifacts | Keep A's `kind`, `body`, `source_type`, `source_id`, and optional project association; add B's `summary`, bounded `metadata`, and `updated_at` deliberately | Artifacts can be project-independent imports while still retaining source lineage. Metadata is not a substitute for normalized provenance. |
| Project memory | One typed memory table with `fact`, `decision`, `preference`, `open_question`, `rejected_idea`, `source`, and `invariant`; add importance, active/archived state, and source/provenance references | B's `invariant`, importance, and activity lifecycle complete A's useful taxonomy. `useful_source` resolves to the canonical `source` name. |
| Models and ratings | Separate provider/model registry from relational category ratings | A's relational rating table supports queryability and integrity. B's provider-model ID, context length, local flag, and display metadata belong on the model/adapter mapping, not JSON category Elo. |
| Assistants/personas | One canonical assistant/persona concept | Retain A's existing `assistants` identity, extended with B's title/category/default/system classification if proven necessary. Do not create both tables. |
| Battle transcript | A generic contribution/message sequence is the base; attach structured per-turn response/latency/token telemetry to canonical responses | It supports multi-turn evolution without storing two incompatible transcript formats. B's paired turn telemetry remains valuable. |
| Cognitive work | One `cognitive_sessions` parent with normalized contributions/rounds, critiques, synthesis, artifacts, and source links | This preserves B's useful session snapshot while avoiding separate competing `council_runs`, `collabs`, and opaque message stores as canonical roots. Council and Collab become execution modes/workflows over the same records. |
| Providers | Provider registry + provider connection + model descriptor + runtime adapter | Separates provider, provider model ID, cognitive role, and model selection. No static catalogue or direct fetch branch becomes the source of truth. |
| Simulation | Explicit `reference`/`simulation` provider environment | It remains useful without being capable of silently claiming a real model/provider result. |
| Jobs | Persist before enqueue; workers own long operations | This is already proven for the Stem Lab vertical slice and becomes the model for provider-backed cognitive work. |

## Non-negotiable invariants

1. There is one canonical representation for projects, artifacts, memory,
   providers, models, assistants, battles, sessions, ratings, and privacy
   events.
2. Every useful output retains provenance: project, source operation, source
   artifact/response, execution environment, and provider/model where relevant.
3. Human evaluation, automated judging, and model execution are separate
   concepts and separate data fields.
4. A reference/simulated response is labelled at the provider, API, database,
   and UI boundaries. It cannot alter empirical leaderboard evidence as though
   it were a real model call.
5. A local-only policy is enforced by the provider router before any cloud
   request is possible.
6. Long-running work is persisted and queued; web requests validate, authorize,
   persist, enqueue, and report state while workers execute.
7. Legacy UI is evidence, not production proof. Do not claim a provider,
   worker, privacy, authorization, or storage guarantee without its real
   backing path and tests.

## Current-repository alignment and gaps

The current Arena checkout already preserves significant Option A evidence:
`src/lib/cognitiveJobs.ts`, `workforce.ts`, `strategies.ts`, `handoffs.ts`,
`projectContext.ts`, Council orchestration, artifact/project-memory tables,
battle lifecycle/ratings, privacy helpers, and offline/arcade surfaces.

It is not yet canonical implementation:

- `src/lib/ai.ts` is a direct/static provider dispatch and fallback chain, not a
  durable provider/connection/capability router. Its local/reference fallbacks
  require explicit persisted execution metadata before they can be trusted as
  evaluation inputs.
- Legacy project, artifact, memory, chat, Council, and Battle resources do not
  yet share a general membership/authorization model. The new Stem Lab session
  and membership path is a bounded vertical slice, not a second permanent
  identity architecture.
- Legacy migration history is incomplete. The repeatable Stem Lab migration
  baseline does not reconstruct all legacy Arena tables.
- `project_memory` lacks invariant, importance/active lifecycle, and provenance
  fields.
- Council and Collab contain useful orchestration but need canonical durable
  response/job/provenance records and real tests.

## Sequenced reconstruction

The real Stem Lab Compose acceptance path remains the current infrastructure
gate. Do not start waveforms, mixer work, remixing, or cosmetic studio features
before it passes in a Docker-capable environment.

After that proof, canonicalize in this order:

1. General identity, project membership, complete migration baseline, and a
   legacy-import fixture.
2. Canonical projects, artifacts, typed memory, sessions/responses, and
   provenance fields.
3. Provider connection/model/capability registry plus a router that records
   local, cloud, browser-local, and reference execution explicitly.
4. One authenticated, provider-backed cognitive job through a durable worker,
   with a real local-provider path and integration tests.
5. Migrate Council, Collab, and Battle execution onto those records while
   preserving A's role/critique/voting/rating mechanics and B's useful
   telemetry.
6. Expand workforce, handoffs, settings, benchmarks, and secondary product
   surfaces only after the Tier 1 loop is proven.

## Future archive-port record

For every concrete port, append:

```text
archive option and commit/path:
recovered mechanism:
canonical concept:
conflicts considered:
why this implementation was selected:
migration impact:
tests proving the behavior:
```

This creates a reviewable answer to where retained code came from and prevents
an accidental "A + B" repository.
