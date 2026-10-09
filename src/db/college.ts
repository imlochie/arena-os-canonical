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

// ============================================================================
// LAYER 3 — attention, coordination and orchestration
// ============================================================================
// Additive only. No Layer 1 or Layer 2 table is renamed or altered.
//
// The faculty is an ORCHESTRATION problem, not a collection of prompts. These
// tables make attention, activation, consultation, handoff and interruption
// first-class institutional state rather than emergent LLM behaviour.
// ============================================================================

// Session phases. A phase is a declared segment of a class that determines
// which faculty are relevant. Distinct from `stage` on college_sessions, which
// records lifecycle position; a phase governs ATTENTION.
export const collegeSessionPhases = pgTable("college_session_phases", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id").notNull(),
  phaseKey: text("phase_key").notNull(), // orientation|inquiry|teaching|challenge|practice|reflection|institutional_record
  sequence: integer("sequence").notNull().default(0),
  // Which positions the phase makes relevant — from the course protocol,
  // never hardcoded globally.
  primaryPositions: text("primary_positions").notNull().default("[]"), // JSON
  watchingPositions: text("watching_positions").notNull().default("[]"), // JSON
  enteredAt: timestamp("entered_at").defaultNow(),
  exitedAt: timestamp("exited_at"),
  note: text("note").notNull().default(""),
});

// Events that occur during a session. Faculty become active because an event
// falls within their remit — not because "the AI was asked to answer".
export const collegeSessionEventBus = pgTable("college_session_event_bus", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id").notNull(),
  sequence: integer("sequence").notNull().default(0),
  // lesson_started | learning_objective_changed | student_response_received |
  // misconception_detected | factual_uncertainty_detected |
  // contradiction_detected | research_required | learning_evidence_observed |
  // goal_conflict_detected | timetable_deviation_detected | decision_proposed |
  // decision_accepted | record_worthy_event_detected | session_phase_changed |
  // session_nearing_completion
  eventType: text("event_type").notNull(),
  payload: text("payload").notNull().default(""),
  // Who or what emitted it: student | system | faculty:<key>
  emittedBy: text("emitted_by").notNull().default("system"),
  phaseKey: text("phase_key").notNull().default(""),
  // Which positions this event was routed to, and why (JSON audit).
  routedTo: text("routed_to").notNull().default("[]"),
  createdAt: timestamp("created_at").defaultNow(),
});

// Stateful faculty participation. A faculty member can ATTEND without SPEAKING.
export const collegeFacultyAttention = pgTable("college_faculty_attention", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id").notNull(),
  positionKey: text("position_key").notNull(),
  // dormant|watching|engaged|consulting|waiting|deferred|escalated|handing_off|completed
  state: text("state").notNull().default("dormant"),
  previousState: text("previous_state").notNull().default(""),
  // Why the state changed — every transition is explainable.
  reason: text("reason").notNull().default(""),
  // The event that caused the transition, if any.
  triggeredByEventId: uuid("triggered_by_event_id"),
  phaseKey: text("phase_key").notNull().default(""),
  // Did this transition produce student-visible output?
  spoke: boolean("spoke").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow(),
});

// One faculty position formally requesting another's attention.
export const collegeConsultations = pgTable("college_consultations", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id").notNull(),
  requestingPosition: text("requesting_position").notNull(),
  requestedPosition: text("requested_position").notNull(),
  reason: text("reason").notNull().default(""),
  question: text("question").notNull().default(""),
  // Evidence references handed over with the request (JSON).
  evidenceRefs: text("evidence_refs").notNull().default("[]"),
  urgency: text("urgency").notNull().default("normal"), // low|normal|high|urgent
  scope: text("scope").notNull().default(""), // what the consulted position may address
  responseRequired: boolean("response_required").notNull().default(true),
  // open|answered|declined|out_of_remit|expired
  status: text("status").notNull().default("open"),
  response: text("response").notNull().default(""),
  // The decision or observation that resulted.
  outcome: text("outcome").notNull().default(""),
  contributionId: uuid("contribution_id"), // links to the produced contribution
  respondedAt: timestamp("responded_at"),
  createdAt: timestamp("created_at").defaultNow(),
});

// Deliberate transfer of responsibility between positions. Explicit + auditable.
export const collegeHandoffs = pgTable("college_handoffs", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id").notNull(),
  fromPosition: text("from_position").notNull(),
  toPosition: text("to_position").notNull(),
  reason: text("reason").notNull().default(""),
  // What is being handed over.
  payload: text("payload").notNull().default(""),
  // Did the receiving position accept, defer, or refuse (out of remit)?
  disposition: text("disposition").notNull().default("pending"), // pending|accepted|deferred|refused
  dispositionReason: text("disposition_reason").notNull().default(""),
  // Crossing the faculty/administration boundary is significant.
  crossesBranch: boolean("crosses_branch").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow(),
});

