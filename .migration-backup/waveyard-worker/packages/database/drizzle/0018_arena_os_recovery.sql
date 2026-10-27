-- Arena OS recovery: namespaced shared intelligence, project, artifact, and privacy tables.
CREATE TABLE "arena_arcade_games" (
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
CREATE TABLE "arena_artifacts" (
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
CREATE TABLE "arena_assistants" (
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
CREATE TABLE "arena_battle_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"battle_id" uuid NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "arena_battles" (
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
CREATE TABLE "arena_chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_id" uuid NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "arena_chats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text DEFAULT 'New chat' NOT NULL,
	"model_id" text DEFAULT 'openai' NOT NULL,
	"assistant_id" uuid,
	"project_id" uuid,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "arena_cognitive_sessions" (
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
CREATE TABLE "arena_collab_contributions" (
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
CREATE TABLE "arena_collabs" (
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
CREATE TABLE "arena_council_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"kind" text DEFAULT 'brief' NOT NULL,
	"title" text DEFAULT 'Untitled artifact' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "arena_council_runs" (
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
CREATE TABLE "arena_model_category_ratings" (
	"model_id" text NOT NULL,
	"category" text NOT NULL,
	"elo" integer DEFAULT 1200 NOT NULL,
	"battles" integer DEFAULT 0 NOT NULL,
	"wins" integer DEFAULT 0 NOT NULL,
	"ties" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "arena_model_category_ratings_model_id_category_pk" PRIMARY KEY("model_id","category")
);
--> statement-breakpoint
CREATE TABLE "arena_models" (
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
CREATE TABLE "arena_privacy_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action" text NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "arena_project_memory" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" text DEFAULT 'fact' NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "arena_projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"emoji" text DEFAULT '📁' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "arena_prompt_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"prompt" text NOT NULL,
	"category" text DEFAULT 'general' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now()
);
