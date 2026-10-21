# Spaces — persistent missions and recurring agent work

Spaces has two connected workflows. **Recurring runs** use a prompt, model,
interval and briefcase to prepare repeatable drafts. **Missions** use a goal,
configured agent fleet, governed tools and a real per-space workspace to do
work, retain command/test observations, and produce immutable Artifacts.
Both are available in the workbench and the single-space pop-out's Workshop.

**Recurring templates draft; missions act within their permissions.** Each recurring template ships with a system
prompt that ends:

> Never pretend to have taken actions (posting, sending, buying) — you draft,
> the human acts.

Those recurring outputs are drafts, not evidence of external actions. Missions
can read/write their workspace and run permitted commands; publishing, browser
interaction, calls, SMS and payments remain behind recorded human approval.
The shared Workshop keeps fleet configuration, mission history, tool outcomes,
reconciliation, outputs and approvals together. No second executor is involved.

## Using Spaces

- `/spaces` — the workbench. Create a space from a template (or blank), then
  watch the window grid. Windows tick every 20s while visible; ⤢ pops a space
  out into a real browser window (`/spaces/<id>`) that keeps ticking every 15s
  on its own. Park pop-outs on a second monitor and the agents keep working.
- Pause/resume any window from the header (`⏸` / `▶`), or edit the briefcase
  live in the pop-out's **Setup** tab.
- **Workshop** in `/spaces/<id>` uses the same fleet, mission and approval
  components as `/spaces`. Give it an objective, inspect the actual backend
  and model in the journal, review recorded tests and immutable outputs, and
  resume a saved mission. Opening a window does not certify a running worker.
- Mission execution completion, a successful command, observed test-tool command
  outcomes and a downloadable deliverable are different evidence. The mission
  summary reports them separately; human-reconciled outcomes do not count as
  machine test-command successes. A test-tool command can itself be arbitrary:
  inspect the assertions/output, not just its zero exit. Actual passing tests
  apply to those recorded tests, not the entire product.

### Templates

Templates follow one test before they earn a slot: would a human spend 10+
minutes doing this, does it happen at least weekly, and is it a predictable
input → process → **validate** → output pipeline? The validate stage is
explicit — money-work templates flag what they couldn't verify (`[MISSING]`,
`[CONFIRM PRICE]`, mismatch reports) instead of silently inventing it.

**Audience & content**

| Template | Cadence | What it drafts |
| --- | --- | --- |
| 📺 YouTube co-pilot | 60 min | Comment drafts for your recent videos; you post them |
| ✍️ Content drip | 24 h | Next post draft from your content calendar |
| 🎙️ Content repurposer | 24 h | One transcript in → clip picks, posts, newsletter, description |

**Revenue**

| Template | Cadence | What it drafts |
| --- | --- | --- |
| 💼 Lead sweeper | 2 h | Fit verdicts + tailored proposal drafts from gig listings |
| 🧾 Quote drafter | 2 h | Customer enquiries → draft quotes with line items + open questions |
| ⭐ Review responder | 4 h | Personal replies to Google/business reviews (crit. handled safely) |
| 🛒 Listing writer | 6 h | Product listing copy iterations (title/bullets/tags) |

**Operations**

| Template | Cadence | What it drafts |
| --- | --- | --- |
| 🧹 Reply drafter | 2 h | Reply drafts for messages you paste in |
| 📄 Doc data extractor | 60 min | Invoices/receipts/forms → validated pipe-table rows |
| 📊 Data cleaner | 4 h | Messy pasted lists → normalized, deduped, categorized |
| 📦 Stock reconciler | 24 h | Stock vs orders vs inbound mismatch report |
| 📈 Watchlist digest | 6 h | Change notes on the tickers/feeds in your briefcase |
| 🔬 Research digest | 24 h | Summaries of the topics you're tracking |

**Custom** — ✨ blank space: your prompt, your cadence.

All templates are starting points — the prompt, model, interval, and briefcase
are editable on any space.

### The briefcase

The briefcase is the space's memory. On every run the agent is told the current
briefcase and asked to end its reply with:

```
### BRIEFCASE UPDATE:
<the new briefcase contents>
```

Whatever follows that marker replaces the briefcase (capped at 8,000 chars) and
is handed to the next run. This is how a lead sweeper remembers which leads it
already drafted, or a content drip avoids repeating itself. You can also edit
it by hand at any time.

