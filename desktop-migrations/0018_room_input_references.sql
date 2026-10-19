ALTER TABLE battles ADD COLUMN IF NOT EXISTS input_reference jsonb;--> statement-breakpoint
ALTER TABLE collabs ADD COLUMN IF NOT EXISTS input_reference jsonb;--> statement-breakpoint
ALTER TABLE council_runs ADD COLUMN IF NOT EXISTS input_reference jsonb;--> statement-breakpoint
ALTER TABLE artifact_revisions ADD COLUMN IF NOT EXISTS body_sha256 text;--> statement-breakpoint
UPDATE artifact_revisions SET body_sha256 = encode(sha256(convert_to(snapshot->>'body', 'UTF8')), 'hex') WHERE body_sha256 IS NULL AND jsonb_typeof(snapshot->'body') = 'string';--> statement-breakpoint
