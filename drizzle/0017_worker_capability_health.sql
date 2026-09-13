ALTER TABLE "models"
  ADD COLUMN "availability" text DEFAULT 'unknown' NOT NULL,
  ADD COLUMN "supports_structured_output" boolean DEFAULT false NOT NULL,
  ADD COLUMN "capabilities" text DEFAULT '[]' NOT NULL;

ALTER TABLE "cognitive_session_assignments"
  ADD COLUMN "worker_availability" text DEFAULT 'unknown' NOT NULL,
  ADD COLUMN "capabilities_considered" text DEFAULT '[]' NOT NULL;
