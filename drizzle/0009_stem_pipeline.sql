-- Durable storage and authorization records for Arena Stem Lab.
-- This is additive: existing Arena projects continue to use the projects table.
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS "arena_users" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "username" text NOT NULL,
  "email" text NOT NULL,
  "password_hash" text NOT NULL,
  "display_name" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "arena_users_username_unique" ON "arena_users" ("username");
CREATE UNIQUE INDEX IF NOT EXISTS "arena_users_email_unique" ON "arena_users" ("email");

CREATE TABLE IF NOT EXISTS "arena_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "arena_users"("id") ON DELETE CASCADE,
  "token_hash" text NOT NULL,
  "expires_at" timestamp NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "arena_sessions_token_hash_unique" ON "arena_sessions" ("token_hash");
CREATE INDEX IF NOT EXISTS "arena_sessions_user_id_idx" ON "arena_sessions" ("user_id");

CREATE TABLE IF NOT EXISTS "arena_project_members" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "arena_users"("id") ON DELETE CASCADE,
  "role" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "arena_project_members_role_check" CHECK ("role" IN ('owner', 'editor', 'viewer'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "arena_project_members_project_user_unique" ON "arena_project_members" ("project_id", "user_id");
CREATE INDEX IF NOT EXISTS "arena_project_members_user_id_idx" ON "arena_project_members" ("user_id");

CREATE TABLE IF NOT EXISTS "stem_worker_heartbeats" (
  "id" text PRIMARY KEY NOT NULL,
  "engine" text NOT NULL,
  "model" text NOT NULL,
  "device" text NOT NULL,
  "last_seen_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "stem_source_assets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
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
  "created_at" timestamp DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "stem_source_assets_storage_key_unique" ON "stem_source_assets" ("storage_key");
CREATE INDEX IF NOT EXISTS "stem_source_assets_project_id_idx" ON "stem_source_assets" ("project_id");

CREATE TABLE IF NOT EXISTS "stem_processing_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "source_asset_id" uuid NOT NULL REFERENCES "stem_source_assets"("id") ON DELETE CASCADE,
  "status" text DEFAULT 'queued' NOT NULL,
  "stage" text DEFAULT 'queued' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "idempotency_key" text NOT NULL,
  "model" text NOT NULL,
  "requested_device" text NOT NULL,
  "resolved_device" text,
  "error_code" text,
  "error_message" text,
  "metadata" text DEFAULT '{}' NOT NULL,
  "started_at" timestamp,
  "completed_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "stem_processing_jobs_status_check" CHECK ("status" IN ('queued', 'preparing', 'processing', 'validating', 'complete', 'failed', 'cancelled'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "stem_processing_jobs_idempotency_unique" ON "stem_processing_jobs" ("idempotency_key");
CREATE INDEX IF NOT EXISTS "stem_processing_jobs_project_id_idx" ON "stem_processing_jobs" ("project_id");
CREATE INDEX IF NOT EXISTS "stem_processing_jobs_status_idx" ON "stem_processing_jobs" ("status");

CREATE TABLE IF NOT EXISTS "stem_assets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "source_asset_id" uuid NOT NULL REFERENCES "stem_source_assets"("id") ON DELETE CASCADE,
  "separation_job_id" uuid NOT NULL REFERENCES "stem_processing_jobs"("id") ON DELETE CASCADE,
  "stem_type" text NOT NULL,
  "engine" text NOT NULL,
  "model" text NOT NULL,
  "model_version" text NOT NULL,
  "storage_key" text NOT NULL,
  "checksum_sha256" text NOT NULL,
  "duration_seconds" integer NOT NULL,
  "sample_rate" integer NOT NULL,
  "channels" integer NOT NULL,
  "codec" text NOT NULL,
  "format" text NOT NULL,
  "file_size_bytes" integer NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "stem_assets_type_check" CHECK ("stem_type" IN ('vocals', 'drums', 'bass', 'other'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "stem_assets_job_stem_unique" ON "stem_assets" ("separation_job_id", "stem_type");
CREATE UNIQUE INDEX IF NOT EXISTS "stem_assets_storage_key_unique" ON "stem_assets" ("storage_key");
CREATE INDEX IF NOT EXISTS "stem_assets_project_id_idx" ON "stem_assets" ("project_id");
