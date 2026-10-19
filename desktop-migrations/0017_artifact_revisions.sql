-- Immutable content/metadata snapshots; current rows become recoverable tombstones.
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;--> statement-breakpoint
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS current_revision_id uuid;--> statement-breakpoint
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS deleted_at timestamp;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS artifact_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_id uuid NOT NULL REFERENCES artifacts(id),
  revision integer NOT NULL,
  snapshot jsonb NOT NULL,
  restored_from_revision_id uuid,
  created_at timestamp NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS artifact_revisions_number_unique ON artifact_revisions(artifact_id, revision);--> statement-breakpoint
INSERT INTO artifact_revisions (artifact_id, revision, snapshot)
SELECT id, revision, jsonb_build_object('title',title,'body',body,'kind',kind,'projectId',project_id,'sourceType',source_type,'sourceId',source_id,'ownerId',owner_id,'deletedAt',deleted_at,'createdAt',created_at)
FROM artifacts WHERE current_revision_id IS NULL ON CONFLICT DO NOTHING;--> statement-breakpoint
UPDATE artifacts a SET current_revision_id = r.id FROM artifact_revisions r WHERE r.artifact_id = a.id AND r.revision = a.revision AND a.current_revision_id IS NULL;--> statement-breakpoint
