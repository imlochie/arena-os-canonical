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

---

# LAYER 2 — THE EXECUTABLE TEACHING LOOP

*Appended after Layer 1 was committed (`082cd3a`). Layer 1 is not rewritten. The
22 original College tables and 18 legacy tables are unchanged; Layer 2 adds 7
tables and 3 columns.*

## A. Current College runtime architecture

```
                     ┌──────────────────────────────────┐
   Notion (canon) ──▶ │ college_sources  (the seam)      │  Arena never mutates canon
                     └──────────────┬───────────────────┘
                                    ▼
                     ┌──────────────────────────────────┐
                     │ COLLEGE STATE  (control loop)    │ ── recomputed, never remembered
                     │ position · curriculum · memory   │
                     │ attention · unknowns · conflicts │
                     └──────────────┬───────────────────┘
                                    ▼  buildOrientation()
                     ┌──────────────────────────────────┐
                     │ ORIENTATION — 8 standing answers │
                     └──────────────┬───────────────────┘
                                    ▼
   FACULTY (teach/observe/interpret)        ADMINISTRATION (classify/file)
   ├ instructor   interpretation            └ registrar — invoked only when a
   ├ researcher   observation                 session produces something
   ├ critic       DISSENT                     record-worthy. Not in class.
   ├ socratic     question
   ├ observer     observation
   ├ assessor     assessment (formative only)
   └ specialist   interpretation
                                    ▼
                     session → contributions → coordination (dissent preserved)
                             → formative evidence → registrar handoff
                             → College State update → next class
```

Runtime paths that actually exist: `src/lib/college/{state,orientation,teaching,
faculty,curriculum,reconciliation,context,memory,registrar}.ts` and the routes
under `src/app/api/college/*`. There is no Tool Runtime, no Collaboration
Orchestrator, no Archive Assistant — see §0.

## B. Current data model (29 College tables)

Layer 2 additions only:

| table | purpose |
|---|---|
| `college_reconciliations` | durable conflicts: source A/B, claims, provenance, detected_at, type, status, required authority/action, resolution, resolution provenance, resolved_at |
| `college_formative_evidence` | formative observations; `assessment_kind` on every row |
| `college_curriculum_versions` | versioned curriculum; supersedes chain |
| `college_curriculum_entries` | **explicit** course membership in a version |
| `college_course_snapshots` | immutable course+weeks as they were at a point in time |
| `college_curriculum_changes` | what/previous/new/reason/initiator + `significance` |
| `college_curriculum_proposals` | AI may propose; never activates |

Columns added: `college_faculty.branch`, `.assessment_authority`,
`.participates_in_class`; `college_sessions.curriculum_version_id`,
`.course_snapshot_id`.

## C. State lifecycle

Recompute → detect conflicts → `registerConflict()` (idempotent by
`conflict_key`; a resolved conflict is **not** reopened unless the claims
themselves changed) → surface in `attention`/`unknowns` → optional immutable
snapshot. UNKNOWN stays UNKNOWN. The Week 1 vs Week 11 conflict is now a row,
not a recomputed opinion, and no code path picks a winner.

## D. Faculty lifecycle

Composition derived from session kind → each position gets a **different**
context packet (`buildContextPacket`) and a **different** task (`POSITION_TASK`)
→ contributions persisted with `contribution_type`, `stance`, `truth_class` →
coordination summarises **without collapsing dissent**. A position whose
`assessment_authority` is `none` cannot make statements about attainment. A
position whose branch is `administration` is refused entry to a class.

## E. Registrar lifecycle

Post-class only. Faculty hands off → Registrar judges NO RECORD REQUIRED vs
RECORD REQUIRED against eight criteria → filing is a **separate explicit act**.
Filed records are immutable; corrections supersede. Faculty never gains
authority over historical records.

## F. Teaching / memory lifecycle

Observation → candidate → corroboration (1/2/3) → promotion. A one-off
observation cannot become permanent truth: *"Promotion refused. A one-off
observation does not become permanent truth automatically."* Promoted memory
re-enters the next class through orientation §5/§6, which is how the College can
answer *why are we teaching this differently now?*

