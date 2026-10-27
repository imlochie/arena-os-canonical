-- Phase 17: deterministic, source-relative musical onset events.
CREATE TABLE "source_event_analyses" (
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
CREATE UNIQUE INDEX "source_event_analyses_source_asset_unique" ON "source_event_analyses" USING btree ("source_asset_id");
CREATE UNIQUE INDEX "source_event_analyses_idempotency_unique" ON "source_event_analyses" USING btree ("idempotency_key");
CREATE INDEX "source_event_analyses_project_id_idx" ON "source_event_analyses" USING btree ("project_id");

CREATE TABLE "source_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "source_asset_id" uuid NOT NULL REFERENCES "source_assets"("id") ON DELETE CASCADE,
  "source_event_analysis_id" uuid NOT NULL REFERENCES "source_event_analyses"("id") ON DELETE CASCADE,
  "event_index" integer NOT NULL,
  "timestamp_ms" integer NOT NULL,
  "strength" real NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "source_events_time_valid" CHECK ("timestamp_ms" >= 0),
  CONSTRAINT "source_events_strength_valid" CHECK ("strength" >= 0 AND "strength" <= 1)
);
CREATE UNIQUE INDEX "source_events_analysis_index_unique" ON "source_events" USING btree ("source_event_analysis_id", "event_index");
CREATE INDEX "source_events_source_time_idx" ON "source_events" USING btree ("source_asset_id", "timestamp_ms");
CREATE INDEX "source_events_project_id_idx" ON "source_events" USING btree ("project_id");
