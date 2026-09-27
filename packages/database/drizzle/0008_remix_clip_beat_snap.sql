-- Phase 8: clip-local source-beat editing intent. Legacy clips retain freehand offsets.
ALTER TABLE "remix_clips" ADD COLUMN "beat_snap_enabled" boolean NOT NULL DEFAULT false;
