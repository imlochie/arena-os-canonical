CREATE TABLE IF NOT EXISTS "vocal_activity_intervals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "vocal_analysis_id" uuid NOT NULL REFERENCES "vocal_analyses"("id") ON DELETE CASCADE,
  "interval_index" integer NOT NULL,
  "start_ms" integer NOT NULL CHECK ("start_ms" >= 0),
  "end_ms" integer NOT NULL CHECK ("end_ms" > "start_ms"),
  "confidence" real NOT NULL CHECK ("confidence" >= 0 AND "confidence" <= 1),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "vocal_activity_intervals_analysis_index_unique" UNIQUE("vocal_analysis_id", "interval_index")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vocal_activity_intervals_analysis_start_idx"
  ON "vocal_activity_intervals" ("vocal_analysis_id", "start_ms");
