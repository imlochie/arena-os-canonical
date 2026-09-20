CREATE TABLE "arcade_games" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"prompt" text NOT NULL,
	"game_type" text DEFAULT 'arena' NOT NULL,
	"engine" text DEFAULT 'verified' NOT NULL,
	"code" text NOT NULL,
	"parent_id" uuid,
	"project_id" uuid,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid,
	"kind" text DEFAULT 'brief' NOT NULL,
	"title" text DEFAULT 'Untitled artifact' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"source_type" text DEFAULT 'manual' NOT NULL,
	"source_id" text,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "assistants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"system_prompt" text NOT NULL,
	"base_model" text DEFAULT 'openai' NOT NULL,
	"temperature" real DEFAULT 0.7 NOT NULL,
	"avatar" text DEFAULT '🤖' NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "battle_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"battle_id" uuid NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "battles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"prompt" text NOT NULL,
	"category" text DEFAULT 'general' NOT NULL,
	"model_a_id" text NOT NULL,
	"model_b_id" text NOT NULL,
	"assistant_a_id" uuid,
	"assistant_b_id" uuid,
	"response_a" text DEFAULT '' NOT NULL,
	"response_b" text DEFAULT '' NOT NULL,
	"latency_a" integer DEFAULT 0 NOT NULL,
	"latency_b" integer DEFAULT 0 NOT NULL,
	"winner" text,
	"judge_result" text,
	"project_id" uuid,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_id" uuid NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "chats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text DEFAULT 'New chat' NOT NULL,
	"model_id" text DEFAULT 'openai' NOT NULL,
	"assistant_id" uuid,
	"project_id" uuid,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "cognitive_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid,
	"council_run_id" uuid,
	"title" text DEFAULT 'Untitled cognitive session' NOT NULL,
	"job_id" text DEFAULT 'second_brain' NOT NULL,
	"material" text NOT NULL,
	"model_a_id" text NOT NULL,
	"model_b_id" text NOT NULL,
	"synthesis_model" text NOT NULL,
	"role_a_label" text DEFAULT '' NOT NULL,
	"role_b_label" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'completed' NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "collab_contributions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"collab_id" uuid NOT NULL,
	"round" integer DEFAULT 1 NOT NULL,
	"contrib_index" integer DEFAULT 0 NOT NULL,
	"kind" text DEFAULT 'draft' NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"model_id" text DEFAULT 'openai' NOT NULL,
	"assistant_id" uuid,
	"content" text NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "collabs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"challenge" text NOT NULL,
	"category" text DEFAULT 'general' NOT NULL,
	"strategy" text DEFAULT 'council' NOT NULL,
	"collaborators" text DEFAULT '[]' NOT NULL,
	"synthesis_model" text DEFAULT 'openai' NOT NULL,
	"synthesis" text DEFAULT '' NOT NULL,
	"rounds" integer DEFAULT 1 NOT NULL,
	"best_contributor" integer,
	"project_id" uuid,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "council_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"kind" text DEFAULT 'brief' NOT NULL,
	"title" text DEFAULT 'Untitled artifact' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "council_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" text DEFAULT 'second_brain' NOT NULL,
	"material" text NOT NULL,
	"model_a_id" text DEFAULT 'openai' NOT NULL,
	"model_b_id" text DEFAULT 'deepseek' NOT NULL,
	"synthesis_model" text DEFAULT 'openai' NOT NULL,
	"role_a_label" text DEFAULT '' NOT NULL,
	"role_b_label" text DEFAULT '' NOT NULL,
	"perspective_a" text DEFAULT '' NOT NULL,
	"perspective_b" text DEFAULT '' NOT NULL,
	"critique_a" text DEFAULT '' NOT NULL,
	"critique_b" text DEFAULT '' NOT NULL,
	"synthesis" text DEFAULT '' NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"project_id" uuid,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "model_category_ratings" (
	"model_id" text NOT NULL,
	"category" text NOT NULL,
	"elo" integer DEFAULT 1200 NOT NULL,
	"battles" integer DEFAULT 0 NOT NULL,
	"wins" integer DEFAULT 0 NOT NULL,
	"ties" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "model_category_ratings_model_id_category_pk" PRIMARY KEY("model_id","category")
);
--> statement-breakpoint
CREATE TABLE "models" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"provider" text DEFAULT 'pollinations' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"is_free" boolean DEFAULT true NOT NULL,
	"elo" integer DEFAULT 1200 NOT NULL,
	"battles" integer DEFAULT 0 NOT NULL,
	"wins" integer DEFAULT 0 NOT NULL,
	"ties" integer DEFAULT 0 NOT NULL,
	"avg_latency_ms" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "privacy_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action" text NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "project_memory" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" text DEFAULT 'fact' NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"emoji" text DEFAULT '📁' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "prompt_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"prompt" text NOT NULL,
	"category" text DEFAULT 'general' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "college_accountability_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"intensity" text DEFAULT 'direct' NOT NULL,
	"pattern_window_days" integer DEFAULT 14 NOT NULL,
	"pattern_threshold" integer DEFAULT 3 NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "college_attention_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"event_id" uuid,
	"event_type" text DEFAULT '' NOT NULL,
	"position_key" text NOT NULL,
	"member_id" uuid,
	"member_name" text DEFAULT '' NOT NULL,
	"resolved_state" text NOT NULL,
	"action" text DEFAULT 'ignore' NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"decided_by" text DEFAULT 'institutional_default' NOT NULL,
	"provenance" text DEFAULT '[]' NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "college_audit_thresholds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope_type" text DEFAULT 'slot' NOT NULL,
	"scope_id" uuid,
	"min_observations" integer DEFAULT 4 NOT NULL,
	"min_weeks" integer DEFAULT 3 NOT NULL,
	"deviations_before_review" integer DEFAULT 3 NOT NULL,
	"review_interval_days" integer DEFAULT 28 NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "college_audits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" uuid,
	"scope_label" text DEFAULT '' NOT NULL,
	"period_start" text DEFAULT '' NOT NULL,
	"period_end" text DEFAULT '' NOT NULL,
	"compared_period_start" text DEFAULT '' NOT NULL,
	"compared_period_end" text DEFAULT '' NOT NULL,
	"curriculum_version_id" uuid,
	"timetable_version_id" uuid,
	"conditions_note" text DEFAULT '' NOT NULL,
	"comparable_conditions" boolean DEFAULT true NOT NULL,
	"dimensions" text DEFAULT '[]' NOT NULL,
	"evidence_considered" text DEFAULT '[]' NOT NULL,
	"faculty_observations" text DEFAULT '[]' NOT NULL,
	"contextual_factors" text DEFAULT '[]' NOT NULL,
	"audit_status" text DEFAULT 'insufficient_evidence' NOT NULL,
	"interpretation" text DEFAULT '' NOT NULL,
	"decision" text DEFAULT 'no_decision' NOT NULL,
	"decision_reason" text DEFAULT '' NOT NULL,
	"decided_by" text DEFAULT '' NOT NULL,
	"reopen_after" text,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "college_capabilities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"source_key" text DEFAULT '' NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "college_commitments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"statement" text NOT NULL,
	"commitment_type" text DEFAULT 'study_session' NOT NULL,
	"goal_id" uuid,
	"course_id" uuid,
	"external_commitment_id" uuid,
	"due_date" text,
	"planned_minutes" integer,
	"status" text DEFAULT 'open' NOT NULL,
	"missed_reason_kind" text DEFAULT '' NOT NULL,
	"missed_reason" text DEFAULT '' NOT NULL,
	"actual_minutes" integer,
	"completed_at" timestamp,
	"session_id" uuid,
	"origin" text DEFAULT 'student' NOT NULL,
	"accepted" boolean DEFAULT true NOT NULL,
	"last_reviewed_at" timestamp,
	"agreed_response" text DEFAULT '' NOT NULL,
	"review_after" text,
	"notes" text DEFAULT '' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "college_consultations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"requesting_position" text NOT NULL,
	"requested_position" text NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"question" text DEFAULT '' NOT NULL,
	"evidence_refs" text DEFAULT '[]' NOT NULL,
	"urgency" text DEFAULT 'normal' NOT NULL,
	"scope" text DEFAULT '' NOT NULL,
	"response_required" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"response" text DEFAULT '' NOT NULL,
	"outcome" text DEFAULT '' NOT NULL,
	"contribution_id" uuid,
	"responded_at" timestamp,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "college_context_signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"signal_type" text DEFAULT 'other' NOT NULL,
	"content" text NOT NULL,
	"origin" text DEFAULT 'declared' NOT NULL,
	"effective_from" text,
	"effective_to" text,
	"impact" text DEFAULT '' NOT NULL,
	"truth_class" text DEFAULT 'fact' NOT NULL,
	"confidence" text DEFAULT 'known' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "college_course_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"course_id" uuid NOT NULL,
	"version_id" uuid,
	"code" text NOT NULL,
	"title" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"status" text DEFAULT '' NOT NULL,
	"weekly_structure" text DEFAULT '[]' NOT NULL,
	"captured_at" timestamp DEFAULT now(),
	"reason" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "college_course_weeks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"course_id" uuid NOT NULL,
	"week_index" integer NOT NULL,
	"objective" text DEFAULT '' NOT NULL,
	"question_of_week" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"source_key" text DEFAULT '' NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "college_courses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"title" text NOT NULL,
	"school_key" text DEFAULT '' NOT NULL,
	"level" integer DEFAULT 100 NOT NULL,
	"course_type" text DEFAULT 'core' NOT NULL,
	"status" text DEFAULT 'blueprint' NOT NULL,
	"primary_capabilities" text DEFAULT '[]' NOT NULL,
	"secondary_capabilities" text DEFAULT '[]' NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"project_id" uuid,
	"source_key" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "college_curriculum_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version_id" uuid,
	"course_id" uuid,
	"change_type" text DEFAULT 'metadata_edit' NOT NULL,
	"significance" text DEFAULT 'metadata_edit' NOT NULL,
	"field" text DEFAULT '' NOT NULL,
	"previous_value" text DEFAULT '' NOT NULL,
	"new_value" text DEFAULT '' NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"initiated_by" text DEFAULT 'founder' NOT NULL,
	"effective_date" text,
	"record_id" uuid,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "college_curriculum_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version_id" uuid NOT NULL,
	"course_id" uuid NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"entry_status" text DEFAULT 'active' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "college_curriculum_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"rationale" text DEFAULT '' NOT NULL,
	"evidence" text DEFAULT '' NOT NULL,
	"affected_courses" text DEFAULT '[]' NOT NULL,
	"expected_consequences" text DEFAULT '' NOT NULL,
	"conflicts" text DEFAULT '' NOT NULL,
	"alternatives" text DEFAULT '' NOT NULL,
	"proposed_by" text DEFAULT 'faculty' NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"decided_by" text DEFAULT '' NOT NULL,
	"decided_at" timestamp,
	"decision_note" text DEFAULT '' NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "college_curriculum_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"term_id" uuid,
	"version_number" integer DEFAULT 1 NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"initiated_by" text DEFAULT 'founder' NOT NULL,
	"effective_from" text,
	"supersedes_id" uuid,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "college_day_themes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version_id" uuid,
	"day_of_week" integer NOT NULL,
	"theme" text DEFAULT '' NOT NULL,
	"color_key" text DEFAULT '' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "college_deviations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"term_id" uuid,
	"week_index" integer,
	"session_id" uuid,
	"slot_id" uuid,
	"deviation_type" text DEFAULT 'other' NOT NULL,
	"scheduled_state" text DEFAULT '' NOT NULL,
	"observed_state" text DEFAULT '' NOT NULL,
	"adjusted_state" text DEFAULT '' NOT NULL,
	"resolution" text DEFAULT 'open' NOT NULL,
	"decided_by" text DEFAULT '' NOT NULL,
	"decision_basis" text DEFAULT '' NOT NULL,
	"truth_class" text DEFAULT 'fact' NOT NULL,
	"confidence" text DEFAULT 'known' NOT NULL,
	"source_key" text DEFAULT '' NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "college_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"surface" text DEFAULT 'campus' NOT NULL,
	"token_hash" text NOT NULL,
	"token_hint" text DEFAULT '' NOT NULL,
	"platform" text DEFAULT 'unknown' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_seen_at" timestamp,
	"revoked_at" timestamp,
	"revoked_reason" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "college_event_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"date" text NOT NULL,
	"time" text DEFAULT '' NOT NULL,
	"occurred_at" timestamp DEFAULT now(),
	"sequence" integer DEFAULT 0 NOT NULL,
	"event_type" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"detail" text DEFAULT '{}' NOT NULL,
	"session_id" uuid,
	"slot_id" uuid,
	"course_id" uuid,
	"member_id" uuid,
	"position_key" text DEFAULT '' NOT NULL,
	"curriculum_version_id" uuid,
	"timetable_version_id" uuid,
	"actor" text DEFAULT 'system' NOT NULL,
	"severity" text DEFAULT 'informational' NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "college_external_commitments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"title" text NOT NULL,
	"commitment_type" text DEFAULT 'course' NOT NULL,
	"progress_state" text DEFAULT '' NOT NULL,
	"starts_on" text,
	"due_on" text,
	"ends_on" text,
	"status" text DEFAULT 'active' NOT NULL,
	"source_note" text DEFAULT '' NOT NULL,
	"evidence_level" text DEFAULT 'reported' NOT NULL,
	"last_confirmed_at" timestamp,
	"notes" text DEFAULT '' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "college_faculty" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"position_key" text NOT NULL,
	"name" text NOT NULL,
	"branch" text DEFAULT 'faculty' NOT NULL,
	"remit" text DEFAULT '' NOT NULL,
	"authority_boundary" text DEFAULT '' NOT NULL,
	"may_file_records" boolean DEFAULT false NOT NULL,
	"assessment_authority" text DEFAULT 'none' NOT NULL,
	"participates_in_class" boolean DEFAULT true NOT NULL,
	"output_type" text DEFAULT 'guidance' NOT NULL,
	"workforce_role_id" text DEFAULT '' NOT NULL,
	"context_scope" text DEFAULT '[]' NOT NULL,
	"derivation" text DEFAULT 'proposed' NOT NULL,
	"source_key" text DEFAULT '' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "college_faculty_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"member_id" uuid NOT NULL,
	"scope" text DEFAULT 'college' NOT NULL,
	"scope_ref" text DEFAULT '' NOT NULL,
	"participation" text DEFAULT 'optional' NOT NULL,
	"temporary" boolean DEFAULT false NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "college_faculty_attention" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"position_key" text NOT NULL,
	"state" text DEFAULT 'dormant' NOT NULL,
	"previous_state" text DEFAULT '' NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"triggered_by_event_id" uuid,
	"phase_key" text DEFAULT '' NOT NULL,
	"spoke" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "college_faculty_contributions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"position_key" text NOT NULL,
	"contribution_type" text DEFAULT 'observation' NOT NULL,
	"stance" text DEFAULT 'neutral' NOT NULL,
	"responds_to_id" uuid,
	"content" text DEFAULT '' NOT NULL,
	"truth_class" text DEFAULT 'interpretation' NOT NULL,
	"confidence" text DEFAULT 'inferred' NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "college_faculty_member_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"member_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"snapshot" text DEFAULT '{}' NOT NULL,
	"change_summary" text DEFAULT '' NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"changed_by" text DEFAULT 'founder' NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "college_faculty_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"position_key" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"temperament" text DEFAULT '' NOT NULL,
	"communication_style" text DEFAULT '' NOT NULL,
	"teaching_style" text DEFAULT '' NOT NULL,
	"questioning_style" text DEFAULT '' NOT NULL,
	"directness" integer DEFAULT 3 NOT NULL,
	"warmth" integer DEFAULT 3 NOT NULL,
	"formality" integer DEFAULT 3 NOT NULL,
	"ambiguity_tolerance" integer DEFAULT 3 NOT NULL,
	"personality_instruction" text DEFAULT '' NOT NULL,
	"responsibilities" text DEFAULT '[]' NOT NULL,
	"granted_authority" text DEFAULT '[]' NOT NULL,
	"mandatory_level" text DEFAULT 'optional' NOT NULL,
	"missing_severity" text DEFAULT 'warn' NOT NULL,
	"can_consult" text DEFAULT '[]' NOT NULL,
	"can_hand_off_to" text DEFAULT '[]' NOT NULL,
	"can_interrupt" text DEFAULT '[]' NOT NULL,
	"activates_on_events" text DEFAULT '[]' NOT NULL,
	"activates_on_phases" text DEFAULT '[]' NOT NULL,
	"watch_for" text DEFAULT '[]' NOT NULL,
	"stay_silent_on" text DEFAULT '[]' NOT NULL,
	"escalate_on" text DEFAULT '[]' NOT NULL,
	"defer_matters" text DEFAULT '[]' NOT NULL,
	"stop_attending_on" text DEFAULT '[]' NOT NULL,
	"interruption_authority" text DEFAULT '' NOT NULL,
	"default_state" text DEFAULT '' NOT NULL,
	"memory_enabled" boolean DEFAULT true NOT NULL,
	"memory_scope_limit" text DEFAULT 'course' NOT NULL,
	"preset_key" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "college_faculty_memory" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"member_id" uuid,
	"position_key" text DEFAULT '' NOT NULL,
	"course_id" uuid,
	"session_id" uuid,
	"content" text NOT NULL,
	"memory_scope" text DEFAULT 'session' NOT NULL,
	"observation_count" integer DEFAULT 1 NOT NULL,
	"promotion_status" text DEFAULT 'private' NOT NULL,
	"promoted_memory_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "college_faculty_protocols" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"course_id" uuid,
	"session_kind" text DEFAULT '' NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"positions" text DEFAULT '[]' NOT NULL,
	"phase_plan" text DEFAULT '[]' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "college_formative_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid,
	"course_id" uuid,
	"week_index" integer,
	"position_key" text DEFAULT 'instructor' NOT NULL,
	"evidence_type" text DEFAULT 'demonstrated_understanding' NOT NULL,
	"content" text NOT NULL,
	"capability_key" text DEFAULT '' NOT NULL,
	"assessment_kind" text DEFAULT 'formative' NOT NULL,
	"truth_class" text DEFAULT 'fact' NOT NULL,
	"confidence" text DEFAULT 'known' NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "college_goal_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"goal_id" uuid NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"relation" text DEFAULT 'contributes_to' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "college_goals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"scope" text DEFAULT 'student' NOT NULL,
	"origin" text DEFAULT '' NOT NULL,
	"purpose" text DEFAULT '' NOT NULL,
	"timeframe" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"progress_note" text DEFAULT '' NOT NULL,
	"obstacles" text DEFAULT '' NOT NULL,
	"truth_class" text DEFAULT 'decision' NOT NULL,
	"confidence" text DEFAULT 'known' NOT NULL,
	"source_key" text DEFAULT '' NOT NULL,
	"last_reviewed_at" timestamp,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "college_handoffs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"from_position" text NOT NULL,
	"to_position" text NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"payload" text DEFAULT '' NOT NULL,
	"disposition" text DEFAULT 'pending' NOT NULL,
	"disposition_reason" text DEFAULT '' NOT NULL,
	"crosses_branch" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "college_institution" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text DEFAULT 'Lochie Life College' NOT NULL,
	"motto" text DEFAULT 'Become by Learning.' NOT NULL,
	"founding_quote" text DEFAULT 'That''s Life.' NOT NULL,
	"timezone" text DEFAULT 'Australia/Brisbane' NOT NULL,
	"academic_year" integer DEFAULT 2026 NOT NULL,
	"institutional_phase" text DEFAULT '' NOT NULL,
	"declared_term_key" text DEFAULT '' NOT NULL,
	"declared_week_index" integer,
	"declared_week_theme" text DEFAULT '' NOT NULL,
	"declared_status_note" text DEFAULT '' NOT NULL,
	"declared_source_key" text DEFAULT '' NOT NULL,
	"declared_observed_at" timestamp,
	"faculty_status" text DEFAULT 'unknown' NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "college_institutional_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject" text NOT NULL,
	"subject_key" text DEFAULT '' NOT NULL,
	"conflict_key" text DEFAULT '' NOT NULL,
	"decision_type" text NOT NULL,
	"statement" text DEFAULT '' NOT NULL,
	"not_chosen" text DEFAULT '' NOT NULL,
	"rationale" text DEFAULT '' NOT NULL,
	"decided_by" text DEFAULT 'founder' NOT NULL,
	"effective_from" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"superseded_by" uuid,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "college_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid,
	"subject_key" text DEFAULT '' NOT NULL,
	"statement" text NOT NULL,
	"intent_kind" text DEFAULT 'plan' NOT NULL,
	"review_after_days" integer,
	"supersedes_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "college_interruptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"position_key" text NOT NULL,
	"interrupted_position" text DEFAULT '' NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"urgency" text DEFAULT 'normal' NOT NULL,
	"outcome" text DEFAULT 'refused' NOT NULL,
	"outcome_reason" text DEFAULT '' NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "college_memory" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" text DEFAULT 'teaching' NOT NULL,
	"course_id" uuid,
	"session_id" uuid,
	"epistemic_status" text DEFAULT 'observation' NOT NULL,
	"memory_type" text DEFAULT 'observation' NOT NULL,
	"content" text NOT NULL,
	"corroboration_count" integer DEFAULT 1 NOT NULL,
	"superseded_by_id" uuid,
	"authored_by" text DEFAULT 'faculty' NOT NULL,
	"truth_class" text DEFAULT 'fact' NOT NULL,
	"confidence" text DEFAULT 'known' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "college_memory_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"memory_id" uuid NOT NULL,
	"evidence_type" text DEFAULT 'memory' NOT NULL,
	"evidence_id" text DEFAULT '' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "college_notification_policy" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_type" text NOT NULL,
	"severity" text DEFAULT 'informational' NOT NULL,
	"occurrences_before_surfacing" integer DEFAULT 1 NOT NULL,
	"notify" boolean DEFAULT false NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "college_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"notification_key" text NOT NULL,
	"severity" text DEFAULT 'informational' NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"source_event_id" uuid,
	"scope_type" text DEFAULT '' NOT NULL,
	"scope_id" uuid,
	"occurrence_count" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"suppressed_until" text DEFAULT '' NOT NULL,
	"suppression_reason" text DEFAULT '' NOT NULL,
	"first_seen_at" timestamp DEFAULT now(),
	"last_seen_at" timestamp DEFAULT now(),
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "college_pairing_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"surface" text DEFAULT 'campus' NOT NULL,
	"expires_at" timestamp NOT NULL,
	"used_at" timestamp,
	"used_by_device_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "college_pairing_codes_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "college_reconciliations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conflict_key" text NOT NULL,
	"conflict_type" text DEFAULT 'other' NOT NULL,
	"subject" text NOT NULL,
	"source_a_key" text DEFAULT '' NOT NULL,
	"source_a_claim" text DEFAULT '' NOT NULL,
	"source_b_key" text DEFAULT '' NOT NULL,
	"source_b_claim" text DEFAULT '' NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	"provenance" text DEFAULT '' NOT NULL,
	"detected_at" timestamp DEFAULT now(),
	"last_seen_at" timestamp DEFAULT now(),
	"status" text DEFAULT 'open' NOT NULL,
	"required_authority" text DEFAULT '' NOT NULL,
	"required_action" text DEFAULT '' NOT NULL,
	"resolution" text DEFAULT '' NOT NULL,
	"resolution_provenance" text DEFAULT '' NOT NULL,
	"resolved_by" text DEFAULT '' NOT NULL,
	"resolved_at" timestamp,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "college_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"record_type" text DEFAULT 'session_record' NOT NULL,
	"subject" text NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"occurred_on" text,
	"recorded_at" timestamp DEFAULT now(),
	"filed_at" timestamp,
	"term_id" uuid,
	"week_index" integer,
	"course_id" uuid,
	"source_session_id" uuid,
	"authoring_faculty" text DEFAULT 'registrar' NOT NULL,
	"provenance" text DEFAULT '' NOT NULL,
	"truth_class" text DEFAULT 'fact' NOT NULL,
	"confidence" text DEFAULT 'known' NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"supersedes_id" uuid,
	"superseded_by_id" uuid,
	"correction_reason" text DEFAULT '' NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "college_schools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"derivation" text DEFAULT 'proposed' NOT NULL,
	"source_key" text DEFAULT '' NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "college_session_event_bus" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"sequence" integer DEFAULT 0 NOT NULL,
	"event_type" text NOT NULL,
	"payload" text DEFAULT '' NOT NULL,
	"emitted_by" text DEFAULT 'system' NOT NULL,
	"phase_key" text DEFAULT '' NOT NULL,
	"routed_to" text DEFAULT '[]' NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "college_session_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"stage" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"actor" text DEFAULT 'system' NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "college_session_faculty" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"faculty_id" uuid,
	"position_key" text NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"context_granted" text DEFAULT '[]' NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "college_session_faculty_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"member_id" uuid,
	"member_version_id" uuid,
	"position_key" text NOT NULL,
	"member_name" text DEFAULT '' NOT NULL,
	"participation" text DEFAULT 'optional' NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "college_session_phases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"phase_key" text NOT NULL,
	"sequence" integer DEFAULT 0 NOT NULL,
	"primary_positions" text DEFAULT '[]' NOT NULL,
	"watching_positions" text DEFAULT '[]' NOT NULL,
	"entered_at" timestamp DEFAULT now(),
	"exited_at" timestamp,
	"note" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "college_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"term_id" uuid,
	"week_index" integer,
	"course_id" uuid,
	"slot_id" uuid,
	"title" text DEFAULT 'Untitled session' NOT NULL,
	"session_kind" text DEFAULT 'lesson' NOT NULL,
	"scheduled_date" text,
	"scheduled_time" text DEFAULT '' NOT NULL,
	"observed_date" text,
	"stage" text DEFAULT 'scheduled' NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"objective" text DEFAULT '' NOT NULL,
	"faculty_plan" text DEFAULT '[]' NOT NULL,
	"curriculum_version_id" uuid,
	"course_snapshot_id" uuid,
	"cognitive_session_id" uuid,
	"council_run_id" uuid,
	"project_id" uuid,
	"filed_at" timestamp,
	"filed_record_id" uuid,
	"summary" text DEFAULT '' NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "college_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"title" text NOT NULL,
	"url" text DEFAULT '' NOT NULL,
	"authority_level" text DEFAULT 'operational' NOT NULL,
	"canonical_status" text DEFAULT 'unverified' NOT NULL,
	"owner" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"observed_at" timestamp DEFAULT now(),
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "college_state_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"computed_at" timestamp DEFAULT now(),
	"reason" text DEFAULT 'manual' NOT NULL,
	"brisbane_date" text DEFAULT '' NOT NULL,
	"derived_week_index" integer,
	"declared_week_index" integer,
	"conflict_count" integer DEFAULT 0 NOT NULL,
	"unknown_count" integer DEFAULT 0 NOT NULL,
	"payload" text DEFAULT '{}' NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "college_terms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"year" integer DEFAULT 2026 NOT NULL,
	"start_monday" text NOT NULL,
	"week_count" integer DEFAULT 10 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"source_key" text DEFAULT '' NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "college_timetable_instances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slot_id" uuid,
	"version_id" uuid,
	"date" text NOT NULL,
	"start_time" text DEFAULT '' NOT NULL,
	"end_time" text DEFAULT '' NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"course_id" uuid,
	"override_id" uuid,
	"runtime_status" text DEFAULT 'scheduled' NOT NULL,
	"status_evidence" text DEFAULT '' NOT NULL,
	"session_id" uuid,
	"deviation_id" uuid,
	"notes" text DEFAULT '' NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "college_timetable_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slot_id" uuid,
	"date" text NOT NULL,
	"exception_type" text DEFAULT 'cancelled' NOT NULL,
	"new_start_time" text DEFAULT '' NOT NULL,
	"new_end_time" text DEFAULT '' NOT NULL,
	"new_title" text DEFAULT '' NOT NULL,
	"new_course_id" uuid,
	"reason" text DEFAULT '' NOT NULL,
	"provenance" text DEFAULT 'founder' NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "college_timetable_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version_id" uuid,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"sequence" integer DEFAULT 0 NOT NULL,
	"start_time" text DEFAULT '' NOT NULL,
	"end_time" text DEFAULT '' NOT NULL,
	"intent" text DEFAULT '' NOT NULL,
	"icon" text DEFAULT '' NOT NULL,
	"color_key" text DEFAULT '' NOT NULL,
	"needs_configuration" boolean DEFAULT false NOT NULL,
	"configuration_note" text DEFAULT '' NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "college_timetable_slots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"term_id" uuid,
	"day_of_week" integer NOT NULL,
	"start_time" text DEFAULT '' NOT NULL,
	"course_id" uuid,
	"label" text DEFAULT '' NOT NULL,
	"session_kind" text DEFAULT 'lesson' NOT NULL,
	"school_key" text DEFAULT '' NOT NULL,
	"confidence" text DEFAULT 'inferred' NOT NULL,
	"source_key" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "college_timetable_template_slots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version_id" uuid,
	"period_id" uuid,
	"day_of_week" integer NOT NULL,
	"start_time" text DEFAULT '' NOT NULL,
	"end_time" text DEFAULT '' NOT NULL,
	"sequence" integer DEFAULT 0 NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"slot_behaviour" text DEFAULT 'scheduled' NOT NULL,
	"activity_type" text DEFAULT 'routine' NOT NULL,
	"category_key" text DEFAULT '' NOT NULL,
	"course_id" uuid,
	"session_kind" text DEFAULT '' NOT NULL,
	"generates_session" boolean DEFAULT false NOT NULL,
	"informs_college_state" boolean DEFAULT true NOT NULL,
	"faculty_requirement" text DEFAULT '[]' NOT NULL,
	"icon" text DEFAULT '' NOT NULL,
	"color_key" text DEFAULT '' NOT NULL,
	"items" text DEFAULT '[]' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"recurrence" text DEFAULT 'weekly' NOT NULL,
	"effective_from" text,
	"effective_to" text,
	"needs_configuration" boolean DEFAULT false NOT NULL,
	"configuration_note" text DEFAULT '' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "college_timetable_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"term_id" uuid,
	"version_number" integer DEFAULT 1 NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"effective_from" text,
	"effective_to" text,
	"supersedes_id" uuid,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "college_weeks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"term_id" uuid NOT NULL,
	"week_index" integer NOT NULL,
	"monday_date" text NOT NULL,
	"theme" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'not_started' NOT NULL,
	"evidence_note" text DEFAULT '' NOT NULL,
	"source_key" text DEFAULT '' NOT NULL,
	"created_at" timestamp DEFAULT now()
);
