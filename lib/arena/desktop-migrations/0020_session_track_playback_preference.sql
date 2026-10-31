-- Preserve an explicit full-track or stems selection for each session entry.
ALTER TABLE "wy_listen_session_tracks"
  ADD COLUMN IF NOT EXISTS "playback_preference" text;
