CREATE TABLE IF NOT EXISTS "cognitive_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid,
  "council_run_id" uuid,
  "title" text DEFAULT 'Untitled cognitive session' NOT NULL,
  "job_id" text DEFAULT 'second_brain' NOT NULL,
  "material" text NOT NULL,
  "model_a_id" text NOT NULL,
  "model_b_id" text NOT NULL,
  "synthesis_model" text NOT NULL,
  "role_a_label" text DEFAULT '' NOT NULL,
  "role_b_label" text DEFAULT '' NOT NULL,
  "status" text DEFAULT 'completed' NOT NULL,
  "created_at" timestamp DEFAULT now()
);
