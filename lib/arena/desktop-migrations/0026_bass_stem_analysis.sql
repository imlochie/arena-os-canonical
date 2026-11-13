CREATE TABLE IF NOT EXISTS "bass_analyses" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "wy_projects"("id") ON DELETE CASCADE,
  "source_asset_id" uuid NOT NULL REFERENCES "source_assets"("id") ON DELETE CASCADE,
  "stem_asset_id" uuid NOT NULL REFERENCES "stem_assets"("id") ON DELETE CASCADE,
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
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "bass_analyses_stem_asset_unique" UNIQUE("stem_asset_id"),
  CONSTRAINT "bass_analyses_idempotency_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bass_analyses_project_id_idx" ON "bass_analyses" ("project_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bass_analyses_source_stem_idx" ON "bass_analyses" ("source_asset_id", "stem_asset_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bass_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "bass_analysis_id" uuid NOT NULL REFERENCES "bass_analyses"("id") ON DELETE CASCADE,
  "event_index" integer NOT NULL,
  "timestamp_ms" integer NOT NULL,
  "strength" real NOT NULL,
  "confidence" real NOT NULL,
  "nearest_beat_index" integer,
  "beat_offset_ms" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "bass_events_analysis_index_unique" UNIQUE("bass_analysis_id", "event_index")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bass_events_analysis_time_idx" ON "bass_events" ("bass_analysis_id", "timestamp_ms");
