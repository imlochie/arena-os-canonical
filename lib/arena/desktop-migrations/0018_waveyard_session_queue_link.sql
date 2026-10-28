-- Preserve the relationship between a saved queue entry and the session item
-- it created. Existing session items remain unlinked because their origin
-- cannot be inferred safely when duplicates or session-only entries exist.
ALTER TABLE "wy_listen_session_tracks"
  ADD COLUMN IF NOT EXISTS "queue_item_id" uuid;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'wy_listen_session_tracks_queue_item_id_wy_queue_items_id_fk'
      AND conrelid = 'public.wy_listen_session_tracks'::regclass
  ) THEN
    ALTER TABLE "wy_listen_session_tracks"
      ADD CONSTRAINT "wy_listen_session_tracks_queue_item_id_wy_queue_items_id_fk"
      FOREIGN KEY ("queue_item_id")
      REFERENCES "public"."wy_queue_items"("id")
      ON DELETE cascade
      ON UPDATE no action;
  END IF;
END
$$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "wy_listen_session_tracks_queue_item_unique"
  ON "wy_listen_session_tracks" USING btree ("queue_item_id");
