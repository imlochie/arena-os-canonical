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

## K. Ledger vocabulary completed (§22)

Seven event types the specification names had no representation, so the
runtime was quietly flattening distinctions that matter:

| added | why it is not a synonym of something else |
|---|---|
| `faculty_interruption_requested` | asking is a fact independent of the answer |
| `faculty_interruption_accepted` / `_rejected` | a refusal is the thing an authority model must be able to show |
| `faculty_silent` | session-level "attended, never spoke" — `faculty_watching` is per-event |
| `memory_recalled` | retrieval is an event; §18 requires it be explainable later |
| `real_world_context_added` | context is not an interruption |
| `record_proposed` / `record_filed` | proposing and filing are different institutional acts |

Interruptions previously wrote `faculty_watching` when refused, which made
every refusal indistinguishable from ordinary attendance — the ledger could
not answer "who asked to interrupt and was told no?". Recall now carries
source, confidence, observation count, retrieval reason and evidence state,
so the memory behind an utterance is recoverable without re-deriving it:

```
memory_recalled  The Patient Teacher was handed 1 faculty memory item(s)
                 as a hint, not as institutional fact.
   source: accumulated observation
   because: Recorded once in this course; included because little else…
   evidence: single faculty observation — not corroborated, not institutional
```

## L. The nine phases (§15 §16) — added without renaming any of them

PREPARATION, OPEN, COORDINATION and CLOSURE had no representation. They are
now defined, bringing the vocabulary to eleven phase keys.

**Existing keys were not renamed.** `inquiry`, `challenge` and
`institutional_record` are already written into stored attention rows and
protocol configuration; renaming them to match the specification's wording
would silently invalidate history to win a vocabulary argument. The mapping is
recorded in the source instead: PRACTICE/ACTIVITY is `practice`, COORDINATION
is `coordination` plus the existing coordination window, POST-CLASS is
`institutional_record`.

PREPARATION is deliberately empty of primary positions — the runtime resolves
slot, curriculum, faculty and memory before anyone speaks, and §16 says not
every class uses every phase. `defaultPrimary` and `defaultWatching` remain
defaults a member's configuration overrides, not a fixed running order.

Verified: the new phases accept transitions, an unknown phase is still
rejected against all eleven, and administration stays out of teaching phases —
entering `coordination` leaves the Registrar `dormant`, because the
"Administration is never activated by a teaching phase" rule in `enterPhase`
applies to the new keys exactly as it did to the old ones.

## M. Failure states and the model boundary (§34 §37)

Two gaps closed by auditing the runtime against its own specification rather
than against the tests, which were passing throughout.

**A provider name was hardcoded in the class runtime.** `executeClass` called
`generate({ modelId: "openai" })`. §34 requires execution to stay behind the
AI abstraction with no provider named by the runtime; which engine serves the
College is an institutional configuration decision, not a fact about teaching.
It now reads `COLLEGE_MODEL_ID` and falls back to a named default constant.

**Two of the four required failure states did not exist.** The runtime now
reports six:

| state | condition |
|---|---|
| `CONTEXT CONSTRUCTION FAILURE` | a member's packet could not be built |
| `FACULTY EXECUTION FAILURE` | the member ran and failed |
| `MEMORY RETRIEVAL FAILURE` / `MEMORY WRITE FAILURE` | memory unavailable in either direction |
| `COORDINATION FAILURE` | **new** — a serving member has no node in the graph, so it cannot consult, defer or escalate |
| `MANDATORY FACULTY FAILURE` | **new** — a mandatory responsibility was not carried |

`MANDATORY FACULTY FAILURE` had to be written carefully, because mandatory
does **not** mean always speaking:

| mandatory Observer | outcome |
|---|---|
| executed | no failure |
| recorded as attending in silence | no failure — silence is a valid outcome |
| neither | **FAILURE** — the responsibility went missing and no substitute was appointed |

The isolated-member case matters for the same reason: without naming it,
silence caused by having no coordination edges is indistinguishable from
silence by choice.

