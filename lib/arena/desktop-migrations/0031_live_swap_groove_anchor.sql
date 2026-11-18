-- Keep the previous audible same-role layer as the rhythm-comparison anchor
-- when a user replaces an already-swapped donor. The original from_* fields
-- remain pinned to the source track for restore and Studio handoff.
ALTER TABLE "wy_listen_session_swaps"
  ADD COLUMN IF NOT EXISTS "groove_anchor_track_id" uuid
    REFERENCES "wy_tracks"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "groove_anchor_stem_asset_id" uuid
    REFERENCES "stem_assets"("id") ON DELETE SET NULL;