## G. Remaining gaps (honest)

1. **Formal assessment is undefined** — deliberately. Faculty may observe; no
   authority exists to declare an outcome officially achieved. The API returns
   403 rather than guessing.
2. **Timetable is empty** — 0 slots. Curriculum↔timetable conflicts are detected
   and surfaced, never auto-repaired.
3. **No live model reachable** in this environment; all generation degrades to
   `localTextReply` and is labelled `via: "offline-fallback"`. Nothing is
   presented as if a real model produced it.
4. **Registrar's Office canon unavailable** (Notion page unreachable); Registrar
   rules remain inferred from the Information Flow Protocol.
5. **AI curriculum proposals** are modelled but intentionally not wired to any
   generator — the institution manages its curriculum deterministically first.
6. Student identity, enrolment, multi-term progression, and cross-course
   prerequisite enforcement are not implemented.

## The guarantee Layer 2 buys

Editing the curriculum cannot rewrite history. Verified end-to-end: after a
session was taught and the course was then retitled and its week-1 objective
replaced, the historical session still resolves to *Personal Systems* with its
original objective, while the live course reads *Personal Systems & Behavioural
Design*.

---

# LAYER 3 — ATTENTION AND COORDINATION

*Appended after Layer 2 (`ff0b201`). Additive: 7 new tables (36 College total),
no Layer 1 or Layer 2 table renamed or altered, 18 legacy tables untouched.*

The faculty is an **orchestration problem**, not a collection of prompts. The
orchestrator decides WHEN a position should operate; the AI is merely an
implementation of that position at a bounded execution point.

## Build order (as specified, 1–10 before AI)

1. `attention.ts` — attention policies (declarative, no generation)
2. activation/deactivation — `setAttention()`, nine states
3. session phases — `enterPhase()`, 7 phases
4. event model — 15 event types, `emitEvent()` routing
5. consultation model — `requestConsultation()` / `answerConsultation()`
6. handoff model — `handOff()` / `settleHandoff()`
7. coordination state — `currentAttention()`, `coordinationBoard()`
8. interruption authority — `mayInterrupt()`, four authority levels
9. coordination trace — `coordinationTrace()`
10. course protocols — `protocol.ts`, per-course configuration

Only then is generation attached, in `coordination.ts`, at the points the
orchestrator has already decided.

## Attention states

`dormant` · `watching` · `engaged` · `consulting` · `waiting` · `deferred` ·
`escalated` · `handing_off` · `completed`

Only `engaged`, `consulting` and `escalated` may speak. **Dormant positions
consume no context and generate nothing** — verified: in an orchestrated class
the Researcher recorded 2 attention transitions and 0 contributions.

## Interruption authority (deliberately unequal)

| position | authority | effect |
|---|---|---|
| Observer, Socratic, Specialist | `none` | must report via observation or handoff |
| Critic, Assessor | `request` | may raise a consultation, never seize |
| Instructor, Researcher | `material` | may interrupt only if the matter materially affects the lesson |
| Registrar | `integrity` | may interrupt for institutional integrity — **not** routine recordkeeping |

Every interruption carries a reason. Refusals are **recorded**, not dropped:
role creep is evidence.

## Signals are not findings

`detectSignals()` returns `epistemicStatus: "signal"` — never `fact`. A keyword
match proposes a candidate event; faculty decide whether it is real. The Critic
is instructed to answer `NO CONCERN` when reasoning is sound, and stands down.

## Coordination windows

The student experiences ONE teacher. Internally, verified across three inputs:

| student input | signals | faculty that generated | visible |
|---|---|---|---|
| "Okay, that sounds reasonable." | 0 | Instructor | 1 |
| "But you said tracking always works. So basically every system fails…" | misconception, contradiction | Observer, **Critic**, Instructor | 1 |
| "Is it true habits take 21 days? What does the research say?" | factual_uncertainty, research_required | Observer, **Researcher**, Instructor | 1 |

The Critic woke only for the reasoning problem; the Researcher only for the
factual one. Neither spoke to the student.

