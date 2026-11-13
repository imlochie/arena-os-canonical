CREATE TABLE IF NOT EXISTS "stem_harmony_analyses" (
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
  CONSTRAINT "stem_harmony_analyses_stem_asset_unique" UNIQUE("stem_asset_id"),
  CONSTRAINT "stem_harmony_analyses_idempotency_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stem_harmony_analyses_project_id_idx"
  ON "stem_harmony_analyses" ("project_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stem_harmony_analyses_source_stem_idx"
  ON "stem_harmony_analyses" ("source_asset_id", "stem_asset_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stem_harmony_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "stem_harmony_analysis_id" uuid NOT NULL REFERENCES "stem_harmony_analyses"("id") ON DELETE CASCADE,
  "event_index" integer NOT NULL,
  "start_ms" integer NOT NULL,
  "end_ms" integer NOT NULL,
  "root" text,
  "quality" text NOT NULL,
  "confidence" real NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "stem_harmony_events_analysis_index_unique" UNIQUE("stem_harmony_analysis_id", "event_index")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stem_harmony_events_analysis_start_idx"
  ON "stem_harmony_events" ("stem_harmony_analysis_id", "start_ms");