## Layer 6 gaps

1. Interruption is modelled, authority-checked and now fully recorded
   (requested / accepted / rejected), but no member escalates during a normal
   class with the current configuration, so acceptance is proven structurally
   rather than by a live interruption.
2. Per-member phase participation is resolved from configuration but is not
   yet editable in the Faculty Builder UI.
3. **No live model is reachable in this sandbox.** Every faculty utterance in
   verification came from `local:text`. Routing, authority, memory,
   coordination and state are proven; language quality is not tested and must
   not be inferred.

---

# LAYER 7 — CAMPUS BRIEFING / ARRIVAL RUNTIME

Layer 6 taught the College to track what it knows. Layer 7 asks a different
question: **how long has it been, and what does that mean?**

The briefing sits **above** the runtime, not inside it:

```
COLLEGE STATE → TEMPORAL STATE → CAMPUS BRIEFING → BEGIN CLASS
                                                       ↓
                                                CLASS PREFLIGHT
                                                       ↓
                              MEMORY → ATTENTION → COORDINATION
                                                       ↓
                                                    TEACHING
                                                       ↓
                                               RECORD → AUDIT
```

## Why the old briefing failed

It asked *"generate me an interesting daily summary."* That is a prose task,
and a prose task will always produce prose — including on days when nothing
happened. This one asks:

> Resolve my current institutional state at this exact point in time,
> determine what has changed since I was last here, determine whether that
> changes today's operating context, and present the result before handing me
> into the appropriate class runtime.

## A. Time is operational context, not presentation metadata

`resolveTemporalState()` measures, deterministically and from the application
clock in Australia/Brisbane:

```
CURRENT TIME → TIME SINCE LAST COLLEGE SESSION → TIME SINCE LAST EXTERNAL
ACADEMIC EVENT → TIME SINCE GOAL START → TIME REMAINING TO DEADLINE →
TIME SINCE LAST REVIEW → TIME SINCE LAST MEANINGFUL PROGRESS →
CURRENT TIMETABLE POSITION → CURRENT CONTINUITY STATE
```

Every interval is an `Interval`, and `known: false` is a first-class outcome.
*"No College session has ever been observed"* must never render as `0 days
ago`, which would read as "just now" — an invented elapsed time is worse than
an admitted gap, because every downstream decision inherits the fiction. Each
interval also carries the **evidence** it was measured from, so no number in
the briefing is unattributable.

**Meaningful progress is evidenced, not felt.** The temptation is to score
engagement; that is exactly the psychological profiling the College refuses.
Instead there is a fixed, inspectable list of ledger events that constitute
demonstrated movement. Opening a page is not progress. Attendance is
participation, and it is measured separately.

## B. The briefing changes behaviour with elapsed time

| continuity | threshold | behaviour |
|---|---|---|
| `no_history` | nothing recorded | say so; do not invent a past |
| `normal` | ≤ 3 days | quick orientation |
| `short_absence` | < 8 days | mention what changed |
| `extended_absence` | < 22 days | reconstruct continuity |
| `long_absence` | ≥ 22 days | re-entry briefing |

Thresholds are exported constants, not magic numbers buried in a conditional —
a student told "you have been away a long time" is entitled to know what the
College counts as long.

Verified against the same data at four arrival times: 1 day → quick
orientation, 5 days → what changed, 15 days → reconstruct continuity, 30 days
→ re-entry, whose directive explicitly restrains the briefing: *"The student is
returning, not continuing. Establish where the College is before proposing
anything. Do not open with obligations or a backlog."*

**`?at=` is replay for arrival.** Like Layer 6's session replay it re-asks the
question against a different clock and changes nothing, so "what would you say
if I disappeared for three weeks?" is answerable before it happens.

The clock is threaded all the way down — `liveCollegeState(at)` and
`livePosition(date, at)` both accept it — so a simulated arrival moves the
timetable position too. Without that, the briefing would report a three-week
absence beside today's real timetable and quietly contradict itself:

