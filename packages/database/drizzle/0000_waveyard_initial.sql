CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE "users" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "username" text NOT NULL,
  "email" text NOT NULL,
  "password_hash" text NOT NULL,
  "display_name" text NOT NULL,
  "avatar_url" text,
  "bio" text DEFAULT '' NOT NULL,
  "email_verified_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "users_username_unique" ON "users" USING btree ("username");
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree ("email");

CREATE TABLE "sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "token_hash" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "sessions_token_hash_unique" ON "sessions" USING btree ("token_hash");
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");

CREATE TABLE "projects" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "owner_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE restrict,
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
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX "projects_owner_id_idx" ON "projects" USING btree ("owner_id");
CREATE INDEX "projects_visibility_idx" ON "projects" USING btree ("visibility");

CREATE TABLE "project_members" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE cascade,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "role" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "project_members_project_user_unique" ON "project_members" USING btree ("project_id", "user_id");
CREATE INDEX "project_members_user_id_idx" ON "project_members" USING btree ("user_id");

CREATE TABLE "source_assets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE cascade,
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
CREATE UNIQUE INDEX "source_assets_storage_key_unique" ON "source_assets" USING btree ("storage_key");
CREATE INDEX "source_assets_project_id_idx" ON "source_assets" USING btree ("project_id");

CREATE TABLE "processing_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE cascade,
  "source_asset_id" uuid NOT NULL REFERENCES "source_assets"("id") ON DELETE cascade,
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
CREATE UNIQUE INDEX "processing_jobs_idempotency_unique" ON "processing_jobs" USING btree ("idempotency_key");
CREATE INDEX "processing_jobs_project_id_idx" ON "processing_jobs" USING btree ("project_id");
CREATE INDEX "processing_jobs_status_idx" ON "processing_jobs" USING btree ("status");

CREATE TABLE "stem_assets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE cascade,
  "source_asset_id" uuid NOT NULL REFERENCES "source_assets"("id") ON DELETE cascade,
  "separation_job_id" uuid NOT NULL REFERENCES "processing_jobs"("id") ON DELETE cascade,
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
CREATE UNIQUE INDEX "stem_assets_job_stem_unique" ON "stem_assets" USING btree ("separation_job_id", "stem_type");
CREATE UNIQUE INDEX "stem_assets_storage_key_unique" ON "stem_assets" USING btree ("storage_key");
CREATE INDEX "stem_assets_project_id_idx" ON "stem_assets" USING btree ("project_id");
