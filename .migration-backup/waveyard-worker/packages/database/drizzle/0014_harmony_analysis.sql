-- Phase 20: deterministic source-relative coarse harmonic timeline.
CREATE TABLE "harmony_analyses" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "source_asset_id" uuid NOT NULL REFERENCES "source_assets"("id") ON DELETE CASCADE,
  "status" text NOT NULL DEFAULT 'queued',
  "stage" text NOT NULL DEFAULT 'queued',
  "attempts" integer NOT NULL DEFAULT 0,
  "idempotency_key" text NOT NULL,
  "analysis_engine" text NOT NULL,
  "analysis_engine_version" text NOT NULL,
  "source_checksum_sha256" text NOT NULL,
  "error_code" text,
  "error_message" text,
  "started_at" timestamptz,
  "analyzed_at" timestamptz,
  "completed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "harmony_analyses_source_asset_unique" ON "harmony_analyses" USING btree ("source_asset_id");
CREATE UNIQUE INDEX "harmony_analyses_idempotency_unique" ON "harmony_analyses" USING btree ("idempotency_key");
CREATE INDEX "harmony_analyses_project_id_idx" ON "harmony_analyses" USING btree ("project_id");

CREATE TABLE "harmony_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "harmony_analysis_id" uuid NOT NULL REFERENCES "harmony_analyses"("id") ON DELETE CASCADE,
  "event_index" integer NOT NULL,
  "start_ms" integer NOT NULL,
  "end_ms" integer NOT NULL,
  "root" text,
  "quality" text NOT NULL,
  "confidence" real NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "harmony_events_range_valid" CHECK ("start_ms" >= 0 AND "end_ms" > "start_ms"),
  CONSTRAINT "harmony_events_confidence_valid" CHECK ("confidence" >= 0 AND "confidence" <= 1),
  CONSTRAINT "harmony_events_quality_valid" CHECK ("quality" IN ('major', 'minor', 'dominant7', 'minor7', 'major7', 'diminished', 'augmented', 'unknown')),
  CONSTRAINT "harmony_events_unknown_valid" CHECK (("quality" = 'unknown' AND "root" IS NULL) OR ("quality" <> 'unknown' AND "root" IS NOT NULL))
);
CREATE UNIQUE INDEX "harmony_events_analysis_index_unique" ON "harmony_events" USING btree ("harmony_analysis_id", "event_index");
CREATE INDEX "harmony_events_analysis_start_idx" ON "harmony_events" USING btree ("harmony_analysis_id", "start_ms");
