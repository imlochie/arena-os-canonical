-- Processing jobs: idempotency is per ACTIVE attempt, not forever.
--
-- The second-pass separation routes (stem-layers, deep-stems) key their jobs
-- by target ("separation-layer:<stem>:<target>", "separation-deep:<target>")
-- and rely on ON CONFLICT DO NOTHING to refuse a duplicate while one is in
-- flight. With a full unique index the key stayed occupied after the job
-- completed or failed, so a target could never be run again. The key is now
-- unique among queued/running jobs only: terminal rows (complete, failed,
-- cancelled) keep their key as history and release the target. Existing rows
-- satisfy the new index trivially (they were globally unique).
DROP INDEX IF EXISTS "processing_jobs_idempotency_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "processing_jobs_active_idempotency_unique"
  ON "processing_jobs" USING btree ("idempotency_key")
  WHERE "status" NOT IN ('complete', 'failed', 'cancelled');
