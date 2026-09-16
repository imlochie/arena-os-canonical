# Orchestrator — the AI collaboration bus

`/orchestrator` replaces the "human message bus" pattern — you copying
prompts between Arena, ChatGPT, Grok, and Notion — with **structured
collaboration**. A Collaboration Session holds a goal, shared context, and
heterogeneous participants connected by explicit, auditable relays.

```
                 Collaboration Orchestrator
                           │
            ┌──────────────┼──────────────┐
            ↓              ↓              ↓
        Arena models   External AIs     You (owner)
            │              │
            └───────┬──────┘
                    ↓
             relays + checkpoints
```

## The primitives

**Collaboration** — goal + shared context + participants + relays + status
(`running` / `blocked` / `closed`). Closing one files a permanent record as an
artifact (sourceType `orchestrator`).

**Participant** — one of three kinds, all first-class:

| Kind | What it is | Dispatch |
| --- | --- | --- |
| `model` | Any model in the arena fan-out (incl. your GPU via TurboAgent) | `generate()` |
| `external` | Any OpenAI-compatible endpoint (Grok/x.ai, LM Studio, vLLM, another Arena…) | direct adapter call |
| `human` | You — the decision-maker | checkpoint (session blocks until you answer) |

Participants declare `capabilities` and a `trust` level (`internal` /
`external`).

**Relay** — the unit of work, an explicit instruction from one participant to
another:

```
source → target · purpose · request
context refs (artifacts) · classification · response contract
```

Relays have status `pending → responded | cancelled | failed` with a `note`
recording why anything failed. A relay targeting a human is a **checkpoint**:
advancing surfaces it, the session goes `blocked`, and you approve / reject /
answer it. The human enters at decision points instead of routing every
message.

## Privacy: the context envelope

Every relay carries a classification, and the envelope a participant receives
contains only what it permits — never the whole workspace:

| Classification | Who may receive it |
| --- | --- |
| `public` | anyone, including external-trust participants |
| `internal` | internal-trust participants only |
| `private` | human participants only |

Violations are rejected at relay creation *and* re-checked at dispatch (the
conductor's relays to external participants are forced `public`). The
envelope itself = goal + shared context + referenced artifact bodies + the
recent transcript + the request + the response contract, capped at 9,000
chars.

## Execution model

House pattern: **no background workers**. `POST /api/orchestrator/[id]/advance`
performs exactly ONE step:

1. **Dispatch** — the next pending relay goes to its target (model via the
   fan-out, external via its adapter). Responses are stored with the `via`
   provenance.
2. **Checkpoint** — a relay targeting a human blocks the session until you
   answer it.
3. **Conductor** *(optional, `autoRoute`)* — an idle session asks a model for
   the next move: a new relay (with purpose, request, contract) or a close.
   Offline it declines honestly and you route manually.

Click **▶ Advance** repeatedly, or wire a cron to the endpoint — same
contract either way.

## API

| Method & path | Body | Notes |
| --- | --- | --- |
| `POST /api/orchestrator` | `{goal (required), title?, context?, autoRoute?, projectId?, participants: [{name, kind?, modelId?, adapterUrl?, adapterModel?, capabilities?, trust?}], relay?}` | 201 `{collaboration}` |
| `GET /api/orchestrator` | — | `{collaborations[]}` (latest 30, full detail) |
| `GET /api/orchestrator/[id]` | — | `{collaboration}` with participants + relays |
| `PATCH /api/orchestrator/[id]` | `{status: "closed", summary?}` | closes + files the record artifact |
| `DELETE /api/orchestrator/[id]` | — | removes the session |
| `POST /api/orchestrator/[id]/advance` | `{keys?, localOnly?}` | one step → `{ran, note, collaboration}` |
| `POST /api/orchestrator/[id]/relays` | `{target, source?, purpose?, request, contextRefs?, classification?, responseContract?}` | manual routing |
| `POST /api/orchestrator/relays/[relayId]` | `{response?, rejected?}` | answer a human checkpoint |

`ran` values: `relay` (dispatched + responded) · `checkpoint` (waiting for
you) · `blocked-relay` (egress policy or dispatch failure) · `autoroute`
(conductor queued the next relay) · `close` · `idle` · `closed`.

External adapters send a bearer token from the client-passed
`keys.externalBearer` — never stored. BYOK keys flow to `model` participants
through the standard fan-out.

## Design notes

- **Not agent-to-agent chat.** Work moves as discrete, typed handoffs
  (who → whom, why, what context, what output is expected) — auditable,
  resumable, and privacy-checked. Max 24 relays per session.
- **External AIs are participants, not integrations.** Anything speaking the
  OpenAI-compatible chat contract can join — there is no bespoke "Grok
  adapter" in the code, just a URL and model name on the participant.
- **The human is an optional participant.** Sessions run
  model↔model without you; you enter at checkpoints (approve / reject /
  answer) and at close.
- **Offline honesty.** With no keys/net, model relays store the offline
  fallback text (clearly `via offline-fallback`) and the conductor refuses to
  route rather than inventing a next step.
- Storage: `collaborations` / `collaboration_participants` /
  `collaboration_relays` (migration `0014`) + in-memory fallback, same as
  every module.

## Roadmap position

This is the 15E core: collaboration protocol + shared context (E.1),
external-AI participants (E.2), conductor auto-routing (E.3), and
checkpoints (E.4) — on one explicit-relay foundation. Natural next steps:
tool-capable participants (relays that invoke the Archive Assistant tool
registry), scheduled collaborations (Spaces driving advance), and egress
policy per artifact rather than per relay.

## Files

- `src/lib/orchestrator.ts` — sessions, relays, envelopes, egress policy,
  dispatch, conductor, close
- `src/app/api/orchestrator/**` — the routes above
- `src/components/OrchestratorWorkbench.tsx` — create form, session list,
  relay timeline, checkpoint banner
