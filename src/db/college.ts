// ============================================================================
// Lochie Life College — institutional runtime schema (ADDITIVE)
// ============================================================================
// Every table here is prefixed `college_`. Nothing in the pre-existing Arena
// schema (models, battles, collabs, councils, projects, artifacts, memory,
// chats, arcade, privacy) is renamed, altered or dropped. The College links
// INTO those tables by nullable id columns rather than absorbing them.
//
// Design rules enforced by this schema:
//   1. Epistemic honesty. Rows that assert something carry a truth class and a
//      confidence, plus provenance. The institution may hold UNKNOWN and
//      CONFLICT as legitimate states.
//   2. Append-oriented history. Institutional records are never rewritten in
//      place; corrections supersede by pointing at what they replace.
//   3. Scheduled vs observed vs adjusted are separate facts, never collapsed.
//   4. Derived state is rebuildable and carries its inputs.
// ============================================================================

import { pgTable, text, integer, boolean, timestamp, uuid } from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Source registry — the canon layer (READ-ONLY by contract)
// ---------------------------------------------------------------------------
// Authoritative institutional documents live outside Arena (Notion). Arena
// references them; it does not own or mutate them. This table is a registry of
// pointers + authority level, so every derived claim can name its source.
export const collegeSources = pgTable("college_sources", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull(), // stable slug, e.g. "academic_calendar"
  title: text("title").notNull(),
  url: text("url").notNull().default(""),
  // governance | academic_standard | operational | draft | working | evidence
  authorityLevel: text("authority_level").notNull().default("operational"),
  // canonical | validated | draft | proposed | superseded | unverified
  canonicalStatus: text("canonical_status").notNull().default("unverified"),
  owner: text("owner").notNull().default(""), // e.g. Administration, Faculty
  notes: text("notes").notNull().default(""),
  observedAt: timestamp("observed_at").defaultNow(), // when Arena last read it
  createdAt: timestamp("created_at").defaultNow(),
});

// ---------------------------------------------------------------------------
// Institution — identity + declared position
// ---------------------------------------------------------------------------
// `declared*` fields record what the institution SAYS about itself (an
// assertion with a source). They are deliberately separate from anything the
// state engine derives from the calendar, so the two can disagree visibly.
export const collegeInstitution = pgTable("college_institution", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().default("Lochie Life College"),
  motto: text("motto").notNull().default("Become by Learning."),
  foundingQuote: text("founding_quote").notNull().default("That's Life."),
  timezone: text("timezone").notNull().default("Australia/Brisbane"),
  academicYear: integer("academic_year").notNull().default(2026),
  institutionalPhase: text("institutional_phase").notNull().default(""),
  // What the institution declares about its own position (assertion, not math)
  declaredTermKey: text("declared_term_key").notNull().default(""),
  declaredWeekIndex: integer("declared_week_index"),
  declaredWeekTheme: text("declared_week_theme").notNull().default(""),
  declaredStatusNote: text("declared_status_note").notNull().default(""),
  declaredSourceKey: text("declared_source_key").notNull().default(""),
  declaredObservedAt: timestamp("declared_observed_at"),
  facultyStatus: text("faculty_status").notNull().default("unknown"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// ---------------------------------------------------------------------------
// Academic calendar — terms and weeks
// ---------------------------------------------------------------------------
export const collegeTerms = pgTable("college_terms", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull(), // "semester-i-2026"
  name: text("name").notNull(), // "Semester I — 2026 (Foundations)"
  year: integer("year").notNull().default(2026),
  startMonday: text("start_monday").notNull(), // ISO date, Brisbane-local
  weekCount: integer("week_count").notNull().default(10),
  status: text("status").notNull().default("active"), // planned|active|closed
  sourceKey: text("source_key").notNull().default(""),
  createdAt: timestamp("created_at").defaultNow(),
});

export const collegeWeeks = pgTable("college_weeks", {
  id: uuid("id").primaryKey().defaultRandom(),
  termId: uuid("term_id").notNull(),
  weekIndex: integer("week_index").notNull(), // 1..n
  mondayDate: text("monday_date").notNull(), // ISO date, Brisbane-local
  theme: text("theme").notNull().default(""),
  // not_started | in_progress | delivered | missed | unknown
  status: text("status").notNull().default("not_started"),
  evidenceNote: text("evidence_note").notNull().default(""),
  sourceKey: text("source_key").notNull().default(""),
  createdAt: timestamp("created_at").defaultNow(),
});

// ---------------------------------------------------------------------------
// Schools, capabilities, courses
// ---------------------------------------------------------------------------
export const collegeSchools = pgTable("college_schools", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  // canon-derived | inferred | proposed
  derivation: text("derivation").notNull().default("proposed"),
  sourceKey: text("source_key").notNull().default(""),
  createdAt: timestamp("created_at").defaultNow(),
});

