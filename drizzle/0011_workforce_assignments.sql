CREATE TABLE IF NOT EXISTS "cognitive_session_assignments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "session_id" uuid NOT NULL,
  "slot" text NOT NULL,
  "requested_role" text NOT NULL,
  "workforce_role_id" text NOT NULL,
  "worker_id" text NOT NULL,
  "provider" text NOT NULL,
  "model_id" text NOT NULL,
  "selection_reason" text NOT NULL,
  "capability_match" text DEFAULT '[]' NOT NULL,
  "created_at" timestamp DEFAULT now(),
  CONSTRAINT "cognitive_session_assignments_session_id_fkey"
    FOREIGN KEY ("session_id") REFERENCES "cognitive_sessions"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "cognitive_session_assignments_session_slot_unique"
  ON "cognitive_session_assignments" ("session_id", "slot");
CREATE INDEX IF NOT EXISTS "cognitive_session_assignments_session_id_idx"
  ON "cognitive_session_assignments" ("session_id");
