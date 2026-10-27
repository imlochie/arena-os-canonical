-- Phase 6: clip-local, export-time tempo-sync intent. Legacy clips stay false.
ALTER TABLE "remix_clips" ADD COLUMN "tempo_sync_enabled" boolean NOT NULL DEFAULT false;