| simulated arrival | resolves to |
|---|---|
| Monday 2026-10-05 09:00 | no active class (before the first slot) |
| Monday 2026-10-05 10:30 | Launch Sequence, next Bedroom reset |
| Monday 2026-10-05 14:30 | LOCO PRØD, next Gym / Movement |

## C. Material change versus routine activity

A class running is **activity**. A curriculum changing is **material**. Without
that line every briefing becomes noise, and "nothing changed" becomes
unsayable. `MATERIAL_EVENTS` is a small explicit set; attendance, recall and
watching are deliberately excluded.

This is what lets the briefing honestly say *"Nothing material changed while
you were away. Ordinary activity may have continued; none of it altered the
institution."*

## D. The external academic world

The College does not replace TAFE. It needs to know what the provider
requires, where the student is in it, and what has happened since — so today's
session can fit around that reality.

Four rules hold `collegeExternalCommitments` in place:

1. **The provider is the authority.** Arena records what it was told. It never
   computes external progress and never marks an external unit complete.
2. **Reported is not verified.** Every commitment carries an evidence level,
   and a `reported` one says so in its own condition text.
3. **External pressure is context, not command.** A TAFE deadline may change
   what today's session should attempt. It must never rewrite the timetable —
   the Layer 4 rule that "student unavailable" never becomes a permanent
   timetable change applies here verbatim.
4. **Silence is not absence.** With nothing recorded the College says it knows
   nothing about TAFE, rather than inferring that nothing is happening.

A commitment with no date **never becomes urgent**, and recording one with no
`sourceNote` is refused outright: *"An external fact with no stated source
becomes indistinguishable from an assumption."*

## E. What the briefing may not do

- **It never generates.** Neither `campus-briefing.ts` nor `temporal-state.ts`
  imports the AI abstraction — asserted structurally in test 12. A briefing
  that can call a model can hallucinate an institution.
- **It never mutates.** Three briefings in a row leave ledger, sessions and
  memory byte-identical. Arriving is not an institutional act.
- **It never begins a class.** There is no POST; the route returns 405.
  Beginning a class stays an explicit, separate call into Layer 6's preflight,
  where it is validated.

## F. Tests

`scripts/college-layer7-tests.mjs` — 20 assertions, **20/20 passing** and
idempotent. Layer 6 still 28/28. Total across Layers 5–7: **68 assertions**.

## G. Goal pressure, in both directions

A goal's `timeframe` is only a deadline when it names a date. `semester`,
`long_term` and `open` are durations or intentions, and converting them into
deadlines would manufacture pressure the founder never set.

| goal | timeframe | pressure | reported as |
|---|---|---|---|
| Complete PSY110 Semester I | `2026-10-02` | **yes** | "Dated target in 7 days. Temporal pressure is real and stated." |
| Build a sustainable daily rhythm | `long_term` | no | "Never formally reviewed. Not a problem in itself — stated so it is visible." |
| Complete PSY110 (arriving 2026-10-10) | `2026-10-02` | — | "Dated target passed 8 day(s) ago. **The goal is still open; the date is not.**" |

That last line is the one that matters. A passed deadline is reported as a
passed date, not as a failed goal — the College does not get to decide that an
objective died because a number went by.

## Layer 7 gaps

1. External commitments are recorded manually. There is no provider
   integration, and there should not be one until the founder asks: the
   College would then be asserting facts it cannot verify.
3. External commitments carry no recurrence. A weekly TAFE class has to be
   recorded as one commitment, not as a repeating slot — deliberate for now,
   since the recurring-timetable machinery belongs to the College's own
   activities and should not silently absorb another institution's schedule.

---

# LAYER 8 — COMMITMENTS AND BOUNDED ACCOUNTABILITY

Layer 7 gave the College a sense of time. Layer 8 gives it the ability to say
*"you said you would do this"* — and, just as importantly, the discipline to
stop there.

The governing sentence for the whole layer:

