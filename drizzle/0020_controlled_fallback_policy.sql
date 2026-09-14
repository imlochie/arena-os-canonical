ALTER TABLE "cognitive_session_assignments"
  ADD COLUMN "pinned_model_id" text,
  ADD COLUMN "assignment_sequence" integer DEFAULT 1 NOT NULL,
  ADD COLUMN "supersedes_assignment_id" uuid,
  ADD COLUMN "reassignment_reason" text,
  ADD COLUMN "status" text DEFAULT 'active' NOT NULL;

ALTER TABLE "cognitive_session_assignments"
  ADD CONSTRAINT "cognitive_session_assignments_supersedes_assignment_id_fkey"
  FOREIGN KEY ("supersedes_assignment_id") REFERENCES "cognitive_session_assignments"("id") ON DELETE SET NULL;

DROP INDEX IF EXISTS "cognitive_session_assignments_session_slot_unique";
CREATE UNIQUE INDEX "cognitive_session_assignments_session_slot_sequence_unique"
  ON "cognitive_session_assignments" ("session_id", "slot", "assignment_sequence");
CREATE INDEX "cognitive_session_assignments_supersedes_id_idx"
  ON "cognitive_session_assignments" ("supersedes_assignment_id");
