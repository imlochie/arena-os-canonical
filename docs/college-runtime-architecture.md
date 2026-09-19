# Lochie Life College — Institutional Runtime Architecture

Status: **Working document.** Design record for the College runtime built into Arena.
Authority: **None.** This is an operational interpretation, not institutional canon.
Canon lives in Notion and is amended only through the Editorial Amendment Register.

Date: 20 September 2026 (Australia/Brisbane)

---

## 0. Critical finding — brief vs. repository

The build brief describes an existing Arena architecture consisting of *"sessions as the
canonical work unit, Workforce for local workers, Tool Runtime for bounded capabilities,
Collaboration Orchestrator above them, and the Archive Assistant remaining the read-only
truth/control plane"*, plus `participants`, `delegations`, `responses`, `checkpoints`,
`bounded context`, `provenance` and `egress`.

**Most of that does not exist in this repository.** Verified by exhaustive search of the
working tree and the entire git history (single commit `c1c1219`):

| Concept in brief | Present? | Evidence |
|---|---|---|
| Sessions as work unit | **Partial** | `cognitive_sessions` table + `/api/cognitive-sessions`. A record of completed Council runs, not a live runtime. |
| Workforce | **Yes** | `src/lib/workforce.ts` — 8 roles, prompt fragments, Elo-informed model selection. |
| Tool Runtime | **No** | Zero matches in tree or history. |
| Collaboration Orchestrator | **No** | Zero matches. `src/lib/collab.ts` is a strategy helper. |
| Archive Assistant / ArchiveContext | **No** | Zero matches. No read-only truth plane exists. |
| participants / delegations / checkpoints | **No** | Zero matches. |
| provenance / bounded context | **No** | Zero matches before this build. |
| egress | **Yes** | `src/lib/privacy.ts` — Local Mode zero-egress enforcement. |

**Consequence.** The instruction "preserve the Archive Assistant boundary" could not be
followed literally, because there is no Archive Assistant to preserve. Rather than invent
one, this build **honours the boundary as a design rule**: Notion remains the authoritative
canon plane, Arena holds operational state, and Arena never mutates canon. The
`college_sources` registry is a pointer table with authority levels — it stores *references
to* canon, never canon itself.

If an Archive Assistant exists in another repository or deployment, this build is ready to
defer to it: `college_sources` is the seam where that contract would attach.

---

## A. Current architecture map (as built, before this change)

**Stack.** Next.js 16.2.6 (App Router, Turbopack) · React 19.2.6 · PostgreSQL via
`drizzle-orm` 0.45.2 / `pg` · Tailwind 4 · PWA (`public/sw.js`, `manifest.json`).

**Identity.** "ArenaForge Personal — Your Free Private AI Arena." A private, local-first,
$0 multi-model AI workbench.

**Persistence (18 tables).** `models`, `model_category_ratings`, `assistants`, `battles`,
`battle_messages`, `prompt_templates`, `collabs`, `collab_contributions`, `council_runs`,
`council_artifacts`, `cognitive_sessions`, `projects`, `artifacts`, `project_memory`,
`privacy_events`, `arcade_games`, `chats`, `chat_messages`.

**Runtime.** `src/lib/ai.ts::generate()` is the single generation entry point, with a
provider fallback chain (BYOK → Pollinations OpenAI-compatible → Pollinations GET →
alias → local engine). It never hard-fails.

**Cognition.** `cognitiveJobs.ts` defines 7 jobs, each a fixed 4-stage pipeline
(perspectives → cross-critique → synthesis → artifact) executed by
`/api/council/route.ts`. `workforce.ts` maps jobs to roles to preferred models.

**Key architectural observation.** Council **automatically persists** every run as a
`council_run`, a `cognitive_session`, a `council_artifact` and a unified `artifact`.
Nothing distinguishes working output from authoritative material. That is correct for a
Work OS and unacceptable for an institution — it is the single most important reason the
College could not simply reuse `artifacts` as its record.

**Context injection.** `projectContext.ts` merges project memory + artifacts into one
undifferentiated block and instructs the model to *"build on it — and challenge it where
the new material suggests it is wrong."* Correct for a Work OS; wrong for Faculty, which
must know which claims are canonical, filed, working or unverified.

---

## B. College institutional model (from canon)

Verified by direct fetch of the Prospectus & Academic Handbook, Academic Calendar,
Institutional State, and linked governance pages.

