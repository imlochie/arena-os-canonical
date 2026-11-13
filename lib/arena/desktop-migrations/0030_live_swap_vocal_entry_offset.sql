-- Preserve a user-selected donor vocal entry independently from the recipient
-- playback position recorded in at_seconds. Existing swaps retain automatic
-- section/beat alignment through NULL.
ALTER TABLE "wy_listen_session_swaps"
  ADD COLUMN IF NOT EXISTS "donor_entry_offset_ms" integer;