## Role creep guard (§17)

`checkRemit()` defers by matter, verified:

- Instructor asked about the historical record → **defer to registrar**
- Registrar asked how to teach → **defer to instructor**
- Researcher asked whether the curriculum should change → **defer to founder**

Curriculum authority defers to the founder, never to another AI position.

## Course protocols

`college_faculty_protocols` stores per-course configuration. PSY110 declares
Instructor primary, Observer continuous, Critic and Researcher conditional,
Registrar administrative. The protocol layer **refuses** to store a
configuration that violates the branch split:

- Registrar as `primary` → refused, "administration does not attend teaching sessions"
- Instructor as `administrative` → refused, "faculty must not silently acquire record-keeping authority"
- a `conditional` position with no activation conditions → refused

## Remaining gaps

1. Signal detection is heuristic (regex). It proposes candidates only; it is
   deliberately not presented as understanding. A model-based detector would
   slot in behind the same `DetectedSignal` contract.
2. Consultation answers currently come from the consulted position's own run;
   multi-turn consultation exchanges are not yet modelled.
3. Attention policies are code-level defaults. Courses override composition and
   phases, but not yet the trigger table itself.
4. No live model is reachable here, so every faculty run degrades to
   `localTextReply`. The orchestration is proven; the prose is fallback.

---

# LAYER 4 — FACULTY CONFIGURATION, LIVE TIMETABLE, AUDIT

Layer 4 adds three subsystems and one architectural correction. Fifteen tables
were appended to `src/db/college.ts`; no existing College table was renamed or
restructured, and the 18 legacy tables were not touched.

## A. Faculty configuration

**Position vs member.** A POSITION is an institutional responsibility and is the
only thing that carries authority. A MEMBER is a configured persona occupying a
position. Personality is expressive; it is never permissive.

`POSITION_AUTHORITY_CEILING` bounds what each position may ever be granted.
`resolveAuthority` computes `requested ∩ ceiling − protected` and returns an
explicit `refused[]` with reasons, which the Builder surfaces. Three authorities
are architecturally protected and cannot be granted to anyone:
`decide_curriculum`, `alter_history`, `formal_assessment`.

`detectAuthorityClaims` additionally scans personality text for five classes of
claim (final-decision, suppression-of-uncertainty, curriculum, history,
assessment). These are warnings, not silent edits — the text is preserved, the
claim simply has no effect.

**Mandatory ≠ speaking.** `mandatoryLevel` is one of college_wide, course,
session_type, phase, conditional, optional. It states that a responsibility
cannot be omitted, not that the member talks. `validateRoster` runs before a
session opens; an uninstantiable mandatory position yields
`SESSION CANNOT FULLY INITIALISE` with per-member `block` or `warn` severity.
No unrelated member is ever substituted.

**Versioning.** Every edit snapshots the prior configuration into
`college_faculty_member_versions` and bumps `version`. Sessions record which
member occupied which position *and* which version applied, in
`college_session_faculty_members`. Verified: renaming a live member to
"The Patient Teacher (renamed) / Brisk / v4" left historical sessions correctly
reporting "The Patient Teacher / Direct / warmth 1 / v2".

Members are never deleted. `DELETE /api/college/members` returns 405 by design.

## B. Live timetable

**Template → version → slot → override → instance.** `SLOT` is a place in the
week, `ACTIVITY` is what occupies it, `SESSION` is what happened. A date-specific
override never mutates the recurring template — verified by cancelling Soul
Session on 2026-09-27 and confirming 2026-10-04 remained `scheduled`.

**Completion is never inferred.** `setInstanceStatus` rejects completed / missed /
deviated / in_progress without evidence: *"The clock passing the end time is not
evidence that something happened."* A slot whose end time has passed with no
evidence resolves to `unknown`, not `completed`.

**Overlaps are surfaced, not arbitrated.** The reference design genuinely
overlaps Garage Downtime (17:00–19:30) with Dinner (18:30–19:30), consistent with
its own Core Rule #1, *"Follow the periods, not the clock."* `livePosition`
returns `concurrent[]` plus an explanatory note rather than picking a winner.

