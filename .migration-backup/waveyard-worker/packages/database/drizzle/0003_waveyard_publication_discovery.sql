ALTER TABLE "users"
  ADD COLUMN "platform_role" text DEFAULT 'member' NOT NULL;
ALTER TABLE "users"
  ADD CONSTRAINT "users_platform_role_check"
  CHECK ("platform_role" IN ('member', 'moderator'));

ALTER TABLE "projects"
  ADD COLUMN "published_export_asset_id" uuid
  REFERENCES "export_assets"("id") ON DELETE SET NULL;
ALTER TABLE "projects"
  ADD CONSTRAINT "projects_visibility_check"
  CHECK ("visibility" IN ('private', 'unlisted', 'public'));
ALTER TABLE "projects"
  ADD CONSTRAINT "projects_publication_status_check"
  CHECK ("publication_status" IN ('draft', 'published'));
ALTER TABLE "projects"
  ADD CONSTRAINT "projects_moderation_status_check"
  CHECK ("moderation_status" IN ('active', 'reported', 'hidden', 'removed'));

CREATE TABLE "project_audit_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE cascade,
  "actor_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE restrict,
  "event_type" text NOT NULL,
  "reason" text,
  "metadata" text DEFAULT '{}' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX "projects_public_discovery_idx"
  ON "projects" USING btree ("visibility", "publication_status", "moderation_status", "updated_at", "id");
CREATE INDEX "project_audit_events_project_created_idx"
  ON "project_audit_events" USING btree ("project_id", "created_at");
CREATE INDEX "project_audit_events_type_created_idx"
  ON "project_audit_events" USING btree ("event_type", "created_at");
CREATE UNIQUE INDEX "project_audit_events_reporter_once_idx"
  ON "project_audit_events" USING btree ("project_id", "actor_id")
  WHERE "event_type" = 'report_submitted';
