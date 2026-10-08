-- Track curation (lightcraft-style): star ratings and labels on listening
-- tracks, plus persistent smart collections. Mirrors the canonical
-- desktop-migrations/0003_track_collections.sql for the dev history folder.
ALTER TABLE "wy_tracks" ADD COLUMN IF NOT EXISTS "rating" integer NOT NULL DEFAULT 0;
ALTER TABLE "wy_tracks" ADD COLUMN IF NOT EXISTS "labels" text;
CREATE TABLE IF NOT EXISTS "wy_smart_collections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "owner_id" uuid NOT NULL,
  "name" text NOT NULL,
  "match" text NOT NULL DEFAULT 'all',
  "rules_json" text NOT NULL DEFAULT '[]',
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "wy_smart_collections_owner_id_idx" ON "wy_smart_collections" ("owner_id");
