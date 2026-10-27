-- Phase 2: real derived waveform assets and non-destructive remix arrangements.
CREATE TABLE "waveform_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE cascade,
  "source_asset_id" uuid REFERENCES "source_assets"("id") ON DELETE cascade,
  "stem_asset_id" uuid REFERENCES "stem_assets"("id") ON DELETE cascade,
  "status" text DEFAULT 'queued' NOT NULL,
  "stage" text DEFAULT 'queued' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "idempotency_key" text NOT NULL,
  "error_code" text,
  "error_message" text,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "waveform_jobs_one_asset" CHECK (("source_asset_id" IS NOT NULL) <> ("stem_asset_id" IS NOT NULL))
);
CREATE UNIQUE INDEX "waveform_jobs_idempotency_unique" ON "waveform_jobs" ("idempotency_key");
CREATE INDEX "waveform_jobs_project_id_idx" ON "waveform_jobs" ("project_id");
CREATE INDEX "waveform_jobs_status_idx" ON "waveform_jobs" ("status");

CREATE TABLE "waveform_assets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE cascade,
  "source_asset_id" uuid REFERENCES "source_assets"("id") ON DELETE cascade,
  "stem_asset_id" uuid REFERENCES "stem_assets"("id") ON DELETE cascade,
  "waveform_job_id" uuid NOT NULL REFERENCES "waveform_jobs"("id") ON DELETE cascade,
  "storage_key" text NOT NULL,
  "checksum_sha256" text NOT NULL,
  "format" text DEFAULT 'waveyard-peaks-v1' NOT NULL,
  "metadata" text DEFAULT '{}' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "waveform_assets_one_asset" CHECK (("source_asset_id" IS NOT NULL) <> ("stem_asset_id" IS NOT NULL))
);
CREATE UNIQUE INDEX "waveform_assets_storage_key_unique" ON "waveform_assets" ("storage_key");
CREATE UNIQUE INDEX "waveform_assets_job_unique" ON "waveform_assets" ("waveform_job_id");
CREATE UNIQUE INDEX "waveform_assets_source_unique" ON "waveform_assets" ("source_asset_id") WHERE "source_asset_id" IS NOT NULL;
CREATE UNIQUE INDEX "waveform_assets_stem_unique" ON "waveform_assets" ("stem_asset_id") WHERE "stem_asset_id" IS NOT NULL;
CREATE INDEX "waveform_assets_project_id_idx" ON "waveform_assets" ("project_id");

CREATE TABLE "remix_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE cascade,
  "owner_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE restrict,
  "name" text NOT NULL,
  "master_volume" real DEFAULT 1 NOT NULL,
  "loop_start_ms" integer DEFAULT 0 NOT NULL,
  "loop_end_ms" integer,
  "version" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX "remix_sessions_project_id_idx" ON "remix_sessions" ("project_id");
CREATE INDEX "remix_sessions_owner_id_idx" ON "remix_sessions" ("owner_id");

CREATE TABLE "remix_tracks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "remix_session_id" uuid NOT NULL REFERENCES "remix_sessions"("id") ON DELETE cascade,
  "stem_asset_id" uuid NOT NULL REFERENCES "stem_assets"("id") ON DELETE restrict,
  "name" text NOT NULL,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "volume" real DEFAULT 1 NOT NULL,
  "pan" real DEFAULT 0 NOT NULL,
  "muted" boolean DEFAULT false NOT NULL,
  "solo" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "remix_tracks_volume_range" CHECK ("volume" >= 0 AND "volume" <= 2),
  CONSTRAINT "remix_tracks_pan_range" CHECK ("pan" >= -1 AND "pan" <= 1)
);
CREATE INDEX "remix_tracks_session_id_idx" ON "remix_tracks" ("remix_session_id");
CREATE UNIQUE INDEX "remix_tracks_session_stem_unique" ON "remix_tracks" ("remix_session_id", "stem_asset_id");

CREATE TABLE "remix_clips" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "remix_track_id" uuid NOT NULL REFERENCES "remix_tracks"("id") ON DELETE cascade,
  "stem_asset_id" uuid NOT NULL REFERENCES "stem_assets"("id") ON DELETE restrict,
  "timeline_start_ms" integer DEFAULT 0 NOT NULL,
  "duration_ms" integer NOT NULL,
  "source_offset_ms" integer DEFAULT 0 NOT NULL,
  "gain" real DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "remix_clips_start_nonnegative" CHECK ("timeline_start_ms" >= 0),
  CONSTRAINT "remix_clips_duration_positive" CHECK ("duration_ms" > 0),
  CONSTRAINT "remix_clips_offset_nonnegative" CHECK ("source_offset_ms" >= 0),
  CONSTRAINT "remix_clips_gain_range" CHECK ("gain" >= 0 AND "gain" <= 4)
);
CREATE INDEX "remix_clips_track_id_idx" ON "remix_clips" ("remix_track_id");
CREATE INDEX "remix_clips_asset_id_idx" ON "remix_clips" ("stem_asset_id");

CREATE TABLE "remix_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "remix_session_id" uuid NOT NULL REFERENCES "remix_sessions"("id") ON DELETE cascade,
  "created_by_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE restrict,
  "name" text NOT NULL,
  "snapshot" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX "remix_versions_session_id_idx" ON "remix_versions" ("remix_session_id");
