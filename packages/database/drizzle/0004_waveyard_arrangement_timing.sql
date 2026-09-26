-- Phase 5: canonical musical timing, non-destructive fades, and duplicateable
-- immutable stem tracks. Existing rows retain their Phase 0-4 semantics.
ALTER TABLE "remix_sessions"
  ADD COLUMN "tempo_bpm" real DEFAULT 120 NOT NULL,
  ADD COLUMN "time_signature_numerator" integer DEFAULT 4 NOT NULL,
  ADD COLUMN "time_signature_denominator" integer DEFAULT 4 NOT NULL,
  ADD COLUMN "grid_division" text DEFAULT 'beat' NOT NULL,
  ADD COLUMN "snap_enabled" boolean DEFAULT true NOT NULL;
ALTER TABLE "remix_sessions"
  ADD CONSTRAINT "remix_sessions_tempo_bpm_range" CHECK ("tempo_bpm" >= 20 AND "tempo_bpm" <= 300),
  ADD CONSTRAINT "remix_sessions_time_signature_numerator_range" CHECK ("time_signature_numerator" >= 1 AND "time_signature_numerator" <= 12),
  ADD CONSTRAINT "remix_sessions_time_signature_denominator_valid" CHECK ("time_signature_denominator" IN (1, 2, 4, 8, 16)),
  ADD CONSTRAINT "remix_sessions_grid_division_valid" CHECK ("grid_division" IN ('bar', 'beat', 'half-beat', 'quarter-note'));

ALTER TABLE "remix_clips"
  ADD COLUMN "fade_in_ms" integer DEFAULT 0 NOT NULL,
  ADD COLUMN "fade_out_ms" integer DEFAULT 0 NOT NULL;
ALTER TABLE "remix_clips"
  ADD CONSTRAINT "remix_clips_fade_in_nonnegative" CHECK ("fade_in_ms" >= 0),
  ADD CONSTRAINT "remix_clips_fade_out_nonnegative" CHECK ("fade_out_ms" >= 0),
  ADD CONSTRAINT "remix_clips_fades_within_duration" CHECK (("fade_in_ms" + "fade_out_ms") <= "duration_ms");

DROP INDEX IF EXISTS "remix_tracks_session_stem_unique";
CREATE INDEX "remix_tracks_session_stem_idx"
  ON "remix_tracks" USING btree ("remix_session_id", "stem_asset_id");