## API

Base: `/api/spaces`

| Method & path | Body | Notes |
| --- | --- | --- |
| `POST /` | `{title, prompt (required), emoji?, modelId?, intervalMinutes?, briefcase?, projectId?}` | 201 `{space}`; interval clamped to 5–1440 min (default 60) |
| `GET /` | — | `{spaces[]}`; `due` = running ∧ (no `nextRunAt` ∨ due now) — a new space is due immediately |
| `GET /[id]` | — | `{space, runs}` (latest 25 runs) |
| `PATCH /[id]` | `{title?, emoji?, prompt?, modelId?, intervalMinutes?, status?, briefcase?}` | `status`: `running` \| `paused` |
| `DELETE /[id]` | — | removes the space (runs are kept in history tables) |
| `POST /[id]/run` | `{keys?, localOnly?}` | force-run now, regardless of schedule |
| `POST /tick` | `{limit? (1–4, default 2), keys?, localOnly?}` | runs up to `limit` **due** spaces; returns `{ran, spaces}` |

Errors: `400` for a missing `prompt` or bad `limit`/`intervalMinutes`, `404`
for an unknown space id.

### Scheduling model

Scheduling is request-driven: visible workbench windows poll `/tick` every
20 seconds and pop-outs every 15 seconds, or a user can choose **Run now**.
`/tick` selects due running spaces; it is not a per-pop-out worker. Pausing a
recurring schedule does not cancel an independently running mission.

There is also an **optional, separately started daemon**, not an automatic
service: `npm run spaces:daemon`, or `npm run spaces:daemon -- --once` for one
tick. It calls the app's HTTP APIs (default loopback port 3000), polls due
spaces, resumes supported approval waits after decisions, and expires stale
pending approvals. The continuous interval defaults to 60 seconds. Both the
daemon and reachable, authorised app server must remain running. With all
windows closed and no daemon/service, there is no scheduled polling.

An already-requested mission may still be executing server-side. Its saved
status alone does not establish a live process. PostgreSQL-backed missions
retain requests, observations, output references and checkpoint state;
memory-only mode is explicitly non-durable. Interrupted ambiguous effects are
not blindly replayed: inspect evidence and use the existing reconciliation
flow. See [Spaces autonomy](docs/spaces-autonomy.md) for runtime prerequisites,
approval boundaries and current verification limits.

Model calls go through the same provider fan-out as everything else
(`src/lib/ai.ts`), so a space uses whichever model id it was assigned, with
your BYOK keys passed from the client. With no keys / no network the offline
fallback text is used, and the run still ticks the schedule — useful for
watching the machinery work before wiring a real model.

## Agent design notes

- **Drafts-for-human-review is a hard rule across all templates.** The system
  prompt is appended server-side (`runSpace` in `src/lib/spaces.ts`), so even a
  custom space gets the "you draft, the human acts" clause.
- The briefcase is the entire memory: no per-space vector store, no chat
  history. Runs are independent; only the briefcase carries forward. If the
  model omits `### BRIEFCASE UPDATE:`, the briefcase is left untouched.
- Concurrency: a per-space `inflight` set guards against double-runs when the
  workbench and a pop-out tick in the same server process; this is not a claim
  of cross-process exactly-once recurring inference. `runSpace` also refuses
  to start if the space is paused. Durable missions have separate lease,
  journal, approval and reconciliation protections.
- Storage: drizzle tables `spaces` / `space_runs` (migration `0012`), with an
  in-memory fallback when Postgres is absent — same pattern as every module.

## Files

- `src/lib/spaceTemplates.ts` — recurring templates (client-safe, prompts +
  briefcase seeds + cadences)
- `src/lib/spaces.ts` — orchestrator: CRUD, `runSpace`, `tickSpaces`
- `src/app/api/spaces/**` — the routes above
- `src/components/SpacesWorkbench.tsx` — workbench grid + pop-out
- `src/components/SpaceDetail.tsx` — pop-out Workshop / Latest / History / Setup
- `src/lib/spaces/mission.ts` — existing durable mission runner and recovery
- `src/lib/spaces/mission-evidence.ts` — read-only evidence summary, no execution
- `scripts/spaces-daemon.mjs` — optional HTTP-client scheduler, never auto-started
