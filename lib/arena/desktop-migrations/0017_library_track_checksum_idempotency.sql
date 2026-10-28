-- Store the content identity on library tracks so uploads can be constrained
-- to one track per owner/checksum. Existing rows remain nullable and continue
-- to be deduplicated through their source_assets checksum.
ALTER TABLE "wy_tracks" ADD COLUMN IF NOT EXISTS "source_checksum_sha256" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "wy_tracks_owner_source_checksum_unique"
  ON "wy_tracks" ("owner_id", "source_checksum_sha256")
  WHERE "source_checksum_sha256" IS NOT NULL;
