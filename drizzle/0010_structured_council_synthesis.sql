ALTER TABLE "council_runs"
  ADD COLUMN IF NOT EXISTS "structured_synthesis" text;

-- Legacy runs retain their rendered prose in `synthesis`. New runs persist a
-- validated versioned JSON contract here; no unsafe best-effort backfill is made.