export const collegeCapabilities = pgTable("college_capabilities", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull(),
  name: text("name").notNull(),
  sourceKey: text("source_key").notNull().default(""),
  createdAt: timestamp("created_at").defaultNow(),
});

export const collegeCourses = pgTable("college_courses", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code").notNull(), // "PSY110"
  title: text("title").notNull(),
  schoolKey: text("school_key").notNull().default(""),
  level: integer("level").notNull().default(100),
  courseType: text("course_type").notNull().default("core"), // core|elective|experience
  // Catalogue policy distinguishes a blueprint from an APPROVED course.
  // blueprint | approved | delivering | closed | proposed
  status: text("status").notNull().default("blueprint"),
  primaryCapabilities: text("primary_capabilities").notNull().default("[]"), // JSON
  secondaryCapabilities: text("secondary_capabilities").notNull().default("[]"), // JSON
  summary: text("summary").notNull().default(""),
  // Optional bridge into the existing Work OS — link, never absorb.
  projectId: uuid("project_id"),
  sourceKey: text("source_key").notNull().default(""),
  notes: text("notes").notNull().default(""),
  createdAt: timestamp("created_at").defaultNow(),
});

// 10-week Semester Roadmap rows (objective per course per week).
export const collegeCourseWeeks = pgTable("college_course_weeks", {
  id: uuid("id").primaryKey().defaultRandom(),
  courseId: uuid("course_id").notNull(),
  weekIndex: integer("week_index").notNull(),
  objective: text("objective").notNull().default(""),
  questionOfWeek: text("question_of_week").notNull().default(""),
  status: text("status").notNull().default("planned"), // planned|delivered|skipped
  sourceKey: text("source_key").notNull().default(""),
  createdAt: timestamp("created_at").defaultNow(),
});

// ---------------------------------------------------------------------------
// Timetable — what SHOULD happen (scheduled intent)
// ---------------------------------------------------------------------------
export const collegeTimetableSlots = pgTable("college_timetable_slots", {
  id: uuid("id").primaryKey().defaultRandom(),
  termId: uuid("term_id"),
  dayOfWeek: integer("day_of_week").notNull(), // 1=Mon .. 7=Sun
  startTime: text("start_time").notNull().default(""), // "10:00" local, may be ""
  courseId: uuid("course_id"),
  label: text("label").notNull().default(""),
  sessionKind: text("session_kind").notNull().default("lesson"),
  schoolKey: text("school_key").notNull().default(""),
  // How strongly is this slot actually established?
  // known | inferred | expected | unknown | conflicting
  confidence: text("confidence").notNull().default("inferred"),
  sourceKey: text("source_key").notNull().default(""),
  notes: text("notes").notNull().default(""),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow(),
});

// ---------------------------------------------------------------------------
// Faculty — institutional positions, not chat personalities
// ---------------------------------------------------------------------------
export const collegeFaculty = pgTable("college_faculty", {
  id: uuid("id").primaryKey().defaultRandom(),
  positionKey: text("position_key").notNull(), // instructor|researcher|critic|registrar|...
  name: text("name").notNull(),
  // faculty = educational actor · administration = record-keeping function.
  // Administration does not teach; Faculty does not own historical records.
  branch: text("branch").notNull().default("faculty"),
  remit: text("remit").notNull().default(""),
  // What this position may and may not do (authority boundary, enforced in lib)
  authorityBoundary: text("authority_boundary").notNull().default(""),
  // May this position file institutional records without human approval?
  mayFileRecords: boolean("may_file_records").notNull().default(false),
  // Formative observation vs formal assessment are different authorities.
  // none | formative | formal — "formal" is reserved for institutional authority.
  assessmentAuthority: text("assessment_authority").notNull().default("none"),
  // Does this position attend teaching sessions at all?
  participatesInClass: boolean("participates_in_class").notNull().default(true),
  outputType: text("output_type").notNull().default("guidance"),
  // Reuse of the existing Workforce abstraction where a sensible mapping exists
  workforceRoleId: text("workforce_role_id").notNull().default(""),
  contextScope: text("context_scope").notNull().default("[]"), // JSON: bounded context keys
  derivation: text("derivation").notNull().default("proposed"), // canon-derived|inferred|proposed
  sourceKey: text("source_key").notNull().default(""),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow(),
});

