-- Phase 7: explicit remix target and clip-local key-sync intent.
-- Existing sessions/clips retain their original, untransformed export behavior.
ALTER TABLE "remix_sessions" ADD COLUMN "target_key" text;
ALTER TABLE "remix_clips" ADD COLUMN "key_sync_enabled" boolean NOT NULL DEFAULT false;
