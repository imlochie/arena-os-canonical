# Arena archive synthesis ledger

## Purpose

This document records how evidence from the two supplied historical Arena options
is evaluated before it becomes part of the canonical Arena architecture. It is a
selection ledger, not a mechanical merge plan.

## Evidence status

The supplied extraction brief describes **Option A** and **Option B**, but the
archive contents themselves have not been made readable in this workspace yet.
Consequently, entries below record the architectural evidence in that brief and
current-repository observations. They do **not** claim that an implementation
was copied from either archive. When source files become available, add their
path and commit reference before porting implementation details.

## Canonical operating loop

```text
input → think / compare / critique → synthesize → capture artifact
      → project memory → future work
```

Projects are the durable context for that loop. Chats, battles, councils,
collaborations, and Stem Lab processing are work operations inside or attached
to a project; none creates a parallel project concept.

## Retention decisions

| Canonical concept | Evidence | Decision | Current evidence / required direction |
| --- | --- | --- | --- |
| Project as long-lived work container | A | retain | `projects` is the common parent. Every new subsystem must reference it rather than introduce another project table. |
| Typed reusable artifacts | A | retain | `artifacts`, council artifacts, and source links should converge on the canonical artifact/provenance model. |
| Typed project memory | A | retain and extend | `project_memory` already distinguishes fact, decision, preference, open question, rejected idea, and source. Add `invariant` and provenance rather than replacing it with an untyped notes field. |
| Cognitive jobs and complementary roles | A, B | retain | `src/lib/cognitiveJobs.ts` is the seed configuration, not merely page copy. It should become executable, versioned workflow configuration. |
| Council: perspective → cross-critique → synthesis → artifact | A | retain | The current Council route performs this sequence. Its execution state and provenance need durable job/session records before treating it as canonical production behavior. |
| Cross-surface handoffs | A | retain | Handoffs must create source-linked project work, not only carry query-string text between screens. |
| Blind empirical battle evaluation | A | retain | Existing randomized sides, stored history, Elo/Bradley–Terry work, category ratings, ties, and both-bad results are evidence. Historical battle records remain authoritative over a leaderboard cache. |
| Provider abstraction and capability-aware routing | A, B | rebuild deliberately | Replace direct provider branching with one provider contract, declared capabilities, recorded routing/environment, and explicit user-visible fallback policy. |
| Local-only / privacy boundary | A | retain and enforce below UI | Local-only must prevent cloud calls in the provider router. Audit records are metadata only. A UI toggle alone is insufficient. |
| Simulation/reference execution | B | retain only as labelled reference | Simulation is useful for tests, demos, and deterministic workflows, but must never be represented as a queried model or a real provider response. |
| Resource lifecycle APIs | B | retain | Resources need scoped GET/create/update/delete and source/provenance links; collection-only routes are insufficient. |
| Arcade | B | retain as secondary | Offline deterministic games remain isolated from the cognitive core and do not set the core data model. |
| Stem Lab | current Arena work | retain as a project module | Private audio assets/jobs attach to the canonical project object. It is not a second product or a replacement for Arena. |

## Non-negotiable invariants

1. There is one canonical representation for projects, artifacts, memory,
   providers, models, assistants, battles, sessions, ratings, and privacy
   events. New fields belong in a deliberate migration; duplicate tables or
   alternate route families are not a solution.
2. Every useful output can retain provenance: project, source operation,
   provider/model/environment where applicable, and source artifact/response.
3. A simulation/reference result is labelled at the data and API boundary,
   not inferred from presentation text.
4. A local-only policy is enforced by the provider router before a network
   request can be made.
5. Jobs own long-running work. Web requests validate, persist, enqueue, and
   report state; workers execute.
6. Existing legacy UI is evidence, not proof of production behavior. Do not
   represent a capability as real until its backing provider, worker, storage,
   authorization, and test path are real.

## Known conflicts and gaps in the current implementation

- The legacy provider implementation is a direct, static catalog with fallback
  behavior, not the canonical provider/connection/capability contract described
  in `ARCHITECTURE.md`. Its reference/offline responses need explicit durable
  execution metadata before they can support empirical evaluation.
- Legacy projects, artifacts, memory, chats, and councils do not yet share the
  authenticated membership model used by the new private Stem Lab slice. The
  Stem Lab account tables are a bounded vertical-slice implementation, not a
  license to create a second canonical identity system.
- Legacy migrations remain incomplete. The Stem Lab migration baseline is
  repeatable only for that slice; it is not a full fresh-install migration chain
  for every existing Arena table.
- `project_memory` lacks the `invariant` kind and source/provenance fields.
- Council and collaboration workflows contain valuable orchestration but need
  canonical durable response/job/provenance records and tests before they can
  serve as the definitive execution architecture.

## Resolution order

After the real Stem Lab Compose acceptance path has passed, canonicalize in this
order:

1. General identity, project membership, and complete migration baseline.
2. Canonical project, artifact, memory, session/response, and provenance
   records, including an `invariant` memory type.
3. Provider connection/model/capability registry and a router that makes local,
   cloud, and simulated execution explicit.
4. One durable, provider-backed cognitive operation through a worker, with
   project-scoped authorization and real integration tests.
5. Migrate Council, Collab, and Battle execution onto those records while
   preserving their useful role, critique, voting, and rating methodology.
6. Expand secondary product surfaces only after the Tier 1 loop is proven.

## Future archive-port record

For every port from Option A or Option B, record:

```text
archive option and commit/path:
retained idea:
canonical concept:
conflicts considered:
why this implementation was selected:
tests proving the behavior:
```

This prevents an accidental "A + B" repository and leaves a reviewable answer
to where each retained mechanism came from.
