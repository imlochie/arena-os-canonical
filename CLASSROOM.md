# 🎓 Lochie Life College — Classroom & institutional state

Lochie Life College is a personal university / life operating system built as **durable institutional state**, not a chatbot or a giant prompt. Philosophy: *Become by Learning*. Motto: *That's Life*. Core principle: *"I cannot imitate what I do not know."*

The user is the **student**. The institution carries the administrative and instructional burden: opening the class on schedule, knowing the week, carrying prior teaching forward, and filing the record at close. The product test: *open Classroom and you're in class — zero setup.*

## What exists

| Layer | Where | Nature |
|---|---|---|
| Institutional domain | `src/lib/college.ts` | Identity, semester calendar, timetable, courses, faculties — documented facts only |
| Classroom runtime | `src/lib/classroom.ts` | Occurrence lifecycle over an orchestrated collaboration |
| APIs | `src/app/api/classroom/**` | `GET ?date=`, `POST start`, `POST advance`, `POST respond`, `DELETE ?date=` |
| UI | `/classroom` (`src/components/ClassroomPanel.tsx`) | Institutional state + the class in progress |

## The authoritative resolver

`resolveCollegeState(date)` is the **single** implementation answering "what class is it today". No duplicates anywhere. It walks **local date → academic week → timetable slot → faculty**:

- Week 1 Monday = **2026-07-06**; weeks derive from the calendar (Monday-based), never arbitrary elapsed-time math.
- Week states: `before` (pre-semester), `within` (documented theme), `beyond` (past Week 10).
- **No fabrication (§24):** beyond the documented Weeks 1–10 the resolver reports "definition required" — it never invents a theme, course, faculty method, policy, or grade.

Documented timetable: Mon **RESET** · Tue **EXPLORE** (Digital Lab) · Wed **ADULTING** · Thu **CREATE** · Fri **KICKOFF** · Sat **ADVENTURE** · Sun **SOUL**.

Documented pilots: **PSY110 Personal Systems** (W1 "Meet Yourself") and **FIN111 Personal Finance Foundations** (curriculum undocumented → marked incomplete).

## Classroom vs Class Occurrence vs Cognitive Session

- **Classroom** — the persistent institutional slot (Mon RESET, Thu CREATE …) with its Faculty.
- **Class Occurrence** — one per scheduled date (unique on date). Phases: `waiting → orientation → lesson → practice → discussion → check → reflection → record → complete`; status `waiting | in_session | complete`.
- **Cognitive Session** — the existing collaboration (see `ORCHESTRATOR.md`). Starting a class creates/resumes one collaboration for the occurrence; there is **no second session lifecycle**.

## Faculty

Faculties are persistent teaching identities (subject domain + documented methods); the model workers executing them are replaceable. Each class runs with a multi-AI faculty behind one voice:

- 🎓 **Faculty Lead** — the classroom's one voice; opens, teaches, records
- ❓ **Socratic Critic** — probes understanding (never grades)
- 🔎 **Researcher** — read-only tool relay; grounds the lesson in workspace facts
- 🛠️ **Pragmatist** — designs the exercise
- 🛡️ **Steward** — owner interest & boundaries (via orchestrator preferences)
- 🧑 **Student** — the human, participating at marked points

## Class flow (bounded)

`POST /api/classroom/advance` performs **exactly one** step per request: dispatch one pending relay, surface the student checkpoint, or transition the phase. The UI's **Auto-run** just loops advance until a checkpoint or completion — there are no server workers, and no recursive class creation.

At close, the runtime files the **Faculty Reflection & Teaching Record** (what was taught vs. accomplished, observations, follow-ups) to educational memory and `/artifacts`, and the next occurrence retrieves it automatically.

## Educational memory

`edu_memory` is distinct from owner preferences/boundaries/goals. Entries are `lesson | reflection | record | observation | review_point`, scoped by classroom, linked to their source occurrence, inspectable via the state API, and deletable via `DELETE /api/classroom?date=`. Writes are **explicit** — relay/tool output never becomes memory automatically; only the close-of-class filing writes lesson/reflection/record.

## Local mode

As everywhere in arena-os: Postgres when available, in-memory fallback otherwise (records persist per-process). The researcher's tool relay uses the same read-only `ORCHESTRATOR_TOOLS` whitelist.
