ALTER TABLE "source_analyses"
  ADD COLUMN IF NOT EXISTS "downbeat_grid" text;
--> statement-breakpoint
ALTER TABLE "source_analyses"
  ADD COLUMN IF NOT EXISTS "downbeat_confidence" real;