**Import, don't invent.** `importReferenceTimetable()` creates a new version with
11 periods, 7 day themes and 77 slots. Five genuinely ambiguous values are
flagged `needsConfiguration` with a note instead of being guessed: the
Garage/Dinner overlap, the 12:00–12:20 gap, Sleep's missing end time, Wednesday
DoorDash sitting outside its band, and unprinted AM/PM.

Ten activity types (academic, creative, administrative, health, relationship,
household, adventure, recovery, entertainment, routine) keep life from being
recast as coursework. `detectTimetableConflicts` reports
`slot_without_active_course` / `active_course_without_slot` / `needs_configuration`
and never auto-repairs.

## C. Audit

An audit answers what happened, how consistently, against what intent, on what
evidence — it never opens with "how can we improve this?".

**Separate dimensions, never one score.** Slots are evaluated on attendance,
consistency, goal alignment, friction and sustainability; courses on exposure,
completion, learning evidence and continuity.

**Evidence before recommendation.** Defaults are 4 observations across 3 weeks,
3 deviations before review, 28-day reopen interval — all configurable per scope,
because Arena must not assume what counts as meaningful. Below threshold the
output is literally *"INSUFFICIENT EVIDENCE. No change indicated. Let it run."*
`POST` refuses `propose_change` outright on insufficient evidence.

**NO CHANGE REQUIRED is a real outcome.** A `keep_as_is` decision sets
`reopenAfter` and returns *"This question will not be reopened before <date>."*
Verified: a slot at 5-of-6 completion with one medical absence returned
*"NO CHANGE INDICATED. No meaningful problem identified."*

**No manufactured winners.** `comparePeriods` refuses to present two periods as a
clean experiment when they differ in structure, intent, context, observation
count, evidence sufficiency or length. Verified: comparing a 4-observation period
against a 2-observation one returns `comparable: false` with both reasons stated.
Differences are always phrased as description, never causation.

Deviations matching appointment/work/travel/household/availability are classified
as **explained**, setting friction to `not_applicable` — real-world interruption
is not schedule failure.

## D. Session integration

`/api/college/class` now validates the roster before opening, records serving
members with pinned versions, and compiles personality as a separate block
appended *after* institutional rules so the institution always outranks the
persona.

One pre-existing defect was fixed here: the Instructor ran in the teaching phase
and again in the coordination window, producing two student-facing answers. The
Instructor now holds its response until coordination completes. Layer 3
regression re-verified — exactly one visible response in every case, with
Observer/Critic/Researcher still working internally.

## Layer 4 gaps

1. Attention policies remain code-level defaults; the per-member attention
   vocabulary (watch for / activate on / stay silent on / consult on / escalate
   on / defer on) is stored but not yet enforced by the orchestrator.
2. Faculty memory (`college_faculty_memory`) has schema and promotion gating but
   no UI.
3. Coordination configuration per member is stored but the orchestrator still
   uses protocol-level coordination.
4. Notification suppression is not implemented.
5. No live model is reachable in this sandbox; all faculty output shown during
   verification came from the `local:text` fallback and must not be read as real
   model behaviour.

---

# LAYER 5 — RUNTIME INTEGRATION

Layer 4 made the College configurable. Layer 5 makes the configuration
**govern**. The gap it closes was real and specific: a founder could configure a
faculty member in the Builder, and the runtime would quietly ignore it and use a
hardcoded policy instead.

Five tables were added (56 `pgTable` total; 55 College + 18 legacy untouched).

## A. Configuration is now authoritative

`src/lib/college/attention-resolver.ts` replaces the old
`getAttentionPolicy(positionKey)` lookup. It composes an **effective policy**
from the configuration layers and records which layer supplied each field.

Precedence: `session` → `course` → `position` → `member` → `institutional_default`.

Note that `position` sits ABOVE `member` deliberately. A member may **narrow**
what it does — fewer triggers, lower interruption authority, a smaller
consultation network — but may never widen beyond the position's ceiling.
Authority flows from the position; preference flows from the member. Attempts to
widen are recorded in the provenance with the reason they were refused.

