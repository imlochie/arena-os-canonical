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
CREATE TABLE "archive_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"path" text,
	"kind" text DEFAULT 'other' NOT NULL,
	"size_bytes" integer,
	"content_hash" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'inbox' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"tags" text DEFAULT '' NOT NULL,
	"collection" text DEFAULT '' NOT NULL,
	"possible_dup_of" uuid,
	"source" text DEFAULT 'manual' NOT NULL,
	"project_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
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
	"created_at" timestamp DEFAULT now(),
	"runtime_a" jsonb,
	"runtime_b" jsonb,
	"rated" boolean DEFAULT true NOT NULL
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
CREATE TABLE "class_occurrences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"date" text NOT NULL,
	"classroom_key" text NOT NULL,
	"week_number" integer NOT NULL,
	"phase" text DEFAULT 'waiting' NOT NULL,
	"status" text DEFAULT 'waiting' NOT NULL,
	"collaboration_id" uuid,
	"opened_at" timestamp,
	"closed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
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
CREATE TABLE "collaboration_participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"collaboration_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"emoji" text DEFAULT '🤖' NOT NULL,
	"kind" text DEFAULT 'model' NOT NULL,
	"model_id" text,
	"adapter_url" text,
	"adapter_model" text,
	"capabilities" text DEFAULT '' NOT NULL,
	"trust" text DEFAULT 'internal' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "collaboration_relays" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"collaboration_id" uuid NOT NULL,
	"seq" integer DEFAULT 1 NOT NULL,
	"source_key" text DEFAULT 'owner' NOT NULL,
	"target_key" text NOT NULL,
	"purpose" text DEFAULT 'contribute' NOT NULL,
	"request" text NOT NULL,
	"context_refs" text DEFAULT '' NOT NULL,
	"classification" text DEFAULT 'internal' NOT NULL,
	"response_contract" text DEFAULT 'markdown text' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"response" text,
	"via" text DEFAULT '' NOT NULL,
	"runtime" jsonb,
	"note" text DEFAULT '' NOT NULL,
	"tool_use" integer DEFAULT 0 NOT NULL,
	"steps" text DEFAULT '[]' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "collaborations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text DEFAULT 'Untitled collaboration' NOT NULL,
	"goal" text NOT NULL,
	"context" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"auto_route" integer DEFAULT 0 NOT NULL,
	"project_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
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
CREATE TABLE "congress_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text DEFAULT 'Untitled congress' NOT NULL,
	"topic" text NOT NULL,
	"project_id" uuid,
	"status" text DEFAULT 'sitting' NOT NULL,
	"seats" text DEFAULT '[]' NOT NULL,
	"synthesis_model" text DEFAULT 'openai' NOT NULL,
	"duration_ms" integer DEFAULT 600000 NOT NULL,
	"remaining_ms" integer,
	"ends_at" timestamp,
	"turn_count" integer DEFAULT 0 NOT NULL,
	"next_seat" integer DEFAULT 0 NOT NULL,
	"max_turns" integer DEFAULT 50 NOT NULL,
	"act" text,
	"parent_session_id" uuid,
	"sitting" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "congress_turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"seat_index" integer DEFAULT -1 NOT NULL,
	"role" text DEFAULT '' NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"model_id" text DEFAULT '' NOT NULL,
	"content" text NOT NULL,
	"kind" text DEFAULT 'speech' NOT NULL,
	"runtime" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
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
	"created_at" timestamp DEFAULT now(),
	"runtime_a" jsonb,
	"runtime_b" jsonb,
	"runtime_synthesis" jsonb
);
--> statement-breakpoint
CREATE TABLE "cut_projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text DEFAULT 'Untitled cut' NOT NULL,
	"aspect" text DEFAULT '16:9' NOT NULL,
	"clips" text DEFAULT '[]' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "edu_memory" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"classroom_key" text NOT NULL,
	"week_number" integer,
	"kind" text DEFAULT 'observation' NOT NULL,
	"content" text NOT NULL,
	"source_occurrence_id" uuid,
	"collaboration_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL
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
CREATE TABLE "owner_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"content" text NOT NULL,
	"kind" text DEFAULT 'preference' NOT NULL,
	"classification" text DEFAULT 'internal' NOT NULL,
	"source" text DEFAULT 'owner' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
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
CREATE TABLE "arena_room_handoffs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"arena_project_id" uuid NOT NULL,
	"room" text NOT NULL,
	"room_project_id" text NOT NULL,
	"source_id" text,
	"kind" text NOT NULL,
	"title" text DEFAULT 'Untitled room handoff' NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"payload" text DEFAULT '{}' NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "space_agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"name" text NOT NULL,
	"role" text DEFAULT 'worker' NOT NULL,
	"model_id" text DEFAULT 'local-engine' NOT NULL,
	"system_prompt" text DEFAULT '' NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "space_missions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"goal" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"status_detail" text DEFAULT '' NOT NULL,
	"time_budget_ms" integer DEFAULT 600000 NOT NULL,
	"agent_plan" jsonb,
	"journal" jsonb,
	"artifacts" jsonb,
	"handoff" text DEFAULT '' NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"ended_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "space_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"agent_id" uuid,
	"agent_name" text,
	"status" text DEFAULT 'ok' NOT NULL,
	"output" text DEFAULT '' NOT NULL,
	"via" text DEFAULT '' NOT NULL,
	"ms" integer DEFAULT 0 NOT NULL,
	"runtime" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text DEFAULT 'Untitled space' NOT NULL,
	"emoji" text DEFAULT '🤖' NOT NULL,
	"prompt" text NOT NULL,
	"model_id" text DEFAULT 'openai' NOT NULL,
	"interval_minutes" integer DEFAULT 60 NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"briefcase" text DEFAULT '' NOT NULL,
	"last_output" text,
	"last_run_at" timestamp,
	"next_run_at" timestamp,
	"run_count" integer DEFAULT 0 NOT NULL,
	"watch_type" text,
	"watch_source" text,
	"watch_state" jsonb,
	"ok_count" integer DEFAULT 0 NOT NULL,
	"project_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "studio_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"backend" text NOT NULL,
	"external_id" text,
	"model_type" text NOT NULL,
	"model_name" text DEFAULT '' NOT NULL,
	"modality" text DEFAULT 'video' NOT NULL,
	"prompt" text NOT NULL,
	"negative_prompt" text DEFAULT '' NOT NULL,
	"settings" text DEFAULT '{}' NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"phase" text DEFAULT '' NOT NULL,
	"progress" real DEFAULT 0 NOT NULL,
	"files" text DEFAULT '[]' NOT NULL,
	"preview" text,
	"error" text,
	"seed" integer,
	"project_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "arrangement_layers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"source_asset_id" uuid NOT NULL,
	"source_checksum_sha256" text NOT NULL,
	"original_prompt" text DEFAULT '' NOT NULL,
	"instruction" text NOT NULL,
	"instrument" text NOT NULL,
	"mood" text NOT NULL,
	"density" text NOT NULL,
	"register_kind" text NOT NULL,
	"target_sections" text NOT NULL,
	"level" real NOT NULL,
	"seed" integer NOT NULL,
	"events" text NOT NULL,
	"notes" text NOT NULL,
	"storage_key" text NOT NULL,
	"renderer" text NOT NULL,
	"sample_rate" integer NOT NULL,
	"duration_seconds" real NOT NULL,
	"provenance" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automatic_remix_generations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"remix_session_id" uuid NOT NULL,
	"engine" text NOT NULL,
	"engine_version" text NOT NULL,
	"variant" text NOT NULL,
	"constraints" text NOT NULL,
	"provenance" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cleanup_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"source_asset_id" uuid NOT NULL,
	"operations" text NOT NULL,
	"storage_key" text NOT NULL,
	"measurements_before" text NOT NULL,
	"measurements_after" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drum_analyses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"source_asset_id" uuid NOT NULL,
	"stem_asset_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"stage" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"idempotency_key" text NOT NULL,
	"analysis_engine" text NOT NULL,
	"analysis_engine_version" text NOT NULL,
	"source_checksum_sha256" text NOT NULL,
	"stem_checksum_sha256" text NOT NULL,
	"error_code" text,
	"error_message" text,
	"started_at" timestamp with time zone,
	"analyzed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drum_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"drum_analysis_id" uuid NOT NULL,
	"event_index" integer NOT NULL,
	"timestamp_ms" integer NOT NULL,
	"strength" real NOT NULL,
	"confidence" real NOT NULL,
	"rhythmic_class" text,
	"nearest_beat_index" integer,
	"beat_offset_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "export_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"export_job_id" uuid NOT NULL,
	"remix_version_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"filename" text NOT NULL,
	"checksum_sha256" text NOT NULL,
	"duration_seconds" integer NOT NULL,
	"sample_rate" integer NOT NULL,
	"channels" integer NOT NULL,
	"codec" text NOT NULL,
	"format" text NOT NULL,
	"file_size_bytes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "export_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"remix_session_id" uuid NOT NULL,
	"remix_version_id" uuid NOT NULL,
	"requested_by_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"stage" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"idempotency_key" text NOT NULL,
	"format" text DEFAULT 'wav' NOT NULL,
	"midi_kind" text,
	"midi_source_asset_id" uuid,
	"midi_stem_asset_id" uuid,
	"midi_ppq" integer,
	"midi_analysis_id" text,
	"midi_source_checksum_sha256" text,
	"midi_analysis_engine" text,
	"midi_analysis_engine_version" text,
	"sample_rate" integer DEFAULT 44100 NOT NULL,
	"channels" integer DEFAULT 2 NOT NULL,
	"error_code" text,
	"error_message" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "harmony_analyses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"source_asset_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"stage" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"idempotency_key" text NOT NULL,
	"analysis_engine" text NOT NULL,
	"analysis_engine_version" text NOT NULL,
	"source_checksum_sha256" text NOT NULL,
	"error_code" text,
	"error_message" text,
	"started_at" timestamp with time zone,
	"analyzed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "harmony_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"harmony_analysis_id" uuid NOT NULL,
	"event_index" integer NOT NULL,
	"start_ms" integer NOT NULL,
	"end_ms" integer NOT NULL,
	"root" text,
	"quality" text NOT NULL,
	"confidence" real NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "processing_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"source_asset_id" uuid NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"stage" text DEFAULT 'queued' NOT NULL,
	"idempotency_key" text NOT NULL,
	"model" text NOT NULL,
	"requested_device" text NOT NULL,
	"resolved_device" text,
	"error_code" text,
	"error_message" text,
	"metadata" text DEFAULT '{}' NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"reason" text,
	"metadata" text DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_builds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"requested_by_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"stage" text DEFAULT 'resolving-sources' NOT NULL,
	"requested_source_count" integer DEFAULT 0 NOT NULL,
	"accepted_source_count" integer DEFAULT 0 NOT NULL,
	"failed_source_count" integer DEFAULT 0 NOT NULL,
	"details" text DEFAULT '{}' NOT NULL,
	"remix_session_id" uuid,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wy_projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"artwork_key" text,
	"genre" text,
	"tags" text DEFAULT '[]' NOT NULL,
	"license_code" text DEFAULT 'all-rights-reserved' NOT NULL,
	"remix_permission" text DEFAULT 'owner-only' NOT NULL,
	"download_permission" text DEFAULT 'owner-only' NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"publication_status" text DEFAULT 'draft' NOT NULL,
	"moderation_status" text DEFAULT 'active' NOT NULL,
	"published_export_asset_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "remix_automation_points" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"remix_session_id" uuid NOT NULL,
	"remix_track_id" uuid NOT NULL,
	"parameter" text NOT NULL,
	"timeline_ms" integer NOT NULL,
	"value" real NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "remix_clips" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"remix_track_id" uuid NOT NULL,
	"stem_asset_id" uuid NOT NULL,
	"timeline_start_ms" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer NOT NULL,
	"source_offset_ms" integer DEFAULT 0 NOT NULL,
	"gain" real DEFAULT 1 NOT NULL,
	"fade_in_ms" integer DEFAULT 0 NOT NULL,
	"fade_out_ms" integer DEFAULT 0 NOT NULL,
	"tempo_sync_enabled" boolean DEFAULT false NOT NULL,
	"key_sync_enabled" boolean DEFAULT false NOT NULL,
	"beat_snap_enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "remix_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"master_volume" real DEFAULT 1 NOT NULL,
	"master_inserts" text DEFAULT '[]' NOT NULL,
	"loop_start_ms" integer DEFAULT 0 NOT NULL,
	"loop_end_ms" integer,
	"tempo_bpm" real DEFAULT 120 NOT NULL,
	"time_signature_numerator" integer DEFAULT 4 NOT NULL,
	"time_signature_denominator" integer DEFAULT 4 NOT NULL,
	"grid_division" text DEFAULT 'beat' NOT NULL,
	"snap_enabled" boolean DEFAULT true NOT NULL,
	"target_key" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "remix_tracks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"remix_session_id" uuid NOT NULL,
	"stem_asset_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"volume" real DEFAULT 1 NOT NULL,
	"pan" real DEFAULT 0 NOT NULL,
	"muted" boolean DEFAULT false NOT NULL,
	"solo" boolean DEFAULT false NOT NULL,
	"inserts" text DEFAULT '[]' NOT NULL,
	"phase_inverted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "remix_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"remix_session_id" uuid NOT NULL,
	"created_by_id" uuid NOT NULL,
	"name" text NOT NULL,
	"snapshot" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sound_design_assets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"recipe" text NOT NULL,
	"storage_key" text NOT NULL,
	"duration_seconds" real NOT NULL,
	"sample_rate" integer NOT NULL,
	"muted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_acquisitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_asset_id" uuid NOT NULL,
	"method" text NOT NULL,
	"source_url" text,
	"title" text,
	"artist" text,
	"resolver" text,
	"metadata" text DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_analyses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"source_asset_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"stage" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"idempotency_key" text NOT NULL,
	"analysis_engine" text NOT NULL,
	"analysis_engine_version" text NOT NULL,
	"source_checksum_sha256" text NOT NULL,
	"bpm" real,
	"bpm_confidence" real,
	"musical_key" text,
	"key_confidence" real,
	"beat_grid" text,
	"beat_confidence" real,
	"analysis_error" text,
	"error_code" text,
	"started_at" timestamp with time zone,
	"analyzed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"original_filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"storage_key" text NOT NULL,
	"checksum_sha256" text NOT NULL,
	"duration_seconds" integer NOT NULL,
	"sample_rate" integer NOT NULL,
	"channels" integer NOT NULL,
	"codec" text NOT NULL,
	"bitrate" integer,
	"file_size_bytes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_event_analyses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"source_asset_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"stage" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"idempotency_key" text NOT NULL,
	"analysis_engine" text NOT NULL,
	"analysis_engine_version" text NOT NULL,
	"source_checksum_sha256" text NOT NULL,
	"error_code" text,
	"error_message" text,
	"started_at" timestamp with time zone,
	"analyzed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"source_asset_id" uuid NOT NULL,
	"source_event_analysis_id" uuid NOT NULL,
	"event_index" integer NOT NULL,
	"timestamp_ms" integer NOT NULL,
	"strength" real NOT NULL,
	"confidence" real DEFAULT 0 NOT NULL,
	"rhythmic_class" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_section_analyses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"source_asset_id" uuid NOT NULL,
	"source_analysis_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"stage" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"idempotency_key" text NOT NULL,
	"analysis_engine" text NOT NULL,
	"analysis_engine_version" text NOT NULL,
	"source_checksum_sha256" text NOT NULL,
	"error_code" text,
	"error_message" text,
	"started_at" timestamp with time zone,
	"analyzed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_sections" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"source_asset_id" uuid NOT NULL,
	"source_analysis_id" uuid NOT NULL,
	"source_section_analysis_id" uuid NOT NULL,
	"section_index" integer NOT NULL,
	"start_ms" integer NOT NULL,
	"end_ms" integer NOT NULL,
	"start_beat_index" integer NOT NULL,
	"end_beat_index" integer NOT NULL,
	"start_bar" integer NOT NULL,
	"end_bar" integer NOT NULL,
	"label" text DEFAULT 'section' NOT NULL,
	"label_confidence" real DEFAULT 0 NOT NULL,
	"structural_confidence" real NOT NULL,
	"analysis_engine" text NOT NULL,
	"analysis_engine_version" text NOT NULL,
	"source_checksum_sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stem_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"source_asset_id" uuid NOT NULL,
	"separation_job_id" uuid NOT NULL,
	"stem_type" text NOT NULL,
	"engine" text NOT NULL,
	"model" text NOT NULL,
	"model_version" text NOT NULL,
	"storage_key" text NOT NULL,
	"waveform_key" text,
	"checksum_sha256" text NOT NULL,
	"duration_seconds" integer NOT NULL,
	"sample_rate" integer NOT NULL,
	"channels" integer NOT NULL,
	"codec" text NOT NULL,
	"format" text NOT NULL,
	"file_size_bytes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vocal_analyses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"source_asset_id" uuid NOT NULL,
	"stem_asset_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"stage" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"idempotency_key" text NOT NULL,
	"analysis_engine" text NOT NULL,
	"analysis_engine_version" text NOT NULL,
	"source_checksum_sha256" text NOT NULL,
	"stem_checksum_sha256" text NOT NULL,
	"error_code" text,
	"error_message" text,
	"started_at" timestamp with time zone,
	"analyzed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vocal_phrases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vocal_analysis_id" uuid NOT NULL,
	"phrase_index" integer NOT NULL,
	"start_ms" integer NOT NULL,
	"end_ms" integer NOT NULL,
	"confidence" real NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vocal_pitch_frames" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vocal_analysis_id" uuid NOT NULL,
	"frame_index" integer NOT NULL,
	"timestamp_ms" integer NOT NULL,
	"frequency_hz" real,
	"midi_float" real,
	"nearest_midi_note" integer,
	"confidence" real NOT NULL,
	"voiced" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "waveform_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"source_asset_id" uuid,
	"stem_asset_id" uuid,
	"waveform_job_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"checksum_sha256" text NOT NULL,
	"format" text DEFAULT 'waveyard-peaks-v1' NOT NULL,
	"metadata" text DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "waveform_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"source_asset_id" uuid,
	"stem_asset_id" uuid,
	"status" text DEFAULT 'queued' NOT NULL,
	"stage" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"idempotency_key" text NOT NULL,
	"error_code" text,
	"error_message" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "space_agents" ADD CONSTRAINT "space_agents_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_missions" ADD CONSTRAINT "space_missions_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "arrangement_layers" ADD CONSTRAINT "arrangement_layers_project_id_wy_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."wy_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "arrangement_layers" ADD CONSTRAINT "arrangement_layers_source_asset_id_source_assets_id_fk" FOREIGN KEY ("source_asset_id") REFERENCES "public"."source_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automatic_remix_generations" ADD CONSTRAINT "automatic_remix_generations_remix_session_id_remix_sessions_id_fk" FOREIGN KEY ("remix_session_id") REFERENCES "public"."remix_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cleanup_versions" ADD CONSTRAINT "cleanup_versions_project_id_wy_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."wy_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cleanup_versions" ADD CONSTRAINT "cleanup_versions_source_asset_id_source_assets_id_fk" FOREIGN KEY ("source_asset_id") REFERENCES "public"."source_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drum_analyses" ADD CONSTRAINT "drum_analyses_project_id_wy_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."wy_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drum_analyses" ADD CONSTRAINT "drum_analyses_source_asset_id_source_assets_id_fk" FOREIGN KEY ("source_asset_id") REFERENCES "public"."source_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drum_analyses" ADD CONSTRAINT "drum_analyses_stem_asset_id_stem_assets_id_fk" FOREIGN KEY ("stem_asset_id") REFERENCES "public"."stem_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drum_events" ADD CONSTRAINT "drum_events_drum_analysis_id_drum_analyses_id_fk" FOREIGN KEY ("drum_analysis_id") REFERENCES "public"."drum_analyses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_assets" ADD CONSTRAINT "export_assets_project_id_wy_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."wy_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_assets" ADD CONSTRAINT "export_assets_export_job_id_export_jobs_id_fk" FOREIGN KEY ("export_job_id") REFERENCES "public"."export_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_assets" ADD CONSTRAINT "export_assets_remix_version_id_remix_versions_id_fk" FOREIGN KEY ("remix_version_id") REFERENCES "public"."remix_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_jobs" ADD CONSTRAINT "export_jobs_project_id_wy_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."wy_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_jobs" ADD CONSTRAINT "export_jobs_remix_session_id_remix_sessions_id_fk" FOREIGN KEY ("remix_session_id") REFERENCES "public"."remix_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_jobs" ADD CONSTRAINT "export_jobs_remix_version_id_remix_versions_id_fk" FOREIGN KEY ("remix_version_id") REFERENCES "public"."remix_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_jobs" ADD CONSTRAINT "export_jobs_midi_source_asset_id_source_assets_id_fk" FOREIGN KEY ("midi_source_asset_id") REFERENCES "public"."source_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_jobs" ADD CONSTRAINT "export_jobs_midi_stem_asset_id_stem_assets_id_fk" FOREIGN KEY ("midi_stem_asset_id") REFERENCES "public"."stem_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "harmony_analyses" ADD CONSTRAINT "harmony_analyses_project_id_wy_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."wy_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "harmony_analyses" ADD CONSTRAINT "harmony_analyses_source_asset_id_source_assets_id_fk" FOREIGN KEY ("source_asset_id") REFERENCES "public"."source_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "harmony_events" ADD CONSTRAINT "harmony_events_harmony_analysis_id_harmony_analyses_id_fk" FOREIGN KEY ("harmony_analysis_id") REFERENCES "public"."harmony_analyses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_jobs" ADD CONSTRAINT "processing_jobs_project_id_wy_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."wy_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_jobs" ADD CONSTRAINT "processing_jobs_source_asset_id_source_assets_id_fk" FOREIGN KEY ("source_asset_id") REFERENCES "public"."source_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_audit_events" ADD CONSTRAINT "project_audit_events_project_id_wy_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."wy_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_builds" ADD CONSTRAINT "project_builds_project_id_wy_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."wy_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_builds" ADD CONSTRAINT "project_builds_remix_session_id_remix_sessions_id_fk" FOREIGN KEY ("remix_session_id") REFERENCES "public"."remix_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remix_automation_points" ADD CONSTRAINT "remix_automation_points_remix_session_id_remix_sessions_id_fk" FOREIGN KEY ("remix_session_id") REFERENCES "public"."remix_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remix_automation_points" ADD CONSTRAINT "remix_automation_points_remix_track_id_remix_tracks_id_fk" FOREIGN KEY ("remix_track_id") REFERENCES "public"."remix_tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remix_clips" ADD CONSTRAINT "remix_clips_remix_track_id_remix_tracks_id_fk" FOREIGN KEY ("remix_track_id") REFERENCES "public"."remix_tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remix_clips" ADD CONSTRAINT "remix_clips_stem_asset_id_stem_assets_id_fk" FOREIGN KEY ("stem_asset_id") REFERENCES "public"."stem_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remix_sessions" ADD CONSTRAINT "remix_sessions_project_id_wy_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."wy_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remix_tracks" ADD CONSTRAINT "remix_tracks_remix_session_id_remix_sessions_id_fk" FOREIGN KEY ("remix_session_id") REFERENCES "public"."remix_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remix_tracks" ADD CONSTRAINT "remix_tracks_stem_asset_id_stem_assets_id_fk" FOREIGN KEY ("stem_asset_id") REFERENCES "public"."stem_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remix_versions" ADD CONSTRAINT "remix_versions_remix_session_id_remix_sessions_id_fk" FOREIGN KEY ("remix_session_id") REFERENCES "public"."remix_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sound_design_assets" ADD CONSTRAINT "sound_design_assets_project_id_wy_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."wy_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_acquisitions" ADD CONSTRAINT "source_acquisitions_source_asset_id_source_assets_id_fk" FOREIGN KEY ("source_asset_id") REFERENCES "public"."source_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_analyses" ADD CONSTRAINT "source_analyses_project_id_wy_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."wy_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_analyses" ADD CONSTRAINT "source_analyses_source_asset_id_source_assets_id_fk" FOREIGN KEY ("source_asset_id") REFERENCES "public"."source_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_assets" ADD CONSTRAINT "source_assets_project_id_wy_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."wy_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_event_analyses" ADD CONSTRAINT "source_event_analyses_project_id_wy_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."wy_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_event_analyses" ADD CONSTRAINT "source_event_analyses_source_asset_id_source_assets_id_fk" FOREIGN KEY ("source_asset_id") REFERENCES "public"."source_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_events" ADD CONSTRAINT "source_events_project_id_wy_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."wy_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_events" ADD CONSTRAINT "source_events_source_asset_id_source_assets_id_fk" FOREIGN KEY ("source_asset_id") REFERENCES "public"."source_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_events" ADD CONSTRAINT "source_events_source_event_analysis_id_source_event_analyses_id_fk" FOREIGN KEY ("source_event_analysis_id") REFERENCES "public"."source_event_analyses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_section_analyses" ADD CONSTRAINT "source_section_analyses_project_id_wy_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."wy_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_section_analyses" ADD CONSTRAINT "source_section_analyses_source_asset_id_source_assets_id_fk" FOREIGN KEY ("source_asset_id") REFERENCES "public"."source_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_section_analyses" ADD CONSTRAINT "source_section_analyses_source_analysis_id_source_analyses_id_fk" FOREIGN KEY ("source_analysis_id") REFERENCES "public"."source_analyses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_sections" ADD CONSTRAINT "source_sections_project_id_wy_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."wy_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_sections" ADD CONSTRAINT "source_sections_source_asset_id_source_assets_id_fk" FOREIGN KEY ("source_asset_id") REFERENCES "public"."source_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_sections" ADD CONSTRAINT "source_sections_source_analysis_id_source_analyses_id_fk" FOREIGN KEY ("source_analysis_id") REFERENCES "public"."source_analyses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_sections" ADD CONSTRAINT "source_sections_source_section_analysis_id_source_section_analyses_id_fk" FOREIGN KEY ("source_section_analysis_id") REFERENCES "public"."source_section_analyses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stem_assets" ADD CONSTRAINT "stem_assets_project_id_wy_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."wy_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stem_assets" ADD CONSTRAINT "stem_assets_source_asset_id_source_assets_id_fk" FOREIGN KEY ("source_asset_id") REFERENCES "public"."source_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stem_assets" ADD CONSTRAINT "stem_assets_separation_job_id_processing_jobs_id_fk" FOREIGN KEY ("separation_job_id") REFERENCES "public"."processing_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vocal_analyses" ADD CONSTRAINT "vocal_analyses_project_id_wy_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."wy_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vocal_analyses" ADD CONSTRAINT "vocal_analyses_source_asset_id_source_assets_id_fk" FOREIGN KEY ("source_asset_id") REFERENCES "public"."source_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vocal_analyses" ADD CONSTRAINT "vocal_analyses_stem_asset_id_stem_assets_id_fk" FOREIGN KEY ("stem_asset_id") REFERENCES "public"."stem_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vocal_phrases" ADD CONSTRAINT "vocal_phrases_vocal_analysis_id_vocal_analyses_id_fk" FOREIGN KEY ("vocal_analysis_id") REFERENCES "public"."vocal_analyses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vocal_pitch_frames" ADD CONSTRAINT "vocal_pitch_frames_vocal_analysis_id_vocal_analyses_id_fk" FOREIGN KEY ("vocal_analysis_id") REFERENCES "public"."vocal_analyses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waveform_assets" ADD CONSTRAINT "waveform_assets_project_id_wy_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."wy_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waveform_assets" ADD CONSTRAINT "waveform_assets_source_asset_id_source_assets_id_fk" FOREIGN KEY ("source_asset_id") REFERENCES "public"."source_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waveform_assets" ADD CONSTRAINT "waveform_assets_stem_asset_id_stem_assets_id_fk" FOREIGN KEY ("stem_asset_id") REFERENCES "public"."stem_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waveform_assets" ADD CONSTRAINT "waveform_assets_waveform_job_id_waveform_jobs_id_fk" FOREIGN KEY ("waveform_job_id") REFERENCES "public"."waveform_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waveform_jobs" ADD CONSTRAINT "waveform_jobs_project_id_wy_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."wy_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waveform_jobs" ADD CONSTRAINT "waveform_jobs_source_asset_id_source_assets_id_fk" FOREIGN KEY ("source_asset_id") REFERENCES "public"."source_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waveform_jobs" ADD CONSTRAINT "waveform_jobs_stem_asset_id_stem_assets_id_fk" FOREIGN KEY ("stem_asset_id") REFERENCES "public"."stem_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "arena_room_handoffs_project_created_idx" ON "arena_room_handoffs" USING btree ("arena_project_id","created_at");--> statement-breakpoint
