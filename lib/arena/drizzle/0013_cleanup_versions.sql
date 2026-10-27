CREATE TABLE IF NOT EXISTS "cleanup_versions" (
  "id" uuid PRIMARY KEY,
  "project_id" uuid NOT NULL REFERENCES "wy_projects"("id") ON DELETE CASCADE,
  "source_asset_id" uuid NOT NULL REFERENCES "source_assets"("id") ON DELETE CASCADE,
  "operations" text NOT NULL,
  "storage_key" text NOT NULL,
  "measurements_before" text NOT NULL,
  "measurements_after" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "cleanup_versions_project_idx" ON "cleanup_versions" ("project_id");
CREATE UNIQUE INDEX IF NOT EXISTS "cleanup_versions_storage_key_unique" ON "cleanup_versions" ("storage_key");
