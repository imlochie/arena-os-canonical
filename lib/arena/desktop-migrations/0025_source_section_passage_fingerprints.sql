ALTER TABLE source_sections
  ADD COLUMN IF NOT EXISTS passage_fingerprint jsonb;
