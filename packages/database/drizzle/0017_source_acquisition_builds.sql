-- Unified source-intake provenance and build orchestration. SourceAsset remains
-- the one audio/source authority; builds only track progress toward a RemixSession.
CREATE TABLE "source_acquisitions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source_asset_id" uuid NOT NULL REFERENCES "source_assets"("id") ON DELETE CASCADE,
  "method" text NOT NULL,
  "source_url" text,
  "title" text,
  "artist" text,
  "resolver" text,
  "metadata" text NOT NULL DEFAULT '{}',
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "source_acquisitions_source_unique" ON "source_acquisitions" USING btree ("source_asset_id");
CREATE INDEX "source_acquisitions_method_idx" ON "source_acquisitions" USING btree ("method");

CREATE TABLE "project_builds" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "requested_by_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "status" text NOT NULL DEFAULT 'queued',
  "stage" text NOT NULL DEFAULT 'resolving-sources',
  "requested_source_count" integer NOT NULL DEFAULT 0,
  "accepted_source_count" integer NOT NULL DEFAULT 0,
  "failed_source_count" integer NOT NULL DEFAULT 0,
  "details" text NOT NULL DEFAULT '{}',
  "remix_session_id" uuid REFERENCES "remix_sessions"("id") ON DELETE SET NULL,
  "error_message" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "project_builds_project_updated_idx" ON "project_builds" USING btree ("project_id", "updated_at");
