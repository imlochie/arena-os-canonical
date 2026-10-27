# 🏛️ Congress — timed multi-seat deliberation with durable results

Seat multiple AI collaborators together for a **set amount of time** and let them
deliberate until the clock runs out — then the Clerk drafts the **Act**, a durable
resolution document that lands in your artifacts (and project memory when linked).
Sessions can be **adjourned**, **resumed**, and **reconvened** as new sittings that
build on previous Acts — results compound over time.

Think of it as the chamber above the **Council** (🧠 two voices, one-shot synthesis):
the Congress is many voices, on the clock, producing records that outlive the session.

## How a sitting works

1. **Convene** (`/congress`): state the topic, pick seats (role + model each), set the
   sitting length (3–30 min), choose the Clerk model, optionally link a project.
2. **Deliberation**: seats speak in round-robin — the Chair opens, the Proposer moves,
   the Skeptic challenges, and so on. Each turn sees the chamber, the clock, and the
   recent record. The page drives the sitting: one turn is generated per `/advance`
   poll (bounded server work per request — no background workers needed).
3. **The gavel falls**: when the clock runs out (or the turn cap is hit, or you close
   early), the Clerk compiles the **Act** — *Resolutions · Decisions · Open Questions ·
   Next Steps* — written for a reader who wasn't present.
4. **Durable results**: the Act is saved to the artifact library (`sourceType:
   "congress"`) and, when a project is linked, as a project-memory decision. The full
   proceedings are kept as **the record**.
5. **Reconvene**: a new sitting (sitting #2, #3, …) seeded with the previous Act —
   the chamber continues where it left off, and Open Questions get answered over time.

### Roles

| Role | Drives |
| --- | --- |
| 🏛️ Chair | Opens the sitting, keeps debate on-topic, pushes toward concrete decisions |
| 📜 Proposer | Turns discussion into specific, votable motions |
| 🔍 Skeptic | Stress-tests claims, names risks, demands edge cases |
| 📚 Researcher | Brings facts, precedents and constraints |
| 🔨 Builder | Converts agreement into plans and checklists |
| 🗂️ Scribe | Maintains the durable running record |

Chamber presets: **Committee** (3 seats · 5 min) · **Session** (5 seats · 10 min) ·
**Plenary** (6 seats · 20 min). Up to 8 seats, any mix of models — including your
local ⚡ TurboAgent server and 🔒 Local Mode (a fully offline congress works too,
via the built-in offline generator).

### The clock

- Time is the primary limit; a turn cap (`maxTurns`, auto-sized from the duration)
  is the safety valve.
- **Adjourn** freezes the clock (remaining time is stored); **Resume** continues it.
- Closing the tab is safe — the record lives server-side. Reopen and the clock
  stands where you left it; the next visit closes expired sittings and drafts their
  Acts on the next advance.

## Under the hood

```
client (polls /advance every 3s while sitting)
   └─► POST /api/congress/[id]/advance   one bounded step:
         ├─ time/turns left?  → next seat speaks (generate() — any provider)
         └─ otherwise         → Clerk drafts the Act → artifact + memory → closed
```

| Path | Purpose |
| --- | --- |
| `src/lib/congressRoles.ts` | role catalog + chamber presets (shared client/server) |
| `src/lib/congress.ts` | orchestrator: step engine, prompts, lifecycle, persistence |
| `src/app/api/congress/*` | routes: convene/list, get/delete, advance, lifecycle |
| `src/components/CongressChamber.tsx` | the chamber UI (floor, countdown, record) |
| `congress_sessions` + `congress_turns` | tables (auto-created; in-memory fallback when the DB is down) |

Design notes for agents:

- One model call per `/advance` request — bounded work, safe to poll, no
  background workers. Concurrency is guarded by an in-flight lock per session.
- Everything routes through `generate()` (`src/lib/ai.ts`), so congress inherits
  the full provider fan-out (Pollinations → BYOK → offline), Local Mode and the
  no-train headers automatically.
- Prompt budget: each seat sees the last ~10 turns (truncated); the Clerk sees the
  last ~24 when drafting the Act.