// Interruptions. Not every position may interrupt, and every interruption
// must carry a reason. Refused attempts are recorded too — role creep is
// evidence, not something to hide.
export const collegeInterruptions = pgTable("college_interruptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id").notNull(),
  positionKey: text("position_key").notNull(),
  interruptedPosition: text("interrupted_position").notNull().default(""),
  reason: text("reason").notNull().default(""),
  urgency: text("urgency").notNull().default("normal"),
  // granted|refused — refusal is a first-class outcome
  outcome: text("outcome").notNull().default("refused"),
  outcomeReason: text("outcome_reason").notNull().default(""),
  createdAt: timestamp("created_at").defaultNow(),
});

// Course-specific faculty protocol. Attention is configuration, not code.
// A course declares which positions are primary, continuous, conditional and
// administrative — and under what conditions the conditional ones activate.
export const collegeFacultyProtocols = pgTable("college_faculty_protocols", {
  id: uuid("id").primaryKey().defaultRandom(),
  // Null courseId = the College default protocol.
  courseId: uuid("course_id"),
  sessionKind: text("session_kind").notNull().default(""),
  label: text("label").notNull().default(""),
  // JSON: [{positionKey, mode, activatesOn[], reason}]
  //   mode: primary|continuous|conditional|administrative
  positions: text("positions").notNull().default("[]"),
  // JSON: [{phaseKey, primary[], watching[]}]
  phasePlan: text("phase_plan").notNull().default("[]"),
  active: boolean("active").notNull().default(true),
  reason: text("reason").notNull().default(""),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export type CollegeSessionPhaseRow = typeof collegeSessionPhases.$inferSelect;
export type CollegeSessionEventBusRow = typeof collegeSessionEventBus.$inferSelect;
export type CollegeFacultyAttentionRow = typeof collegeFacultyAttention.$inferSelect;
export type CollegeConsultationRow = typeof collegeConsultations.$inferSelect;
export type CollegeHandoffRow = typeof collegeHandoffs.$inferSelect;
export type CollegeInterruptionRow = typeof collegeInterruptions.$inferSelect;
export type CollegeFacultyProtocolRow = typeof collegeFacultyProtocols.$inferSelect;

// ============================================================================
// LAYER 4 — faculty members, live timetable, audit
// ============================================================================
// Additive only. No earlier table is renamed or altered.
//
// Principle for this layer, from the founder:
//   "Do not optimise the College by default. Make the College observable,
//    understandable, and governable."
//
// And: uncertainty must not paralyse. A conflict exposes where an
// INSTITUTIONAL DECISION is needed; the decision becomes authoritative while
// the original disagreement stays preserved.
// ============================================================================

// ---------------------------------------------------------------------------
// FACULTY MEMBERS — a configured persona occupying an institutional position
// ---------------------------------------------------------------------------
// POSITION = the institutional responsibility (code-defined, authority-bearing)
// MEMBER   = who occupies it (founder-configured, personality-bearing)
// Personality must never override institutional authority.
export const collegeFacultyMembers = pgTable("college_faculty_members", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(), // "The Patient Teacher"
  positionKey: text("position_key").notNull(), // instructor|observer|critic|...
  // active|inactive|archived|retired — never hard-deleted once it has taught
  status: text("status").notNull().default("active"),
  // Personality: structured dials PLUS a real instruction.
  temperament: text("temperament").notNull().default(""),
  communicationStyle: text("communication_style").notNull().default(""),
  teachingStyle: text("teaching_style").notNull().default(""),
  questioningStyle: text("questioning_style").notNull().default(""),
  directness: integer("directness").notNull().default(3), // 1..5
  warmth: integer("warmth").notNull().default(3),
  formality: integer("formality").notNull().default(3),
  ambiguityTolerance: integer("ambiguity_tolerance").notNull().default(3),
  personalityInstruction: text("personality_instruction").notNull().default(""),
  // Responsibilities actually enabled for this member (JSON string[]).
  responsibilities: text("responsibilities").notNull().default("[]"),
  // Granted authority (JSON string[]) — INTERSECTED with the position's
  // architectural ceiling at runtime. Configuration can only ever subtract.
  grantedAuthority: text("granted_authority").notNull().default("[]"),
  // college_wide|course|session_type|phase|optional|conditional
  mandatoryLevel: text("mandatory_level").notNull().default("optional"),
  // block|warn — what happens if a mandatory member cannot be instantiated
  missingSeverity: text("missing_severity").notNull().default("warn"),
  // Coordination network overrides (JSON string[]); empty = use policy default.
  canConsult: text("can_consult").notNull().default("[]"),
  canHandOffTo: text("can_hand_off_to").notNull().default("[]"),
  canInterrupt: text("can_interrupt").notNull().default("[]"),
  // Activation overrides (JSON string[]) — event types; empty = policy default.
  activatesOnEvents: text("activates_on_events").notNull().default("[]"),
  activatesOnPhases: text("activates_on_phases").notNull().default("[]"),
  // LAYER 5 — the rest of the attention vocabulary, so a configured member
  // actually governs runtime. Empty means "fall back to the position policy",
  // which is a genuine absence of configuration, not a silent override.
  watchFor: text("watch_for").notNull().default("[]"),
  staySilentOn: text("stay_silent_on").notNull().default("[]"),
  escalateOn: text("escalate_on").notNull().default("[]"),
  deferMatters: text("defer_matters").notNull().default("[]"), // [{matter,to}]
  stopAttendingOn: text("stop_attending_on").notNull().default("[]"),
  // none|request|material|integrity — empty string = use position policy.
  interruptionAuthority: text("interruption_authority").notNull().default(""),
  // dormant|watching|attentive — state when a session opens. Empty = policy.
  defaultState: text("default_state").notNull().default(""),
  // Whether this member may retain and retrieve faculty memory.
  memoryEnabled: boolean("memory_enabled").notNull().default(true),
  memoryScopeLimit: text("memory_scope_limit").notNull().default("course"),
  // Which preset this began life as, for provenance only.
  presetKey: text("preset_key").notNull().default(""),
  notes: text("notes").notNull().default(""),
  // Current version number; history lives in college_faculty_member_versions.
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Immutable snapshots. Historical sessions retain the configuration that
// applied when they occurred — changing a personality must not rewrite history.
export const collegeFacultyMemberVersions = pgTable("college_faculty_member_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  memberId: uuid("member_id").notNull(),
  version: integer("version").notNull().default(1),
  snapshot: text("snapshot").notNull().default("{}"), // full JSON of the member
  changeSummary: text("change_summary").notNull().default(""),
  reason: text("reason").notNull().default(""),
  changedBy: text("changed_by").notNull().default("founder"),
  createdAt: timestamp("created_at").defaultNow(),
});

// Assignment of a member to a scope. Most specific valid scope wins.
export const collegeFacultyAssignments = pgTable("college_faculty_assignments", {
  id: uuid("id").primaryKey().defaultRandom(),
  memberId: uuid("member_id").notNull(),
  // college|school|course|session_type|timetable_slot|session
  scope: text("scope").notNull().default("college"),
  scopeRef: text("scope_ref").notNull().default(""), // courseId, slotId, kind...
  // mandatory|optional|conditional|administrative
  participation: text("participation").notNull().default("optional"),
  // Session-scope assignments are temporary overrides and expire.
  temporary: boolean("temporary").notNull().default(false),
  reason: text("reason").notNull().default(""),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow(),
});

// Which member actually occupied which position in a given session, and at
// which version. This is what makes faculty history honest.
export const collegeSessionFacultyMembers = pgTable("college_session_faculty_members", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id").notNull(),
  memberId: uuid("member_id"),
  memberVersionId: uuid("member_version_id"),
  positionKey: text("position_key").notNull(),
  memberName: text("member_name").notNull().default(""), // denormalised on purpose
  participation: text("participation").notNull().default("optional"),
  createdAt: timestamp("created_at").defaultNow(),
});

// Faculty memory — what a member learned about teaching this student/course.
// DISTINCT from institutional memory. Remember generously, believe cautiously.
export const collegeFacultyMemory = pgTable("college_faculty_memory", {
  id: uuid("id").primaryKey().defaultRandom(),
  memberId: uuid("member_id"),
  positionKey: text("position_key").notNull().default(""),
  courseId: uuid("course_id"),
  sessionId: uuid("session_id"),
  content: text("content").notNull(),
  // session|course|student|subject — the bound of what it claims
  memoryScope: text("memory_scope").notNull().default("session"),
  observationCount: integer("observation_count").notNull().default(1),
  // private = faculty's own; proposed = offered for institutional promotion;
  // promoted = accepted into college_memory; declined = rejected
  promotionStatus: text("promotion_status").notNull().default("private"),
  promotedMemoryId: uuid("promoted_memory_id"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow(),
});

// ---------------------------------------------------------------------------
// LIVE TIMETABLE
// ---------------------------------------------------------------------------
// TEMPLATE (recurring structure) → INSTANCE (a real date) → SESSION (what
// actually happened). Kept strictly distinct.

export const collegeTimetableVersions = pgTable("college_timetable_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  termId: uuid("term_id"),
  versionNumber: integer("version_number").notNull().default(1),
  label: text("label").notNull().default(""),
  status: text("status").notNull().default("active"), // draft|active|superseded|archived
  reason: text("reason").notNull().default(""),
  effectiveFrom: text("effective_from"), // ISO date
  effectiveTo: text("effective_to"),
  supersedesId: uuid("supersedes_id"),
  createdAt: timestamp("created_at").defaultNow(),
});

// The daily backbone: Launch Sequence, Life Skills, Today's Subject, ...
export const collegeTimetablePeriods = pgTable("college_timetable_periods", {
  id: uuid("id").primaryKey().defaultRandom(),
  versionId: uuid("version_id"),
  key: text("key").notNull(), // launch_sequence|life_skills|todays_subject|...
  label: text("label").notNull(),
  sequence: integer("sequence").notNull().default(0),
  startTime: text("start_time").notNull().default(""), // "10:15" 24h
  endTime: text("end_time").notNull().default(""),
  intent: text("intent").notNull().default(""), // "Become ready. Set the tone."
  icon: text("icon").notNull().default(""),
  colorKey: text("color_key").notNull().default(""),
  // Times taken from the reference image but not independently confirmed.
  needsConfiguration: boolean("needs_configuration").notNull().default(false),
  configurationNote: text("configuration_note").notNull().default(""),
  createdAt: timestamp("created_at").defaultNow(),
});

export const collegeDayThemes = pgTable("college_day_themes", {
  id: uuid("id").primaryKey().defaultRandom(),
  versionId: uuid("version_id"),
  dayOfWeek: integer("day_of_week").notNull(), // 1=Mon..7=Sun
  theme: text("theme").notNull().default(""), // RESET|EXPLORE|ADULTING|...
  colorKey: text("color_key").notNull().default(""),
  note: text("note").notNull().default(""),
  createdAt: timestamp("created_at").defaultNow(),
});

// A SLOT is a place in the timetable. The activity occupying it can change.
export const collegeTimetableTemplateSlots = pgTable("college_timetable_template_slots", {
  id: uuid("id").primaryKey().defaultRandom(),
  versionId: uuid("version_id"),
  periodId: uuid("period_id"),
  dayOfWeek: integer("day_of_week").notNull(),
  startTime: text("start_time").notNull().default(""),
  endTime: text("end_time").notNull().default(""),
  sequence: integer("sequence").notNull().default(0),
  title: text("title").notNull().default(""),
  description: text("description").notNull().default(""),
  // fixed | scheduled | slotable — fixed routines vs configurable activity slots
  slotBehaviour: text("slot_behaviour").notNull().default("scheduled"),
  // academic|creative|administrative|health|relationship|household|adventure|
  // recovery|entertainment|routine — the day is not all "courses"
  activityType: text("activity_type").notNull().default("routine"),
  categoryKey: text("category_key").notNull().default(""),
  courseId: uuid("course_id"), // reference, never a duplicate of the course
  sessionKind: text("session_kind").notNull().default(""),
  // Does entering this slot create a College session?
  generatesSession: boolean("generates_session").notNull().default(false),
  // Does it participate in College State reasoning?
  informsCollegeState: boolean("informs_college_state").notNull().default(true),
  facultyRequirement: text("faculty_requirement").notNull().default("[]"), // JSON
  icon: text("icon").notNull().default(""),
  colorKey: text("color_key").notNull().default(""),
  items: text("items").notNull().default("[]"), // JSON checklist from the design
  notes: text("notes").notNull().default(""),
  recurrence: text("recurrence").notNull().default("weekly"), // weekly|none
  effectiveFrom: text("effective_from"),
  effectiveTo: text("effective_to"),
  needsConfiguration: boolean("needs_configuration").notNull().default(false),
  configurationNote: text("configuration_note").notNull().default(""),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// A date-specific override. NEVER mutates the recurring template.
export const collegeTimetableOverrides = pgTable("college_timetable_overrides", {
  id: uuid("id").primaryKey().defaultRandom(),
  slotId: uuid("slot_id"),
  date: text("date").notNull(), // ISO date this applies to
  // cancelled|moved|substituted|extended|shortened|rescheduled|special_session|
  // holiday|personal_commitment|unavailable|unscheduled
  exceptionType: text("exception_type").notNull().default("cancelled"),
  newStartTime: text("new_start_time").notNull().default(""),
  newEndTime: text("new_end_time").notNull().default(""),
  newTitle: text("new_title").notNull().default(""),
  newCourseId: uuid("new_course_id"),
  reason: text("reason").notNull().default(""),
  provenance: text("provenance").notNull().default("founder"),
  createdAt: timestamp("created_at").defaultNow(),
});

// What actually happened at a slot on a date. Runtime state is NOT inferred
// from the clock passing — completion requires evidence.
export const collegeTimetableInstances = pgTable("college_timetable_instances", {
  id: uuid("id").primaryKey().defaultRandom(),
  slotId: uuid("slot_id"),
  versionId: uuid("version_id"), // the timetable version that applied THEN
  date: text("date").notNull(),
  startTime: text("start_time").notNull().default(""),
  endTime: text("end_time").notNull().default(""),
  title: text("title").notNull().default(""),
  courseId: uuid("course_id"),
  overrideId: uuid("override_id"),
  // scheduled|current|in_progress|completed|missed|cancelled|deviated|unknown
  runtimeStatus: text("runtime_status").notNull().default("scheduled"),
  // How do we know? clock alone is NOT sufficient for "completed".
  statusEvidence: text("status_evidence").notNull().default(""),
  sessionId: uuid("session_id"),
  deviationId: uuid("deviation_id"),
  notes: text("notes").notNull().default(""),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// ---------------------------------------------------------------------------
// INTENT — what a structure is FOR. Audits evaluate against intent, not
// against a theoretical optimum.
// ---------------------------------------------------------------------------
export const collegeIntents = pgTable("college_intents", {
  id: uuid("id").primaryKey().defaultRandom(),
  subjectType: text("subject_type").notNull(), // course|slot|goal|curriculum|timetable|faculty
  subjectId: uuid("subject_id"),
  subjectKey: text("subject_key").notNull().default(""),
  statement: text("statement").notNull(),
  // GOAL / PLAN / EXPERIMENT are different things, per the founder.
  intentKind: text("intent_kind").notNull().default("plan"), // goal|plan|experiment
  // For experiments: how long before it is fair to look?
  reviewAfterDays: integer("review_after_days"),
  supersedesId: uuid("supersedes_id"),
  active: boolean("active").notNull().default(true),
  reason: text("reason").notNull().default(""),
  createdAt: timestamp("created_at").defaultNow(),
});

// ---------------------------------------------------------------------------
// AUDIT — understanding, not optimisation
// ---------------------------------------------------------------------------
export const collegeAudits = pgTable("college_audits", {
  id: uuid("id").primaryKey().defaultRandom(),
  scopeType: text("scope_type").notNull(), // curriculum|timetable|course|class|goal|faculty|slot
  scopeId: uuid("scope_id"),
  scopeLabel: text("scope_label").notNull().default(""),
  periodStart: text("period_start").notNull().default(""),
  periodEnd: text("period_end").notNull().default(""),
  comparedPeriodStart: text("compared_period_start").notNull().default(""),
  comparedPeriodEnd: text("compared_period_end").notNull().default(""),
  // Conditions that applied, so two periods are never presented as a clean
  // experiment when they were not.
  curriculumVersionId: uuid("curriculum_version_id"),
  timetableVersionId: uuid("timetable_version_id"),
  conditionsNote: text("conditions_note").notNull().default(""),
  comparableConditions: boolean("comparable_conditions").notNull().default(true),
  // Per-dimension evidence, never collapsed into one score (JSON).
  dimensions: text("dimensions").notNull().default("[]"),
  evidenceConsidered: text("evidence_considered").notNull().default("[]"),
  facultyObservations: text("faculty_observations").notNull().default("[]"),
  contextualFactors: text("contextual_factors").notNull().default("[]"),
  // stable|improving|deteriorating|changed|uncertain|insufficient_evidence
  auditStatus: text("audit_status").notNull().default("insufficient_evidence"),
  interpretation: text("interpretation").notNull().default(""),
  // keep_as_is|investigate|propose_change|no_decision — "keep as is" is real
  decision: text("decision").notNull().default("no_decision"),
  decisionReason: text("decision_reason").notNull().default(""),
  decidedBy: text("decided_by").notNull().default(""),
  // Stops the same question being reopened every week.
  reopenAfter: text("reopen_after"), // ISO date
  createdAt: timestamp("created_at").defaultNow(),
});

// Configurable thresholds. Arena must not assume what counts as meaningful.
export const collegeAuditThresholds = pgTable("college_audit_thresholds", {
  id: uuid("id").primaryKey().defaultRandom(),
  scopeType: text("scope_type").notNull().default("slot"),
  scopeId: uuid("scope_id"),
  minObservations: integer("min_observations").notNull().default(4),
  minWeeks: integer("min_weeks").notNull().default(3),
  deviationsBeforeReview: integer("deviations_before_review").notNull().default(3),
  reviewIntervalDays: integer("review_interval_days").notNull().default(28),
  reason: text("reason").notNull().default(""),
  createdAt: timestamp("created_at").defaultNow(),
});

export type CollegeFacultyMemberRow = typeof collegeFacultyMembers.$inferSelect;
export type CollegeFacultyMemberVersionRow = typeof collegeFacultyMemberVersions.$inferSelect;
export type CollegeFacultyAssignmentRow = typeof collegeFacultyAssignments.$inferSelect;
export type CollegeSessionFacultyMemberRow = typeof collegeSessionFacultyMembers.$inferSelect;
export type CollegeFacultyMemoryRow = typeof collegeFacultyMemory.$inferSelect;
export type CollegeTimetableVersionRow = typeof collegeTimetableVersions.$inferSelect;
export type CollegeTimetablePeriodRow = typeof collegeTimetablePeriods.$inferSelect;
export type CollegeDayThemeRow = typeof collegeDayThemes.$inferSelect;
export type CollegeTimetableTemplateSlotRow = typeof collegeTimetableTemplateSlots.$inferSelect;
export type CollegeTimetableOverrideRow = typeof collegeTimetableOverrides.$inferSelect;
export type CollegeTimetableInstanceRow = typeof collegeTimetableInstances.$inferSelect;
export type CollegeIntentRow = typeof collegeIntents.$inferSelect;
export type CollegeAuditRow = typeof collegeAudits.$inferSelect;
export type CollegeAuditThresholdRow = typeof collegeAuditThresholds.$inferSelect;

// ===========================================================================
// LAYER 5 — RUNTIME INTEGRATION
// Configuration must GOVERN runtime, not merely describe it.
// ===========================================================================

// The College Event Ledger.
// Not a copy of every table — a structured institutional timeline of what
// actually happened, in order. This is the connective tissue between the
// timetable, the session, real-world context and the audit.
//
// RAW OBSERVATION ONLY. Interpretation lives in the audit, never here.
export const collegeEventLedger = pgTable("college_event_ledger", {
  id: uuid("id").primaryKey().defaultRandom(),
  // Brisbane date + time so the ledger reads as an institutional day.
  date: text("date").notNull(), // YYYY-MM-DD
  time: text("time").notNull().default(""), // HH:MM
  occurredAt: timestamp("occurred_at").defaultNow(),
  sequence: integer("sequence").notNull().default(0),
  // timetable_slot_active | class_opened | faculty_activated | faculty_deferred |
  // faculty_consulted | observer_noted | real_world_interruption |
  // class_shortened | class_completed | session_closed | timetable_override |
  // curriculum_change | goal_addressed | objective_demonstrated | decision_recorded
  eventType: text("event_type").notNull(),
  // What the event is about, in plain institutional language.
  summary: text("summary").notNull().default(""),
  // Structured detail (JSON) for machine consumption by the audit.
  detail: text("detail").notNull().default("{}"),
  // Links — all optional; the ledger never requires a full object graph.
  sessionId: uuid("session_id"),
  slotId: uuid("slot_id"),
  courseId: uuid("course_id"),
  memberId: uuid("member_id"),
  positionKey: text("position_key").notNull().default(""),
  // Versions in force AT THE TIME, so the audit never compares across silently
  // changed conditions.
  curriculumVersionId: uuid("curriculum_version_id"),
  timetableVersionId: uuid("timetable_version_id"),
  // student | faculty:<key> | system | founder
  actor: text("actor").notNull().default("system"),
  // informational | low | medium | high | critical
  severity: text("severity").notNull().default("informational"),
  createdAt: timestamp("created_at").defaultNow(),
});

// Notifications are DERIVED from ledger events and are suppressible.
// A single missed class is informational. Repetition may become a signal.
export const collegeNotifications = pgTable("college_notifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  // Stable identity so the same condition is not re-notified endlessly.
  notificationKey: text("notification_key").notNull(),
  severity: text("severity").notNull().default("informational"),
  title: text("title").notNull(),
  body: text("body").notNull().default(""),
  sourceEventId: uuid("source_event_id"),
  scopeType: text("scope_type").notNull().default(""),
  scopeId: uuid("scope_id"),
  occurrenceCount: integer("occurrence_count").notNull().default(1),
  // pending | shown | acknowledged | suppressed | settled
  status: text("status").notNull().default("pending"),
  // When a KEEP AS IS or acknowledgement silences this until a date.
  suppressedUntil: text("suppressed_until").notNull().default(""),
  suppressionReason: text("suppression_reason").notNull().default(""),
  firstSeenAt: timestamp("first_seen_at").defaultNow(),
  lastSeenAt: timestamp("last_seen_at").defaultNow(),
  createdAt: timestamp("created_at").defaultNow(),
});

// Per-College notification policy. Arena must not assume what deserves
// interruption.
export const collegeNotificationPolicy = pgTable("college_notification_policy", {
  id: uuid("id").primaryKey().defaultRandom(),
  eventType: text("event_type").notNull(),
  severity: text("severity").notNull().default("informational"),
  // How many occurrences before this is worth surfacing at all.
  occurrencesBeforeSurfacing: integer("occurrences_before_surfacing").notNull().default(1),
  // Whether it may ever interrupt, or only appear in a digest.
  notify: boolean("notify").notNull().default(false),
  reason: text("reason").notNull().default(""),
  createdAt: timestamp("created_at").defaultNow(),
});

// A resolved attention decision, recorded per event so the founder can see
// WHY a member did or did not act, and WHICH configuration layer decided it.
export const collegeAttentionDecisions = pgTable("college_attention_decisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id").notNull(),
  eventId: uuid("event_id"),
  eventType: text("event_type").notNull().default(""),
  positionKey: text("position_key").notNull(),
  memberId: uuid("member_id"),
  memberName: text("member_name").notNull().default(""),
  // dormant|watching|attentive|consulting|speaking|deferred|escalated
  resolvedState: text("resolved_state").notNull(),
  // notice | activate | consult | defer | escalate | speak | ignore
  action: text("action").notNull().default("ignore"),
  reason: text("reason").notNull().default(""),
  // WHICH layer decided: session|course|position|member|institutional_default
  decidedBy: text("decided_by").notNull().default("institutional_default"),
  // The full provenance trail (JSON) for the runtime inspector.
  provenance: text("provenance").notNull().default("[]"),
  createdAt: timestamp("created_at").defaultNow(),
});

// An explicit institutional decision that settles a source conflict.
// The original disagreement is NEVER overwritten — it stays in
// college_reconciliations. This records the position the College has taken.
export const collegeInstitutionalDecisions = pgTable("college_institutional_decisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  // What the decision is about.
  subject: text("subject").notNull(),
  subjectKey: text("subject_key").notNull().default(""),
  conflictKey: text("conflict_key").notNull().default(""),
  // adopt_a | adopt_b | new_position | leave_unresolved
  decisionType: text("decision_type").notNull(),
  // The position the College now holds.
  statement: text("statement").notNull().default(""),
  // What was NOT chosen, preserved deliberately.
  notChosen: text("not_chosen").notNull().default(""),
  rationale: text("rationale").notNull().default(""),
  decidedBy: text("decided_by").notNull().default("founder"),
  effectiveFrom: text("effective_from").notNull().default(""),
  // active | superseded
  status: text("status").notNull().default("active"),
  supersededBy: uuid("superseded_by"),
  createdAt: timestamp("created_at").defaultNow(),
});

export type CollegeEventLedgerRow = typeof collegeEventLedger.$inferSelect;
export type CollegeNotificationRow = typeof collegeNotifications.$inferSelect;
export type CollegeAttentionDecisionRow = typeof collegeAttentionDecisions.$inferSelect;
export type CollegeInstitutionalDecisionRow = typeof collegeInstitutionalDecisions.$inferSelect;

// ---------------------------------------------------------------------------
// LAYER 7 — EXTERNAL ACADEMIC WORLD
// ---------------------------------------------------------------------------
// The College does not replace TAFE and does not govern it. It needs to know
// three things: what the external provider REQUIRES, WHERE the student is in
// it, and WHAT HAS HAPPENED since they last studied — so that today's College
// session can fit around that reality instead of pretending it does not exist.
//
// This is deliberately thin. An external commitment is NOT a course, NOT a
// curriculum entry and NOT something the College may grade, reschedule or
// mark complete on the student's behalf. Arena holds operational awareness of
// it; the provider remains the authority. Recording "TAFE assessment due
// Friday" must never become the College asserting an academic judgement.
export const collegeExternalCommitments = pgTable("college_external_commitments", {
  id: uuid("id").primaryKey().defaultRandom(),
  // The provider, e.g. "TAFE Queensland". Free text: the College does not own
  // a registry of institutions and must not pretend to.
  provider: text("provider").notNull(),
  title: text("title").notNull(),
  // course | unit | assessment | placement | exam | class | admin
  commitmentType: text("commitment_type").notNull().default("course"),
  // Where the student is in it, in the PROVIDER's terms, recorded verbatim.
  // The College never computes this and never advances it automatically.
  progressState: text("progress_state").notNull().default(""),
  // ISO dates. Null means genuinely unknown, never "today".
  startsOn: text("starts_on"),
  dueOn: text("due_on"),
  endsOn: text("ends_on"),
  // active | upcoming | completed | withdrawn | unknown
  status: text("status").notNull().default("active"),
  // Who told the College. Evidence, not assumption.
  sourceNote: text("source_note").notNull().default(""),
  // How much weight this may carry. The College does not verify provider
  // records, so it must be honest that this is reported, not confirmed.
  // reported | documented | verified
  evidenceLevel: text("evidence_level").notNull().default("reported"),
  lastConfirmedAt: timestamp("last_confirmed_at"),
  notes: text("notes").notNull().default(""),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export type CollegeExternalCommitmentRow =
  typeof collegeExternalCommitments.$inferSelect;

// ---------------------------------------------------------------------------
// LAYER 8 — COMMITMENTS AND BOUNDED ACCOUNTABILITY
// ---------------------------------------------------------------------------
// A GOAL is what we are trying to accomplish.
// A PLAN is how we intended to get there.
// A COMMITMENT is what the student explicitly agreed to do.
// ACCOUNTABILITY is whether reality matched the commitment, and what the
// College should understand from that.
//
// Those four are deliberately separate. Collapsing them is how a study system
// becomes a task list that nags: every unmet intention starts reading as a
// moral failure, and the goal quietly moves to make the numbers look better.
//
// THE COLLEGE NOTICES WITHOUT JUDGING. A missed commitment records WHAT was
// missed and, where stated, WHY. It never concludes "therefore you are
// failing", never silently lowers the goal, and never converts a run of
// missed sessions into a verdict about the student.
export const collegeCommitments = pgTable("college_commitments", {
  id: uuid("id").primaryKey().defaultRandom(),
  // What was actually agreed, in the student's own terms.
  statement: text("statement").notNull(),
  // study_session | task | habit | attendance | submission | preparation
  commitmentType: text("commitment_type").notNull().default("study_session"),
  // What this serves. Optional: not every commitment belongs to a goal, and
  // pretending otherwise would force false structure onto ordinary intentions.
  goalId: uuid("goal_id"),
  courseId: uuid("course_id"),
  // External commitments (TAFE) may be the reason a commitment exists.
  externalCommitmentId: uuid("external_commitment_id"),
  // When the student said they would do it.
  dueDate: text("due_date"), // ISO date, null = no dated expectation
  // Size of the promise, so "behind by one session" is meaningful.
  plannedMinutes: integer("planned_minutes"),
  // open|completed|missed|deferred|cancelled|partial
  // "missed" is a factual state, not a judgement. "cancelled" is a legitimate
  // decision the student is allowed to make.
  status: text("status").notNull().default("open"),
  // WHY, when the student chose to say. Never inferred, never guessed.
  // forgot | chose_not_to | circumstance | unclear_task | no_reason_given
  missedReasonKind: text("missed_reason_kind").notNull().default(""),
  missedReason: text("missed_reason").notNull().default(""),
  // What actually happened, recorded at closure.
  actualMinutes: integer("actual_minutes"),
  completedAt: timestamp("completed_at"),
  // The session that discharged it, when one did.
  sessionId: uuid("session_id"),
  // Where the commitment came from. The College may PROPOSE a commitment, but
  // only the student may make one — proposals do not self-activate.
  origin: text("origin").notNull().default("student"), // student|college_proposed
  accepted: boolean("accepted").notNull().default(true),
  // A commitment that was reviewed and deliberately left alone. Stops the
  // same conversation reopening every single morning.
  lastReviewedAt: timestamp("last_reviewed_at"),
  agreedResponse: text("agreed_response").notNull().default(""),
  reviewAfter: text("review_after"), // ISO date
  notes: text("notes").notNull().default(""),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// The College's configured tone when reporting accountability. Intensity
// changes WORDING ONLY. It never changes what is true, never creates an
// obligation, and never grants any faculty member authority it lacks — the
// Layer 3 rule that personality cannot confer authority applies here exactly.
export const collegeAccountabilitySettings = pgTable("college_accountability_settings", {
  id: uuid("id").primaryKey().defaultRandom(),
  // gentle | direct | firm
  intensity: text("intensity").notNull().default("direct"),
  // How many days of history a pattern may be detected across.
  patternWindowDays: integer("pattern_window_days").notNull().default(14),
  // How many misses before the College names a pattern rather than an event.
  patternThreshold: integer("pattern_threshold").notNull().default(3),
  reason: text("reason").notNull().default(""),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export type CollegeCommitmentRow = typeof collegeCommitments.$inferSelect;
export type CollegeAccountabilitySettingsRow =
  typeof collegeAccountabilitySettings.$inferSelect;

// ===========================================================================
// LAYER 9 — INSTITUTIONAL SURFACES AND DEVICE IDENTITY
// ===========================================================================
// The College is about to be reachable from a phone over the public internet.
// Until now every route was open, which was survivable only because nothing
// but localhost could reach it.
//
// The model deliberately mirrors the Faculty authority model rather than
// inventing a second one: a SURFACE has a ceiling, configuration may only
// SUBTRACT from it, and no credential can grant authority the surface does
// not structurally hold. The phone is another institutional surface, not
// another institution.
// ===========================================================================

/** A paired client. One row per physical device that may talk to the College. */
export const collegeDevices = pgTable("college_devices", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Human label, e.g. "Lochie's iPhone". Shown in the Control Room. */
  name: text("name").notNull(),
  /**
   * Which institutional surface this device is. The ceiling is derived from
   * this and cannot be widened per-device.
   *   campus       — the phone. Inhabits the institution.
   *   control_room — desktop. Administers the institution.
   */
  surface: text("surface").notNull().default("campus"),
  /** SHA-256 of the bearer token. The token itself is shown exactly once. */
  tokenHash: text("token_hash").notNull(),
  /** Last 6 chars of the token, so a device is identifiable without storing it. */
  tokenHint: text("token_hint").notNull().default(""),
  platform: text("platform").notNull().default("unknown"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  lastSeenAt: timestamp("last_seen_at"),
  /** Revocation is immediate and permanent. A lost phone is a real scenario. */
  revokedAt: timestamp("revoked_at"),
  revokedReason: text("revoked_reason").notNull().default(""),
});

/**
 * Short-lived pairing codes. The phone never sees a long-lived secret until
 * it has proved it was physically handed a code by someone at the Control
 * Room, which is the only enrolment authority that exists.
 */
export const collegePairingCodes = pgTable("college_pairing_codes", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code").notNull().unique(),
  surface: text("surface").notNull().default("campus"),
  expiresAt: timestamp("expires_at").notNull(),
  usedAt: timestamp("used_at"),
  usedByDeviceId: uuid("used_by_device_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type CollegeDevice = typeof collegeDevices.$inferSelect;
export type CollegePairingCode = typeof collegePairingCodes.$inferSelect;
