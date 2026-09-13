ALTER TABLE "cognitive_sessions"
  ADD COLUMN IF NOT EXISTS "intent" text,
  ADD COLUMN IF NOT EXISTS "current_stage" text,
  ADD COLUMN IF NOT EXISTS "metadata" text DEFAULT '{}' NOT NULL;

ALTER TABLE "council_runs" ADD COLUMN IF NOT EXISTS "session_id" uuid;

CREATE TABLE IF NOT EXISTS "cognitive_session_inputs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "session_id" uuid NOT NULL,
  "kind" text DEFAULT 'primary' NOT NULL,
  "content" text NOT NULL,
  "created_at" timestamp DEFAULT now(),
  CONSTRAINT "cognitive_session_inputs_session_id_fkey"
    FOREIGN KEY ("session_id") REFERENCES "cognitive_sessions"("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "cognitive_session_inputs_session_id_idx"
  ON "cognitive_session_inputs" ("session_id");

-- Preserve the old Council-specific session data before removing it from the
-- generic root. Mode detail belongs on the Council run; input and job metadata
-- belong in generic extension records.
UPDATE "council_runs" r
SET "session_id" = s."id"
FROM "cognitive_sessions" s
WHERE s."council_run_id" = r."id" AND r."session_id" IS NULL;

INSERT INTO "cognitive_session_inputs" ("session_id", "kind", "content", "created_at")
SELECT s."id", 'primary', s."material", s."created_at"
FROM "cognitive_sessions" s
WHERE NOT EXISTS (
  SELECT 1 FROM "cognitive_session_inputs" i
  WHERE i."session_id" = s."id" AND i."kind" = 'primary'
);

UPDATE "cognitive_sessions"
SET "metadata" = json_build_object('jobId', "job_id")::text
WHERE "metadata" = '{}' OR "metadata" IS NULL;

UPDATE "cognitive_sessions"
SET "current_stage" = "status", "status" = 'running'
WHERE "status" IN ('perspectives', 'cross_critique', 'synthesis', 'artifact_generation');

ALTER TABLE "cognitive_sessions" DROP CONSTRAINT IF EXISTS "cognitive_sessions_status_check";
ALTER TABLE "cognitive_sessions"
  ADD CONSTRAINT "cognitive_sessions_status_check"
  CHECK ("status" IN ('created', 'running', 'completed', 'failed'));

ALTER TABLE "council_runs"
  ADD CONSTRAINT "council_runs_session_id_fkey"
  FOREIGN KEY ("session_id") REFERENCES "cognitive_sessions"("id") ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "council_runs_session_id_unique"
  ON "council_runs" ("session_id") WHERE "session_id" IS NOT NULL;

ALTER TABLE "cognitive_sessions"
  DROP COLUMN IF EXISTS "council_run_id",
  DROP COLUMN IF EXISTS "job_id",
  DROP COLUMN IF EXISTS "material",
  DROP COLUMN IF EXISTS "model_a_id",
  DROP COLUMN IF EXISTS "model_b_id",
  DROP COLUMN IF EXISTS "synthesis_model",
  DROP COLUMN IF EXISTS "role_a_label",
  DROP COLUMN IF EXISTS "role_b_label";
