# Spaces — multi-window recurring agent workbench

Spaces are small, recurring agent tasks that run on a schedule you control.
Each space is a **window** in the workbench: a prompt + model + interval + a
persistent **briefcase** of carry-forward notes. Agents tick on the workbench's
schedule, produce a fresh draft each run, and fold what they learned back into
the briefcase for the next run.

**The house rule: agents draft, you act.** Every template ships with a system
prompt that ends:

> Never pretend to have taken actions (posting, sending, buying) — you draft,
> the human acts.

That is deliberate. Auto-posting / auto-engagement bots violate platform terms
of service (YouTube's especially) and get accounts banned. Spaces instead run
as a **co-pilot**: the agent prepares comments, messages, listings, or digests
in the briefcase, and you review and post them yourself — a few minutes of
human time per cycle in exchange for zero ban risk.

## Using Spaces

- `/spaces` — the workbench. Create a space from a template (or blank), then
  watch the window grid. Windows tick every 20s while visible; ⤢ pops a space
  out into a real browser window (`/spaces/<id>`) that keeps ticking every 15s
  on its own. Park pop-outs on a second monitor and the agents keep working.
- Pause/resume any window from the header (`⏸` / `▶`), or edit the briefcase
  live in the pop-out's **Setup** tab.

### Templates

| Template | Cadence | What it drafts |
| --- | --- | --- |
| 📺 YouTube co-pilot | 60 min | Comment drafts for your recent videos; you post them |
| 🧲 Lead sweeper | 120 min | Outreach message drafts from your lead list |
| 🏷️ Listing writer | 6 h | Product listing copy iterations (title/bullets/desc) |
| 🦅 Watchlist digest | 6 h | Change notes on the tickers/feeds in your briefcase |
| 🗓️ Content drip | 24 h | Next post draft from your content calendar |
| 🔬 Research digest | 24 h | Summaries of the topics you're tracking |
| 📥 Inbox triage | 120 min | Reply drafts for mail you paste in |
| ✨ Custom | any | Your prompt, your cadence |

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

There are **no background workers**. Runs happen when a client calls `/tick`
(workbench every 20s, pop-out windows every 15s, both skipping when the tab is
hidden) or when you hit **Run now**. `nextRunAt` is simply `lastRun +
intervalMinutes`; pausing just excludes the space from due checks. This keeps
the platform stateless and heroku-free: close every window and nothing runs;
open one pop-out and the cadence resumes.

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
  workbench and a pop-out tick near-simultaneously; `runSpace` also refuses to
  start if the space is paused.
- Storage: drizzle tables `spaces` / `space_runs` (migration `0012`), with an
  in-memory fallback when Postgres is absent — same pattern as every module.

## Files

- `src/lib/spaceTemplates.ts` — the 8 templates (client-safe, prompts +
  briefcase seeds + cadences)
- `src/lib/spaces.ts` — orchestrator: CRUD, `runSpace`, `tickSpaces`
- `src/app/api/spaces/**` — the routes above
- `src/components/SpacesWorkbench.tsx` — workbench grid + pop-out
- `src/components/SpaceDetail.tsx` — pop-out detail view (Latest / History /
  Setup)