// ---------------------------------------------------------------------------
// Sessions — the classroom runtime
// ---------------------------------------------------------------------------
// A College session is the institutional wrapper. Execution may be delegated to
// the existing cognitive-session / council machinery via the nullable links.
export const collegeSessions = pgTable("college_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  termId: uuid("term_id"),
  weekIndex: integer("week_index"),
  courseId: uuid("course_id"),
  slotId: uuid("slot_id"),
  title: text("title").notNull().default("Untitled session"),
  sessionKind: text("session_kind").notNull().default("lesson"),
  // SCHEDULED: what the timetable said
  scheduledDate: text("scheduled_date"), // ISO date
  scheduledTime: text("scheduled_time").notNull().default(""),
  // OBSERVED: what actually happened
  observedDate: text("observed_date"),
  // scheduled|orientation|context_check|lesson|practice|inquiry|understanding|
  // reflection|close|faculty_record|institutional_update|completed|
  // interrupted|missed|cancelled
  stage: text("stage").notNull().default("scheduled"),
  status: text("status").notNull().default("scheduled"), // scheduled|running|completed|interrupted|missed
  objective: text("objective").notNull().default(""),
  facultyPlan: text("faculty_plan").notNull().default("[]"), // JSON position keys
  // Curriculum context AS IT WAS when the session occurred. Historical
  // accuracy: later curriculum edits must never rewrite a past session.
  curriculumVersionId: uuid("curriculum_version_id"),
  courseSnapshotId: uuid("course_snapshot_id"),
  // Bridges into existing Arena runtime (nullable — never required)
  cognitiveSessionId: uuid("cognitive_session_id"),
  councilRunId: uuid("council_run_id"),
  projectId: uuid("project_id"),
  // Institutional authority: working material until explicitly filed
  filedAt: timestamp("filed_at"),
  filedRecordId: uuid("filed_record_id"),
  summary: text("summary").notNull().default(""),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Lifecycle transitions — the runtime trail (append-only).
export const collegeSessionEvents = pgTable("college_session_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id").notNull(),
  stage: text("stage").notNull(),
  note: text("note").notNull().default(""),
  actor: text("actor").notNull().default("system"), // system|student|faculty:<key>
  createdAt: timestamp("created_at").defaultNow(),
});

// Faculty participation in a session. Composition is contextual, and
// disagreement between positions is preserved rather than synthesised away.
export const collegeSessionFaculty = pgTable("college_session_faculty", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id").notNull(),
  facultyId: uuid("faculty_id"),
  positionKey: text("position_key").notNull(),
  reason: text("reason").notNull().default(""), // why this position was required
  contextGranted: text("context_granted").notNull().default("[]"), // JSON bounded context
  createdAt: timestamp("created_at").defaultNow(),
});

export const collegeFacultyContributions = pgTable("college_faculty_contributions", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id").notNull(),
  positionKey: text("position_key").notNull(),
  // observation|interpretation|assessment|question|recommendation|dissent|record_proposal
  contributionType: text("contribution_type").notNull().default("observation"),
  // support|dissent|question|neutral — disagreement is first-class
  stance: text("stance").notNull().default("neutral"),
  respondsToId: uuid("responds_to_id"), // another contribution; preserves the exchange
  content: text("content").notNull().default(""),
  truthClass: text("truth_class").notNull().default("interpretation"),
  confidence: text("confidence").notNull().default("inferred"),
  createdAt: timestamp("created_at").defaultNow(),
});

