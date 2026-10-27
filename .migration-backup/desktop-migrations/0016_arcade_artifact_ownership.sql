-- Per-record ownership for arcade games and artifacts.
--
-- Existing rows were created by the single local owner of this local-first
-- deployment, so the backfill default is LOCAL_OWNER_ID — the same id the
-- runtime records on every new row. API mutations are scoped to owner_id
-- (delete/update of a foreign row is refused), making this column a real
-- authorisation boundary instead of bookkeeping.

ALTER TABLE "arcade_games" ADD COLUMN IF NOT EXISTS "owner_id" text NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001';--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN IF NOT EXISTS "owner_id" text NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001';