- **Purpose.** A personal university making life development coherent and progressive.
  Motto *Become by Learning*; founding quote *That's Life*.
- **Philosophy.** Education before productivity · principles before techniques · real-world
  application over theory · progression and coherence · kind rigor.
- **Continuation Principle.** Students never restart a semester. Learning resumes from the
  next available lesson. Setbacks are observations, not failures.
- **Capability framework.** 12 core graduate capabilities; assessments must evidence
  measurable improvement in ≥1 primary capability.
- **Course standards.** Blueprint → 10-week roadmap → lessons, in that order. Assessments
  are authentic projects; **no exams**.
- **Catalogue policy.** *"No courses have been approved yet in the First Edition."*
- **Separation of powers.** Faculty owns teaching and academic continuity. Administration
  owns classification, filing, records and institutional continuity. The Student owns
  attendance, evidence and honest reflection.
- **Calendar.** Semester I 2026: Week 1 Monday 6 Jul 2026, ten weeks to Week 10
  (7 Sep 2026). Themes: Observation, Patterns, Friction, Design, Rhythm, Attention,
  Feedback, Recovery, Alignment, Integration. Timezone Australia/Brisbane.

### Live contradictions preserved, not resolved

1. **Academic position.** Calendar arithmetic places 20 Sep 2026 in **week 11** — one week
   past the final listed week. Institutional State declares **Week 1 (Observation)**.
   Surfaced as `CONFLICT`.
2. **PSY110 status.** The catalogue says no courses are approved, yet teaching has been
   delivered and filed against PSY110. Recorded as `blueprint`, not silently upgraded.
3. **Timetable.** Degree Map, Theme Matrix, Schools and Timetable Integration disagree on
   the Semester I catalogue and day mapping. **Not seeded.** Reported `UNKNOWN`.

---

## C. College State model

College State is the institution's current understanding of itself, recomputed from
persisted rows on every request. It is **not** a dashboard and **not** model memory.

Seven state domains: Institutional Identity · Academic · Student · Teaching · Institutional ·
Real-World · Derived.

Every surfaced value is a `Claim`:

```ts
interface Claim<T> {
  value: T;
  truthClass: "fact" | "interpretation" | "decision" | "expectation" | "unknown" | "conflict";
  confidence: "known" | "inferred" | "expected" | "unknown" | "conflicting";
  provenance: string;
  conflictWith?: string[];
}
```

A value cannot reach the UI or a model prompt without declaring what kind of claim it is
and where it came from.

---

## D. Entity model (22 additive tables, all `college_` prefixed)

| Group | Tables |
|---|---|
| Canon | `sources` |
| Identity | `institution` |
| Calendar | `terms`, `weeks` |
| Curriculum | `schools`, `capabilities`, `courses`, `course_weeks` |
| Scheduled intent | `timetable_slots` |
| Faculty | `faculty`, `session_faculty`, `faculty_contributions` |
| Runtime | `sessions`, `session_events` |
| Reality gap | `deviations`, `context_signals` |
| Purpose | `goals`, `goal_links` |
| Memory | `memory`, `memory_evidence` |
| History | `records` |
| Audit | `state_snapshots` |

**No existing table was renamed, altered or dropped.** The College links into the Work OS
by nullable columns (`projectId`, `cognitiveSessionId`, `councilRunId`) — linking, never
absorbing. Verified live: 40 tables total = 18 legacy (intact) + 22 College.

---

## E. Runtime / session flow

```
scheduled → orientation → context_check → lesson → practice → inquiry
   → understanding → reflection → close → faculty_record → institutional_update
```

Adaptive, not forced: each session kind declares only the stages it uses. Direct Support
uses one. Every transition appends to `session_events` — the trail is append-only.

A session is **working material until explicitly filed**. Once `filedAt` is set the session
becomes immutable; changes require a correction record.

---

## F. Faculty architecture

Faculty are institutional **responsibilities**, not personalities. Eight positions:
Instructor, Researcher, Critic, Registrar, Observer, Assessor, Specialist, Socratic.

Each declares a remit, an authority boundary, a bounded context scope, an output type, and
its **derivation** (`canon-derived` / `inferred` / `proposed`) so speculative roles are
never mistaken for canon.

**Authority invariant, enforced in code:** every position ships with
`mayFileRecords: false` and `mayAssess: false`. No AI faculty member can write institutional
history or issue a formal academic judgement.

**Composition is contextual** (`deriveFacultyComposition`), derived from session kind plus
live circumstances — an open deviation pulls in the Registrar; a revisit pulls in the Critic.

