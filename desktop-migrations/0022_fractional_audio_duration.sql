-- Integer-second intake truncated valid audio when creating a Studio clip.
-- Preserve known historical values; no guessed durations or file migration.
ALTER TABLE source_assets ALTER COLUMN duration_seconds TYPE double precision USING duration_seconds::double precision;
--> statement-breakpoint
ALTER TABLE stem_assets ALTER COLUMN duration_seconds TYPE double precision USING duration_seconds::double precision;
--> statement-breakpoint
ALTER TABLE wy_tracks ALTER COLUMN duration_seconds TYPE double precision USING duration_seconds::double precision;