A value counts as configured only when genuinely set. An empty list means "not
configured" and the next layer legitimately applies — an empty configuration is
never read as an instruction to do nothing.

Every routing decision is written to `college_attention_decisions` with
`decided_by`, so the founder can always answer "why did the Critic stay quiet?".

**Proof:** with the Critic configured to `activatesOnEvents: [contradiction_detected]`,
a contradiction produced `attentive / activate / by=member`. Changing only the
configuration to `[misconception_detected]` and sending the *identical* input
produced `dormant / ignore`, with the reason
`"contradiction_detected" is outside The Devil's Advocate's configured attention.`

## B. Attention is a runtime state

Seven states: dormant, watching, attentive, consulting, speaking, deferred,
escalated. `watching` is a real, common, successful outcome — a mandatory
Observer may watch an entire class without speaking once.

Evaluation order is deliberate: stop-attending → defer → escalate → activate →
silence → watch → dormant. Deferral is treated as **successful coordination**,
not failure.

Speaking order is resolved by role, never by which model call returned first.
The Instructor is ranked last so it speaks to the student after the internal
positions have fed in.

## C. The College Event Ledger

`college_event_ledger` is the connective tissue between the timetable, the
session, real-world context and the audit. Without it the audit had to
reconstruct history by joining scattered tables and inferring order.

Two rules keep it honest: it records **observations, never interpretations**
("class shortened" belongs here; "Thursday is inefficient" does not), and it is
**append-only**. A ledger write failure never propagates into a class — a
dropped observation is bad, a crashed lesson is worse.

The audit now reads ledger events for contextual factors, and `comparePeriods`
uses the ledger to detect whether the curriculum version, timetable version,
faculty configuration or deviation count differed between two periods.

## D. Notifications are quiet by default

Derived from ledger events, never emitted directly. The default posture is
silence: a single missed class has `occurrences: 99, notify: false` — it is
recorded and never surfaced. Only `unexplained_deviation` (3 occurrences),
`mandatory_faculty_missing` and `institutional_conflict` surface at all, and
suppression is honoured against `suppressedUntil`.

## E. Faculty memory

Four kinds of knowledge stay separate: SOURCE MATERIAL, INSTITUTIONAL MEMORY,
SESSION RECORD and FACULTY MEMORY.

Writing faculty memory is cheap; leaving it is not. **Two independent gates**
apply, and conflating them was a real bug caught during testing: the existing
`canPromote` governs climbing the institutional ladder
(observation → interpretation → hypothesis → established) and permits a single
observation. That is the wrong question for *crossing into* institutional memory
at all. `FACULTY_MEMORY_CROSSING_THRESHOLD = 2` now guards the boundary
separately — one teacher noticing one thing once is precisely what must not
become institutional truth. Past the crossing, entries land at the bottom rung
and climb under the usual rules.

Recalled memory is always rendered labelled:
`[FACULTY MEMORY | source: … | confidence: seen twice]`, with an explicit
instruction that it is a hint about what to try, never evidence about what is
true. Members may be configured with `memoryEnabled: false` or a scope limit; a
memory claiming wider scope than its member permits is refused.

## F. Institutional decisions

`POST /api/college/decisions` settles a conflict without erasing it. The
long-standing Week 1 vs Week 11 disagreement is now decidable: adopting the
calendar records `statement: "Week 11"` and `notChosen: "institutional_state: Week 1"`,
while `college_reconciliations` still reports both original claims verbatim.
`leave_unresolved` is offered as a legitimate choice.

## G. Curriculum editor completed

Added `set_course_status` (archive/reactivate), `reorder` and `adopt_version`.

A second real bug surfaced here: `getCurrentCurriculum()` returns curriculum
*membership* and ignores course `status`, so an archived course still counted as
active and its orphaned timetable slot went unreported. Both call sites now
filter on status. Verified end to end: archiving PSY110 surfaced
`slot_without_active_course` for the Tuesday Digital Lab slot, reactivating
cleared it, and the slot itself was never modified.

## H. Tests

