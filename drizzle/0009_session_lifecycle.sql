ALTER TABLE "cognitive_sessions"
  ADD COLUMN IF NOT EXISTS "mode" text DEFAULT 'council' NOT NULL,
  ADD COLUMN IF NOT EXISTS "error_code" text,
  ADD COLUMN IF NOT EXISTS "error_message" text,
  ADD COLUMN IF NOT EXISTS "updated_at" timestamp DEFAULT now(),
  ADD COLUMN IF NOT EXISTS "started_at" timestamp,
  ADD COLUMN IF NOT EXISTS "completed_at" timestamp,
  ADD COLUMN IF NOT EXISTS "failed_at" timestamp;

-- Existing rows were created only after successful Council completion.
UPDATE "cognitive_sessions"
SET "status" = 'completed',
    "completed_at" = COALESCE("completed_at", "created_at"),
    "updated_at" = COALESCE("updated_at", "created_at")
WHERE "status" IS NULL OR "status" IN ('complete', 'completed');

ALTER TABLE "cognitive_sessions" ALTER COLUMN "status" SET DEFAULT 'created';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'cognitive_sessions_status_check'
  ) THEN
    ALTER TABLE "cognitive_sessions"
      ADD CONSTRAINT "cognitive_sessions_status_check"
      CHECK ("status" IN ('created', 'running', 'perspectives', 'cross_critique', 'synthesis', 'artifact_generation', 'completed', 'failed'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "cognitive_session_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "session_id" uuid NOT NULL,
  "type" text NOT NULL,
  "sequence" integer NOT NULL,
  "payload" text DEFAULT '{}' NOT NULL,
  "created_at" timestamp DEFAULT now(),
  CONSTRAINT "cognitive_session_events_session_id_fkey"
    FOREIGN KEY ("session_id") REFERENCES "cognitive_sessions"("id") ON DELETE CASCADE,
  CONSTRAINT "cognitive_session_events_session_sequence_unique"
    UNIQUE ("session_id", "sequence")
);

CREATE INDEX IF NOT EXISTS "cognitive_session_events_session_id_idx"
  ON "cognitive_session_events" ("session_id", "sequence");

-- Backfill one terminal event so legacy sessions participate in lifecycle history.
INSERT INTO "cognitive_session_events" ("session_id", "type", "sequence", "payload", "created_at")
SELECT s."id", 'completed', 1, '{"backfilled":true}', COALESCE(s."completed_at", s."created_at", now())
FROM "cognitive_sessions" s
WHERE NOT EXISTS (
  SELECT 1 FROM "cognitive_session_events" e WHERE e."session_id" = s."id"
);
