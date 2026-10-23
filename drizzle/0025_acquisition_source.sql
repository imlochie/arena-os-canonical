-- Acquisition jobs precede a verified source asset. Never insert placeholder media.
ALTER TABLE "processing_jobs" ALTER COLUMN "source_asset_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "processing_jobs" ADD CONSTRAINT "processing_jobs_source_required" CHECK (source_asset_id IS NOT NULL OR type = 'acquisition');