> The College should hold you accountable to commitments you have actually
> made, while remaining capable of recognising when circumstances changed.

## §A. Four things that must never merge

| Concept | Question it answers | Where it lives |
|---|---|---|
| GOAL | What are we trying to accomplish? | `college_goals` |
| PLAN | How did we intend to get there? | curriculum, timetable |
| COMMITMENT | What did I explicitly agree to do? | `college_commitments` |
| ACCOUNTABILITY | Did reality match, and what should we understand? | `accountability.ts` (derived) |

Accountability is the only one of the four that is **computed, never stored**.
`accountabilityState(now)` reads commitments and returns a view. There is no
"accountability record" to drift out of date, and nothing to migrate when the
wording changes.

## §B. What the College may and may not say

Permitted: *"You said you would do X. You haven't done X."* · *"Here's how we
know."* · *"Here's how much time has passed."*

Forbidden: *"Therefore you are failing."*

A miss has several possible causes — `forgot`, `chose_not_to`, `circumstance`,
`unclear_task`, `no_reason_given` — and the College cannot distinguish them by
observation. So it does not try. It records the fact, records the reason **if
one was given**, and leaves the interpretation to the person who has it.

The hardest-won rule in this layer: **an overdue commitment is never
auto-marked missed.** The clock proves that a date passed; it does not prove
what happened. An overdue commitment stays `open` and is described as *"Due N
day(s) ago with nothing recorded. The College does not assume why."* This is
the same principle as §L6's refusal to infer session completion from time.

## §C. Patterns

A single miss is noise. `patternThreshold` (default 3) misses of the *same*
statement within `patternWindowDays` (default 14) is a pattern, and patterns
are the one thing the College will actively raise:

> "90 minutes toward Assessment 01" — 3 times in 14 days.
> Stated: TAFE orientation ran long
> The College is not changing the objective. The pattern is recorded so today's
> class can address the gap directly, and so the founder can decide whether the
> commitment itself was the wrong shape.

Note what it does **not** do. It does not lower the target, reschedule
anything, or conclude the student is incapable. Moving a goal because it was
missed is an institutional decision, and this layer has no authority to make
one. **Never move the goal to flatter the numbers.**

## §D. Intensity is wording, not authority

`gentle | direct | firm` changes phrasing only:

| intensity | the same overdue commitment |
|---|---|
| gentle | "Draft assessment outline" hasn't happened yet — it was due yesterday. |
| direct | You committed to "Draft assessment outline" yesterday. It hasn't happened. |
| firm | "Draft assessment outline" was committed to yesterday and has not been done. |

Facts are byte-identical across all three (asserted by test 8). A "drill
sergeant" faculty personality can sound as hard as it likes and still cannot
invent an obligation or impose a consequence — **authority comes from the
commitment and governance systems, never from personality.**

## §E. Only the student commits

`origin` is `student` or `college_proposed`. A College proposal is created
`accepted: false` and is **inert** — it does not appear in counts, cannot be
missed, and creates no obligation until `PATCH action:"accept"`. This is
AI PROPOSAL ≠ INSTITUTIONAL DECISION applied to the student's own intentions.

## §F. Review closes the loop

An overdue commitment that is reviewed — with a **required** `agreedResponse` —
becomes `settled` and stops resurfacing until `reviewAfter`. *"Leave it exactly
as it is"* is a legitimate response, but it has to be said. This is the
commitment-level equivalent of §19's "NO CHANGE REQUIRED", and it is what stops
the briefing reopening the same wound every morning.

## §G. INTENDED → ATTEMPTED → ACTUAL

`plannedMinutes` and `actualMinutes` are both retained, and `partial` is a
first-class outcome. Over time this is what will separate *"I can't study
consistently"* from *"my sessions are too long"* from *"I work better after
TAFE"* from *"this keeps getting deferred because the task isn't understood."*
The closure half is wired at the API (`action:"close"`); binding it to the end
of a class run is deliberately left for after the UI has been lived with.

## §H. The Campus UI

