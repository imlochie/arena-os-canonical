-- Full private content is a descriptor inside the existing Artifact/revision
-- contract. The bounded body remains inline text or a checksummed manifest.
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS content_object jsonb;
