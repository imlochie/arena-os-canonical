-- Persist tempo and beat-grid estimates from the exact isolated drum stem.
-- Null remains an honest "not measured / not confident" value.
ALTER TABLE "drum_analyses" ADD COLUMN IF NOT EXISTS "bpm" real;
--> statement-breakpoint
ALTER TABLE "drum_analyses" ADD COLUMN IF NOT EXISTS "bpm_confidence" real;
--> statement-breakpoint
ALTER TABLE "drum_analyses" ADD COLUMN IF NOT EXISTS "beat_grid" text;
--> statement-breakpoint
ALTER TABLE "drum_analyses" ADD COLUMN IF NOT EXISTS "beat_confidence" real;
