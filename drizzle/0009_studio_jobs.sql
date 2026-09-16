CREATE TABLE IF NOT EXISTS "studio_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "backend" text NOT NULL,
  "external_id" text,
  "model_type" text NOT NULL,
  "model_name" text DEFAULT '' NOT NULL,
  "modality" text DEFAULT 'video' NOT NULL,
  "prompt" text NOT NULL,
  "negative_prompt" text DEFAULT '' NOT NULL,
  "settings" text DEFAULT '{}' NOT NULL,
  "status" text DEFAULT 'queued' NOT NULL,
  "phase" text DEFAULT '' NOT NULL,
  "progress" real DEFAULT 0 NOT NULL,
  "files" text DEFAULT '[]' NOT NULL,
  "preview" text,
  "error" text,
  "seed" integer,
  "project_id" uuid,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

-- Studio outputs can be saved as artifacts (sourceType: 'studio')