// ---------------------------------------------------------------------------
// Timetable vs reality — deviations
// ---------------------------------------------------------------------------
// Records the difference WITHOUT declaring the timetable wrong and WITHOUT
// auto-applying a response. Adjusted state requires an explicit decision.
export const collegeDeviations = pgTable("college_deviations", {
  id: uuid("id").primaryKey().defaultRandom(),
  termId: uuid("term_id"),
  weekIndex: integer("week_index"),
  sessionId: uuid("session_id"),
  slotId: uuid("slot_id"),
  // missed_session|interrupted|rescheduled|objective_changed|already_demonstrated|
  // capacity_reduced|calendar_conflict|catalogue_conflict|other
  deviationType: text("deviation_type").notNull().default("other"),
  scheduledState: text("scheduled_state").notNull().default(""), // what SHOULD be
  observedState: text("observed_state").notNull().default(""), // what IS
  adjustedState: text("adjusted_state").notNull().default(""), // decided response (may be empty)
  // open | acknowledged | adjusted | resolved | accepted_as_is
  resolution: text("resolution").notNull().default("open"),
  // Institutional response must come from a rule or an explicit decision
  decidedBy: text("decided_by").notNull().default(""),
  decisionBasis: text("decision_basis").notNull().default(""),
  truthClass: text("truth_class").notNull().default("fact"),
  confidence: text("confidence").notNull().default("known"),
  sourceKey: text("source_key").notNull().default(""),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// ---------------------------------------------------------------------------
// Real-world context — declared conditions only (no inference, no surveillance)
// ---------------------------------------------------------------------------
export const collegeContextSignals = pgTable("college_context_signals", {
  id: uuid("id").primaryKey().defaultRandom(),
  // sleep|appointment|work|travel|deadline|household|project|interruption|
  // availability|energy|other
  signalType: text("signal_type").notNull().default("other"),
  content: text("content").notNull(),
  // Only ever "declared" (student/faculty stated it) or "recorded" (filed doc).
  origin: text("origin").notNull().default("declared"),
  effectiveFrom: text("effective_from"), // ISO date
  effectiveTo: text("effective_to"), // ISO date, null = ongoing
  impact: text("impact").notNull().default(""), // how it bears on teaching
  truthClass: text("truth_class").notNull().default("fact"),
  confidence: text("confidence").notNull().default("known"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow(),
});

// ---------------------------------------------------------------------------
// Goals — living institutional state, not a checklist
// ---------------------------------------------------------------------------
export const collegeGoals = pgTable("college_goals", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  scope: text("scope").notNull().default("student"), // institutional|student|course|project
  origin: text("origin").notNull().default(""), // where it came from
  purpose: text("purpose").notNull().default(""), // why it exists
  timeframe: text("timeframe").notNull().default(""), // semester|year|long_term|open
  // proposed|active|progressing|stalled|achieved|abandoned|superseded
  status: text("status").notNull().default("proposed"),
  progressNote: text("progress_note").notNull().default(""),
  obstacles: text("obstacles").notNull().default(""),
  truthClass: text("truth_class").notNull().default("decision"),
  confidence: text("confidence").notNull().default("known"),
  sourceKey: text("source_key").notNull().default(""),
  lastReviewedAt: timestamp("last_reviewed_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Goal ↔ anything. Lets the College ask "which activity serves which goal?"
export const collegeGoalLinks = pgTable("college_goal_links", {
  id: uuid("id").primaryKey().defaultRandom(),
  goalId: uuid("goal_id").notNull(),
  // course|session|record|memory|artifact|project|evidence|deviation
  targetType: text("target_type").notNull(),
  targetId: text("target_id").notNull(),
  relation: text("relation").notNull().default("contributes_to"),
  note: text("note").notNull().default(""),
  createdAt: timestamp("created_at").defaultNow(),
});

// ---------------------------------------------------------------------------
// Educational memory — with an explicit epistemic ladder
// ---------------------------------------------------------------------------
// observation → interpretation → hypothesis → established
// Promotion requires corroborating evidence; nothing is auto-promoted.
export const collegeMemory = pgTable("college_memory", {
  id: uuid("id").primaryKey().defaultRandom(),
  // institutional|student_learning|teaching|course|session|historical
  scope: text("scope").notNull().default("teaching"),
  courseId: uuid("course_id"),
  sessionId: uuid("session_id"),
  // observation|interpretation|hypothesis|established
  epistemicStatus: text("epistemic_status").notNull().default("observation"),
  // worked|failed|confusion|explanation|misconception|discovery|struggle|
  // revisit|question|preference|strategy_change
  memoryType: text("memory_type").notNull().default("observation"),
  content: text("content").notNull(),
  // How many independent observations support this? Drives promotion eligibility.
  corroborationCount: integer("corroboration_count").notNull().default(1),
  supersededById: uuid("superseded_by_id"),
  authoredBy: text("authored_by").notNull().default("faculty"),
  truthClass: text("truth_class").notNull().default("fact"),
  confidence: text("confidence").notNull().default("known"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// The promotion trail: which observations justify a hypothesis/established item.
export const collegeMemoryEvidence = pgTable("college_memory_evidence", {
  id: uuid("id").primaryKey().defaultRandom(),
  memoryId: uuid("memory_id").notNull(),
  // memory|session|record|artifact|contribution|external
  evidenceType: text("evidence_type").notNull().default("memory"),
  evidenceId: text("evidence_id").notNull().default(""),
  note: text("note").notNull().default(""),
  createdAt: timestamp("created_at").defaultNow(),
});

// ---------------------------------------------------------------------------
// Institutional record — append-only history, Registrar-gated
// ---------------------------------------------------------------------------
export const collegeRecords = pgTable("college_records", {
  id: uuid("id").primaryKey().defaultRandom(),
  // milestone|decision|curriculum_change|goal_change|learning_discovery|
  // progression|correction|teaching_strategy_change|institutional_change|
  // session_record|administrative
  recordType: text("record_type").notNull().default("session_record"),
  subject: text("subject").notNull(),
  content: text("content").notNull().default(""),
  // Chronology is preserved separately from when we learned/filed it.
  occurredOn: text("occurred_on"), // ISO date the event happened
  recordedAt: timestamp("recorded_at").defaultNow(), // when observed
  filedAt: timestamp("filed_at"), // when it became an institutional record
  termId: uuid("term_id"),
  weekIndex: integer("week_index"),
  courseId: uuid("course_id"),
  sourceSessionId: uuid("source_session_id"),
  authoringFaculty: text("authoring_faculty").notNull().default("registrar"),
  provenance: text("provenance").notNull().default(""), // where the claim came from
  truthClass: text("truth_class").notNull().default("fact"),
  confidence: text("confidence").notNull().default("known"),
  // proposed | filed | superseded | withdrawn
  // Registrar PROPOSES; filing is the institutional act.
  status: text("status").notNull().default("proposed"),
  // Append-only correction: never rewrite, always supersede.
  supersedesId: uuid("supersedes_id"),
  supersededById: uuid("superseded_by_id"),
  correctionReason: text("correction_reason").notNull().default(""),
  createdAt: timestamp("created_at").defaultNow(),
});

// ---------------------------------------------------------------------------
// Derived state snapshots — auditability + rebuildability
// ---------------------------------------------------------------------------
export const collegeStateSnapshots = pgTable("college_state_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  computedAt: timestamp("computed_at").defaultNow(),
  reason: text("reason").notNull().default("manual"),
  brisbaneDate: text("brisbane_date").notNull().default(""),
  derivedWeekIndex: integer("derived_week_index"),
  declaredWeekIndex: integer("declared_week_index"),
  conflictCount: integer("conflict_count").notNull().default(0),
  unknownCount: integer("unknown_count").notNull().default(0),
  payload: text("payload").notNull().default("{}"), // JSON of the full state
  createdAt: timestamp("created_at").defaultNow(),
});

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------
export type CollegeSourceRow = typeof collegeSources.$inferSelect;
export type CollegeInstitutionRow = typeof collegeInstitution.$inferSelect;
export type CollegeTermRow = typeof collegeTerms.$inferSelect;
export type CollegeWeekRow = typeof collegeWeeks.$inferSelect;
export type CollegeSchoolRow = typeof collegeSchools.$inferSelect;
export type CollegeCapabilityRow = typeof collegeCapabilities.$inferSelect;
export type CollegeCourseRow = typeof collegeCourses.$inferSelect;
export type CollegeCourseWeekRow = typeof collegeCourseWeeks.$inferSelect;
export type CollegeTimetableSlotRow = typeof collegeTimetableSlots.$inferSelect;
export type CollegeFacultyRow = typeof collegeFaculty.$inferSelect;
export type CollegeSessionRow = typeof collegeSessions.$inferSelect;
export type CollegeSessionEventRow = typeof collegeSessionEvents.$inferSelect;
export type CollegeSessionFacultyRow = typeof collegeSessionFaculty.$inferSelect;
export type CollegeFacultyContributionRow = typeof collegeFacultyContributions.$inferSelect;
export type CollegeDeviationRow = typeof collegeDeviations.$inferSelect;
export type CollegeContextSignalRow = typeof collegeContextSignals.$inferSelect;
export type CollegeGoalRow = typeof collegeGoals.$inferSelect;
export type CollegeGoalLinkRow = typeof collegeGoalLinks.$inferSelect;
export type CollegeMemoryRow = typeof collegeMemory.$inferSelect;
export type CollegeMemoryEvidenceRow = typeof collegeMemoryEvidence.$inferSelect;
export type CollegeRecordRow = typeof collegeRecords.$inferSelect;
export type CollegeStateSnapshotRow = typeof collegeStateSnapshots.$inferSelect;

// ============================================================================
// LAYER 2 — reconciliation, formative evidence, curriculum
// ============================================================================
// Additive only. No Layer 1 table is renamed or altered.
// ============================================================================

// ---------------------------------------------------------------------------
// Institutional reconciliation — a conflict is STATE, not an error
// ---------------------------------------------------------------------------
// When authoritative sources disagree, the disagreement itself becomes part of
// institutional state and persists until formally resolved. The system never
// picks a winner, and never "fixes" a conflict because today's date suggests
// an interpretation.
export const collegeReconciliations = pgTable("college_reconciliations", {
  id: uuid("id").primaryKey().defaultRandom(),
  // stable identity so the same live conflict is not re-opened every request
  conflictKey: text("conflict_key").notNull(),
  // temporal | catalogue | timetable | governance | curriculum | other
  conflictType: text("conflict_type").notNull().default("other"),
  subject: text("subject").notNull(),
  sourceAKey: text("source_a_key").notNull().default(""),
  sourceAClaim: text("source_a_claim").notNull().default(""),
  sourceBKey: text("source_b_key").notNull().default(""),
  sourceBClaim: text("source_b_claim").notNull().default(""),
  detail: text("detail").notNull().default(""),
  provenance: text("provenance").notNull().default(""),
  detectedAt: timestamp("detected_at").defaultNow(),
  lastSeenAt: timestamp("last_seen_at").defaultNow(),
  // open | acknowledged | awaiting_authority | resolved | accepted_as_permanent
  status: text("status").notNull().default("open"),
  // what kind of act would settle it (amendment, clarification, decision)
  requiredAuthority: text("required_authority").notNull().default(""),
  requiredAction: text("required_action").notNull().default(""),
  resolution: text("resolution").notNull().default(""),
  resolutionProvenance: text("resolution_provenance").notNull().default(""),
  resolvedBy: text("resolved_by").notNull().default(""),
  resolvedAt: timestamp("resolved_at"),
  createdAt: timestamp("created_at").defaultNow(),
});

// ---------------------------------------------------------------------------
// Formative evidence — what learning was observed (NOT formal attainment)
// ---------------------------------------------------------------------------
// Faculty may record these freely. They never constitute a formal assessment.
export const collegeFormativeEvidence = pgTable("college_formative_evidence", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id"),
  courseId: uuid("course_id"),
  weekIndex: integer("week_index"),
  positionKey: text("position_key").notNull().default("instructor"),
  // demonstrated_understanding | demonstrated_skill | confusion | misconception |
  // successful_explanation | incomplete_understanding | needs_practice
  evidenceType: text("evidence_type").notNull().default("demonstrated_understanding"),
  content: text("content").notNull(),
  capabilityKey: text("capability_key").notNull().default(""),
  // Always "formative". Present so the distinction is explicit in the data.
  assessmentKind: text("assessment_kind").notNull().default("formative"),
  truthClass: text("truth_class").notNull().default("fact"),
  confidence: text("confidence").notNull().default("known"),
  createdAt: timestamp("created_at").defaultNow(),
});

// ---------------------------------------------------------------------------
// Curriculum — living institutional state, versioned
// ---------------------------------------------------------------------------
// The handbook defines the framework. The CURRENT curriculum is the founder's
// to decide, and changes must never rewrite what was true at the time.
export const collegeCurriculumVersions = pgTable("college_curriculum_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  termId: uuid("term_id"),
  versionNumber: integer("version_number").notNull().default(1),
  label: text("label").notNull().default(""),
  status: text("status").notNull().default("active"), // active | superseded
  reason: text("reason").notNull().default(""),
  initiatedBy: text("initiated_by").notNull().default("founder"),
  effectiveFrom: text("effective_from"), // ISO date
  supersedesId: uuid("supersedes_id"),
  createdAt: timestamp("created_at").defaultNow(),
});

// Membership: which courses are ACTIVE in a given curriculum version.
// A course existing (in Notion or in college_courses) does not imply membership.
export const collegeCurriculumEntries = pgTable("college_curriculum_entries", {
  id: uuid("id").primaryKey().defaultRandom(),
  versionId: uuid("version_id").notNull(),
  courseId: uuid("course_id").notNull(),
  position: integer("position").notNull().default(0), // ordering
  entryStatus: text("entry_status").notNull().default("active"), // active|paused
  note: text("note").notNull().default(""),
  createdAt: timestamp("created_at").defaultNow(),
});

// Immutable snapshot of what a course MEANT at a point in time.
// Historical sessions reference a snapshot, so later edits cannot rewrite them.
export const collegeCourseSnapshots = pgTable("college_course_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  courseId: uuid("course_id").notNull(),
  versionId: uuid("version_id"),
  code: text("code").notNull(),
  title: text("title").notNull(),
  summary: text("summary").notNull().default(""),
  status: text("status").notNull().default(""),
  weeklyStructure: text("weekly_structure").notNull().default("[]"), // JSON
  capturedAt: timestamp("captured_at").defaultNow(),
  reason: text("reason").notNull().default(""),
});

// Auditable curriculum change log — distinguishes metadata edits from
// institutional decisions.
export const collegeCurriculumChanges = pgTable("college_curriculum_changes", {
  id: uuid("id").primaryKey().defaultRandom(),
  versionId: uuid("version_id"),
  courseId: uuid("course_id"),
  // course_added | course_removed | course_edited | status_changed |
  // week_edited | reordered | timetable_changed | metadata_edit
  changeType: text("change_type").notNull().default("metadata_edit"),
  // metadata_edit = ordinary; institutional_decision = record-worthy
  significance: text("significance").notNull().default("metadata_edit"),
  field: text("field").notNull().default(""),
  previousValue: text("previous_value").notNull().default(""),
  newValue: text("new_value").notNull().default(""),
  reason: text("reason").notNull().default(""),
  initiatedBy: text("initiated_by").notNull().default("founder"),
  effectiveDate: text("effective_date"),
  recordId: uuid("record_id"), // set if filed by the Registrar
  createdAt: timestamp("created_at").defaultNow(),
});

// AI curriculum proposals — generated, never auto-applied.
export const collegeCurriculumProposals = pgTable("college_curriculum_proposals", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  rationale: text("rationale").notNull().default(""),
  evidence: text("evidence").notNull().default(""),
  affectedCourses: text("affected_courses").notNull().default("[]"), // JSON
  expectedConsequences: text("expected_consequences").notNull().default(""),
  conflicts: text("conflicts").notNull().default(""),
  alternatives: text("alternatives").notNull().default(""),
  proposedBy: text("proposed_by").notNull().default("faculty"),
  // proposed | accepted | rejected
  status: text("status").notNull().default("proposed"),
  decidedBy: text("decided_by").notNull().default(""),
  decidedAt: timestamp("decided_at"),
  decisionNote: text("decision_note").notNull().default(""),
  createdAt: timestamp("created_at").defaultNow(),
});

export type CollegeReconciliationRow = typeof collegeReconciliations.$inferSelect;
export type CollegeFormativeEvidenceRow = typeof collegeFormativeEvidence.$inferSelect;
export type CollegeCurriculumVersionRow = typeof collegeCurriculumVersions.$inferSelect;
export type CollegeCurriculumEntryRow = typeof collegeCurriculumEntries.$inferSelect;
export type CollegeCourseSnapshotRow = typeof collegeCourseSnapshots.$inferSelect;
export type CollegeCurriculumChangeRow = typeof collegeCurriculumChanges.$inferSelect;
export type CollegeCurriculumProposalRow = typeof collegeCurriculumProposals.$inferSelect;