CREATE INDEX "arena_room_handoffs_room_project_idx" ON "arena_room_handoffs" USING btree ("room","room_project_id");--> statement-breakpoint
CREATE INDEX "arrangement_layers_project_idx" ON "arrangement_layers" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "arrangement_layers_storage_key_unique" ON "arrangement_layers" USING btree ("storage_key");--> statement-breakpoint
CREATE UNIQUE INDEX "automatic_remix_generations_session_unique" ON "automatic_remix_generations" USING btree ("remix_session_id");--> statement-breakpoint
CREATE INDEX "automatic_remix_generations_session_idx" ON "automatic_remix_generations" USING btree ("remix_session_id");--> statement-breakpoint
CREATE INDEX "cleanup_versions_project_idx" ON "cleanup_versions" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cleanup_versions_storage_key_unique" ON "cleanup_versions" USING btree ("storage_key");--> statement-breakpoint
CREATE UNIQUE INDEX "drum_analyses_stem_asset_unique" ON "drum_analyses" USING btree ("stem_asset_id");--> statement-breakpoint
CREATE UNIQUE INDEX "drum_analyses_idempotency_unique" ON "drum_analyses" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "drum_analyses_project_id_idx" ON "drum_analyses" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "drum_analyses_source_stem_idx" ON "drum_analyses" USING btree ("source_asset_id","stem_asset_id");--> statement-breakpoint
CREATE UNIQUE INDEX "drum_events_analysis_index_unique" ON "drum_events" USING btree ("drum_analysis_id","event_index");--> statement-breakpoint
CREATE INDEX "drum_events_analysis_time_idx" ON "drum_events" USING btree ("drum_analysis_id","timestamp_ms");--> statement-breakpoint
CREATE UNIQUE INDEX "export_assets_job_unique" ON "export_assets" USING btree ("export_job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "export_assets_storage_key_unique" ON "export_assets" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "export_assets_project_id_idx" ON "export_assets" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "export_assets_version_id_idx" ON "export_assets" USING btree ("remix_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "export_jobs_idempotency_unique" ON "export_jobs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "export_jobs_project_id_idx" ON "export_jobs" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "export_jobs_version_id_idx" ON "export_jobs" USING btree ("remix_version_id");--> statement-breakpoint
CREATE INDEX "export_jobs_status_idx" ON "export_jobs" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "harmony_analyses_source_asset_unique" ON "harmony_analyses" USING btree ("source_asset_id");--> statement-breakpoint
CREATE UNIQUE INDEX "harmony_analyses_idempotency_unique" ON "harmony_analyses" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "harmony_analyses_project_id_idx" ON "harmony_analyses" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "harmony_events_analysis_index_unique" ON "harmony_events" USING btree ("harmony_analysis_id","event_index");--> statement-breakpoint
CREATE INDEX "harmony_events_analysis_start_idx" ON "harmony_events" USING btree ("harmony_analysis_id","start_ms");--> statement-breakpoint
CREATE UNIQUE INDEX "processing_jobs_idempotency_unique" ON "processing_jobs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "processing_jobs_project_id_idx" ON "processing_jobs" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "processing_jobs_status_idx" ON "processing_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "project_audit_events_project_created_idx" ON "project_audit_events" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "project_audit_events_type_created_idx" ON "project_audit_events" USING btree ("event_type","created_at");--> statement-breakpoint
CREATE INDEX "project_builds_project_updated_idx" ON "project_builds" USING btree ("project_id","updated_at");--> statement-breakpoint
CREATE INDEX "projects_owner_id_idx" ON "wy_projects" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "projects_visibility_idx" ON "wy_projects" USING btree ("visibility");--> statement-breakpoint
CREATE UNIQUE INDEX "remix_automation_points_track_parameter_time_unique" ON "remix_automation_points" USING btree ("remix_track_id","parameter","timeline_ms");--> statement-breakpoint
CREATE INDEX "remix_automation_points_session_track_idx" ON "remix_automation_points" USING btree ("remix_session_id","remix_track_id");--> statement-breakpoint
CREATE INDEX "remix_clips_track_id_idx" ON "remix_clips" USING btree ("remix_track_id");--> statement-breakpoint
CREATE INDEX "remix_clips_asset_id_idx" ON "remix_clips" USING btree ("stem_asset_id");--> statement-breakpoint
CREATE INDEX "remix_sessions_project_id_idx" ON "remix_sessions" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "remix_sessions_owner_id_idx" ON "remix_sessions" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "remix_tracks_session_id_idx" ON "remix_tracks" USING btree ("remix_session_id");--> statement-breakpoint
CREATE INDEX "remix_tracks_session_stem_idx" ON "remix_tracks" USING btree ("remix_session_id","stem_asset_id");--> statement-breakpoint
CREATE INDEX "remix_versions_session_id_idx" ON "remix_versions" USING btree ("remix_session_id");--> statement-breakpoint
CREATE INDEX "sound_design_project_idx" ON "sound_design_assets" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sound_design_storage_key_unique" ON "sound_design_assets" USING btree ("storage_key");--> statement-breakpoint
CREATE UNIQUE INDEX "source_acquisitions_source_unique" ON "source_acquisitions" USING btree ("source_asset_id");--> statement-breakpoint
CREATE INDEX "source_acquisitions_method_idx" ON "source_acquisitions" USING btree ("method");--> statement-breakpoint
CREATE UNIQUE INDEX "source_analyses_source_asset_unique" ON "source_analyses" USING btree ("source_asset_id");--> statement-breakpoint
CREATE UNIQUE INDEX "source_analyses_idempotency_unique" ON "source_analyses" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "source_analyses_project_id_idx" ON "source_analyses" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "source_analyses_status_idx" ON "source_analyses" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "source_assets_storage_key_unique" ON "source_assets" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "source_assets_project_id_idx" ON "source_assets" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "source_event_analyses_source_asset_unique" ON "source_event_analyses" USING btree ("source_asset_id");--> statement-breakpoint
CREATE UNIQUE INDEX "source_event_analyses_idempotency_unique" ON "source_event_analyses" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "source_event_analyses_project_id_idx" ON "source_event_analyses" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "source_events_analysis_index_unique" ON "source_events" USING btree ("source_event_analysis_id","event_index");--> statement-breakpoint
CREATE INDEX "source_events_source_time_idx" ON "source_events" USING btree ("source_asset_id","timestamp_ms");--> statement-breakpoint
CREATE INDEX "source_events_project_id_idx" ON "source_events" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "source_section_analyses_source_asset_unique" ON "source_section_analyses" USING btree ("source_asset_id");--> statement-breakpoint
CREATE UNIQUE INDEX "source_section_analyses_idempotency_unique" ON "source_section_analyses" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "source_section_analyses_project_id_idx" ON "source_section_analyses" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "source_section_analyses_status_idx" ON "source_section_analyses" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "source_sections_source_index_unique" ON "source_sections" USING btree ("source_asset_id","section_index");--> statement-breakpoint
CREATE INDEX "source_sections_source_order_idx" ON "source_sections" USING btree ("source_asset_id","section_index");--> statement-breakpoint
CREATE INDEX "source_sections_project_id_idx" ON "source_sections" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stem_assets_job_stem_unique" ON "stem_assets" USING btree ("separation_job_id","stem_type");--> statement-breakpoint
CREATE UNIQUE INDEX "stem_assets_storage_key_unique" ON "stem_assets" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "stem_assets_project_id_idx" ON "stem_assets" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vocal_analyses_stem_asset_unique" ON "vocal_analyses" USING btree ("stem_asset_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vocal_analyses_idempotency_unique" ON "vocal_analyses" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "vocal_analyses_project_id_idx" ON "vocal_analyses" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "vocal_analyses_source_stem_idx" ON "vocal_analyses" USING btree ("source_asset_id","stem_asset_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vocal_phrases_analysis_index_unique" ON "vocal_phrases" USING btree ("vocal_analysis_id","phrase_index");--> statement-breakpoint
CREATE INDEX "vocal_phrases_analysis_start_idx" ON "vocal_phrases" USING btree ("vocal_analysis_id","start_ms");--> statement-breakpoint
CREATE UNIQUE INDEX "vocal_pitch_frames_analysis_index_unique" ON "vocal_pitch_frames" USING btree ("vocal_analysis_id","frame_index");--> statement-breakpoint
CREATE INDEX "vocal_pitch_frames_analysis_time_idx" ON "vocal_pitch_frames" USING btree ("vocal_analysis_id","timestamp_ms");--> statement-breakpoint
CREATE UNIQUE INDEX "waveform_assets_storage_key_unique" ON "waveform_assets" USING btree ("storage_key");--> statement-breakpoint
CREATE UNIQUE INDEX "waveform_assets_job_unique" ON "waveform_assets" USING btree ("waveform_job_id");--> statement-breakpoint
CREATE INDEX "waveform_assets_project_id_idx" ON "waveform_assets" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "waveform_jobs_idempotency_unique" ON "waveform_jobs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "waveform_jobs_project_id_idx" ON "waveform_jobs" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "waveform_jobs_status_idx" ON "waveform_jobs" USING btree ("status");