`/college/campus` is the place accountability speaks, and the rule governing it
is that **not every day needs every section**. Each block is gated on having
something real to say:

| Section | Appears when |
|---|---|
| CURRENT POSITION | always — it is the answer to "where am I?" |
| SINCE YOU WERE LAST HERE | material events exist, or you have been away |
| ACCOUNTABILITY | at least one commitment has been made |
| ACADEMIC CONTEXT | external (TAFE) commitments are known |
| WORTH KNOWING | something needs a decision, or a condition is live |
| GOALS | a goal exists |
| TODAY + BEGIN CLASS | always — it is the exit into the runtime |

A College with nothing to report renders one line: *"No significant changes
since your last session."* Epistemic footnotes (`temporal.unmeasured`) are
deliberately **not** promoted into WORTH KNOWING — "no external event has ever
been recorded" is true, and inspectable, but it is not news.

The page is a phone surface first: single column, 42–48px tap targets,
`env(safe-area-inset-*)` padding, and a `viewportFit: cover` viewport. The
manifest gains Campus and Today shortcuts. **There is no second mobile
backend** — the phone and the desktop read the same `/api/college/briefing`
over the same database. Desktop remains the Control Room (curriculum, faculty,
governance, audit); the phone is the Campus.

## §I. The briefing is still not a source of truth

Unchanged and load-bearing:

```
Source → Institutional Decision → Operational State → Reality →
Temporal State → Interpretation → BRIEFING → Runtime
```

Layer 8 adds commitments to Operational State and accountability to
Interpretation. The briefing gained a section, not a privilege: test 18 asserts
that two full briefing renders leave the commitment and ledger tables
byte-identical.

## §J. Ledger correction

`external_academic_event` had been written by `/api/college/external` since
Layer 7 while never appearing in `LEDGER_EVENTS`. `record()` accepted the
string and wrote it silently. An event the vocabulary cannot name cannot be
filtered, audited, or reasoned about — so it is now declared.
**`LEDGER_EVENTS` is 32 types.**

## §K. Deliberately not built

- Automatic commitment creation from timetable slots. A scheduled class is not
  a promise; conflating them would manufacture obligations nobody made.
- Notifications. The phrasing is designed (*"your planned session ended 20
  minutes ago, but no completion was recorded"*) but nothing is delivered yet.
- Streaks as a visible number. `rhythmDelta` exists because "4 sessions behind
  the plan you set" is a fact; it is never rendered as a score, and there is no
  gamification anywhere in this layer.

## §L. Campus Arrival, not Daily Briefing

The name matters because the usage pattern changed. You may enter Arena at 7am,
after TAFE, before an evening class, from a phone somewhere else entirely, or
after a week away. The system is not briefing you about *the day*. It is
briefing you about **where the College is at the moment you arrive**. The
section formerly headed TODAY is now RIGHT NOW, for the same reason.

## §M. SLOT ≠ CLASS (correction found while living with the UI)

The first Campus build offered a blue BEGIN CLASS button whenever the timetable
had any position open. On a Sunday afternoon that meant the College inviting
the student into a "class" during **Time with Kirra**.

The timetable is 77 slots. Exactly **2** are academic. The other 75 are
recovery, routine, health, relationship, entertainment, administrative,
household, adventure and creative time — scheduled life the College observes
and deliberately stays out of.

`next.classAvailable` is now true only for genuinely academic positions.
`next.lifeActivity` marks scheduled life, and the handoff reads:

> "Time with Kirra" is scheduled now. That is not College time — nothing is
> being asked of you here.

The way in is still available — the button reads *"Open the College anyway"* —
but it is quiet, grey, and it is not called a class. **An institution that
schedules your recovery time is not entitled to bill it as study.** This is the
same SLOT / ACTIVITY / SESSION separation as §L5, surfacing at the UI layer
where it is far easier to violate by accident.

Silence is information. So is declining to ask for something.

`scripts/college-layer8-tests.mjs` — 22 assertions, self-cleaning.
