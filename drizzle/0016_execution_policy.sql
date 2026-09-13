ALTER TABLE "cognitive_sessions"
  ADD COLUMN "execution_mode" text DEFAULT 'online' NOT NULL;

ALTER TABLE "cognitive_session_assignments"
  ADD COLUMN "execution_mode" text DEFAULT 'online' NOT NULL,
  ADD COLUMN "eligibility_decision" text DEFAULT 'eligible under default online policy' NOT NULL;
