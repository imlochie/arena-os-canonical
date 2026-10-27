-- Phase 10: worker-owned structural analysis metadata over immutable sources.
CREATE TABLE "source_section_analyses" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "source_asset_id" uuid NOT NULL REFERENCES "source_assets"("id") ON DELETE CASCADE,
  "source_analysis_id" uuid NOT NULL REFERENCES "source_analyses"("id") ON DELETE CASCADE,
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
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "source_section_analyses_status_valid" CHECK ("status" IN ('queued', 'preparing', 'processing', 'complete', 'failed', 'unavailable'))
);
CREATE UNIQUE INDEX "source_section_analyses_source_asset_unique" ON "source_section_analyses" USING btree ("source_asset_id");
CREATE UNIQUE INDEX "source_section_analyses_idempotency_unique" ON "source_section_analyses" USING btree ("idempotency_key");
CREATE INDEX "source_section_analyses_project_id_idx" ON "source_section_analyses" USING btree ("project_id");
CREATE INDEX "source_section_analyses_status_idx" ON "source_section_analyses" USING btree ("status");

CREATE TABLE "source_sections" (
  "id" text PRIMARY KEY NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "source_asset_id" uuid NOT NULL REFERENCES "source_assets"("id") ON DELETE CASCADE,
  "source_analysis_id" uuid NOT NULL REFERENCES "source_analyses"("id") ON DELETE CASCADE,
  "source_section_analysis_id" uuid NOT NULL REFERENCES "source_section_analyses"("id") ON DELETE CASCADE,
  "section_index" integer NOT NULL,
  "start_ms" integer NOT NULL,
  "end_ms" integer NOT NULL,
  "start_beat_index" integer NOT NULL,
  "end_beat_index" integer NOT NULL,
  "start_bar" integer NOT NULL,
  "end_bar" integer NOT NULL,
  "label" text NOT NULL DEFAULT 'section',
  "label_confidence" real NOT NULL DEFAULT 0,
  "structural_confidence" real NOT NULL,
  "analysis_engine" text NOT NULL,
  "analysis_engine_version" text NOT NULL,
  "source_checksum_sha256" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "source_sections_bounds_valid" CHECK ("start_ms" >= 0 AND "end_ms" > "start_ms" AND "end_beat_index" > "start_beat_index"),
  CONSTRAINT "source_sections_label_confidence_range" CHECK ("label_confidence" >= 0 AND "label_confidence" <= 1),
  CONSTRAINT "source_sections_structural_confidence_range" CHECK ("structural_confidence" >= 0 AND "structural_confidence" <= 1)
);
CREATE UNIQUE INDEX "source_sections_source_index_unique" ON "source_sections" USING btree ("source_asset_id", "section_index");
CREATE INDEX "source_sections_source_order_idx" ON "source_sections" USING btree ("source_asset_id", "section_index");
CREATE INDEX "source_sections_project_id_idx" ON "source_sections" USING btree ("project_id");
