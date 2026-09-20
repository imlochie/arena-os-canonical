# Legacy-to-Canonical Migration Plan

## Principle

The legacy ArenaForge Personal application is product evidence, not disposable data. Canonical migration is **export-first, append-only, and reversible** until users verify the resulting project work. No schema reset, destructive cleanup, or silent reinterpretation is allowed as a migration strategy.

The source schema currently has no users or ownership. Therefore, an operator must explicitly map each legacy database/data directory to a canonical owner during import. A migration cannot infer identity safely.

## Preconditions

1. Take a PostgreSQL backup and preserve the original schema/data untouched.
2. Export legacy content using the legacy export endpoint plus a direct database dump for records it does not cover.
3. Create or select the canonical owner who will receive the imported data.
4. Run a dry-run importer that produces counts, unmappable records, validation errors, and an import manifest.
5. Require explicit operator/user approval before the import transaction is finalized.
6. Retain the source-to-target mapping and raw legacy export for the documented retention window.

## Source mapping

| Legacy source | Canonical target | Transformation / decision |
| --- | --- | --- |
| `projects` | `Project` | Preserve name, description, emoji/status, timestamps where present. Assign explicit owner and create owner membership. |
| `chats` | `Conversation` | Preserve project association and title. Snapshot configured model/assistant metadata where recoverable. |
| `chat_messages` | `Message` and/or `Response` | Human messages become user messages; assistant messages become Response-backed messages with `provider/model = legacy/unknown` unless recorded elsewhere. |
| `assistants` | `Agent` | Import as owner-scoped agents with name/avatar/instructions/model/temperature. Tools and memory grants default to **none**, not broad access. |
| `models` | `Model` evaluation records | Import rating history only into the optional model-evaluation module. Do not present old static model aliases as usable canonical provider connections. |
| `model_category_ratings` | Evaluation rating rows | Retain category/score/counts with a `legacy-import` source marker. |
| `battles` | `Battle`, `ArenaSession`, `ArenaParticipant`, first-round `Response` | Preserve prompt, category, sides, answers, vote/judge snapshot, latency, and project. Legacy missing/unknown participant details are marked rather than invented. |
| `battle_messages` | `ArenaRound` + messages/responses | Reconstruct sequence by timestamps/roles where possible. Legacy side A/B is preserved as historical participant labels. |
| `collabs` | `ArenaSession` / `Battle` (mode=`build` or `collaboration`) | Parse collaborator JSON into participants only if valid. Invalid JSON becomes attached legacy material for review, never guessed. |
| `collab_contributions` | `Response`, `Challenge`, / Council source entries | Map drafts, critiques, syntheses, and human directions by round/kind. |
| `council_runs` | `CouncilSession` + source responses | Persist raw material, perspectives, cross-critiques, synthesis, role labels, model snapshots, and project reference. |
| `council_artifacts` | `Artifact` + initial `ArtifactVersion` | Link to imported CouncilSession through provenance. |
| `cognitive_sessions` | legacy session reference | Reconcile to `council_runs` where link exists; retain as legacy session metadata, do not create duplicated canonical session trees. |
| `artifacts` | `Artifact` + `ArtifactVersion` | Preserve kind/title/body/source type/source id. Link source only when imported target mapping exists; otherwise use an immutable `legacyReference`. |
| `project_memory` | `MemoryEntry` + `MemorySource` | Map kind to canonical classification, scope=`project`, confidence=`unknown`, source=`legacy import`. Never treat imported memory as verified fact. |
| `prompt_templates` | `LibraryItem` type=`prompt` | Preserve title/prompt/category; assign owner and version 1. |
| `privacy_events` | `PrivacyEvent` | Retain metadata with `legacy-import` actor/system marker. Do not infer user identity. |
| `arcade_games` | legacy export bundle only | The Arcade Forge is retired from core. Preserve downloadable HTML/code history, but do not import into canonical project objects by default. |

## Special cases and known ambiguities

### Council artifact duplication

The legacy Council endpoint writes both `council_artifacts` and a unified `artifacts` row for the same generated content. Importer matching uses source run ID, normalized title/body hash, and creation-time proximity to identify a single canonical Artifact. Ambiguous pairs are reported for review; duplicates are never silently dropped without an import report entry.

### Missing provenance

Legacy text stores do not consistently record provider, precise model, tool calls, sources, confidence, response parentage, or environment. The importer must use explicit values such as:

```text
provenanceStatus: legacy-incomplete
inferenceEnvironment: unknown
provider: legacy-unknown
confidence: unknown
```

It must not manufacture citations, claims, tool executions, or local/cloud assertions.

### No ownership history

The legacy database is globally scoped. The chosen import owner is an operational mapping, not historical evidence of who authored each record. Imported actor fields should be `legacy-import` where user identity cannot be demonstrated.

### Legacy local mode

`localOnly` and `ephemeral` were primarily request/client flags. Imported records may preserve a declared legacy mode as metadata, but that flag is not evidence of verified zero egress. Canonical privacy reporting must distinguish `declared legacy mode` from `verified canonical environment`.

### Deleted/ephemeral work

Ephemeral work was designed not to persist and cannot be migrated. Existing wipe/deletion semantics need a reconciliation report before importing a database that may contain partial dependent rows.

## Import workflow

```text
legacy database backup + endpoint export
        ↓
validate source schema/version
        ↓
normalize rows to an immutable import manifest
        ↓
dry-run mapping + duplicate/unmappable report
        ↓
owner selects destination and approves
        ↓
transactional import with deterministic external IDs
        ↓
post-import count, provenance, and access checks
        ↓
user reviews projects/artifacts/memory
        ↓
retain or purge raw import bundle per retention policy
```

### Idempotency

Every imported object receives a unique `(import_id, legacy_table, legacy_id)` mapping. Re-running the same import updates the report or skips the existing target; it never makes duplicate battles, artifacts, or messages.

### Verification checklist

- Counts for every source table equal `imported + skipped + quarantined`.
- Each project has exactly one explicit owner membership after import.
- Every imported project object belongs to the destination project and is inaccessible to non-members.
- Imported artifacts have one initial ArtifactVersion and legacy provenance.
- Imported memory is project scoped and marked `legacy-import`/`unknown confidence`.
- Legacy Council duplicate candidates appear exactly once or in a review queue.
- A sample of battle, collab, Council, chat, artifact, and memory records is rendered and manually verified.
- Exporting the imported project preserves object IDs, provenance status, and source references.

## Current migration readiness

**Not ready to run.** The canonical schema, authentication model, importer, complete legacy migration chain, and test fixture do not exist yet. This document is the contract that implementation must satisfy before legacy data is moved.