`scripts/college-layer5-tests.mjs` — 20 end-to-end assertions against the real
HTTP API and database, one per numbered requirement. **20/20 passing**, and
idempotent across repeated runs (test 9 generates a unique probe each run so
accumulated observations cannot silently satisfy the gate under test).

## Layer 5 gaps

1. Coordination still runs through the protocol-level window; per-member
   coordination configuration is resolved and recorded but the consultation
   sequence itself is not yet member-driven.
2. `buildContextPacket` §13 narrowing is improved by attention resolution but
   still sends a broadly-scoped packet rather than a per-member minimal one.
3. Signal detection remains regex-based (`epistemicStatus: "signal"`).
4. No live model is reachable in this sandbox; all faculty output during
   verification came from the `local:text` fallback.

---

# LAYER 6 — THE CLASS RUNTIME

Layers 1–5 built the organs. Layer 6 makes them operate as one organism:

```
MEMORY → ATTENTION → COORDINATION → TEACHING → RECORD → AUDIT
```

Nothing was redesigned and nothing working was replaced. `/api/college/class`
still runs the Layer 2–5 loop unchanged; the member-driven runtime is a second
entry point at `/api/college/class-runtime`, so any regression stays
attributable.

## THREE RIVERS — the distinction that governs everything else

The system now holds three different kinds of memory, and conflating them is
how an institution loses control of its own knowledge:

| | what it is | threshold |
|---|---|---|
| **Event Ledger** | what happened | none — record generously |
| **Faculty Memory** | what one member learned from what happened | member's own judgement |
| **Institutional Memory** | what the College has established | corroboration, then the ladder |

Two chains run from events, and they are deliberately not the same chain:

```
Event → Observation → Faculty Memory → Corroboration → Institutional Memory
Event → Audit → Interpretation → Governance Decision
```

They meet only at the founder. Nothing crosses from the first river to the
second automatically.

## A. The resolution chain (§1 §2)

`preflightClass()` resolves clock → slot → curriculum → course version →
objective → faculty → member versions → attention → memory → real-world
context, and reports each subsystem as a **diagnostic state** — valid,
degraded, unavailable — never a score. "Class health: 7/10" would say nothing
about which organ is failing.

Preflight is a GET with no side effects. Checking whether a class can start
must never start one.

A blocking problem returns 409 with the problems named and **nothing created
and nothing substituted**. Proving this is test 27: a class requested against
a non-existent course blocks, names the problem, and creates no session row.

## B. Coordination is a graph, not a hardcoded sequence (§8–§12)

`buildCoordinationGraph()` resolves who may talk to whom from member
configuration. Edges exist or they do not; no runtime shortcut may invent one.

Building it surfaced two modelling errors that had been latent since Layer 3:

1. **Deferring to the founder is not a broken edge.** `founder` and
   `institutional authority` are not faculty positions, so the graph was
   refusing the single most important thing a member can do with a question
   that is not theirs. They are now **escalations** that leave the class and
   become governance items.

2. **The administration boundary only held in one direction.** The Registrar
   could not be consulted, but nothing stopped the Registrar from consulting
   or interrupting *into* a class. Administration must not silently become
   teaching faculty; the boundary is now enforced on both the source and the
   target of every edge. The Registrar may still **defer** — routing a
   teaching question back to the Instructor is exactly right.

## C. Per-member bounded context (§3–§5 §17 §18)

`buildMemberContext()` wraps the position packet rather than replacing it, so
the institutional charter and epistemic labelling survive. It adds faculty
memory retrieved **narrowly** (limit 4, not 50), each entry carrying a
`retrievedBecause` so "why did the Instructor remember this?" is answerable
without reading source code.

Verified distinct in test 5: observer 2 scopes in / 10 withheld; critic 5/7;
researcher 4/8; instructor 5/7. Different members genuinely receive different
slices of reality.

## D. The output contract (§32 §33 §34)

Faculty do not reply; they return a proposal —
`ACTION · CONTENT · TARGET · REASON · CONFIDENCE · EVIDENCE` — and the runtime
decides whether it is permitted. An action the member may not take is
**downgraded to observation with the content preserved**, because the thinking
may matter even when the act does not.

