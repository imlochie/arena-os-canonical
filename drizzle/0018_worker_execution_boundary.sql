CREATE TABLE IF NOT EXISTS "worker_executions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "session_id" uuid NOT NULL,
  "assignment_id" uuid NOT NULL,
  "status" text DEFAULT 'running' NOT NULL,
  "selected_provider" text NOT NULL,
  "selected_model_id" text NOT NULL,
  "actual_provider" text,
  "actual_model_id" text,
  "route" text,
  "output_contract" text DEFAULT 'text' NOT NULL,
  "error_code" text,
  "error_message" text,
  "metadata" text DEFAULT '{}' NOT NULL,
  "started_at" timestamp DEFAULT now() NOT NULL,
  "completed_at" timestamp,
  CONSTRAINT "worker_executions_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "cognitive_sessions"("id") ON DELETE CASCADE,
  CONSTRAINT "worker_executions_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "cognitive_session_assignments"("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "worker_executions_session_id_idx" ON "worker_executions" ("session_id", "started_at");
CREATE INDEX IF NOT EXISTS "worker_executions_assignment_id_idx" ON "worker_executions" ("assignment_id", "started_at");
