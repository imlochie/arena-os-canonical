-- Phase 3: worker-owned, version-provenanced private audio export.
CREATE TABLE "export_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE cascade,
  "remix_session_id" uuid NOT NULL REFERENCES "remix_sessions"("id") ON DELETE restrict,
  "remix_version_id" uuid NOT NULL REFERENCES "remix_versions"("id") ON DELETE restrict,
  "requested_by_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE restrict,
  "status" text NOT NULL DEFAULT 'queued',
  "stage" text NOT NULL DEFAULT 'queued',
  "attempts" integer NOT NULL DEFAULT 0,
  "idempotency_key" text NOT NULL,
  "format" text NOT NULL DEFAULT 'wav',
  "sample_rate" integer NOT NULL DEFAULT 44100,
  "channels" integer NOT NULL DEFAULT 2,
  "error_code" text,
  "error_message" text,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "export_jobs_wav_only" CHECK ("format" = 'wav'),
  CONSTRAINT "export_jobs_sample_rate_positive" CHECK ("sample_rate" > 0),
  CONSTRAINT "export_jobs_channels_positive" CHECK ("channels" > 0)
);
CREATE UNIQUE INDEX "export_jobs_idempotency_unique" ON "export_jobs" ("idempotency_key");
CREATE INDEX "export_jobs_project_id_idx" ON "export_jobs" ("project_id");
CREATE INDEX "export_jobs_version_id_idx" ON "export_jobs" ("remix_version_id");
CREATE INDEX "export_jobs_status_idx" ON "export_jobs" ("status");

CREATE TABLE "export_assets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE cascade,
  "export_job_id" uuid NOT NULL REFERENCES "export_jobs"("id") ON DELETE cascade,
  "remix_version_id" uuid NOT NULL REFERENCES "remix_versions"("id") ON DELETE restrict,
  "storage_key" text NOT NULL,
  "filename" text NOT NULL,
  "checksum_sha256" text NOT NULL,
  "duration_seconds" integer NOT NULL,
  "sample_rate" integer NOT NULL,
  "channels" integer NOT NULL,
  "codec" text NOT NULL,
  "format" text NOT NULL,
  "file_size_bytes" integer NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "export_assets_duration_positive" CHECK ("duration_seconds" > 0),
  CONSTRAINT "export_assets_sample_rate_positive" CHECK ("sample_rate" > 0),
  CONSTRAINT "export_assets_channels_positive" CHECK ("channels" > 0),
  CONSTRAINT "export_assets_size_positive" CHECK ("file_size_bytes" > 0)
);
CREATE UNIQUE INDEX "export_assets_job_unique" ON "export_assets" ("export_job_id");
CREATE UNIQUE INDEX "export_assets_storage_key_unique" ON "export_assets" ("storage_key");
CREATE INDEX "export_assets_project_id_idx" ON "export_assets" ("project_id");
CREATE INDEX "export_assets_version_id_idx" ON "export_assets" ("remix_version_id");
