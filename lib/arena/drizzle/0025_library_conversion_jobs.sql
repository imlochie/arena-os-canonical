CREATE TABLE IF NOT EXISTS "wy_library_conversion_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "owner_id" uuid NOT NULL,
  "original_track_id" uuid NOT NULL REFERENCES "wy_tracks"("id") ON DELETE CASCADE,
  "source_asset_id" uuid NOT NULL REFERENCES "source_assets"("id") ON DELETE CASCADE,
  "format" text NOT NULL,
  "bitrate" integer DEFAULT 192 NOT NULL,
  "idempotency_key" text NOT NULL,
  "status" text DEFAULT 'queued' NOT NULL,
  "stage" text DEFAULT 'queued' NOT NULL,
  "progress" integer DEFAULT 0 NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "converted_track_id" uuid REFERENCES "wy_tracks"("id") ON DELETE SET NULL,
  "verification" text,
  "error_message" text,
  "started_at" timestamptz,
  "completed_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "wy_library_conversion_jobs_idempotency_unique"
  ON "wy_library_conversion_jobs" USING btree ("idempotency_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wy_library_conversion_jobs_owner_updated_idx"
  ON "wy_library_conversion_jobs" USING btree ("owner_id", "updated_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wy_library_conversion_jobs_status_idx"
  ON "wy_library_conversion_jobs" USING btree ("status");
