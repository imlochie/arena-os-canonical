CREATE TABLE "worker_execution_operations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "session_id" uuid NOT NULL REFERENCES "cognitive_sessions"("id") ON DELETE CASCADE,
  "assignment_id" uuid NOT NULL REFERENCES "cognitive_session_assignments"("id") ON DELETE CASCADE,
  "next_attempt_number" integer DEFAULT 1 NOT NULL,
  "status" text DEFAULT 'running' NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "completed_at" timestamp
);
CREATE INDEX "worker_execution_operations_assignment_idx" ON "worker_execution_operations" ("assignment_id", "created_at");
ALTER TABLE "worker_executions" ADD COLUMN "operation_id" uuid REFERENCES "worker_execution_operations"("id") ON DELETE CASCADE;
INSERT INTO "worker_execution_operations" ("id", "session_id", "assignment_id", "next_attempt_number", "status", "created_at", "completed_at")
SELECT gen_random_uuid(), "session_id", "assignment_id", MAX("attempt_number") + 1,
  CASE WHEN bool_or("status" = 'running') THEN 'running' ELSE 'completed' END,
  MIN("started_at"), MAX("completed_at")
FROM "worker_executions" GROUP BY "session_id", "assignment_id";
UPDATE "worker_executions" e SET "operation_id" = o."id" FROM "worker_execution_operations" o
WHERE e."session_id" = o."session_id" AND e."assignment_id" = o."assignment_id";
ALTER TABLE "worker_executions" ALTER COLUMN "operation_id" SET NOT NULL;
DROP INDEX IF EXISTS "worker_executions_assignment_attempt_unique";
CREATE UNIQUE INDEX "worker_executions_operation_attempt_unique" ON "worker_executions" ("operation_id", "attempt_number");
