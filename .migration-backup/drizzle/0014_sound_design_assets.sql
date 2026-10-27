CREATE TABLE IF NOT EXISTS "sound_design_assets" (
  "id" uuid PRIMARY KEY,
  "project_id" uuid NOT NULL REFERENCES "wy_projects"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "recipe" text NOT NULL,
  "storage_key" text NOT NULL,
  "duration_seconds" real NOT NULL,
  "sample_rate" integer NOT NULL,
  "muted" boolean NOT NULL DEFAULT false,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "sound_design_project_idx" ON "sound_design_assets" ("project_id");
CREATE UNIQUE INDEX IF NOT EXISTS "sound_design_storage_key_unique" ON "sound_design_assets" ("storage_key");
