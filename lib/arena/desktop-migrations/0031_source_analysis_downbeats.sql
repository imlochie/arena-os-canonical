-- A pulse grid cannot establish bar phase. Persist independently measured
-- downbeats so bar actions remain unavailable for weak or missing evidence.
ALTER TABLE "source_analyses"
  ADD COLUMN IF NOT EXISTS "downbeat_grid" text;
ALTER TABLE "source_analyses"
  ADD COLUMN IF NOT EXISTS "downbeat_confidence" real;