**Disagreement is preserved.** `faculty_contributions` carries `stance`
(support/dissent/question/neutral) and `respondsToId`. Dissent is stored, never synthesised
away — deliberately unlike the Council pipeline, which collapses to one synthesis.

**Bounded context** (`context.ts`) gives each position only its declared scope keys, labels
every line with its epistemic status, and always ends with an explicit visibility statement.

---

## G. Memory architecture

Six scopes: institutional · student_learning · teaching · course · session · historical.

Epistemic ladder with **evidence-gated promotion**:

| From → To | Corroboration required |
|---|---|
| observation → interpretation | 1 |
| interpretation → hypothesis | 2 |
| hypothesis → established | 3 |

New memory **cannot be created as `established`** — the API downgrades the request and says
why. Promotion is refused with a stated reason when evidence is short. Revision happens by
**supersession**, never overwrite. The institution can always explain why its teaching
changed.

---

## H. Registrar / historical record

Record-worthiness is a **deterministic rule**, not a model call: milestone, decision,
discovery, curriculum change, goal change, teaching-strategy change, correction or completed
session. Routine conversation is explicitly refused.

`propose → file` is a two-step act. The Registrar only ever proposes; filing is the
institutional act. Records carry `occurredOn` / `recordedAt` / `filedAt` as **three distinct
timestamps** so chronology survives later understanding. Corrections supersede; the
superseded row keeps its content and is marked, never edited.

---

## I. Timetable vs reality

Three separate facts, never collapsed:

- **Scheduled** — `timetable_slots` (what should happen)
- **Observed** — `sessions`, `context_signals` (what is happening)
- **Adjusted** — `deviations.adjustedState` (the decided response)

Recording a deviation does **not** mark the timetable wrong and does **not** decide the
response. Adjustment requires both `adjustedState` and `decisionBasis` — the API returns
400 without them. The institution never invents "therefore Z".

---

## J. Teaching-quality loop

```
TEACH → OBSERVE (memory: observation)
      → RECORD (session_events, contributions)
      → REFLECT (faculty_record stage)
      → PROMOTE (evidence-gated, explainable)
      → ADAPT (teaching_memory in the next context packet)
      → TEACH
```

Not an opaque preference-learner: every adaptation traces to corroborated observations via
`memory_evidence`.

---

## K. UI architecture

`/college` is a **projection** of College State — it computes nothing and holds no truth.
Panels answer the brief's questions directly: Where are we · What should be happening ·
What is actually happening · What are we trying to accomplish · What does the College know ·
What needs attention · Institutional record · Who should be involved.

`TruthBadge` gives one visual language for epistemic status. Conflicts render in a dedicated
red band; unknowns get their own panel titled *"What the College does not know."*

---

## L. Migration / implementation status

**Done and verified live**

- 22 additive tables pushed; 18 legacy tables intact.
- Bootstrap seeds only evidence-backed canon and reports what it refused to invent.
- State engine surfaces the week conflict and the unknown timetable.
- Registrar gate, memory promotion gate, deviation decision gate all verified.
- Bounded context packets verified to differ per position.
- `tsc --noEmit` exit 0. ESLint on all new code exit 0.

**Deliberately not built** (would require decisions only the founder can make)

- Faculty **execution** against `ai.ts`. The context packets are built and inspectable, but
  wiring generation in requires deciding whether AI faculty may assess, and how modes are
  selected. Building it first would have embedded a guess.
- Timetable contents, course catalogue beyond PSY110, schools, student goals, learning
  history.
- Council/Collab handoff into College sessions — the seam exists (`cognitiveSessionId`,
  `councilRunId`) and is unused pending the authority decision.

---

## Open decisions

1. **Registrar URL unreachable.** `Administration-Registrar-s-Office-ea7b16f08…` failed to
   fetch repeatedly; search found no alternative. Registrar rules are inferred from the
   Information Flow Protocol, not from the Registrar's own page.
2. **Faculty AI instructions authority** — filed guidance, current prompt, or draft?
   Currently registered `unverified`.
3. **Assessment authority** — may AI faculty assess, or only recommend? Currently: recommend
   only.
4. **Academic position** — reconcile Week 1 vs week 11, or close Semester I?
5. **Mode selection** — explicit Student/Founder/Direct-Help switch, or inferred?
6. **Source of truth split** — which domains are Notion's, which are Arena's?
