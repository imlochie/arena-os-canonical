-- A bank is the existing separation_job_id, not a second asset/job registry.
ALTER TABLE wy_listen_session_tracks ADD COLUMN IF NOT EXISTS asset_selection text;
--> statement-breakpoint
ALTER TABLE wy_listen_session_swaps ADD COLUMN IF NOT EXISTS from_stem_asset_id uuid REFERENCES stem_assets(id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE wy_listen_session_swaps ADD COLUMN IF NOT EXISTS to_stem_asset_id uuid REFERENCES stem_assets(id) ON DELETE RESTRICT;
-- Legacy identity is not inferable from track/type and today's publications.
-- Keep NULL, preserve all levels/cues/ledger rows, and require an explicit
-- choice. In particular never bind old swaps to a newly published donor.
