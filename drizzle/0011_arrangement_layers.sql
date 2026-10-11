CREATE TABLE IF NOT EXISTS "arrangement_layers" (
  "id" uuid PRIMARY KEY,
  "project_id" uuid NOT NULL REFERENCES "wy_projects"("id") ON DELETE CASCADE,
  "source_asset_id" uuid NOT NULL REFERENCES "source_assets"("id") ON DELETE CASCADE,
  "source_checksum_sha256" text NOT NULL,
  "original_prompt" text NOT NULL DEFAULT '',
  "instruction" text NOT NULL,
  "instrument" text NOT NULL,
  "mood" text NOT NULL,
  "density" text NOT NULL,
  "register_kind" text NOT NULL,
  "target_sections" text NOT NULL,
  "level" real NOT NULL,
  "seed" integer NOT NULL,
  "events" text NOT NULL,
  "notes" text NOT NULL,
  "storage_key" text NOT NULL,
  "renderer" text NOT NULL,
  "sample_rate" integer NOT NULL,
  "duration_seconds" real NOT NULL,
  "provenance" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "arrangement_layers_project_idx" ON "arrangement_layers" ("project_id");
CREATE UNIQUE INDEX IF NOT EXISTS "arrangement_layers_storage_key_unique" ON "arrangement_layers" ("storage_key");
