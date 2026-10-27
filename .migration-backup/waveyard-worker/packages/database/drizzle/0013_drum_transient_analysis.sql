-- Phase 19: reusable event evidence gets explicit confidence/class support;
-- deterministic drum analysis remains tied to one isolated drums stem.
ALTER TABLE "source_events" ADD COLUMN "confidence" real NOT NULL DEFAULT 0;
ALTER TABLE "source_events" ADD COLUMN "rhythmic_class" text;
UPDATE "source_events" SET "confidence" = "strength" WHERE "confidence" = 0;
ALTER TABLE "source_events" ADD CONSTRAINT "source_events_confidence_valid" CHECK ("confidence" >= 0 AND "confidence" <= 1);

CREATE TABLE "drum_analyses" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "source_asset_id" uuid NOT NULL REFERENCES "source_assets"("id") ON DELETE CASCADE,
  "stem_asset_id" uuid NOT NULL REFERENCES "stem_assets"("id") ON DELETE CASCADE,
  "status" text NOT NULL DEFAULT 'queued',
  "stage" text NOT NULL DEFAULT 'queued',
  "attempts" integer NOT NULL DEFAULT 0,
  "idempotency_key" text NOT NULL,
  "analysis_engine" text NOT NULL,
  "analysis_engine_version" text NOT NULL,
  "source_checksum_sha256" text NOT NULL,
  "stem_checksum_sha256" text NOT NULL,
  "error_code" text,
  "error_message" text,
  "started_at" timestamptz,
  "analyzed_at" timestamptz,
  "completed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "drum_analyses_stem_asset_unique" ON "drum_analyses" USING btree ("stem_asset_id");
CREATE UNIQUE INDEX "drum_analyses_idempotency_unique" ON "drum_analyses" USING btree ("idempotency_key");
CREATE INDEX "drum_analyses_project_id_idx" ON "drum_analyses" USING btree ("project_id");
CREATE INDEX "drum_analyses_source_stem_idx" ON "drum_analyses" USING btree ("source_asset_id", "stem_asset_id");

CREATE TABLE "drum_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "drum_analysis_id" uuid NOT NULL REFERENCES "drum_analyses"("id") ON DELETE CASCADE,
  "event_index" integer NOT NULL,
  "timestamp_ms" integer NOT NULL,
  "strength" real NOT NULL,
  "confidence" real NOT NULL,
  "rhythmic_class" text,
  "nearest_beat_index" integer,
  "beat_offset_ms" integer,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "drum_events_time_valid" CHECK ("timestamp_ms" >= 0),
  CONSTRAINT "drum_events_strength_valid" CHECK ("strength" >= 0 AND "strength" <= 1),
  CONSTRAINT "drum_events_confidence_valid" CHECK ("confidence" >= 0 AND "confidence" <= 1),
  CONSTRAINT "drum_events_class_valid" CHECK ("rhythmic_class" IS NULL OR "rhythmic_class" IN ('kick', 'snare', 'hat', 'other'))
);
CREATE UNIQUE INDEX "drum_events_analysis_index_unique" ON "drum_events" USING btree ("drum_analysis_id", "event_index");
CREATE INDEX "drum_events_analysis_time_idx" ON "drum_events" USING btree ("drum_analysis_id", "timestamp_ms");