Parsing is defensive. A model that ignores the format produces a valid
observation, not an error.

## E. Attention is not speech (§7 §14)

Most members watch. Silence is recorded as a successful outcome and never
padded into dialogue to demonstrate that an agent ran. One class, one
student-facing voice — the Instructor — with everything else internal,
recorded and inspectable.

## F. Inspector and replay (§35 §36)

`/college/inspector` reconstructs a session from its immutable references:
the curriculum version it was pinned to, the member versions that served, the
memory that existed, the attention decisions with their `decidedBy`, the
ledger in order.

**Replay is not re-execution.** Nothing re-runs a class. Where the College has
changed since, the divergence is reported rather than hidden — a course
renamed after the fact shows both names.

## G. Governance queue (§31) and the audit boundary (§29)

One derived queue, phrased identically:
`WHAT · WHY · EVIDENCE · SOURCE · IMPACT · AUTHORITY REQUIRED`.

Derived, not stored — every item already exists somewhere, and a second copy
would drift. Audit signals are marked **informational**: a request to look,
never a request to act. An empty queue says **NO CHANGE INDICATED**.

## H. Defects this layer found in itself

Three were caught by running the runtime and reading its own records:

1. **Fallback output was becoming faculty memory.** The offline engine's
   boilerplate was being stored as observations — and because memory
   accumulates toward a corroboration threshold, repeated fallback runs could
   have carried that text across the crossing gate into institutional truth.
   Fallback executions are now refused memory explicitly. Five polluted rows
   were purged.

2. **Duplicate `memory_recorded` ledger entries**, because
   `facultyMemory.remember()` already writes one. The second would have
   inflated any audit that counts events.

3. **The student-facing response was missing from the ledger** — the one act
   of the class the student actually experiences.

## I. Tests

`scripts/college-layer6-tests.mjs` — 28 assertions, one per §39 requirement,
against the real HTTP API and database. **28/28 passing**, idempotent across
three consecutive runs. Layer 5's 20 still pass: **48 assertions total**.

Four initially failed and all four were the *test's* wrong assumptions, not the
system's behaviour — authority refusals arrive in `warnings`, the audit takes
`scopeType`/`scopeId`, overrides belong to `/timetable-live` and need a date
on the slot's own weekday. The system was right each time.

## J. Consultation is a consequence of authority, not a hardcoded pair

The first version of this layer could only consult when a member's attention
explicitly resolved to `consult` — and `evaluateAttention` never returns that,
so consultation was provable only as graph edges. Structure without behaviour.

The rule is now derived. The runtime asks what authority an event calls for
(`EVENT_NEEDS_AUTHORITY`), checks whether the activated member holds it, and
if not, looks for a permitted consultee **that actually does**. Consulting
someone equally unequipped would be coordination theatre.

The old coordination window already sent factual uncertainty to the Researcher
— the right outcome for the wrong reason, because the pair was fixed in
TypeScript. Now the same hop happens *because* the Instructor lacks `research`
authority and is configured to consult the Researcher, and it stops happening
the moment either fact changes:

| student turn | authority required | instructor holds it? | outcome |
|---|---|---|---|
| "is it true habits form in 21 days?" | `research` | no | **consults the Researcher** |
| "memory works like a video recording" | `critique` | yes | **answers for itself** |

Finding this also exposed a real defect: the runtime kept only each member's
highest-ranked outcome across all events, which discarded *which* event had
triggered it. A member activating on three events, only one of which exceeds
its authority, lost precisely the fact consultation depends on. Engaged events
are now tracked per member.

## Layer 6 gaps

1. Class phases (§15 §16) use the existing phase plan; per-member phase
   participation is resolved but not yet configurable in the Builder.
2. Interruption is modelled and authority-checked, but no member currently
   escalates during a normal class, so acceptance is proven structurally.
3. **No live model is reachable in this sandbox.** Every faculty utterance in
   verification came from `local:text`. Routing, authority, memory,
   coordination and state are proven; language quality is not tested and must
   not be inferred.
