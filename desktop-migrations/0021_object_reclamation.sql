-- This is an operation/audit ledger, NOT a second reference registry. The
-- authoritative roots remain Artifacts, revisions, Missions and workspaces.
CREATE TABLE IF NOT EXISTS object_reclamations (
 id uuid PRIMARY KEY,
 owner_id text NOT NULL,
 sha256 text NOT NULL,
 bytes integer NOT NULL,
 identity jsonb NOT NULL,
 state text NOT NULL DEFAULT 'marked',
 marked_at timestamptz NOT NULL DEFAULT now(),
 not_before timestamptz NOT NULL,
 purge_after timestamptz,
 quarantined_at timestamptz,
 reason text NOT NULL,
 audit jsonb NOT NULL DEFAULT '[]'
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS object_reclamations_owner_hash ON object_reclamations(owner_id, sha256);
--> statement-breakpoint
-- Table-level SHARE locks in the collector serialize against *every* current
-- and historical root write, including old application processes. This guard
-- additionally refuses a late descriptor binding while bytes are quarantined
-- or deletion intent is unresolved. A verified republication cancels the intent.
CREATE OR REPLACE FUNCTION guard_reclaimed_artifact_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE descriptor jsonb; who text; claimed text;
BEGIN
 IF TG_TABLE_NAME='artifacts' THEN descriptor := NEW.content_object; who := NEW.owner_id; claimed := who;
 ELSE descriptor := NEW.snapshot->'contentObject'; claimed := NEW.snapshot->>'ownerId'; SELECT owner_id INTO who FROM artifacts WHERE id=NEW.artifact_id; END IF;
 IF descriptor IS NOT NULL AND EXISTS (SELECT 1 FROM object_reclamations WHERE (owner_id=who OR owner_id=claimed) AND sha256=descriptor->>'sha256' AND state IN ('quarantining','quarantined','purging','reclaimed')) THEN
   RAISE EXCEPTION 'Content reclamation unresolved: restore or republish verified bytes before binding a revision';
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER guard_reclaimed_artifact BEFORE INSERT OR UPDATE ON artifacts FOR EACH ROW EXECUTE FUNCTION guard_reclaimed_artifact_binding();
--> statement-breakpoint
CREATE TRIGGER guard_reclaimed_revision BEFORE INSERT OR UPDATE ON artifact_revisions FOR EACH ROW EXECUTE FUNCTION guard_reclaimed_artifact_binding();
