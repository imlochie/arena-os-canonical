CREATE TABLE IF NOT EXISTS "spaces" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "title" text DEFAULT 'Untitled space' NOT NULL,
  "emoji" text DEFAULT '🤖' NOT NULL,
  "prompt" text NOT NULL,
  "model_id" text DEFAULT 'openai' NOT NULL,
  "interval_minutes" integer DEFAULT 60 NOT NULL,
  "status" text DEFAULT 'running' NOT NULL,
  "briefcase" text DEFAULT '' NOT NULL,
  "last_output" text,
  "last_run_at" timestamp,
  "next_run_at" timestamp,
  "run_count" integer DEFAULT 0 NOT NULL,
  "ok_count" integer DEFAULT 0 NOT NULL,
  "project_id" uuid,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "space_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "space_id" uuid NOT NULL,
  "status" text DEFAULT 'ok' NOT NULL,
  "output" text DEFAULT '' NOT NULL,
  "via" text DEFAULT '' NOT NULL,
  "ms" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "space_runs_space_idx" ON "space_runs" ("space_id");
