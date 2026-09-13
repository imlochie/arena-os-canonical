CREATE TABLE IF NOT EXISTS "handoffs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source_session_id" uuid,
  "target_session_id" uuid NOT NULL,
  "source_artifact_id" uuid,
  "source_project_id" uuid,
  "target_project_id" uuid,
  "type" text DEFAULT 'continue' NOT NULL,
  "intent" text,
  "payload" text DEFAULT '{}' NOT NULL,
  "metadata" text DEFAULT '{}' NOT NULL,
  "created_at" timestamp DEFAULT now(),
  CONSTRAINT "handoffs_source_session_id_fkey"
    FOREIGN KEY ("source_session_id") REFERENCES "cognitive_sessions"("id") ON DELETE SET NULL,
  CONSTRAINT "handoffs_target_session_id_fkey"
    FOREIGN KEY ("target_session_id") REFERENCES "cognitive_sessions"("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "handoffs_source_session_id_idx" ON "handoffs" ("source_session_id");
CREATE INDEX IF NOT EXISTS "handoffs_target_session_id_idx" ON "handoffs" ("target_session_id");
