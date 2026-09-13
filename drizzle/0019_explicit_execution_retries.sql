ALTER TABLE "cognitive_sessions"
  ADD COLUMN "max_execution_attempts" integer DEFAULT 2 NOT NULL,
  ADD COLUMN "fallback_policy" text DEFAULT 'none' NOT NULL;

ALTER TABLE "cognitive_session_assignments"
  ADD COLUMN "next_execution_attempt" integer DEFAULT 1 NOT NULL;

ALTER TABLE "worker_executions"
  ADD COLUMN "attempt_number" integer,
  ADD COLUMN "previous_execution_id" uuid,
  ADD COLUMN "retry_reason" text,
  ADD COLUMN "fallback_source_assignment_id" uuid,
  ADD COLUMN "fallback_policy" text DEFAULT 'none' NOT NULL;

WITH numbered AS (
  SELECT "id", ROW_NUMBER() OVER (
    PARTITION BY "assignment_id" ORDER BY "started_at", "id"
  )::integer AS attempt
  FROM "worker_executions"
)
UPDATE "worker_executions" AS execution
SET "attempt_number" = numbered.attempt
FROM numbered
WHERE execution."id" = numbered."id";

UPDATE "cognitive_session_assignments" AS assignment
SET "next_execution_attempt" = COALESCE((
  SELECT MAX(execution."attempt_number") + 1
  FROM "worker_executions" AS execution
  WHERE execution."assignment_id" = assignment."id"
), 1);

ALTER TABLE "worker_executions"
  ALTER COLUMN "attempt_number" SET DEFAULT 1,
  ALTER COLUMN "attempt_number" SET NOT NULL,
  ADD CONSTRAINT "worker_executions_previous_execution_id_fkey"
    FOREIGN KEY ("previous_execution_id") REFERENCES "worker_executions"("id") ON DELETE SET NULL,
  ADD CONSTRAINT "worker_executions_fallback_source_assignment_id_fkey"
    FOREIGN KEY ("fallback_source_assignment_id") REFERENCES "cognitive_session_assignments"("id") ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "worker_executions_assignment_attempt_unique"
  ON "worker_executions" ("assignment_id", "attempt_number");
CREATE INDEX IF NOT EXISTS "worker_executions_previous_execution_id_idx"
  ON "worker_executions" ("previous_execution_id");
