-- Pin the exact audio assets used by live stem swaps. Existing rows remain
-- NULL because their asset versions cannot be inferred safely from track IDs.
ALTER TABLE "wy_listen_session_swaps"
  ADD COLUMN IF NOT EXISTS "from_stem_asset_id" uuid;
--> statement-breakpoint
ALTER TABLE "wy_listen_session_swaps"
  ADD COLUMN IF NOT EXISTS "to_stem_asset_id" uuid;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'wy_listen_session_swaps_from_stem_asset_id_stem_assets_id_fk'
      AND conrelid = 'public.wy_listen_session_swaps'::regclass
  ) THEN
    ALTER TABLE "wy_listen_session_swaps"
      ADD CONSTRAINT "wy_listen_session_swaps_from_stem_asset_id_stem_assets_id_fk"
      FOREIGN KEY ("from_stem_asset_id")
      REFERENCES "public"."stem_assets"("id")
      ON DELETE SET NULL
      ON UPDATE no action;
  END IF;
END
$$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'wy_listen_session_swaps_to_stem_asset_id_stem_assets_id_fk'
      AND conrelid = 'public.wy_listen_session_swaps'::regclass
  ) THEN
    ALTER TABLE "wy_listen_session_swaps"
      ADD CONSTRAINT "wy_listen_session_swaps_to_stem_asset_id_stem_assets_id_fk"
      FOREIGN KEY ("to_stem_asset_id")
      REFERENCES "public"."stem_assets"("id")
      ON DELETE SET NULL
      ON UPDATE no action;
  END IF;
END
$$;
