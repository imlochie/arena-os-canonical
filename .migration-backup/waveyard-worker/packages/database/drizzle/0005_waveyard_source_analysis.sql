-- Phase 6: worker-owned, immutable-source musical analysis. Beat positions are
-- persisted in canonical milliseconds on source metadata, never remix timing.
CREATE TABLE "source_analyses" (
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
  "bpm" real,
  "bpm_confidence" real,
  "musical_key" text,
  "key_confidence" real,
  "beat_grid" text,
  "beat_confidence" real,
  "analysis_error" text,
  "error_code" text,
  "started_at" timestamptz,
  "analyzed_at" timestamptz,
  "completed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "source_analyses_status_valid" CHECK ("status" IN ('queued', 'preparing', 'processing', 'finalizing', 'complete', 'failed', 'cancelled')),
  CONSTRAINT "source_analyses_bpm_range" CHECK ("bpm" IS NULL OR ("bpm" >= 40 AND "bpm" <= 300)),
  CONSTRAINT "source_analyses_bpm_confidence_range" CHECK ("bpm_confidence" IS NULL OR ("bpm_confidence" >= 0 AND "bpm_confidence" <= 1)),
  CONSTRAINT "source_analyses_key_confidence_range" CHECK ("key_confidence" IS NULL OR ("key_confidence" >= 0 AND "key_confidence" <= 1)),
  CONSTRAINT "source_analyses_beat_confidence_range" CHECK ("beat_confidence" IS NULL OR ("beat_confidence" >= 0 AND "beat_confidence" <= 1))
);
CREATE UNIQUE INDEX "source_analyses_source_asset_unique" ON "source_analyses" USING btree ("source_asset_id");
CREATE UNIQUE INDEX "source_analyses_idempotency_unique" ON "source_analyses" USING btree ("idempotency_key");
CREATE INDEX "source_analyses_project_id_idx" ON "source_analyses" USING btree ("project_id");
CREATE INDEX "source_analyses_status_idx" ON "source_analyses" USING btree ("status");
