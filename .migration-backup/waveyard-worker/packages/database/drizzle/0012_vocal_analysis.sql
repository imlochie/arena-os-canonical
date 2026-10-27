-- Phase 18: deterministic, isolated-vocal-stem pitch observation.
CREATE TABLE "vocal_analyses" (
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
CREATE UNIQUE INDEX "vocal_analyses_stem_asset_unique" ON "vocal_analyses" USING btree ("stem_asset_id");
CREATE UNIQUE INDEX "vocal_analyses_idempotency_unique" ON "vocal_analyses" USING btree ("idempotency_key");
CREATE INDEX "vocal_analyses_project_id_idx" ON "vocal_analyses" USING btree ("project_id");
CREATE INDEX "vocal_analyses_source_stem_idx" ON "vocal_analyses" USING btree ("source_asset_id", "stem_asset_id");

CREATE TABLE "vocal_pitch_frames" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "vocal_analysis_id" uuid NOT NULL REFERENCES "vocal_analyses"("id") ON DELETE CASCADE,
  "frame_index" integer NOT NULL,
  "timestamp_ms" integer NOT NULL,
  "frequency_hz" real,
  "midi_float" real,
  "nearest_midi_note" integer,
  "confidence" real NOT NULL,
  "voiced" boolean NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "vocal_pitch_frames_time_valid" CHECK ("timestamp_ms" >= 0),
  CONSTRAINT "vocal_pitch_frames_confidence_valid" CHECK ("confidence" >= 0 AND "confidence" <= 1),
  CONSTRAINT "vocal_pitch_frames_state_valid" CHECK (
    ("voiced" AND "frequency_hz" >= 50 AND "frequency_hz" <= 1200 AND "midi_float" IS NOT NULL AND "nearest_midi_note" IS NOT NULL)
    OR
    (NOT "voiced" AND "frequency_hz" IS NULL AND "midi_float" IS NULL AND "nearest_midi_note" IS NULL)
  )
);
CREATE UNIQUE INDEX "vocal_pitch_frames_analysis_index_unique" ON "vocal_pitch_frames" USING btree ("vocal_analysis_id", "frame_index");
CREATE INDEX "vocal_pitch_frames_analysis_time_idx" ON "vocal_pitch_frames" USING btree ("vocal_analysis_id", "timestamp_ms");

CREATE TABLE "vocal_phrases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "vocal_analysis_id" uuid NOT NULL REFERENCES "vocal_analyses"("id") ON DELETE CASCADE,
  "phrase_index" integer NOT NULL,
  "start_ms" integer NOT NULL,
  "end_ms" integer NOT NULL,
  "confidence" real NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "vocal_phrases_range_valid" CHECK ("start_ms" >= 0 AND "end_ms" >= "start_ms"),
  CONSTRAINT "vocal_phrases_confidence_valid" CHECK ("confidence" >= 0 AND "confidence" <= 1)
);
CREATE UNIQUE INDEX "vocal_phrases_analysis_index_unique" ON "vocal_phrases" USING btree ("vocal_analysis_id", "phrase_index");
CREATE INDEX "vocal_phrases_analysis_start_idx" ON "vocal_phrases" USING btree ("vocal_analysis_id", "start_ms");
