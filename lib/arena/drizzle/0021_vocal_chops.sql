-- Vocal chops — one-shot vocal notes sampled out of a separated vocal stem
-- (the chipmunk-soul sampler, vision §V4). WAV payloads live in project
-- storage; these rows are the durable, ranked manifest.
CREATE TABLE IF NOT EXISTS "vocal_chops" (
  "id" uuid PRIMARY KEY,
  "project_id" uuid NOT NULL REFERENCES "wy_projects"("id") ON DELETE CASCADE,
  "source_asset_id" uuid NOT NULL REFERENCES "source_assets"("id") ON DELETE CASCADE,
  "stem_asset_id" uuid NOT NULL REFERENCES "stem_assets"("id") ON DELETE CASCADE,
  "start_ms" integer NOT NULL,
  "duration_ms" integer NOT NULL,
  "root_midi" integer NOT NULL,
  "cents" integer NOT NULL,
  "confidence" real NOT NULL,
  "detection" text NOT NULL,
  "storage_key" text NOT NULL,
  "sample_rate" integer NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "vocal_chops_project_idx" ON "vocal_chops" ("project_id");
CREATE UNIQUE INDEX IF NOT EXISTS "vocal_chops_storage_key_unique" ON "vocal_chops" ("storage_key");
